/**
 * Both fixtures are trimmed copies of live replies (see the module docs for the
 * verbatim shapes), so these tests assert the contract with the gateway itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchModelIds, fetchQuota, formatQuota, parseModelIds, parseQuota } from '../src/gateway-api.ts'

const modelsReply = () => ({
    object: 'list',
    data: [
        { id: 'deepseek-v4-flash', object: 'model', created: 1791214378, owned_by: 'opencode' },
        { id: 'deepseek-v4.1-flash', object: 'model', created: 1791214378, owned_by: 'opencode' },
    ],
})

const usageReply = () => ({
    usage: {
        rolling: { status: 'ok', percent: 2, resetsAt: '2026-10-05T19:56:40.000Z' },
        weekly: { status: 'ok', percent: 0, resetsAt: '2026-10-12T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 7, resetsAt: '2026-11-01T15:37:28.000Z' },
    },
})

describe('parseModelIds', () => {
    it('reads the standard data array', () => {
        expect(parseModelIds(modelsReply())).toEqual(['deepseek-v4-flash', 'deepseek-v4.1-flash'])
    })

    it('accepts a bare array or bare ids, and drops an unusable id', () => {
        expect(parseModelIds(['a', { id: 'b' }, { id: '' }, { nope: 1 }, 7])).toEqual(['a', 'b'])
    })

    it('de-duplicates, because the same id twice would double a picker row', () => {
        expect(parseModelIds({ data: [{ id: 'a' }, { id: 'a' }] })).toEqual(['a'])
    })

    it('answers an empty list for a malformed reply', () => {
        expect(parseModelIds(undefined)).toEqual([])
        expect(parseModelIds({ object: 'list' })).toEqual([])
    })
})

describe('parseQuota', () => {
    it('reads the three windows the provider reports, 5-hour first', () => {
        const snapshot = parseQuota(usageReply(), 'opencode-go', 1000)
        expect(snapshot.route).toBe('opencode-go')
        expect(snapshot.fetchedAt).toBe(1000)
        expect(snapshot.error).toBeUndefined()
        expect(snapshot.windows.map((window) => window.id)).toEqual(['rolling', 'weekly', 'monthly'])
        expect(snapshot.windows[0]).toEqual({
            id: 'rolling',
            label: '5-hour',
            percentUsed: 2,
            percentRemaining: 98,
            status: 'ok',
            resetsAt: '2026-10-05T19:56:40.000Z',
        })
    })

    it('keeps a window the provider added under its own id', () => {
        const snapshot = parseQuota({ usage: { daily: { status: 'ok', percent: 40 } } }, 'r', 0)
        expect(snapshot.windows[0]).toMatchObject({ id: 'daily', label: 'daily', percentRemaining: 60 })
    })

    it('clamps a nonsense percentage rather than reporting negative headroom', () => {
        expect(parseQuota({ usage: { rolling: { percent: 140 } } }, 'r', 0).windows[0]).toMatchObject({
            percentUsed: 100,
            percentRemaining: 0,
        })
        expect(parseQuota({ usage: { rolling: { percent: -5 } } }, 'r', 0).windows[0]).toMatchObject({
            percentUsed: 0,
            percentRemaining: 100,
        })
    })

    it('skips a window with no percentage and reports why the report is empty', () => {
        const empty = parseQuota({ usage: {} }, 'r', 0)
        expect(empty.windows).toEqual([])
        expect(empty.error).toBeUndefined()
        expect(parseQuota({}, 'r', 0).error).toMatch(/no `usage` object/)
        expect(parseQuota(null, 'r', 0).error).toMatch(/not an object/)
    })
})

describe('fetchModelIds', () => {
    it('reads the gateway list at the configured root', async () => {
        const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(modelsReply()), { status: 200 }))
        const ids = await fetchModelIds({ baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'k', fetch: fetchImpl as unknown as typeof fetch })
        expect(ids).toHaveLength(2)
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://opencode.ai/zen/go/v1/models')
        const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k')
    })

    it('tolerates a trailing slash on the configured root', async () => {
        const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }))
        await fetchModelIds({ baseURL: 'https://x/v1/', fetch: fetchImpl as unknown as typeof fetch })
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://x/v1/models')
    })

    it('answers an empty list for a refusal or a network failure, never throwing', async () => {
        const refused = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('nope', { status: 401 }))
        await expect(fetchModelIds({ baseURL: 'https://x', fetch: refused as unknown as typeof fetch })).resolves.toEqual([])
        const offline = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
            throw new Error('offline')
        })
        await expect(fetchModelIds({ baseURL: 'https://x', fetch: offline as unknown as typeof fetch })).resolves.toEqual([])
    })
})

describe('fetchQuota', () => {
    it('reads the usage report at the configured root', async () => {
        const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(usageReply()), { status: 200 }))
        const snapshot = await fetchQuota({ baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'k', fetch: fetchImpl as unknown as typeof fetch }, 'opencode-go')
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://opencode.ai/zen/go/v1/usage')
        expect(snapshot.windows).toHaveLength(3)
    })

    it('reports a refusal as an explainable empty report', async () => {
        const refused = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('nope', { status: 403 }))
        const snapshot = await fetchQuota({ baseURL: 'https://x', fetch: refused as unknown as typeof fetch }, 'opencode-go')
        expect(snapshot.windows).toEqual([])
        expect(snapshot.error).toBe('usage endpoint answered 403')
    })

    it('reports a network failure as an explainable empty report', async () => {
        const offline = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
            throw new Error('getaddrinfo ENOTFOUND')
        })
        const snapshot = await fetchQuota({ baseURL: 'https://x', fetch: offline as unknown as typeof fetch }, 'opencode-go')
        expect(snapshot.error).toBe('getaddrinfo ENOTFOUND')
    })
})

describe('formatQuota', () => {
    it('leads with what is left, because that is the decision', () => {
        const lines = formatQuota(parseQuota(usageReply(), 'opencode-go', 0))
        expect(lines[0]).toBe('5-hour: 98% left (2% used, resets 2026-10-05T19:56:40.000Z)')
        expect(lines[2]).toMatch(/^monthly: 93% left/)
    })

    it('says why a report is empty instead of printing nothing', () => {
        expect(formatQuota({ route: 'opencode-go', windows: [], fetchedAt: 0 })).toEqual(['No quota reported for opencode-go.'])
        expect(formatQuota({ route: 'r', windows: [], fetchedAt: 0, error: 'usage endpoint answered 500' })).toEqual([
            'No quota reported for r: usage endpoint answered 500',
        ])
    })

    it('flags a window the provider is not reporting as healthy', () => {
        const lines = formatQuota(parseQuota({ usage: { rolling: { status: 'throttled', percent: 99 } } }, 'r', 0))
        expect(lines[0]).toBe('5-hour: 1% left (99% used) [throttled]')
    })
})
