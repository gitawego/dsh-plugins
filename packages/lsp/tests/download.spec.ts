import { describe, expect, it } from 'vitest'
import { detectPlatform } from '../src/platform.ts'
import { downloadPlanFor, feasibleOn, canAutoDownload } from '../src/download.ts'
import { mergeConfig, resolveConfig } from '../src/config.ts'

describe('download plans', () => {
  it('looks up npm / github-release / go-install plans', () => {
    expect(downloadPlanFor({ id: 'typescript', download: 'npm' })).toMatchObject({ kind: 'npm', package: 'typescript-language-server' })
    expect(downloadPlanFor({ id: 'gopls', download: 'go-install' })).toMatchObject({ kind: 'go-install', bin: 'gopls' })
  })

  it('returns undefined for unknown ids or strategies', () => {
    expect(downloadPlanFor({ id: 'bogus', download: 'npm' })).toBeUndefined()
    expect(downloadPlanFor({ id: 'clangd' })).toBeUndefined()
  })

  it('refuses github-release on android (bionic)', async () => {
    const info = detectPlatform({ PREFIX: '/data/data/com.termux/files/usr', ANDROID_ROOT: '/system' } as NodeJS.ProcessEnv, 'linux', 'arm64')
    expect(info.isTermux).toBe(true)
    const plan = downloadPlanFor({ id: 'kotlin', download: 'github-release' })!
    expect(await feasibleOn(plan, info, {})).toBe(false)
  })

  it('is feasible for npm on supported 64-bit', async () => {
    const info = detectPlatform({} as NodeJS.ProcessEnv, 'linux', 'x64')
    const plan = downloadPlanFor({ id: 'typescript', download: 'npm' })!
    expect(await feasibleOn(plan, info, {})).toBe(true)
  })

  it('flags autoDownload from resolved config', () => {
    const resolved = resolveConfig(mergeConfig({})).servers
    expect(canAutoDownload(resolved.typescript!)).toBe(true)
    expect(canAutoDownload(resolved.clangd!)).toBe(false)
  })
})
