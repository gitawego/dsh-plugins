import { access } from 'node:fs/promises'
import path from 'node:path'

// Resolve the executable for a configured server. Order (mirrors OpenCode /
// pi-lsp): 1. absolute command path, used directly; 2. PATH search;
// 3. project-local node_modules/.bin walk-up (npm-installed servers).

export interface BinaryResolution {
  /** Absolute path to the executable. */
  command: string
  /** Remaining argv after the executable. */
  args: string[]
}

interface CommandLike {
  command: string[]
}

const WINDOWS_EXTS = ['', '.cmd', '.exe', '.bat']

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function executableCandidates(
  file: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (platform !== 'win32') {
    return (await isExecutable(file)) ? file : undefined
  }
  for (const ext of WINDOWS_EXTS) {
    const candidate = file + ext
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

export async function resolveBinary(
  name: string,
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env

  if (path.isAbsolute(name)) return executableCandidates(name, platform)

  const searchPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of searchPath) {
    const candidate = await executableCandidates(path.join(dir, name), platform)
    if (candidate) return candidate
  }

  return walkUpNodeModulesBin(name, cwd, platform)
}

async function walkUpNodeModulesBin(
  name: string,
  cwd: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const normalized = path.resolve(cwd)
  let current = normalized
  while (true) {
    const candidate = await executableCandidates(path.join(current, 'node_modules', '.bin', name), platform)
    if (candidate) return candidate
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Resolve the full spawn command for a server config. */
export async function resolveCommand(
  server: CommandLike,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<BinaryResolution | undefined> {
  const [name, ...args] = server.command
  if (!name) return undefined
  const resolved = await resolveBinary(name, cwd, { env })
  if (!resolved) return undefined
  return { command: resolved, args }
}
