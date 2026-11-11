import { describe, expect, it, vi } from 'vitest'
import {
    ANTIGRAVITY_OAUTH_CLIENT_ID,
    ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    GOOGLE_TOKEN_ENDPOINT,
    decodeJwtEmail,
    refreshAgyToken,
} from '../src/oauth.ts'

function idToken(email: string): string {
    const payload = Buffer.from(JSON.stringify({ email }), 'utf8').toString('base64url')
    return `header.${payload}.signature`
}

describe('decodeJwtEmail', () => {
    it('reads the email claim from the payload', () => {
        expect(decodeJwtEmail(idToken('user@example.com'))).toBe('user@example.com')
    })

    it('returns undefined for malformed tokens', () => {
        expect(decodeJwtEmail('not-a-jwt')).toBeUndefined()
        expect(decodeJwtEmail('a.b')).toBeUndefined()
        expect(decodeJwtEmail(`a.${Buffer.from('{}').toString('base64url')}.c`)).toBeUndefined()
    })
})

describe('refreshAgyToken', () => {
    it('exchanges the refresh token and reports the new expiry and email', async () => {
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            expect(String(url)).toBe(GOOGLE_TOKEN_ENDPOINT)
            expect(init?.method).toBe('POST')
            const body = new URLSearchParams(String(init?.body))
            expect(body.get('client_id')).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID)
            expect(body.get('client_secret')).toBe(ANTIGRAVITY_OAUTH_CLIENT_SECRET)
            expect(body.get('refresh_token')).toBe('refresh-old')
            expect(body.get('grant_type')).toBe('refresh_token')
            return new Response(JSON.stringify({
                access_token: 'access-new',
                expires_in: 3599,
                token_type: 'Bearer',
                scope: 'scope-a',
                id_token: idToken('user@example.com'),
            }), { status: 200 })
        }) as unknown as typeof fetch
        const token = await refreshAgyToken('refresh-old', { fetch: fetchImpl, now: () => 1_700_000_000_000 })
        expect(token).toEqual({
            accessToken: 'access-new',
            expiresAt: 1_700_003_599,
            tokenType: 'Bearer',
            scope: 'scope-a',
            idToken: idToken('user@example.com'),
            email: 'user@example.com',
        })
    })

    it('keeps a rotated refresh token when Google returns one', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 60,
            token_type: 'Bearer',
        }), { status: 200 })) as unknown as typeof fetch
        const token = await refreshAgyToken('refresh-old', { fetch: fetchImpl, now: () => 0 })
        expect(token.refreshToken).toBe('refresh-new')
    })

    it('names the OAuth failure without echoing the token', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
        }), { status: 400 })) as unknown as typeof fetch
        await expect(refreshAgyToken('refresh-old', { fetch: fetchImpl })).rejects.toThrow(
            'Google token refresh failed (invalid_grant: Token has been expired or revoked.)',
        )
    })

    it('refuses an empty refresh token and a response without an access token', async () => {
        await expect(refreshAgyToken('   ')).rejects.toThrow('no refresh token')
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ expires_in: 60 }), { status: 200 })) as unknown as typeof fetch
        await expect(refreshAgyToken('refresh-old', { fetch: fetchImpl })).rejects.toThrow('no access token')
    })
})
