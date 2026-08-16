// Managed install plans for official LSP servers whose binaries may be missing.
// Mirrors OpenCode / pi-lsp auto-download (gopls via `go install`, kotlin-lsp via
// GitHub releases, TS servers via npm) — opt-in per server, platform-gated
// (64-bit only; android refuses github-release plans). Driven by the manager's
// #spawn once resolveBinary returns nothing for an autoDownload server.

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { resolveBinary } from './binary.js'
import type { PlatformInfo } from './platform.js'
import type { ResolvedServer } from './config.js'

const exec = promisify(execFile)

export type DownloadPlan =
  | { kind: 'npm'; package: string; bin: string; requires?: ReadonlyArray<'java' | 'go'> }
  | { kind: 'github-release'; owner: string; repo: string; bin: string; requires?: ReadonlyArray<'java' | 'go'> }
  | { kind: 'go-install'; package: string; bin: string; requires?: ReadonlyArray<'java' | 'go'> }

interface Downloadable {
  id: string
  download?: unknown
}

const NPM_PACKAGES: Record<string, { package: string; bin: string }> = {
  typescript: { package: 'typescript-language-server', bin: 'typescript-language-server' },
  pyright: { package: 'pyright', bin: 'pyright-langserver' },
}

const GITHUB_RELEASES: Record<string, { owner: string; repo: string; bin: string }> = {
  kotlin: { owner: 'Kotlin', repo: 'kotlin-lsp', bin: 'kotlin-lsp' },
}

const GO_INSTALLS: Record<string, { package: string; bin: string }> = {
  gopls: { package: 'golang.org/x/tools/gopls@latest', bin: 'gopls' },
}

/** Return the managed-install plan for a server, or undefined when it cannot auto-download. */
export function downloadPlanFor(server: Downloadable): DownloadPlan | undefined {
  switch (server.download) {
    case 'npm': {
      const spec = NPM_PACKAGES[server.id]
      return spec ? { kind: 'npm', ...spec } : undefined
    }
    case 'github-release': {
      const spec = GITHUB_RELEASES[server.id]
      return spec ? { kind: 'github-release', ...spec } : undefined
    }
    case 'go-install': {
      const spec = GO_INSTALLS[server.id]
      return spec ? { kind: 'go-install', ...spec } : undefined
    }
    default:
      return undefined
  }
}

/** Whether a plan can be installed on this platform. Async (resolves toolchains). */
export async function feasibleOn(
  plan: DownloadPlan | undefined,
  info: PlatformInfo,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!plan || !info.supported) return false
  // glibc/JVM launchers are unreliable on bionic Termux.
  if (info.platform === 'android' && plan.kind === 'github-release') return false
  for (const tool of plan.requires ?? []) {
    if (!(await resolveBinary(tool, process.cwd(), { env }))) return false
  }
  return true
}

/**
 * Install a plan into binDir and return the installed binary path.
 * Refuses unsupported architectures. github-release installs return undefined
 * (deferred installer; such plans are already gated out on android).
 */
export async function install(
  plan: DownloadPlan,
  info: PlatformInfo,
  opts: { binDir: string; env?: NodeJS.ProcessEnv },
): Promise<string | undefined> {
  if (!info.supported) return undefined
  const env = opts.env ?? process.env
  await mkdir(opts.binDir, { recursive: true })
  if (plan.kind === 'npm') {
    await exec('npm', ['install', '--prefix', opts.binDir, '--no-audit', '--no-fund', plan.package], { env })
    return path.join(opts.binDir, 'node_modules', '.bin', plan.bin)
  }
  if (plan.kind === 'go-install') {
    await exec('go', ['install', plan.package], { env: { ...env, GOBIN: opts.binDir } })
    return path.join(opts.binDir, plan.bin + (info.isWindows ? '.exe' : ''))
  }
  return undefined
}

/** Whether this server is configured to auto-download a missing binary. */
export function canAutoDownload(server: ResolvedServer): boolean {
  return server.autoDownload === true
}
