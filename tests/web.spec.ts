/** Tests for the Web routes: data-driven models catalog + the settings
 *  snapshot/save endpoint (the client settings form depends on these). */
import { describe, expect, it } from 'vitest'
import {
  applySettingsPatch, buildModelsSnapshot, buildSettingsSnapshot, type VisionSettingsLike,
} from '../src/web.ts'

type MutateOp = { op: 'set'; path: string; value?: unknown } | { op: 'unset'; path: string }

function fakeSettings(initial: Record<string, unknown> = {}): {
  settings: VisionSettingsLike
  section: Record<string, unknown>
  updateCalls: Array<Record<string, unknown>>
  mutateCalls: MutateOp[][]
} {
  const section: Record<string, unknown> = { ...initial }
  const updateCalls: Array<Record<string, unknown>> = []
  const mutateCalls: MutateOp[][] = []
  const settings: VisionSettingsLike = {
    get: () => section as never,
    update: async (patch) => {
      updateCalls.push(patch)
      Object.assign(section, patch)
    },
    mutate: async (ops) => {
      mutateCalls.push(ops as MutateOp[])
      for (const op of ops) {
        if (op.op === 'set') (section as Record<string, unknown>)[op.path] = op.value
        else delete (section as Record<string, unknown>)[op.path]
      }
    },
  }
  return { settings, section, updateCalls, mutateCalls }
}

function fakeCtx(overrides: Record<string, unknown> = {}): never {
  return {
    settings: { writable: true },
    logger: { warn: () => {} },
    ...overrides,
  } as never
}

describe('web settings snapshot', () => {
  it('returns writability and the current resolved value', async () => {
    const { settings, section } = fakeSettings({ provider: 'p', model: 'm' })
    section.enabled = false
    const snapshot = await buildSettingsSnapshot(fakeCtx(), settings)
    expect(snapshot.writable).toBe(true)
    expect(snapshot.value).toBe(section)
  })
})

describe('web settings save', () => {
  it('writes the patch through update with the http block', async () => {
    const { settings, updateCalls } = fakeSettings()
    const snapshot = await applySettingsPatch(fakeCtx(), settings, {
      provider: 'opencode-go', model: 'minimax-m3', enabled: true,
      delegation: 'auto', maxDimension: 2048, http: { baseUrl: 'https://x.test', credential: 'KEY', model: 'm', protocol: 'openai' },
    })
    // provider/model ride the mutate ops, not the update patch
    expect(updateCalls[0]).not.toHaveProperty('provider')
    expect(updateCalls[0]).not.toHaveProperty('model')
    expect(updateCalls[0]).toMatchObject({ maxDimension: 2048, delegation: 'auto' })
    expect(snapshot.value.provider).toBe('opencode-go')
    expect(snapshot.value.model).toBe('minimax-m3')
    expect(snapshot.value.maxDimension).toBe(2048)
    expect(snapshot.value.http).toMatchObject({ baseUrl: 'https://x.test', credential: 'KEY', model: 'm', protocol: 'openai' })
  })

  it('unsets empty provider/model via mutate', async () => {
    const { settings, mutateCalls } = fakeSettings({ provider: 'p', model: 'm' })
    await applySettingsPatch(fakeCtx(), settings, { provider: '  ', model: '' })
    const first = mutateCalls[0] ?? []
    expect(first).toContainEqual({ op: 'unset', path: 'provider' })
    expect(first).toContainEqual({ op: 'unset', path: 'model' })
    expect(settings.get().provider).toBeUndefined()
    expect(settings.get().model).toBeUndefined()
  })

  it('clamps numeric fields and normalizes http', async () => {
    const { settings } = fakeSettings()
    const snapshot = await applySettingsPatch(fakeCtx(), settings, {
      provider: 'p', model: 'm', maxDimension: 999999, jpegQuality: -3, http: { protocol: 'anthropic' },
    })
    expect(snapshot.value.maxDimension).toBe(8000)
    expect(snapshot.value.jpegQuality).toBe(1)
    expect(snapshot.value.http).toEqual({ protocol: 'anthropic' })
  })

  it('rejects a non-object patch', async () => {
    const { settings } = fakeSettings()
    await expect(applySettingsPatch(fakeCtx(), settings, 'nope')).rejects.toThrow('must be an object')
  })

  it('rejects an invalid http baseUrl through config validation', async () => {
    const { settings } = fakeSettings()
    await expect(applySettingsPatch(fakeCtx(), settings, { http: { baseUrl: 'ftp://x' } })).rejects.toThrow(/http/)
  })

  it('refuses writes on a read-only provider', async () => {
    const { settings } = fakeSettings()
    await expect(applySettingsPatch(fakeCtx({ settings: { writable: false } }), settings, {})).rejects.toThrow('read-only')
  })
})

describe('web models catalog (data-driven)', () => {
  function llmCtx(providers: Array<{ id: string; name: string }>, models: Record<string, Array<{ id: string; name: string; inputModalities?: string[] }>>) {
    return fakeCtx({
      llm: {
        listProviders: () => providers,
        listModels: async (id: string) => {
          const list = models[id]
          if (list === undefined) throw new Error('no such provider')
          return list
        },
      },
    })
  }

  it('lists only image-capable models from the live catalog and detects a default', async () => {
    const ctx = llmCtx(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      {
        a: [{ id: 'text-only', name: 'T', inputModalities: ['text'] }, { id: 'vision', name: 'V', inputModalities: ['text', 'image'] }],
        b: [{ id: 'other', name: 'O' }],
      },
    )
    const resolved = { provider: undefined, model: undefined } as never
    const snapshot = await buildModelsSnapshot(ctx, resolved)
    expect(snapshot.available).toBe(true)
    expect(snapshot.providers).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    expect(snapshot.visionModels).toEqual([{ provider: 'a', model: 'vision', name: 'V' }])
    expect(snapshot.detected).toEqual({ provider: 'a', model: 'vision', name: 'V', default: true })
    expect(snapshot.configured).toEqual({ provider: undefined, model: undefined })
  })

  it('skips providers that fail to list models and reports unavailable when none exist', async () => {
    const ctx = llmCtx([{ id: 'broken', name: 'B' }], {})
    const snapshot = await buildModelsSnapshot(ctx, { provider: undefined, model: undefined } as never)
    expect(snapshot.visionModels).toEqual([])
    expect(snapshot.detected).toBeUndefined()
    expect(snapshot.available).toBe(true)
    const empty = await buildModelsSnapshot(fakeCtx({ llm: { listProviders: () => [], listModels: async () => [] } }), { provider: undefined, model: undefined } as never)
    expect(empty.available).toBe(false)
  })
})

