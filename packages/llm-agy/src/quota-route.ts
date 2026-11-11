/**
 * Guarded loopback route for the Antigravity quota card.
 *
 * The quota comes from a local CLI process, which a browser cannot spawn; the
 * route exposes only aggregate percentages and reset times. It follows the host
 * `/api` trust rules: GET only, loopback Host, no cross-site fetch, and an
 * Origin that agrees with Host.
 *
 * @module @gitawego/dsh-llm-agy/quota-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AgyQuota } from './quota.ts'

/** Path the settings card reads. */
export const AGY_QUOTA_ROUTE_PATH = '/llm-agy/quota'

/** Request facts used by the trust decision. */
export interface RequestFacts {
    method?: string | undefined
    host?: string | undefined
    origin?: string | undefined
    secFetchSite?: string | undefined
}

function isLoopback(hostname: string): boolean {
    const bare = hostname.startsWith('[') ? hostname.slice(1, hostname.indexOf(']')) : hostname
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1' || bare === '0.0.0.0'
}

/** Whether one request may read the quota. */
export function isTrustedLocalRequest(facts: RequestFacts): boolean {
    if (facts.method !== 'GET') return false
    if (facts.host === undefined || facts.host.length === 0) return false
    let authority: URL
    try {
        authority = new URL(`http://${facts.host}`)
    } catch {
        return false
    }
    if (!isLoopback(authority.hostname)) return false
    if (facts.secFetchSite === 'cross-site') return false
    if (facts.origin === undefined) return true
    try {
        return new URL(facts.origin).host === authority.host
    } catch {
        return false
    }
}

function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
}

function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
    })
    res.end(text)
}

/** What the route needs. */
export interface AgyQuotaRouteDeps {
    quotaOf: (force: boolean) => Promise<AgyQuota>
}

/** Build the route handler (exported for tests). */
export function createAgyQuotaHandler(deps: AgyQuotaRouteDeps) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const facts: RequestFacts = {
            method: req.method,
            host: header(req, 'host'),
            origin: header(req, 'origin'),
            secFetchSite: header(req, 'sec-fetch-site'),
        }
        if (!isTrustedLocalRequest(facts)) {
            send(res, 403, { error: 'forbidden' })
            return
        }
        const force = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('refresh') === '1'
        try {
            send(res, 200, await deps.quotaOf(force))
        } catch (error) {
            send(res, 502, {
                windows: [],
                fetchedAt: Date.now(),
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

/** Register the route when the composition has a web server. */
export function registerAgyQuotaRoute(ctx: Context, deps: AgyQuotaRouteDeps): void {
    ctx.inject(['webServer'], (host: Context) => {
        host.effect(
            () => host.webServer.register({
                kind: 'exact',
                path: AGY_QUOTA_ROUTE_PATH,
                handler: createAgyQuotaHandler(deps),
            }),
            'llm-agy: quota route',
        )
    })
}
