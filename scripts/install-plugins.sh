#!/usr/bin/env bash
# install-plugins.sh — install all dsh-plugins packages into a DSH profile.
#
# Usage:
#   bash scripts/install-plugins.sh [PROFILE_DIR]
#
# Defaults to $DSH_HOME/profiles/web (or ~/.dsh/profiles/web).
# The script is idempotent: running it twice changes nothing unless a package
# was added or removed from packages/.
#
# This works around a pnpm 12 limitation where `dsh plugin add <path>` fails
# because the dsh plugin script's anchorPathSpec regex only handles relative
# paths starting with . or .. — absolute paths pass through verbatim and pnpm
# rejects them as package names. Instead, this script edits the profile
# manifest directly (adding file deps + bundles) and runs pnpm install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_DIR="$(dirname "$SCRIPT_DIR")"
PROFILE="${1:-${DSH_HOME:-${HOME}/.dsh}/profiles/web}"

echo "monorepo: $MONOREPO_DIR"
echo "profile:  $PROFILE"

# Verify profile exists
if [ ! -d "$PROFILE" ]; then
  echo "ERROR: profile directory does not exist: $PROFILE" >&2
  exit 1
fi
if [ ! -f "$PROFILE/package.json" ]; then
  echo "ERROR: profile/package.json does not exist: $PROFILE" >&2
  exit 1
fi

# Scan packages/ and update profile manifest
python3 - "$MONOREPO_DIR" "$PROFILE" << 'PYEOF'
import json, subprocess, os, sys

monorepo = sys.argv[1]
profile = sys.argv[2]
packages_dir = os.path.join(monorepo, 'packages')

manifest_path = os.path.join(profile, 'package.json')
with open(manifest_path) as f:
    manifest = json.load(f)

changed = False

for name in sorted(os.listdir(packages_dir)):
    pkg_dir = os.path.join(packages_dir, name)
    pkg_json = os.path.join(pkg_dir, 'package.json')
    if not os.path.isfile(pkg_json):
        continue
    with open(pkg_json) as f:
        pkg = json.load(f)
    pkg_name = pkg.get('name')
    if not pkg_name:
        continue

    # Add as file dependency
    dep_val = f'file:{os.path.abspath(pkg_dir)}'
    if manifest['dependencies'].get(pkg_name) != dep_val:
        manifest['dependencies'][pkg_name] = dep_val
        changed = True
        print(f'  + {pkg_name}')

    # Add to bundles if plugin declares dsh.bundle
    has_patch = os.path.isfile(os.path.join(pkg_dir, 'cordis.patch.yml'))
    bundles = manifest.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
    if has_patch and pkg_name not in bundles:
        bundles.append(pkg_name)
        changed = True
        print(f'  + bundle: {pkg_name}')

if not changed:
    print('  (no changes needed)')
else:
    # Write back
    with open(manifest_path, 'w') as f:
        f.write(json.dumps(manifest, indent=2) + '\n')

# Run pnpm install --offline
result = subprocess.run(
    ['pnpm', 'install', '--offline'],
    cwd=profile,
    capture_output=True,
    text=True,
)
print(result.stdout.strip())
if result.returncode != 0:
    print(result.stderr.strip())
    sys.exit(1)
PYEOF

echo ""
echo "done. open a new browser tab to load the updated bundles."
