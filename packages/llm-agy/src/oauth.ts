/**
 * Google OAuth token refresh for Antigravity accounts.
 *
 * Antigravity's CLI and desktop app use the same installed-app OAuth client.
 * Refresh tokens are long lived; access tokens expire after an hour. The CLI
 * refreshes a token when it uses one, but account switching needs a fresh
 * token *before* the keyring is replaced, so a target account whose last use
 * was days ago still works on the first click.
 *
 * The client id is the public installed-app client the Antigravity CLI uses
 * (its `acp --login` URL names it). The matching client secret is supplied
 * locally at runtime; see `oauth-secret.ts`.
 *
 * @module @gitawego/dsh-llm-agy/oauth
 */
import { MISSING_OAUTH_SECRET_MESSAGE, resolveOAuthClientSecret } from './oauth-secret.ts'

/** Antigravity's installed-app OAuth client. */
export const ANTIGRAVITY_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

/** Token endpoint used by installed apps. */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** A successfully refreshed token. */
export interface RefreshedToken {
    accessToken: string
    refreshToken?: string
    idToken?: string
    /** Epoch seconds. */
    expiresAt: number
    tokenType: string
    scope?: string
    email?: string
}

/** Options for one refresh, injectable for tests. */
export interface RefreshTokenOptions {
    fetch?: typeof fetch
    now?: () => number
    signal?: AbortSignal
    /** Test/integration override; normally resolved from the local config. */
    clientSecret?: string
}

/** Identity claims carried by an OpenID id_token. */
export interface JwtIdentity {
    email?: string
    name?: string
}

/** Pull the identity claims out of an unverified JWT payload. */
export function decodeJwtClaims(idToken: string): JwtIdentity {
    const parts = idToken.split('.')
    if (parts.length < 2) return {}
    try {
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
        return {
            ...(typeof payload['email'] === 'string' && payload['email'].trim().length > 0
                ? { email: payload['email'].trim() }
                : {}),
            ...(typeof payload['name'] === 'string' && payload['name'].trim().length > 0
                ? { name: payload['name'].trim() }
                : {}),
        }
    } catch {
        return {}
    }
}

/** Pull the email claim out of an unverified JWT payload. */
export function decodeJwtEmail(idToken: string): string | undefined {
    return decodeJwtClaims(idToken).email
}

/** Read a Google error body without echoing sensitive material. */
async function errorText(response: Response): Promise<string> {
    const text = await response.text().catch(() => '')
    if (text.length === 0) return `HTTP ${response.status}`
    try {
        const body = JSON.parse(text) as Record<string, unknown>
        const code = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`
        const description = typeof body['error_description'] === 'string' ? `: ${body['error_description']}` : ''
        return `${code}${description}`
    } catch {
        return `HTTP ${response.status}: ${text.slice(0, 200)}`
    }
}

/** Identity returned by Google's userinfo endpoint. */
export interface AgyUserInfo {
    email: string
    name?: string
}

/**
 * Resolve an account's email from an access token.
 *
 * Older CLI builds may store a token without `id_token_email`. This is the
 * fallback used when importing the active login into the multi-account store.
 * @param accessToken - a bearer token the user already owns.
 * @param options - fetch and cancellation injection.
 * @returns the identity, or undefined when Google cannot answer.
 */
export async function fetchAgyUserInfo(
    accessToken: string,
    options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AgyUserInfo | undefined> {
    const token = accessToken.trim()
    if (token.length === 0) return undefined
    try {
        const response = await (options.fetch ?? fetch)('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        if (!response.ok) return undefined
        const payload = (await response.json()) as Record<string, unknown>
        const email = typeof payload['email'] === 'string' ? payload['email'].trim() : ''
        if (email.length === 0) return undefined
        return {
            email,
            ...(typeof payload['name'] === 'string' && payload['name'].trim().length > 0 ? { name: payload['name'].trim() } : {}),
        }
    } catch {
        return undefined
    }
}

/**
 * Exchange a refresh token for a fresh access token.
 * @param refreshToken - the account's Google refresh token.
 * @param options - fetch, clock, and cancellation injection.
 * @returns the refreshed token material.
 * @throws when the refresh token is missing, rejected, or the response is malformed.
 */
export async function refreshAgyToken(refreshToken: string, options: RefreshTokenOptions = {}): Promise<RefreshedToken> {
    const token = refreshToken.trim()
    if (token.length === 0) throw new Error('account has no refresh token')
    const clientSecret = options.clientSecret ?? (await resolveOAuthClientSecret())
    if (clientSecret === undefined) throw new Error(MISSING_OAUTH_SECRET_MESSAGE)
    const fetchImpl = options.fetch ?? fetch
    const now = options.now ?? Date.now
    const body = new URLSearchParams({
        client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: token,
        grant_type: 'refresh_token',
    })
    let response: Response
    try {
        response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
    } catch (error) {
        throw new Error(`Google token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`Google token refresh failed (${await errorText(response)})`)
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    const accessToken = typeof payload?.['access_token'] === 'string' ? payload['access_token'] : ''
    if (accessToken.length === 0) throw new Error('Google token refresh returned no access token')
    const expiresIn = typeof payload?.['expires_in'] === 'number' && Number.isFinite(payload['expires_in'])
        ? payload['expires_in']
        : 3600
    const idToken = typeof payload?.['id_token'] === 'string' ? payload['id_token'] : undefined
    const nextRefresh = typeof payload?.['refresh_token'] === 'string' && payload['refresh_token'].length > 0
        ? payload['refresh_token']
        : undefined
    const email = idToken !== undefined ? decodeJwtEmail(idToken) : undefined
    return {
        accessToken,
        ...(nextRefresh !== undefined ? { refreshToken: nextRefresh } : {}),
        ...(idToken !== undefined ? { idToken } : {}),
        expiresAt: Math.floor(now() / 1000) + expiresIn,
        tokenType: typeof payload?.['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
        ...(typeof payload?.['scope'] === 'string' ? { scope: payload['scope'] } : {}),
        ...(email !== undefined ? { email } : {}),
    }
}
