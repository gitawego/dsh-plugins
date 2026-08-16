import { access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PlatformInfo } from './platform.js'

const exec = promisify(execFile)

/** Where tsserver.js lives under an npm prefix install of `typescript`. */
const TSSERVER_REL = ['node_modules', 'typescript', 'lib', 'tsserver.js']
export const GLOBAL_TYPESCRIPT = 'typescript'
// Pin to the 6.x major: typescript-language-server (classic tsserver consumer)
// needs lib/tsserver.js, which typescript@7/latest dropped for a new layout.
// typescript@6 still ships the classic lib/tsserver.js entry.
export const GLOBAL_TYPESCRIPT_VERSION = '6'

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** Full path to tsserver.js under a prefix install dir. */
export function tsserverUnder(prefix: string): string {
  return join(prefix, ...TSSERVER_REL)
}

/** The default tsserver.js resource path (for the shared global install). */
export function tsserverUnderHome(home: string): string {
  return tsserverUnder(join(home))
}

/**
 * Find a real tsserver.js by walking up from `cwd` (project-local
 * `node_modules/typescript`), so the typescript-language-server has a payload.
 * Returns undefined when none is reachable.
 */
export async function findProjectTsserver(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd)
  while (true) {
    const candidate = join(current, ...TSSERVER_REL)
    if (await exists(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Whether `typescript` is already present in the managed binDir prefix.
 */
export async function hasManagedTsserver(binDir: string): Promise<boolean> {
  return exists(tsserverUnder(binDir))
}

/**
 * Resolve the effective `tsserver.path` to feed typescript-language-server's
 * initialization, installing a global `typescript` payload when neither the
 * project tree nor a previous managed install provides one.
 *
 * Priority:
 *   1. explicit `tsserverPath` (user-configured) — honored verbatim;
 *   2. a reachable project `typescript` (walk up from `cwd`);
 *   3. an already-managed `typescript` in `binDir`;
 *   4. install `typescript` into `binDir` (global, managed) and use it.
 *
 * Returns the resolved path plus a short "action" string for transparency/logs.
 */
export async function resolveTsserverPath(options: {
  binDir: string
  cwd: string
  explicit?: string
  info?: PlatformInfo
  install?: boolean
  /** Managed `typescript` payload version to install; defaults to 6. */
  version?: string
  onStatus?: (text: string | undefined) => void
}): Promise<{ path?: string; action?: string }> {
  if (options.explicit && (await exists(options.explicit))) {
    return { path: options.explicit }
  }
  if (options.explicit) {
    return { action: `configured tsserver.path not found (${options.explicit}); ignoring` }
  }

  const project = await findProjectTsserver(options.cwd)
  if (project) return { path: project }

  const managed = tsserverUnder(options.binDir)
  if (await exists(managed)) return { path: managed, action: 'global' }

  const version = options.version?.trim() && options.version.trim().length > 0
    ? options.version.trim()
    : GLOBAL_TYPESCRIPT_VERSION
  if (options.install !== false && options.info?.supported !== false) {
    options.onStatus?.('typescript installing')
    try {
      await exec('npm', [
        'install', '--prefix', options.binDir, '--no-audit', '--no-fund',
        `${GLOBAL_TYPESCRIPT}@${version}`,
      ], { env: process.env })
      options.onStatus?.(undefined)
      if (await exists(managed)) {
        return { path: managed, action: `installed ${GLOBAL_TYPESCRIPT}@${version} globally to ${options.binDir} and configured tsserver.path for typescript-language-server` }
      }
      return { action: `${GLOBAL_TYPESCRIPT}@${version} install finished but tsserver.js was not produced in ${options.binDir}` }
    } catch (error) {
      options.onStatus?.(undefined)
      return { action: `global ${GLOBAL_TYPESCRIPT}@${version} install failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { action: 'could not obtain a typescript payload (auto-install disabled)' }
}
