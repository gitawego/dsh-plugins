import { describe, expect, it, vi } from 'vitest'
import {
    ANTIGRAVITY_SCOPES,
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    startGoogleLogin,
    type GoogleLoginResult,
} from '../src/oauth-login.ts'
import { ANTIGRAVITY_OAUTH_CLIENT_ID, GOOGLE_TOKEN_ENDPOINT } from '../src/oauth.ts'

function idToken(email: string, name?: string): string {
    const payload = Buffer.from(JSON.stringify({ email, ...(name !== undefined ? { name } : {}) }), 'utf8').toString('base64url')
    return `header.${payload}.signature`
}

function result(email: string, name?: string): GoogleLoginResult {
    return {
        email,
        ...(name !== undefined ? { name } : {}),
        credential: {
            accessToken: 'access',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
            expiresAt: 1_900_000_000,
            email,
        },
    }
}

function redirectOf(url: string): { redirectUri: string; state: string } {
    const parsed = new URL(url)
    return {
        redirectUri: parsed.searchParams.get('redirect_uri') ?? '',
        state: parsed.searchParams.get('state') ?? '',
    }
}

describe('buildGoogleAuthUrl', () => {
    it('carries the loopback redirect, PKCE, scopes, and an optional login hint', () => {
        const url = new URL(buildGoogleAuthUrl({
            redirectUri: 'http://127.0.0.1:41234/oauth/callback',
            state: 'state-1',
            codeChallenge: 'challenge',
            loginHint: 'user@example.com',
        }))
        expect(url.origin).toBe('https://accounts.google.com')
        expect(url.searchParams.get('client_id')).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID)
        expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:41234/oauth/callback')
        expect(url.searchParams.get('state')).toBe('state-1')
        expect(url.searchParams.get('code_challenge')).toBe('challenge')
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        expect(url.searchParams.get('scope')).toBe(ANTIGRAVITY_SCOPES)
        expect(url.searchParams.get('login_hint')).toBe('user@example.com')
        expect(url.searchParams.get('access_type')).toBe('offline')
        expect(url.searchParams.get('prompt')).toContain('consent')
    })
})

describe('exchangeGoogleCode', () => {
    it('exchanges the code with PKCE and reads the id_token identity', async () => {
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            expect(String(url)).toBe(GOOGLE_TOKEN_ENDPOINT)
            const form = new URLSearchParams(String(init?.body))
            expect(form.get('grant_type')).toBe('authorization_code')
            expect(form.get('code')).toBe('code-1')
            expect(form.get('code_verifier')).toBe('verifier')
            expect(form.get('redirect_uri')).toBe('http://127.0.0.1:41234/oauth/callback')
            return new Response(JSON.stringify({
                access_token: 'access',
                refresh_token: 'refresh',
                expires_in: 3600,
                token_type: 'Bearer',
                scope: ANTIGRAVITY_SCOPES,
                id_token: idToken('user@example.com', 'User Name'),
            }), { status: 200 })
        }) as unknown as typeof fetch
        const value = await exchangeGoogleCode('code-1', 'http://127.0.0.1:41234/oauth/callback', 'verifier', {
            fetch: fetchImpl,
            now: () => 1_700_000_000_000,
        })
        expect(value.email).toBe('user@example.com')
        expect(value.name).toBe('User Name')
        expect(value.credential).toMatchObject({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAt: 1_700_003_600,
            email: 'user@example.com',
        })
    })

    it('reports a rejected exchange without leaking the code', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            error: 'access_denied',
            error_description: 'The user denied the request.',
        }), { status: 400 })) as unknown as typeof fetch
        await expect(exchangeGoogleCode('secret-code', 'http://127.0.0.1:1/oauth/callback', 'verifier', { fetch: fetchImpl }))
            .rejects.toThrow('Google sign-in failed (access_denied: The user denied the request.)')
    })
})

describe('startGoogleLogin', () => {
    it('serves the callback on a free loopback port and resolves the exchange', async () => {
        const handle = await startGoogleLogin({
            exchange: async (code, redirectUri, verifier) => {
                expect(code).toBe('code-ok')
                expect(redirectUri).toContain('127.0.0.1')
                expect(verifier.length).toBeGreaterThan(20)
                return result('user@example.com', 'User')
            },
        })
        const { redirectUri, state } = redirectOf(handle.url)
        expect(new URL(redirectUri).port).not.toBe('0')
        const response = await fetch(`${redirectUri}?code=code-ok&state=${encodeURIComponent(state)}`)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('user@example.com')
        await expect(handle.result).resolves.toMatchObject({ email: 'user@example.com', name: 'User' })
    })

    it('uses a different free port for every sign-in', async () => {
        const first = await startGoogleLogin({ exchange: async () => result('a@example.com') })
        const second = await startGoogleLogin({ exchange: async () => result('b@example.com') })
        expect(new URL(redirectOf(first.url).redirectUri).port).not.toBe(new URL(redirectOf(second.url).redirectUri).port)
        first.cancel()
        second.cancel()
        await expect(first.result).rejects.toThrow(/cancelled/)
        await expect(second.result).rejects.toThrow(/cancelled/)
    })

    it('ignores a callback with the wrong state without killing the flow', async () => {
        const handle = await startGoogleLogin({ exchange: async () => result('user@example.com') })
        const { redirectUri, state } = redirectOf(handle.url)
        const wrong = await fetch(`${redirectUri}?code=code-ok&state=wrong`)
        expect(wrong.status).toBe(400)
        const right = await fetch(`${redirectUri}?code=code-ok&state=${encodeURIComponent(state)}`)
        expect(right.status).toBe(200)
        await expect(handle.result).resolves.toMatchObject({ email: 'user@example.com' })
    })

    it('cancels the listener when the user changes their mind', async () => {
        const handle = await startGoogleLogin({ exchange: async () => result('user@example.com') })
        const { redirectUri } = redirectOf(handle.url)
        handle.cancel()
        await expect(handle.result).rejects.toThrow(/cancelled/)
        await expect(fetch(`${redirectUri}?code=code-ok&state=x`)).rejects.toThrow()
    })
})
