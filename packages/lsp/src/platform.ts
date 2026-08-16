import path from 'node:path'

// Cross-platform detection. android-arm64 (Termux) is a supported target:
// modern Termux Node builds report process.platform === "android"; older
// builds report "linux" with $PREFIX and $ANDROID_ROOT set — detect both.
// 64-bit only: supported architectures are arm64 and x64.

export type DshPlatform = 'android' | 'linux' | 'darwin' | 'win32'

export interface PlatformInfo {
  platform: DshPlatform
  arch: string
  isTermux: boolean
  isWindows: boolean
  /** true only for 64-bit architectures (arm64/x64). */
  supported: boolean
  /** GitHub-release asset naming; undefined on unsupported architectures. */
  assetPlatform: 'linux' | 'darwin' | 'windows' | undefined
  assetArch: string | undefined
}

export function detectPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformInfo {
  const isTermux =
    platform === 'android' ||
    (platform === 'linux' && Boolean(env.PREFIX) && Boolean(env.ANDROID_ROOT))
  const effective: DshPlatform = isTermux ? 'android' : (platform as DshPlatform)
  const supported = arch === 'arm64' || arch === 'x64'
  const assetPlatform: PlatformInfo['assetPlatform'] = supported
    ? effective === 'darwin'
      ? 'darwin'
      : effective === 'win32'
        ? 'windows'
        : 'linux'
    : undefined
  const assetArch: PlatformInfo['assetArch'] = supported
    ? arch === 'arm64'
      ? 'aarch64'
      : 'x86_64'
    : undefined
  return {
    platform: effective,
    arch,
    isTermux,
    isWindows: effective === 'win32',
    supported,
    assetPlatform,
    assetArch,
  }
}

/** Managed-install directory for LSP server binaries (dsh-lsp namespace). */
export function managedBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || path.join(env.HOME ?? env.PREFIX ?? '.', '.cache')
  return path.join(base, 'dsh-lsp', 'bin')
}
