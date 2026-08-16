import { describe, expect, it } from 'vitest'
import { applySettingsPatch, buildSettingsSnapshot, type LspSettingsLike } from '../src/web.ts'
import { mergeConfig, resolveConfig } from '../src/config.ts'

interface MockSettings extends LspSettingsLike {
  current: Record<string, unknown>
}
function mockSettings(initial: Record<string, unknown>): MockSettings {
  const current: Record<string, unknown> = { ...initial }
  return {
    current,
    get: () => mergeConfig(current),
    async update(patch) {
      Object.assign(current, patch)
    },
    async mutate(ops) {
      for (const op of ops) {
        const path = Array.isArray(op.path) ? op.path : [op.path]
        if (op.op === 'set') {
          setPath(current, path, op.value)
        } else {
          unsetPath(current, path)
        }
      }
    },
  }
}
function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (!isObj(cur[key])) cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[path[path.length - 1]!] = value
}
function unsetPath(obj: Record<string, unknown>, path: string[]): void {
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (!isObj(cur[key])) return
    cur = cur[key] as Record<string, unknown>
  }
  delete cur[path[path.length - 1]!]
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const writableCtx = { settings: { writable: true } } as never

describe('LSP settings route (web)', () => {
  it('buildSettingsSnapshot reports the merged config', async () => {
    const settings = mockSettings({ timeout: 15000 })
    const snap = await buildSettingsSnapshot(writableCtx, settings)
    expect(snap.writable).toBe(true)
    expect(snap.value.timeout).toBe(15000)
  })

  it('applySettingsPatch persists timeout/progressive/servers via mutations', async () => {
    const settings = mockSettings({})
    await applySettingsPatch(writableCtx, settings, {
      timeout: 42000,
      progressive: { enabled: false, inject: 'none', maxDiagnostics: 5, quietMs: 999 },
      servers: {
        typescript: {
          command: ['typescript-language-server', '--stdio'],
          initialization: { tsserver: { path: '/opt/ts/tsserver.js' } },
        },
      },
    })
    const resolved = resolveConfig(mergeConfig(settings.current))
    expect(resolved.timeout).toBe(42000)
    expect(resolved.progressive.enabled).toBe(false)
    expect(resolved.progressive.inject).toBe('none')
    expect(resolved.progressive.quietMs).toBe(999)
    const tsInitialization = resolved.servers.typescript!.initialization as Record<string, unknown>
    expect((tsInitialization?.tsserver as Record<string, unknown>)?.path).toBe('/opt/ts/tsserver.js')
  })

  it('rejects when the settings provider is read-only', async () => {
    const settings = mockSettings({})
    const readOnlyCtx = { settings: { writable: false } } as never
    await expect(applySettingsPatch(readOnlyCtx, settings, { timeout: 1 })).rejects.toThrow('read-only')
  })

  it('clamps invalid timeout to the default on save', async () => {
    const settings = mockSettings({})
    await applySettingsPatch(writableCtx, settings, { timeout: -1 })
    expect((await buildSettingsSnapshot(writableCtx, settings)).value.timeout).toBe(30000)
  })
})
