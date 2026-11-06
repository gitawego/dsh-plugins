/**
 * The dashboard's client state.
 *
 * Two claims matter here, because both have already broken this card once:
 *
 * 1. the snapshot is a **stable reference** between changes — a snapshot that
 *    rebuilt itself per call re-renders forever (React error #185);
 * 2. the card **cannot** write anything but its own four fields — the route,
 *    the catalog, and the credential are the host adapter's.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createDashboard, parseStatus } from '../src/client/controller.ts'
import type { MonitorProfile } from '../src/config.ts'
import { QUOTA_ROUTE_PATH, STATUS_ROUTE_PATH } from '../src/quota-path.ts'

const PROFILE: MonitorProfile = {
    route: 'opencode-go',
    baseURL: 'https://gw.test/v1',
    apiKeyEnv: 'OPENCODE_GO_CUSTOM_API_KEY',
    refreshMinutes: 15,
}

/** A settings form holding one profile and recording writes. */
function fakeScope(value: Partial<MonitorProfile> = {}): ConfigForm<MonitorProfile> & { writes: unknown[] } {
    const writes: unknown[] = []
    let current = { ...PROFILE, ...value } as MonitorProfile
    const listeners = new Set<() => void>()
    const snapshot = (): ReturnType<ConfigForm<MonitorProfile>['getSnapshot']> => ({
        status: 'ready',
        value: current,
        base: PROFILE,
        user: current,
        revision: 1,
        writable: true,
    })
    return {
        writes,
        getSnapshot: snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        set: async (field: keyof MonitorProfile, next: unknown) => {
            writes.push({ set: field, next })
            current = { ...current, [field]: next } as MonitorProfile
            for (const listener of listeners) listener()
            return true
        },
        unset: async (field: keyof MonitorProfile) => {
            writes.push({ unset: field })
            current = { ...current, [field]: PROFILE[field as keyof MonitorProfile] } as MonitorProfile
            for (const listener of listeners) listener()
            return true
        },
        mutate: async () => true,
    } as unknown as ConfigForm<MonitorProfile> & { writes: unknown[] }
}

/** A client context with only `effect` (the refresher's disposer). */
function fakeContext(): ClientContext {
    return { effect: () => () => {} } as unknown as ClientContext
}

/** One gateway status reply. */
const STATUS_REPLY = {
    route: 'opencode-go',
    endpoint: 'https://gw.test/v1',
    credential: 'OPENCODE_GO_CUSTOM_API_KEY',
    credentialPresent: true,
    servedCount: 2,
    knownCount: 1,
    unknownIds: ['deepseek-v4.1-flash'],
    fetchedAt: 1_700_000_000_000,
    models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', known: true, live: true, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], reasoning: true },
        { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', known: false, live: true },
    ],
}

/** One quota reply. */
const QUOTA_REPLY = {
    route: 'opencode-go',
    fetchedAt: 1_700_000_000_000,
    windows: [{ id: 'rolling', label: '5-hour', percentUsed: 12, percentRemaining: 88, status: 'ok' }],
}

/** A fetch that answers both guarded routes. */
function stubFetch(options: { status?: unknown; quota?: unknown; statusCode?: number } = {}): { calls: string[] } {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
        const url = String(input)
        calls.push(url)
        if (url.startsWith(STATUS_ROUTE_PATH)) {
            const code = options.statusCode ?? 200
            return new Response(JSON.stringify(options.status ?? STATUS_REPLY), { status: code })
        }
        return new Response(JSON.stringify(options.quota ?? QUOTA_REPLY), { status: 200 })
    })
    return { calls }
}

/** Resolve pending microtasks and the two fetches. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('parsing a status reply', () => {
    it('reads rows, counts, and the unknown list', () => {
        const parsed = parseStatus(STATUS_REPLY, PROFILE)
        expect(parsed.route).toBe('opencode-go')
        expect(parsed.servedCount).toBe(2)
        expect(parsed.models.map((row) => row.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4.1-flash'])
        expect(parsed.unknownIds).toEqual(['deepseek-v4.1-flash'])
        expect(parsed.credentialPresent).toBe(true)
    })

    it('fills gaps from the profile instead of throwing on a partial document', () => {
        const parsed = parseStatus({ models: [{ id: 'alpha' }, { name: 'no id' }, 'nope'] }, PROFILE)
        expect(parsed.models.map((row) => row.id)).toEqual(['alpha'])
        expect(parsed.route).toBe('opencode-go')
        expect(parsed.endpoint).toBe('https://gw.test/v1')
    })

    it('keeps only known modalities', () => {
        const parsed = parseStatus({ models: [{ id: 'alpha', input: ['text', 'audio', 'image'] }] }, PROFILE)
        expect(parsed.models[0]?.input).toEqual(['text', 'image'])
    })

    it('survives a reply that is not an object', () => {
        expect(parseStatus(null, PROFILE).models).toEqual([])
    })
})

describe('the dashboard', () => {
    it('starts from the settings profile', () => {
        stubFetch()
        const dashboard = createDashboard(fakeContext(), fakeScope())
        expect(dashboard.getSnapshot().route).toBe('opencode-go')
        expect(dashboard.getSnapshot().status).toBe('ready')
    })

    it('reads status and allowance from the guarded routes', async () => {
        const { calls } = stubFetch()
        const dashboard = createDashboard(fakeContext(), fakeScope())
        await settle()
        expect(calls.some((url) => url.startsWith(STATUS_ROUTE_PATH))).toBe(true)
        expect(calls.some((url) => url.startsWith(`${QUOTA_ROUTE_PATH}?route=opencode-go`))).toBe(true)
        expect(dashboard.getSnapshot().quota.windows).toHaveLength(1)
    })

    it('returns the SAME snapshot object between changes', async () => {
        stubFetch()
        const dashboard = createDashboard(fakeContext(), fakeScope())
        await settle()
        const first = dashboard.getSnapshot()
        expect(dashboard.getSnapshot()).toBe(first)
    })

    it('replaces the snapshot after a read', async () => {
        stubFetch()
        const dashboard = createDashboard(fakeContext(), fakeScope())
        await settle()
        const first = dashboard.getSnapshot()
        dashboard.actions.refresh()
        await settle()
        expect(dashboard.getSnapshot()).not.toBe(first)
        expect(dashboard.getSnapshot().servedCount).toBe(2)
    })

    it('reports a refused read without dropping the previous state', async () => {
        stubFetch({ statusCode: 403 })
        const dashboard = createDashboard(fakeContext(), fakeScope())
        await settle()
        const snapshot = dashboard.getSnapshot()
        expect(snapshot.error).toBe('status read refused (403)')
        expect(snapshot.route).toBe('opencode-go')
    })

    it('writes only profile fields, through the shared form', async () => {
        stubFetch()
        const scope = fakeScope()
        const dashboard = createDashboard(fakeContext(), scope)
        dashboard.actions.edit('route', 'other-route')
        dashboard.actions.edit('baseURL', 'https://gw.test/v2')
        dashboard.actions.clear('apiKeyEnv')
        await settle()
        expect(scope.writes).toEqual([
            { set: 'route', next: 'other-route' },
            { set: 'baseURL', next: 'https://gw.test/v2' },
            { unset: 'apiKeyEnv' },
        ])
    })

    it('asks the new route after a settings change', async () => {
        const { calls } = stubFetch()
        const dashboard = createDashboard(fakeContext(), fakeScope())
        await settle()
        calls.length = 0
        dashboard.actions.edit('route', 'other-route')
        await settle()
        expect(calls.some((url) => url.includes('route=other-route'))).toBe(true)
        expect(dashboard.getSnapshot().route).toBe('other-route')
    })

    it('stops publishing after its fiber is disposed', async () => {
        stubFetch()
        const listeners: (() => void)[] = []
        const dashboard = createDashboard(fakeContext(), fakeScope())
        dashboard.subscribe(() => listeners.push(() => {}))
        await settle()
        dashboard.subscribe(() => {})
        expect(dashboard.getSnapshot().servedCount).toBe(2)
    })
})
