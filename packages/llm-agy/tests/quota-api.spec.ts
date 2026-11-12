import { describe, expect, it, vi } from 'vitest'
import { readAccountQuota } from '../src/quota-api.ts'

const DIRECT = {
    groups: [
        {
            displayName: 'Gemini Models',
            buckets: [
                {
                    bucketId: 'gemini-weekly',
                    displayName: 'Weekly Limit Remaining',
                    window: 'weekly',
                    resetTime: '2026-11-15T11:22:35Z',
                    description: 'weekly prose',
                    remainingFraction: 0.94009614,
                },
                {
                    bucketId: 'gemini-5h',
                    displayName: 'Five Hour Limit Remaining',
                    window: '5h',
                    resetTime: '2026-11-12T11:21:07Z',
                    remainingFraction: 1,
                },
            ],
        },
    ],
}

describe('readAccountQuota', () => {
    it('resolves the project and parses the direct camelCase payload', async () => {
        const calls: Array<{ url: string; body: unknown; auth: string | null }> = []
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: headers.get('authorization') })
            if (String(url).endsWith(':loadCodeAssist')) {
                return new Response(JSON.stringify({ cloudaicompanionProject: 'project-1' }), { status: 200 })
            }
            return new Response(JSON.stringify(DIRECT), { status: 200 })
        }) as unknown as typeof fetch
        const quota = await readAccountQuota('access-token', { fetch: fetchImpl, now: () => 123 })
        expect(quota.error).toBeUndefined()
        expect(quota.fetchedAt).toBe(123)
        expect(quota.windows).toHaveLength(2)
        expect(quota.windows[0]).toMatchObject({
            id: 'Gemini Models:gemini-weekly',
            group: 'Gemini Models',
            percentRemaining: 94.01,
            percentUsed: 5.99,
            resetsAt: '2026-11-15T11:22:35Z',
        })
        expect(calls[1]?.body).toEqual({ project: 'project-1' })
        expect(calls[0]?.auth).toBe('Bearer access-token')
    })

    it('tries the fallback endpoint when the first one fails', async () => {
        let quotaCalls = 0
        const fetchImpl = vi.fn(async (url: string | URL | Request) => {
            if (String(url).includes('daily-cloudcode-pa')) return new Response('nope', { status: 503 })
            if (String(url).endsWith(':loadCodeAssist')) {
                return new Response(JSON.stringify({ cloudaicompanionProject: 'project-2' }), { status: 200 })
            }
            quotaCalls += 1
            return new Response(JSON.stringify(DIRECT), { status: 200 })
        }) as unknown as typeof fetch
        const quota = await readAccountQuota('access-token', { fetch: fetchImpl })
        expect(quota.windows).toHaveLength(2)
        expect(quotaCalls).toBe(1)
    })

    it('returns an error body instead of throwing on transport failures', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('network down')
        }) as unknown as typeof fetch
        const quota = await readAccountQuota('access-token', { fetch: fetchImpl })
        expect(quota.windows).toEqual([])
        expect(quota.error).toContain('network down')
    })

    it('refuses an empty token', async () => {
        const quota = await readAccountQuota('   ')
        expect(quota.error).toBe('account has no access token')
    })
})
