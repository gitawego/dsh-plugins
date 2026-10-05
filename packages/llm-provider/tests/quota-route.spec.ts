/**
 * The quota route is the one place this plugin answers an HTTP request, so its
 * guard is tested as carefully as its payload: it spends the stored credential,
 * and it must be readable only from the machine's own browser.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { QUOTA_ROUTE_PATH, createQuotaHandler, isTrustedLocalRequest, quotaPayload, registerQuotaRoute } from '../src/quota-route.ts'
import { parseQuotaView } from '../src/client/quota-format.ts'
import { parseQuota } from '../src/gateway-api.ts'

/** A minimal request. */
function request(over: { method?: string; url?: string; headers?: Record<string, string> } = {}): IncomingMessage {
    return {
        method: over.method ?? 'GET',
        url: over.url ?? '/llm-provider/quota?route=opencode-go-session',
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

const snapshot = parseQuota(
    { usage: { rolling: { status: 'ok', percent: 3, resetsAt: '2026-10-05T19:56:40.000Z' }, monthly: { status: 'ok', percent: 82 } } },
    'opencode-go-session',
    1_791_212_000_000,
)

describe('isTrustedLocalRequest', () => {
    it('accepts a same-origin loopback read', () => {
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080' })).toBe(true)
        expect(isTrustedLocalRequest({ method: 'GET', host: 'localhost:3080', origin: 'http://localhost:3080', secFetchSite: 'same-origin' })).toBe(true)
        expect(isTrustedLocalRequest({ method: 'GET', host: '[::1]:3080' })).toBe(true)
    })

    it('refuses a request from another origin, whatever the host header says', () => {
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', secFetchSite: 'cross-site' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', origin: 'https://evil.example' })).toBe(false)
        // A different port on the same host is a different origin.
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })).toBe(false)
    })

    it('refuses a non-loopback authority, so a deployment bound to 0.0.0.0 does not expose it', () => {
        expect(isTrustedLocalRequest({ method: 'GET', host: '192.168.1.10:3080' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: 'dsh.example.com' })).toBe(false)
    })

    it('refuses anything but a read, and a request with no usable host', () => {
        expect(isTrustedLocalRequest({ method: 'POST', host: '127.0.0.1:3080' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: '' })).toBe(false)
        expect(isTrustedLocalRequest({ method: 'GET', host: 'not a host' })).toBe(false)
    })

    it('refuses a malformed origin rather than treating it as absent', () => {
        expect(isTrustedLocalRequest({ method: 'GET', host: '127.0.0.1:3080', origin: 'nonsense' })).toBe(false)
    })
})

describe('quotaPayload', () => {
    it('carries the windows and nothing else', () => {
        const payload = quotaPayload(snapshot)
        expect(Object.keys(payload).sort()).toEqual(['fetchedAt', 'route', 'windows'])
        expect(payload.windows.map((window) => window.label)).toEqual(['5-hour', 'monthly'])
    })

    it('carries the failure reason when the read failed', () => {
        expect(quotaPayload({ route: 'r', windows: [], fetchedAt: 0, error: 'usage endpoint answered 429' }).error).toBe('usage endpoint answered 429')
    })

    it('parses with the same function the tool card uses', () => {
        const view = parseQuotaView(quotaPayload(snapshot))
        expect(view?.windows.map((window) => window.tone)).toEqual(['ok', 'warn'])
    })
})

describe('registration', () => {
    /**
     * A context that behaves like cordis: `get` probes without declaring, while
     * reading the service as a property throws unless the context declared it.
     * That asymmetry is what crashed the boot, so it is what this double
     * reproduces.
     */
    function contexts() {
        const registered: { kind?: string; path?: string }[] = []
        const deps: unknown[] = []
        const inner = {
            effect: (fn: () => unknown) => { fn(); return () => {} },
            get webServer() {
                return { register: (route: { kind?: string; path?: string }) => { registered.push(route); return () => {} } }
            },
        }
        const outer = {
            get: () => ({}),
            get webServer(): never {
                throw new Error('cannot get property "webServer" without inject')
            },
            inject: (names: unknown[], callback: (host: unknown) => unknown) => {
                deps.push(names)
                callback(inner)
                return { dispose: () => {} }
            },
        }
        return { outer, inner, registered, deps }
    }

    it('registers through an injected fiber, never through the property form', () => {
        const { outer, registered, deps } = contexts()
        registerQuotaRoute(outer as never, { routes: ['opencode-go-session'], quotaOf: async () => snapshot })
        expect(deps).toEqual([['webServer']])
        expect(registered).toMatchObject([{ kind: 'exact', path: QUOTA_ROUTE_PATH }])
    })

    it('does not require the service to exist up front, so a profile without a webserver still loads', () => {
        // `ctx.inject` simply never runs the callback; nothing else in apply
        // depends on the route.
        const { outer, registered } = contexts()
        expect(() => registerQuotaRoute(outer as never, { routes: [], quotaOf: async () => snapshot })).not.toThrow()
        expect(registered).toHaveLength(1)
    })
})

describe('the handler', () => {
    const deps = { routes: ['opencode-go-session'], quotaOf: async () => snapshot }

    it('answers the report for a served route', async () => {
        const { res, written } = response()
        await createQuotaHandler(deps)(request(), res)
        expect(written.status).toBe(200)
        expect((written.headers as Record<string, string>)['cache-control']).toBe('no-store')
        const view = parseQuotaView(JSON.parse(written.body ?? '{}'))
        expect(view?.windows[0]?.label).toBe('5-hour')
    })

    it('refuses an untrusted request without reading quota', async () => {
        const quotaOf = vi.fn(async () => snapshot)
        const { res, written } = response()
        await createQuotaHandler({ ...deps, quotaOf })(request({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), res)
        expect(written.status).toBe(403)
        expect(quotaOf).not.toHaveBeenCalled()
    })

    it('refuses a route it does not serve, naming the ones it does', async () => {
        const { res, written } = response()
        await createQuotaHandler(deps)(request({ url: '/llm-provider/quota?route=nope' }), res)
        expect(written.status).toBe(400)
        expect(written.body).toMatch(/unknown route; served: opencode-go-session/)
    })

    it('answers a provider failure as an explainable report, not a crash', async () => {
        const { res, written } = response()
        await createQuotaHandler({ ...deps, quotaOf: async () => { throw new Error('credential missing') } })(request(), res)
        expect(written.status).toBe(502)
        expect(JSON.parse(written.body ?? '{}')).toMatchObject({ error: 'credential missing', windows: [] })
    })
})
