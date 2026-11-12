/**
 * Guarded loopback routes for multi-account sign-in and switching.
 *
 * Reads are `GET /llm-agy/accounts`. Every mutation is a same-origin JSON POST
 * carrying {@link MUTATION_HEADER}; the guard in `route-guard.ts` refuses
 * cross-site and non-loopback requests. No token ever appears in a response.
 *
 * @module @gitawego/dsh-llm-agy/accounts-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AccountList } from './accounts.ts'
import type { AgyQuota } from './quota.ts'
import type { LoginStatus, PendingLogin } from './account-manager.ts'
import { header, isTrustedLocalMutation, isTrustedLocalRequest, readJsonBody, sendJson, type RequestFacts } from './route-guard.ts'

/** Account list path. */
export const AGY_ACCOUNTS_ROUTE_PATH = '/llm-agy/accounts'
/** Switch path. */
export const AGY_ACCOUNT_SWITCH_PATH = '/llm-agy/accounts/switch'
/** One account's direct quota path. */
export const AGY_ACCOUNT_QUOTA_PATH = '/llm-agy/accounts/quota'
/** Start sign-in path. */
export const AGY_ACCOUNT_LOGIN_PATH = '/llm-agy/accounts/login'
/** Sign-in status path. */
export const AGY_ACCOUNT_LOGIN_STATUS_PATH = '/llm-agy/accounts/login/status'
/** Cancel sign-in path. */
export const AGY_ACCOUNT_LOGIN_CANCEL_PATH = '/llm-agy/accounts/login/cancel'

/** What the account routes need. */
export interface AgyAccountRouteDeps {
    list: () => Promise<AccountList>
    accountQuota: (id: string, force: boolean) => Promise<AgyQuota>
    switchTo: (id: string) => Promise<AccountList>
    startLogin: (emailHint?: string) => Promise<PendingLogin>
    loginStatus: (loginId: string) => LoginStatus
    cancelLogin: (loginId: string) => void
}

/** Read the trust facts for one request. */
function factsOf(req: IncomingMessage): RequestFacts {
    return {
        method: req.method,
        host: header(req, 'host'),
        origin: header(req, 'origin'),
        secFetchSite: header(req, 'sec-fetch-site'),
        contentType: header(req, 'content-type'),
        requestHeader: header(req, 'x-dsh-llm-agy'),
    }
}

/** Read a non-empty string field from a JSON object. */
function stringField(body: unknown, name: string): string | undefined {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
    const value = (body as Record<string, unknown>)[name]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Map a manager failure to a useful status without leaking internals. */
function statusOf(message: string): number {
    if (/^unknown Antigravity account/u.test(message)) return 404
    if (/^could not (refresh|write)/u.test(message)) return 502
    if (/already waiting|still waiting/u.test(message)) return 409
    return 400
}

/** Send a thin error body. */
function fail(res: ServerResponse, status: number, error: unknown): void {
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
}

/** Build all five handlers (exported for tests). */
export function createAgyAccountHandlers(deps: AgyAccountRouteDeps) {
    const read = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isTrustedLocalRequest(factsOf(req))) {
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        try {
            sendJson(res, 200, await deps.list())
        } catch (error) {
            fail(res, 502, error)
        }
    }

    const accountQuota = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isTrustedLocalRequest(factsOf(req))) {
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const id = url.searchParams.get('id')?.trim() ?? ''
        if (id.length === 0) {
            sendJson(res, 400, { error: 'id is required' })
            return
        }
        try {
            sendJson(res, 200, await deps.accountQuota(id, url.searchParams.get('refresh') === '1'))
        } catch (error) {
            fail(res, statusOf(error instanceof Error ? error.message : String(error)), error)
        }
    }

    const switchAccount = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isTrustedLocalMutation(factsOf(req))) {
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        let body: unknown
        try {
            body = await readJsonBody(req)
        } catch (error) {
            fail(res, 400, error)
            return
        }
        const id = stringField(body, 'id')
        if (id === undefined) {
            sendJson(res, 400, { error: 'id is required' })
            return
        }
        try {
            sendJson(res, 200, await deps.switchTo(id))
        } catch (error) {
            fail(res, statusOf(error instanceof Error ? error.message : String(error)), error)
        }
    }

    const startLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isTrustedLocalMutation(factsOf(req))) {
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        let body: unknown
        try {
            body = await readJsonBody(req)
        } catch (error) {
            fail(res, 400, error)
            return
        }
        const emailHint = stringField(body, 'email')
        try {
            sendJson(res, 200, await deps.startLogin(emailHint))
        } catch (error) {
            fail(res, statusOf(error instanceof Error ? error.message : String(error)), error)
        }
    }

    const loginStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isTrustedLocalRequest(factsOf(req))) {
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        const loginId = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('loginId')?.trim() ?? ''
        if (loginId.length === 0) {
            sendJson(res, 400, { error: 'loginId is required' })
            return
        }
        sendJson(res, 200, deps.loginStatus(loginId))
    }

    const cancelLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!isTrustedLocalMutation(factsOf(req))) {
            sendJson(res, 403, { error: 'forbidden' })
            return
        }
        let body: unknown
        try {
            body = await readJsonBody(req)
        } catch (error) {
            fail(res, 400, error)
            return
        }
        const loginId = stringField(body, 'loginId')
        if (loginId === undefined) {
            sendJson(res, 400, { error: 'loginId is required' })
            return
        }
        deps.cancelLogin(loginId)
        sendJson(res, 200, { cancelled: true })
    }

    return { read, accountQuota, switchAccount, startLogin, loginStatus, cancelLogin }
}

/** Register all account routes when the composition has a web server. */
export function registerAgyAccountRoutes(ctx: Context, deps: AgyAccountRouteDeps): void {
    const handlers = createAgyAccountHandlers(deps)
    const routes = [
        { path: AGY_ACCOUNTS_ROUTE_PATH, handler: handlers.read },
        { path: AGY_ACCOUNT_QUOTA_PATH, handler: handlers.accountQuota },
        { path: AGY_ACCOUNT_SWITCH_PATH, handler: handlers.switchAccount },
        { path: AGY_ACCOUNT_LOGIN_PATH, handler: handlers.startLogin },
        { path: AGY_ACCOUNT_LOGIN_STATUS_PATH, handler: handlers.loginStatus },
        { path: AGY_ACCOUNT_LOGIN_CANCEL_PATH, handler: handlers.cancelLogin },
    ]
    ctx.inject(['webServer'], (host: Context) => {
        for (const route of routes) {
            host.effect(
                () => host.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
                `llm-agy: ${route.path}`,
            )
        }
    })
}
