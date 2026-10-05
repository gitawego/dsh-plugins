/**
 * The section's face and its snapshot must be two views of ONE controller per
 * route.
 *
 * They were not, once: the actions were wired to a controller built separately
 * from the one the panel rendered, so `refresh()` and `refreshQuota()` updated
 * an orphan while the visible panel stayed at its initial state — "Not read yet"
 * under Allowance, and every pinned model marked "no longer served" because the
 * rendered controller had never read the catalog.
 *
 * These tests drive the face the way the UI does and then read the snapshot the
 * UI renders, so that class of wiring mistake fails here instead of in a
 * screenshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSectionFace } from '../src/client/index.tsx'
import type { ProviderSections, SettingsPathOp, SettingsScopeLike } from '../src/client/controller.ts'
import { QUOTA_ROUTE_PATH } from '../src/quota-path.ts'

const ROUTE = 'opencode-go-session'

/** A settings scope that holds a profile and accepts writes. */
function fakeScope(): SettingsScopeLike<ProviderSections> {
    let value: ProviderSections = { [ROUTE]: { apiKeyEnv: 'KEY' } }
    const listeners = new Set<() => void>()
    let snapshot = { status: 'ready' as const, value, writable: true, revision: 1 }
    const republish = (): void => {
        snapshot = { status: 'ready', value, writable: true, revision: snapshot.revision + 1 }
        for (const listener of listeners) listener()
    }
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        mutate: async (ops: readonly SettingsPathOp[]) => {
            const next: ProviderSections = { ...value }
            for (const op of ops) {
                const section = { ...(next[op.path[0]!] ?? {}) } as Record<string, unknown>
                if (op.op === 'set') section[op.path[1]!] = op.value
                else delete section[op.path[1]!]
                next[op.path[0]!] = section as ProviderSections[string]
            }
            value = next
            republish()
        },
    }
}

/**
 * A client context with the three services this face reads: locale, the scoped
 * Remote carrier, and nothing else.
 */
function fakeContext(): ClientContext {
    const injected = {
        remote: {
            llm: {
                discoverModels: async () => ({ ok: true, value: [{ id: 'live-model', name: 'Live Model', contextWindow: 1000, maxTokens: 100 }] }),
            },
            credentials: {
                describe: async () => ({ ok: true, value: {} }),
                set: async () => ({ ok: true }),
            },
        },
    }
    return {
        locale: { bind: () => (key: string) => key },
        inject: (_names: unknown, callback: (host: unknown) => unknown) => {
            callback(injected)
            return { dispose: () => {} }
        },
    } as unknown as ClientContext
}

/** Answer the quota route with one window. */
function stubQuotaFetch(): void {
    vi.stubGlobal('fetch', async (input: string | URL) => {
        if (!String(input).startsWith(QUOTA_ROUTE_PATH)) return new Response('{}', { status: 404 })
        return new Response(
            JSON.stringify({ route: ROUTE, windows: [{ id: 'rolling', label: '5-hour', percentUsed: 3, percentRemaining: 97, status: 'ok' }], fetchedAt: 5 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        )
    })
}

afterEach(() => {
    vi.unstubAllGlobals()
})

/**
 * Let the controller's promise chain settle.
 *
 * A plain macrotask drain rather than `vi.waitFor`: the reads here resolve in a
 * microtask, and waiting on a poller would test the poller.
 */
async function settle(): Promise<void> {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function face() {
    stubQuotaFetch()
    const scope = fakeScope()
    const section = createSectionFace(fakeContext(), scope as unknown as SettingsScope<ProviderSections>, [ROUTE])
    return { section, scope }
}

/** The panel state the section currently renders. */
function rendered(section: ReturnType<typeof face>['section']) {
    return section.hooks.providers.getSnapshot().providers[0]!.card
}

describe('the section face', () => {
    it('renders one panel per served route', () => {
        const { section } = face()
        expect(section.hooks.providers.getSnapshot().providers.map((entry) => entry.route)).toEqual([ROUTE])
        expect(section.byRoute[ROUTE]).toBeDefined()
    })

    it('starts idle, before anything is read', () => {
        const { section } = face()
        expect(rendered(section).catalog.state).toBe('idle')
        expect(rendered(section).quota.state).toBe('idle')
    })

    it('shows the catalog that the actions read, not an orphan', async () => {
        const { section } = face()
        section.byRoute[ROUTE]!.refresh()
        await settle()
        expect(rendered(section).catalog.state).toBe('ready')
        expect(rendered(section).models.map((row) => row.id)).toEqual(['live-model'])
    })

    it('shows the allowance that the actions read, not an orphan', async () => {
        const { section } = face()
        section.byRoute[ROUTE]!.refreshQuota()
        await settle()
        expect(rendered(section).quota.state).toBe('ready')
        const quota = rendered(section).quota
        expect(quota.state === 'ready' && quota.view.windows[0]?.label).toBe('5-hour')
    })

    it('reflects a picker edit in the same snapshot the actions came from', async () => {
        const { section } = face()
        section.byRoute[ROUTE]!.refresh()
        await settle()
        // Nothing pinned means every served model is allowed, so the picker opens
        // with the catalog selected.
        section.byRoute[ROUTE]!.openPicker()
        expect(rendered(section).picker).toMatchObject({ open: true, selected: ['live-model'] })
        section.byRoute[ROUTE]!.clearSelection()
        expect(rendered(section).picker.selected).toEqual([])
        section.byRoute[ROUTE]!.togglePickerModel('live-model')
        expect(rendered(section).picker.selected).toEqual(['live-model'])
    })

    it('keeps the snapshot reference stable between reads, or React loops', () => {
        const { section } = face()
        const first = section.hooks.providers.getSnapshot()
        expect(section.hooks.providers.getSnapshot()).toBe(first)
    })

    it('replaces the snapshot when a panel changes', async () => {
        const { section } = face()
        const first = section.hooks.providers.getSnapshot()
        section.byRoute[ROUTE]!.refresh()
        await settle()
        expect(section.hooks.providers.getSnapshot()).not.toBe(first)
        const second = section.hooks.providers.getSnapshot()
        expect(section.hooks.providers.getSnapshot()).toBe(second)
    })

    it('notifies subscribers when a panel changes', async () => {
        const { section } = face()
        const listener = vi.fn()
        const off = section.hooks.providers.subscribe(listener)
        section.byRoute[ROUTE]!.refresh()
        await settle()
        expect(listener).toHaveBeenCalled()
        off()
    })
})
