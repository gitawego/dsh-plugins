/** Tests for the LSP settings-patch domain helpers (extracted from the
 *  rc.6 bespoke HTTP route). The same logic now powers both the host-side
 *  /lsp command and the rc.7 client-side settings.widget via
 *  ctx.settingsScope.bind. */
import { describe, expect, it } from 'vitest'
import { applySettingsPatch, buildSettingsSnapshot, type LspSettingsLike } from '../src/settings-patch.ts'
import { mergeConfig, resolveConfig } from '../src/config.ts'

interface MockSettings extends LspSettingsLike {
  current: Record<string, unknown>
  mutateCalls: Array<{ op: 'set'; path: string | string[]; value?: unknown } | { op: 'unset'; path: string | string[] }>
}
function mockSettings(initial: Record<string, unknown>): MockSettings {
  const current: Record<string, unknown> = { ...initial }
  const mutateCalls: MockSettings['mutateCalls'] = []
  return {
    current,
    mutateCalls,
    get: () => mergeConfig(current) as never,
    async update(patch: Record<string, unknown>) {
      Object.assign(current, patch)
    },
    async mutate(ops: Array<{ op: 'set'; path: string | string[]; value?: unknown } | { op: 'unset'; path: string | string[] }>) {
      for (const op of ops) mutateCalls.push(op)
      for (const op of ops) {
        const path = Array.isArray(op.path) ? op.path : [op.path]
        if (op.op === 'set') {
          setPath(current, path, op.value)
        } else {
          unsetPath(current, path)
        }
      }
    },
  } as never
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

describe('LSP settings helpers (settings-patch)', () => {
  it('buildSettingsSnapshot reports the merged config', () => {
    const settings = mockSettings({ timeout: 15000 })
    const snap = buildSettingsSnapshot(writableCtx, settings)
    expect(snap.writable).toBe(true)
    expect((snap.value as { timeout: number }).timeout).toBe(15000)
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
    expect((buildSettingsSnapshot(writableCtx, settings).value as { timeout: number }).timeout).toBe(30000)
  })
})
