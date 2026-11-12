import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAgyAccountHandlers, type AgyAccountRouteDeps } from '../src/accounts-route.ts'
import type { AccountList } from '../src/accounts.ts'

function request(over: { method?: string; url?: string; headers?: Record<string, string> } = {}, body?: unknown): IncomingMessage {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    return Object.assign(stream, {
        method: over.method ?? 'GET',
        url: over.url ?? '/llm-agy/accounts',
        headers: over.headers ?? { host: '127.0.0.1:3080' },
    }) as unknown as IncomingMessage
}

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

const MUTATION = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'content-type': 'application/json',
    'x-dsh-llm-agy': '1',
}

const LIST: AccountList = {
    activeEmail: 'a@example.com',
    accounts: [{ id: 'a@example.com', identity: 'a@example.com', source: 'keyring', active: true }],
}

function deps(overrides: Partial<AgyAccountRouteDeps> = {}): AgyAccountRouteDeps {
    return {
        list: async () => LIST,
        accountQuota: async () => ({ windows: [], fetchedAt: 1 }),
        switchTo: async () => LIST,
        startLogin: async () => ({ loginId: 'login-1', url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake' }),
        loginStatus: () => ({ status: 'pending' }),
        cancelLogin: () => {},
        ...overrides,
    }
}

describe('account routes', () => {
    it('serves the account list and marks it uncacheable', async () => {
        const handlers = createAgyAccountHandlers(deps())
        const { res, written } = response()
        await handlers.read(request(), res)
        expect(written.status).toBe(200)
        expect((written.headers as Record<string, string>)['cache-control']).toBe('no-store')
        expect(JSON.parse(written.body ?? '{}')).toEqual(LIST)
    })

    it('refuses a non-GET request on the read route', async () => {
        const handlers = createAgyAccountHandlers(deps())
        const { res, written } = response()
        await handlers.read(request({ method: 'POST', headers: { host: '127.0.0.1:3080' } }, {}), res)
        expect(written.status).toBe(403)
    })

    it('refuses a mutation without the custom header or JSON type', async () => {
        const switchTo = vi.fn(async () => LIST)
        const handlers = createAgyAccountHandlers(deps({ switchTo }))
        for (const headers of [
            { ...MUTATION, 'x-dsh-llm-agy': '' },
            { ...MUTATION, 'content-type': 'text/plain' },
            { ...MUTATION, 'sec-fetch-site': 'cross-site' },
            { ...MUTATION, origin: 'http://127.0.0.1:9999' },
        ]) {
            const { res, written } = response()
            await handlers.switchAccount(request({ method: 'POST', headers }, { id: 'a@example.com' }), res)
            expect(written.status).toBe(403)
        }
        expect(switchTo).not.toHaveBeenCalled()
    })

    it('reads one account quota without switching', async () => {
        const accountQuota = vi.fn(async () => ({ windows: [], fetchedAt: 9 }))
        const handlers = createAgyAccountHandlers(deps({ accountQuota }))
        const { res, written } = response()
        await handlers.accountQuota(request({ url: '/llm-agy/accounts/quota?id=target%40example.com&refresh=1' }), res)
        expect(accountQuota).toHaveBeenCalledWith('target@example.com', true)
        expect(written.status).toBe(200)
        expect(JSON.parse(written.body ?? '{}')).toEqual({ windows: [], fetchedAt: 9 })

        const missing = response()
        await handlers.accountQuota(request({ url: '/llm-agy/accounts/quota' }), missing.res)
        expect(missing.written.status).toBe(400)
    })

    it('switches through a trusted JSON POST', async () => {
        const switchTo = vi.fn(async () => LIST)
        const handlers = createAgyAccountHandlers(deps({ switchTo }))
        const { res, written } = response()
        await handlers.switchAccount(request({ method: 'POST', headers: MUTATION }, { id: 'a@example.com' }), res)
        expect(switchTo).toHaveBeenCalledWith('a@example.com')
        expect(written.status).toBe(200)
        expect(JSON.parse(written.body ?? '{}')).toEqual(LIST)
    })

    it('requires an account id and reports manager failures by kind', async () => {
        const handlers = createAgyAccountHandlers(deps({
            switchTo: async () => {
                throw new Error('unknown Antigravity account "missing"')
            },
        }))
        const missing = response()
        await handlers.switchAccount(request({ method: 'POST', headers: MUTATION }, {}), missing.res)
        expect(missing.written.status).toBe(400)
        const unknown = response()
        await handlers.switchAccount(request({ method: 'POST', headers: MUTATION }, { id: 'missing' }), unknown.res)
        expect(unknown.written.status).toBe(404)
    })

    it('starts a sign-in with an optional email hint', async () => {
        const startLogin = vi.fn(async (emailHint?: string) => ({
            loginId: 'login-1',
            url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
            ...(emailHint !== undefined ? { emailHint } : {}),
        }))
        const handlers = createAgyAccountHandlers(deps({ startLogin }))
        const started = response()
        await handlers.startLogin(request({ method: 'POST', headers: MUTATION }, { email: 'a@example.com' }), started.res)
        expect(startLogin).toHaveBeenCalledWith('a@example.com')
        expect(started.written.status).toBe(200)
        expect(JSON.parse(started.written.body ?? '{}').loginId).toBe('login-1')

        const plain = response()
        await handlers.startLogin(request({ method: 'POST', headers: MUTATION }, {}), plain.res)
        expect(startLogin).toHaveBeenLastCalledWith(undefined)
    })

    it('polls sign-in status and cancels it', async () => {
        const loginStatus = vi.fn(() => ({ status: 'success' as const, accounts: LIST }))
        const cancelLogin = vi.fn()
        const handlers = createAgyAccountHandlers(deps({ loginStatus, cancelLogin }))
        const status = response()
        await handlers.loginStatus(request({ url: '/llm-agy/accounts/login/status?loginId=login-1' }), status.res)
        expect(loginStatus).toHaveBeenCalledWith('login-1')
        expect(status.written.status).toBe(200)
        expect(JSON.parse(status.written.body ?? '{}')).toEqual({ status: 'success', accounts: LIST })

        const missing = response()
        await handlers.loginStatus(request({ url: '/llm-agy/accounts/login/status' }), missing.res)
        expect(missing.written.status).toBe(400)

        const cancelled = response()
        await handlers.cancelLogin(request({ method: 'POST', headers: MUTATION }, { loginId: 'login-1' }), cancelled.res)
        expect(cancelLogin).toHaveBeenCalledWith('login-1')
        expect(cancelled.written.status).toBe(200)
    })

    it('refuses a non-GET status request', async () => {
        const handlers = createAgyAccountHandlers(deps())
        const { res, written } = response()
        await handlers.loginStatus(request({ method: 'POST', url: '/llm-agy/accounts/login/status?loginId=x' }), res)
        expect(written.status).toBe(403)
    })
})
