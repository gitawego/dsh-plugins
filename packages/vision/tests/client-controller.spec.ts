/** Tests for the rc.7 client controllers in `src/client/index.tsx`:
 *  - CatalogController (api.llm.models RPC, injected via constructor)
 *  - SettingsController (settingsScope.bind)
 *  - providerOptions / modelOptions (pure dropdown helpers)
 *
 *  Replaces the rc.6 bespoke HTTP route tests. The controllers now back
 *  onto ctx.settingsScope.bind (the standard settings scope) and the
 *  LlmApi RPC exposed by `dsh-host-apiproxy` via ctx.connection.api. */
import { describe, expect, it } from 'vitest'
import { CatalogController, SettingsController } from '../src/client/index.tsx'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { VisionConfig } from '../src/config.ts'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeSettingsScope(initial: VisionConfig): SettingsScope<VisionConfig> & {
  store: { status: 'loading' | 'ready' | 'unavailable'; value: VisionConfig | undefined; writable: boolean; revision: number; base: unknown; user: unknown; mode: 'host' }
  setCalls: Array<{ field: string; value: unknown }>
} {
  const store = {
    status: 'ready' as 'loading' | 'ready' | 'unavailable',
    value: structuredClone(initial) as VisionConfig | undefined,
    writable: true,
    revision: 1,
    base: undefined,
    user: undefined,
    mode: 'host' as 'host' | 'memory',
  }
  const listeners = new Set<() => void>()
  const setCalls: Array<{ field: string; value: unknown }> = []
  const scope: SettingsScope<VisionConfig> & {
    store: typeof store
    setCalls: Array<{ field: string; value: unknown }>
  } = {
    store,
    setCalls,
    getSnapshot: () => store,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    set: async (field, value) => {
      setCalls.push({ field, value })
      const target = store.value as Record<string, unknown>
      target[field] = value
      store.revision += 1
      for (const l of listeners) l()
    },
    unset: async (field) => {
      const target = store.value as Record<string, unknown>
      delete target[field]
      store.revision += 1
      for (const l of listeners) l()
    },
  }
  return scope
}

function makeStubLlmApi(
  providers: Array<{ id: string; name: string }>,
  models: Record<string, Array<{ id: string; name: string; inputModalities?: readonly string[] }>>,
  failOnListProviders = false,
) {
  return {
    listProviders: failOnListProviders
      ? () => { throw new Error('boom') }
      : () => providers,
    models: async () => ({
      groups: providers.map((p) => ({
        provider: p.id,
        models: models[p.id] ?? [],
      })),
    }),
  }
}

// ── SettingsController ───────────────────────────────────────────────────

describe('SettingsController (settingsScope.bind)', () => {
  it('loads the current snapshot', async () => {
    const scope = makeSettingsScope({ enabled: false, delegation: 'auto' } as VisionConfig)
    const controller = new SettingsController(scope, async () => {})
    let state = controller.getSnapshot()
    expect(state.status).toBe('idle')
    await controller.load()
    state = controller.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.snapshot?.value.delegation).toBe('auto')
    expect(state.snapshot?.writable).toBe(true)
  })

  it('saves via settingsScope.set for each field', async () => {
    const scope = makeSettingsScope({ enabled: false, delegation: 'auto' } as VisionConfig)
    const controller = new SettingsController(scope, async (patch) => {
      for (const [field, value] of Object.entries(patch)) {
        await scope.set(field, value)
      }
    })
    await controller.load()
    await controller.save({ enabled: true, delegation: 'native' })
    expect(scope.setCalls).toContainEqual({ field: 'enabled', value: true })
    expect(scope.setCalls).toContainEqual({ field: 'delegation', value: 'native' })
  })

  it('rejects a non-object patch', async () => {
    const scope = makeSettingsScope({ enabled: false } as VisionConfig)
    const controller = new SettingsController(scope, async () => {})
    await controller.load()
    await expect(controller.save('nope' as never)).rejects.toThrow('must be an object')
  })

  it('refuses writes on a read-only provider', async () => {
    const scope = makeSettingsScope({ enabled: false } as VisionConfig)
    scope.store.writable = false
    const controller = new SettingsController(scope, async () => {})
    await controller.load()
    await expect(controller.save({ enabled: true })).rejects.toThrow('read-only')
  })
})

// ── CatalogController ────────────────────────────────────────────────────

describe('CatalogController (api.llm.models via constructor injection)', () => {
  it('publishes the live catalog snapshot', async () => {
    const api = makeStubLlmApi(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      {
        a: [{ id: 'vision', name: 'V', inputModalities: ['text', 'image'] }],
        b: [{ id: 'text', name: 'T', inputModalities: ['text'] }],
      },
    )
    const controller = new CatalogController(api)
    let state = controller.getSnapshot()
    expect(state.status).toBe('idle')
    await controller.load()
    state = controller.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.snapshot?.providers).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    expect(state.snapshot?.visionModels).toEqual([{ provider: 'a', model: 'vision', name: 'V' }])
    expect(state.snapshot?.available).toBe(true)
  })

  it('surfaces load failures without throwing', async () => {
    const api = makeStubLlmApi(
      [{ id: 'a', name: 'A' }],
      { a: [{ id: 'vision', name: 'V', inputModalities: ['text', 'image'] }] },
      true, // failOnListProviders
    )
    const controller = new CatalogController(api)
    await controller.load()
    const state = controller.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toContain('boom')
  })
})
