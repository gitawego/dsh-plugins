/**
 * The quota read path for the browser.
 *
 * Every other piece of client-facing state in this plugin travels a seam: the
 * profile over the settings namespace, the catalog over `remote.llm`. Allowance
 * has neither. The llm Remote namespace exposes exactly `listProviders`,
 * `listConfigurableProviders`, and `discoverModels`; forwarded events are a
 * host-owned allowlist (`API_REMOTE_FORWARDED_EVENTS`) a plugin cannot extend;
 * and a provider's usage endpoint is not reachable from a browser (no key, no
 * CORS). So the choice is a plugin route or no quota in the UI.
 *
 * The route is a *read* of aggregate percentages and nothing else — no key
 * material, no prompt content, no session data — and it is guarded the way the
 * host guards its own `/api` bridge:
 *
 * - `GET` only;
 * - the `Host` header must be loopback;
 * - `Sec-Fetch-Site: cross-site` is refused, and an `Origin` that disagrees with
 *   `Host` is refused. Browsers set both and scripts cannot forge them, so a
 *   page on another origin cannot read this endpoint.
 *
 * It does spend the stored credential, on one cheap request per read, which is
 * why the card refreshes it on demand rather than on a timer.
 *
 * @module @gitawego/dsh-llm-provider/quota-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { QuotaSnapshot } from './gateway-api.ts'
import { QUOTA_ROUTE_PATH } from './quota-path.ts'

export { QUOTA_ROUTE_PATH } from './quota-path.ts'

/** The request facts the trust decision reads. */
export interface RequestFacts {
    /** HTTP method. */
    method?: string | undefined
    /** `Host` header. */
    host?: string | undefined
    /** `Origin` header, when the browser sent one. */
    origin?: string | undefined
    /** `Sec-Fetch-Site` header, when the browser sent one. */
    secFetchSite?: string | undefined
}

/** Whether a hostname is a loopback address. */
function isLoopback(hostname: string): boolean {
    const bare = hostname.startsWith('[') ? hostname.slice(1, hostname.indexOf(']')) : hostname
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1' || bare === '0.0.0.0'
}

/**
 * Decide whether one request may read quota.
 *
 * Mirrors the host's own `/api` bridge check: same-origin, loopback, browser
 * markers consistent. A refusal is a 403 with no detail, because the response
 * is not a debugging surface.
 * @param facts - method and the three headers the decision reads.
 * @returns true when the request may proceed.
 */
export function isTrustedLocalRequest(facts: RequestFacts): boolean {
    if (facts.method !== 'GET') return false
    const host = facts.host
    if (host === undefined || host.length === 0) return false
    let authority: URL
    try {
        authority = new URL(`http://${host}`)
    } catch {
        return false
    }
    if (!isLoopback(authority.hostname)) return false
    if (facts.secFetchSite === 'cross-site') return false
    if (facts.origin === undefined) return true
    try {
        // Ports must match too: `localhost:3080` and `localhost:9999` are
        // different origins, and the webserver is reachable on both.
        return new URL(facts.origin).host === authority.host
    } catch {
        return false
    }
}

/** The payload the card parses; the same shape the tool's meta carries. */
export interface QuotaRoutePayload {
    route: string
    windows: QuotaSnapshot['windows']
    fetchedAt: number
    error?: string
}

/**
 * Shape one report for the wire.
 * @param snapshot - the fetched report.
 * @returns the payload, with `error` present only when there is one.
 */
export function quotaPayload(snapshot: QuotaSnapshot): QuotaRoutePayload {
    return {
        route: snapshot.route,
        windows: snapshot.windows,
        fetchedAt: snapshot.fetchedAt,
        ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    }
}

/** Everything the route needs. */
export interface QuotaRouteDeps {
    /** Routes this build serves. */
    routes: readonly string[]
    /** Read one route's quota through the credential seam. */
    quotaOf: (route: string) => Promise<QuotaSnapshot>
}

/** Read one header from a node request. */
function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
}

/** Write one JSON response and end it. */
function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        // A quota read is a live measurement; a cached one is a wrong one.
        'cache-control': 'no-store',
    })
    res.end(text)
}

/**
 * Build the route handler.
 *
 * Exported over explicit dependencies so the handler is testable without a
 * server, a socket, or a credential.
 * @param deps - served routes and the quota reader.
 * @returns the handler for {@link QUOTA_ROUTE_PATH}.
 */
export function createQuotaHandler(deps: QuotaRouteDeps) {
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
        const requested = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('route')
        const route = requested !== null && deps.routes.includes(requested) ? requested : undefined
        if (route === undefined) {
            send(res, 400, { error: `unknown route; served: ${deps.routes.join(', ')}` })
            return
        }
        try {
            send(res, 200, quotaPayload(await deps.quotaOf(route)))
        } catch (error) {
            send(res, 502, { route, windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) })
        }
    }
}

/**
 * Register the quota route when this deployment has a web server.
 *
 * Optional on purpose: a composition without a webserver (an Electron or
 * headless profile) has no browser to serve, and the plugin must keep working
 * there.
 * @param ctx - the plugin's context.
 * @param deps - served routes and the quota reader.
 */
export function registerQuotaRoute(ctx: Context, deps: QuotaRouteDeps): void {
    // `ctx.inject` both waits for the service and hands back a context that
    // DECLARES it, which is what makes `host.webServer` readable: cordis guards
    // the property form (`cannot get property "webServer" without inject`) while
    // `ctx.get(name)` is an unguarded probe. Probing with one and reading with
    // the other is how this crashed the boot — the service existed, the
    // declaration did not.
    ctx.inject(['webServer'], (host: Context) => {
        host.effect(
            () => host.webServer.register({ kind: 'exact', path: QUOTA_ROUTE_PATH, handler: createQuotaHandler(deps) }),
            'llm-provider: quota route',
        )
    })
}
