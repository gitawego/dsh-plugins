#!/usr/bin/env bash
# install-plugins.sh — install all dsh-plugins packages into a DSH profile.
#
# Usage:
#   bash scripts/install-plugins.sh [PROFILE_DIR] [PKG]
#
# Defaults to $DSH_HOME/profiles/web (or ~/.dsh/profiles/web).
# PKG filters to a single package (name or directory under packages/), e.g.
#   bash scripts/install-plugins.sh "" llm-provider
#   bash scripts/install-plugins.sh ~/.dsh/profiles/web lsp
# The script is idempotent: running it twice changes nothing unless a package
# was added or removed from packages/.
#
# DSH's own `dsh plugin` command forwards to pnpm. This repository uses Bun
# for the workspace and for profile installs, so the script edits the profile
# manifest directly (adding file deps + bundles) and runs Bun itself. The two
# install flags are load-bearing:
#
#   --linker=hoisted    a flat node_modules, the layout DSH loads from;
#   --production        do not install the workspace packages' devDependencies;
#   --omit=peer         do not install a profile-local copy of every
#                       @deepseek-ai peer. A profile copy shadows the running
#                       host, which is how an old dsh-host-webserver once broke
#                       the web app after a host upgrade.
#
# Bun snapshots file: dependencies (it does not symlink them), so a repo build
# is still not a deploy. The build below runs before the profile install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_DIR="$(dirname "$SCRIPT_DIR")"
PROFILE="${1:-${DSH_HOME:-${HOME}/.dsh}/profiles/web}"
PKG="${2:-}"

echo "monorepo: $MONOREPO_DIR"
echo "profile:  $PROFILE"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun is not on PATH; install Bun 1.4.5 or newer." >&2
  exit 1
fi

# Refuse to deploy a manifest that disagrees with the harness it will load into.
# A runtime or stale dependency on a host package installs a second copy inside
# the plugin, so the plugin speaks an older protocol than the host it boots in —
# the failure that once shipped an adapter built against a pi-ai two versions
# behind the harness.
node "$MONOREPO_DIR/scripts/check-host-pins.mjs" --host "${DSH_HOST:-$(dirname "$(dirname "$(command -v dsh || echo /nonexistent/dsh)")")/lib/node_modules/@deepseek-ai/dsh}"
if [ -n "$PKG" ]; then echo "package:  $PKG (filtered)"; fi

# Verify profile exists
if [ ! -d "$PROFILE" ]; then
  echo "ERROR: profile directory does not exist: $PROFILE" >&2
  exit 1
fi
if [ ! -f "$PROFILE/package.json" ]; then
  echo "ERROR: profile/package.json does not exist: $PROFILE" >&2
  exit 1
fi

# Build the file: packages before they are snapshotted into the profile.
bun run --cwd "$MONOREPO_DIR" --filter '*' build

# Scan packages/ and update profile manifest
python3 - "$MONOREPO_DIR" "$PROFILE" "$PKG" << 'PYEOF'
import json, subprocess, os, shutil, sys

monorepo = sys.argv[1]
profile = sys.argv[2]
pkg_filter = sys.argv[3] or None
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
    if pkg_filter and pkg_filter not in (name, pkg_name):
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

# Make ad-hoc `bun install` in the profile behave like this script: flat layout,
# no devDependencies, no profile-local peer copies. Do not overwrite a bunfig
# the user already owns.
bunfig = os.path.join(profile, 'bunfig.toml')
if not os.path.exists(bunfig):
    with open(bunfig, 'w') as f:
        f.write('[install]\nlinker = "hoisted"\nproduction = true\npeer = false\n')
    print('  + bunfig.toml (hoisted, production, no peers)')

# A bun.lock written by an install that did not pass --omit=peer keeps host
# peers in the graph, and a plain re-install will not remove them. Start clean
# when the profile already has a profile-local host tree.
host_tree = os.path.join(profile, 'node_modules', '@deepseek-ai')
if os.path.isdir(host_tree):
    print('  ! removing stale profile-local @deepseek-ai copies')
    shutil.rmtree(host_tree)
    lock = os.path.join(profile, 'bun.lock')
    if os.path.exists(lock):
        os.remove(lock)

result = subprocess.run(
    ['bun', 'install', '--linker=hoisted', '--production', '--omit=peer', '--prefer-offline'],
    cwd=profile,
    capture_output=True,
    text=True,
)
print(result.stdout.strip())
if result.returncode != 0:
    print(result.stderr.strip())
    sys.exit(1)

# The harness supplies these at runtime. A profile-local copy shadows it.
if os.path.isdir(host_tree):
    print('ERROR: bun installed a profile-local @deepseek-ai tree.')
    print('       Remove bun.lock and retry; the profile must resolve host packages from dsh.')
    sys.exit(1)
PYEOF

echo ""
echo "done. open a new browser tab to load the updated bundles."
