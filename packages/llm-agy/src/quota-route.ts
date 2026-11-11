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
import { header, isTrustedLocalRequest, sendJson, type RequestFacts } from './route-guard.ts'
import type { AgyQuota } from './quota.ts'

/** Path the settings card reads. */
export const AGY_QUOTA_ROUTE_PATH = '/llm-agy/quota'

export { isTrustedLocalRequest, type RequestFacts } from './route-guard.ts'

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
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        const force = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('refresh') === '1'
        try {
            sendJson(res, 200, await deps.quotaOf(force))
        } catch (error) {
            sendJson(res, 502, {
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
