import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { parseAgyUsage, type AgyQuota } from '../src/quota.ts'
import { createAgyQuotaHandler, isTrustedLocalRequest } from '../src/quota-route.ts'

const USAGE = JSON.stringify({
    status: 'SUCCESS',
    command: {
        name: 'usage',
        data: {
            groups: [
                {
                    name: 'Gemini Models',
                    buckets: [
                        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9400961399078369, reset_time: '2026-11-15T11:22:35Z', description: 'weekly prose' },
                        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.9938779473304749, reset_time: '2026-11-12T00:14:12Z' },
                    ],
                },
                {
                    name: 'Claude and GPT models',
                    buckets: [
                        { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-18T22:41:59Z' },
                    ],
                },
            ],
        },
    },
})

describe('parseAgyUsage', () => {
    it('reads groups and measured buckets', () => {
        const quota = parseAgyUsage(USAGE, 123)
        expect(quota.error).toBeUndefined()
        expect(quota.fetchedAt).toBe(123)
        expect(quota.windows).toEqual([
            {
                id: 'Gemini Models:gemini-weekly',
                group: 'Gemini Models',
                label: 'Weekly Limit Remaining',
                window: 'weekly',
                percentRemaining: 94.01,
                percentUsed: 5.99,
                resetsAt: '2026-11-15T11:22:35Z',
                description: 'weekly prose',
                status: 'ok',
            },
            {
                id: 'Gemini Models:gemini-5h',
                group: 'Gemini Models',
                label: 'Five Hour Limit Remaining',
                window: '5h',
                percentRemaining: 99.39,
                percentUsed: 0.61,
                resetsAt: '2026-11-12T00:14:12Z',
                status: 'ok',
            },
            {
                id: 'Claude and GPT models:3p-weekly',
                group: 'Claude and GPT models',
                label: 'Weekly Limit Remaining',
                window: 'weekly',
                percentRemaining: 100,
                percentUsed: 0,
                resetsAt: '2026-11-18T22:41:59Z',
                status: 'ok',
            },
        ])
    })

    it('marks an exhausted bucket and clamps fractions', () => {
        const quota = parseAgyUsage(JSON.stringify({
            status: 'SUCCESS',
            command: { data: { groups: [{ name: 'Gemini', buckets: [{ id: 'x', name: 'Limit', window: '5h', remaining_fraction: -0.2 }] }] } },
        }))
        expect(quota.windows[0]).toMatchObject({ percentRemaining: 0, percentUsed: 100, status: 'exhausted' })
    })

    it('reports invalid JSON, failed status, and an empty report', () => {
        expect(parseAgyUsage('not json').error).toContain('invalid JSON')
        expect(parseAgyUsage(JSON.stringify({ status: 'FAILED' })).error).toContain('FAILED')
        expect(parseAgyUsage(JSON.stringify({ status: 'SUCCESS', command: { data: { groups: [] } } })).error).toContain('no quota groups')
    })
})

describe('quota route trust', () => {
    it('accepts a same-origin loopback GET', () => {
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', secFetchSite: 'same-origin' })).toBe(true)
        expect(isTrustedLocalRequest({ method: 'GET', host: 'localhost:3080' })).toBe(true)
    })

    it('refuses non-loopback, cross-site, and wrong-origin requests', () => {
        expect(isTrustedLocalRequest({ method: 'POST', host: '127.0.0.1:3080' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: 'example.com' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', secFetchSite: 'cross-site' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })).toBe(false)
    })
})

/** A minimal request. */
function request(over: { method?: string; url?: string; headers?: Record<string, string> } = {}): IncomingMessage {
    return {
        method: over.method ?? 'GET',
        url: over.url ?? '/llm-agy/quota',
        headers: over.headers ?? { host: '127.0.0.1:3080' },
    } as unknown as IncomingMessage
}

/** A response that records what the handler wrote. */
function response() {
    const written: { status?: number; headers?: unknown; body?: string } = {}
    return {
        written,
        res: {
            writeHead: (status: number, headers: unknown) => {
                written.status = status
                written.headers = headers
            },
            end: (body: string) => {
                written.body = body
            },
        } as unknown as ServerResponse,
    }
}

const QUOTA: AgyQuota = { windows: [], fetchedAt: 1 }

describe('createAgyQuotaHandler', () => {
    it('serves the cached read and marks it uncacheable', async () => {
        const quotaOf = vi.fn(async () => QUOTA)
        const { res, written } = response()
        await createAgyQuotaHandler({ quotaOf })(request(), res)
        expect(written.status).toBe(200)
        expect((written.headers as Record<string, string>)['cache-control']).toBe('no-store')
        expect(JSON.parse(written.body ?? '{}')).toEqual(QUOTA)
        expect(quotaOf).toHaveBeenCalledWith(false)
    })

    it('passes refresh=1 through as a forced read', async () => {
        const quotaOf = vi.fn(async () => QUOTA)
        const { res } = response()
        await createAgyQuotaHandler({ quotaOf })(request({ url: '/llm-agy/quota?refresh=1' }), res)
        expect(quotaOf).toHaveBeenCalledWith(true)
    })

    it('refuses an untrusted request without reading quota', async () => {
        const quotaOf = vi.fn(async () => QUOTA)
        const { res, written } = response()
        await createAgyQuotaHandler({ quotaOf })(request({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), res)
        expect(written.status).toBe(403)
        expect(quotaOf).not.toHaveBeenCalled()
    })

    it('answers a failed read as JSON with status 502', async () => {
        const { res, written } = response()
        await createAgyQuotaHandler({
            quotaOf: async () => {
                throw new Error('agy missing')
            },
        })(request(), res)
        expect(written.status).toBe(502)
        expect(JSON.parse(written.body ?? '{}')).toMatchObject({ error: 'agy missing', windows: [] })
    })
})
