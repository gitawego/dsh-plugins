/**
 * The section's injected face.
 *
 * A slot component gets exactly one injected hook, so the face is the whole
 * contract between the registration and the panel: one snapshot hook, one
 * translator bound to this plugin's namespace, and one set of actions.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MonitorProfile } from '../src/config.ts'
import { createSectionFace, NS } from '../src/client/section-face.ts'
import { QUOTA_ROUTE_PATH, STATUS_ROUTE_PATH } from '../src/quota-path.ts'

const PROFILE: MonitorProfile = {
    route: 'opencode-go',
    baseURL: 'https://gw.test/v1',
    apiKeyEnv: 'OPENCODE_GO_CUSTOM_API_KEY',
    refreshMinutes: 15,
}

/** A settings form holding one profile. */
function fakeScope(): ConfigForm<MonitorProfile> {
    return {
        getSnapshot: () => ({ status: 'ready', value: PROFILE, base: PROFILE, user: PROFILE, revision: 1, writable: true }),
        subscribe: () => () => {},
        set: async () => true,
        unset: async () => true,
        mutate: async () => true,
    } as unknown as ConfigForm<MonitorProfile>
}

/** A client context answering the two services the face reads. */
function fakeContext(): ClientContext {
    return {
        locale: { bind: () => (key: string) => key },
        effect: () => () => {},
    } as unknown as ClientContext
}

/** Answer both guarded routes. */
function stubFetch(): void {
    vi.stubGlobal('fetch', async (input: string | URL) => {
        const url = String(input)
        if (url.startsWith(STATUS_ROUTE_PATH)) {
            return new Response(JSON.stringify({ route: 'opencode-go', models: [{ id: 'alpha', known: true, live: true }], servedCount: 1, knownCount: 1, unknownIds: [], fetchedAt: 1 }), { status: 200 })
        }
        expect(url.startsWith(QUOTA_ROUTE_PATH)).toBe(true)
        return new Response(JSON.stringify({ route: 'opencode-go', windows: [] }), { status: 200 })
    })
}

describe('the section face', () => {
    it('owns the llm-provider namespace', () => {
        expect(NS).toBe('llm-provider')
    })

    it('binds the translator to that namespace', () => {
        stubFetch()
        const bind = vi.fn(() => (key: string) => key)
        const face = createSectionFace({ ...fakeContext(), locale: { bind } } as unknown as ClientContext, fakeScope())
        expect(bind).toHaveBeenCalledWith(NS)
        expect(face.t('sectionNav')).toBe('sectionNav')
    })

    it('exposes one snapshot hook and the two actions', () => {
        stubFetch()
        const face = createSectionFace(fakeContext(), fakeScope())
        expect(typeof face.hooks.dashboard.getSnapshot).toBe('function')
        expect(typeof face.hooks.dashboard.subscribe).toBe('function')
        expect(Object.keys(face.actions).sort()).toEqual(['clear', 'edit', 'refresh'])
    })

    it('answers a snapshot that already carries the profile', () => {
        stubFetch()
        const face = createSectionFace(fakeContext(), fakeScope())
        const snapshot = face.hooks.dashboard.getSnapshot()
        expect(snapshot.route).toBe('opencode-go')
        expect(snapshot.endpoint).toBe('https://gw.test/v1')
        expect(snapshot.credential).toBe('OPENCODE_GO_CUSTOM_API_KEY')
    })

    it('keeps the snapshot identity stable across reads', () => {
        stubFetch()
        const face = createSectionFace(fakeContext(), fakeScope())
        expect(face.hooks.dashboard.getSnapshot()).toBe(face.hooks.dashboard.getSnapshot())
    })
})
