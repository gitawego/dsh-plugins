/**
 * Google OAuth with a loopback callback, matching the Antigravity desktop
 * app's account flow.
 *
 * The plugin listens on an ephemeral `127.0.0.1` port, sends the browser to
 * Google with a PKCE challenge and a random state, and exchanges the returned
 * authorization code at the token endpoint. No authorization code is ever
 * pasted into the settings UI, and no token reaches the browser.
 *
 * @module @gitawego/dsh-llm-agy/oauth-login
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
    ANTIGRAVITY_OAUTH_CLIENT_ID,
    ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    GOOGLE_TOKEN_ENDPOINT,
    decodeJwtClaims,
    fetchAgyUserInfo,
} from './oauth.ts'
import type { OAuthCredential } from './token-storage.ts'

/** Google's authorization endpoint. */
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Callback path the local listener serves. */
export const OAUTH_CALLBACK_PATH = '/oauth/callback'

/** Scopes the Antigravity CLI requests for its own login. */
export const ANTIGRAVITY_SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/experimentsandconfigs',
    'https://www.googleapis.com/auth/aicode',
].join(' ')

/** A completed sign-in. */
export interface GoogleLoginResult {
    email: string
    name?: string
    credential: OAuthCredential
}

/** A running sign-in. */
export interface GoogleLoginHandle {
    id: string
    url: string
    /** Resolves after the callback exchanges its code successfully. */
    result: Promise<GoogleLoginResult>
    cancel(): void
}

/** Code exchange injection point for tests. */
export type CodeExchanger = (code: string, redirectUri: string, codeVerifier: string) => Promise<GoogleLoginResult>

/** Options for one sign-in. */
export interface GoogleLoginOptions {
    /** Pre-select this Google account (re-authentication). */
    loginHint?: string
    timeoutMs?: number
    fetch?: typeof fetch
    exchange?: CodeExchanger
    successPage?: (result: GoogleLoginResult) => string
    errorPage?: (message: string) => string
}

/** Build the Google authorization URL. */
export function buildGoogleAuthUrl(input: {
    redirectUri: string
    state: string
    codeChallenge: string
    loginHint?: string
}): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT)
    url.searchParams.set('client_id', ANTIGRAVITY_OAUTH_CLIENT_ID)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', ANTIGRAVITY_SCOPES)
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'select_account consent')
    url.searchParams.set('include_granted_scopes', 'true')
    url.searchParams.set('state', input.state)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (input.loginHint !== undefined && input.loginHint.trim().length > 0) {
        url.searchParams.set('login_hint', input.loginHint.trim())
    }
    return url.toString()
}

/** Read a Google error body without echoing secrets. */
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

/**
 * Exchange an authorization code and resolve the account identity.
 * @param code - the callback's authorization code.
 * @param redirectUri - the exact redirect URI used for the request.
 * @param codeVerifier - the PKCE verifier.
 * @param options - fetch, clock, and cancellation injection.
 * @returns the account identity and credential.
 */
export async function exchangeGoogleCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
    options: { fetch?: typeof fetch; now?: () => number; signal?: AbortSignal } = {},
): Promise<GoogleLoginResult> {
    const fetchImpl = options.fetch ?? fetch
    const now = options.now ?? Date.now
    const form = new URLSearchParams({
        client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
        client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
    })
    let response: Response
    try {
        response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: form,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
    } catch (error) {
        throw new Error(`Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`Google sign-in failed (${await errorText(response)})`)
    const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    const accessToken = typeof payload?.['access_token'] === 'string' ? payload['access_token'] : ''
    if (accessToken.length === 0) throw new Error('Google sign-in returned no access token')
    const idToken = typeof payload?.['id_token'] === 'string' ? payload['id_token'] : undefined
    const claims = idToken !== undefined ? decodeJwtClaims(idToken) : {}
    let email = claims.email
    let name = claims.name
    if (email === undefined) {
        const info = await fetchAgyUserInfo(accessToken, {
            fetch: fetchImpl,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        email = info?.email
        name = name ?? info?.name
    }
    if (email === undefined) throw new Error('Google sign-in did not return an email address')
    const expiresIn = typeof payload?.['expires_in'] === 'number' && Number.isFinite(payload['expires_in'])
        ? payload['expires_in']
        : 3600
    return {
        email,
        ...(name !== undefined ? { name } : {}),
        credential: {
            accessToken,
            refreshToken: typeof payload?.['refresh_token'] === 'string' ? payload['refresh_token'] : '',
            ...(idToken !== undefined ? { idToken } : {}),
            expiresAt: Math.floor(now() / 1000) + expiresIn,
            tokenType: typeof payload?.['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
            ...(typeof payload?.['scope'] === 'string' ? { scope: payload['scope'] } : {}),
            email,
        },
    }
}

/** Escape text for the callback page. */
function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

/** The shared callback page shell. */
function page(title: string, body: string, tone: 'ok' | 'error'): string {
    const accent = tone === 'ok' ? '#3fb950' : '#f85149'
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{max-width:440px;margin:24px;padding:28px 32px;border:1px solid #30363d;border-radius:16px;background:#161b22;text-align:center}
.mark{width:42px;height:42px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:${accent}22;color:${accent};font-size:22px}
h1{margin:0 0 8px;font-size:18px}
p{margin:0;color:#8b949e}
</style></head><body><main class="card"><div class="mark">${tone === 'ok' ? '✓' : '!'}</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
}

const defaultSuccessPage = (result: GoogleLoginResult): string => page(
    'Google sign-in successful',
    `<p>Signed in as ${escapeHtml(result.email)}.</p><p>You can close this tab and return to DSH.</p>`,
    'ok',
)

const defaultErrorPage = (message: string): string => page(
    'Google sign-in failed',
    `<p>${escapeHtml(message)}</p><p>Close this tab and try again from DSH.</p>`,
    'error',
)

/**
 * Start a loopback OAuth sign-in.
 *
 * The listener is bound to `127.0.0.1` on an ephemeral port and closes after
 * the first valid callback, a timeout, or cancellation.
 * @param options - login hint, timeouts, and test seams.
 * @returns a handle whose `url` should be opened in the browser.
 */
export async function startGoogleLogin(options: GoogleLoginOptions = {}): Promise<GoogleLoginHandle> {
    const id = randomUUID()
    const state = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let server: Server | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let resolveResult!: (result: GoogleLoginResult) => void
    let rejectResult!: (error: Error) => void
    const result = new Promise<GoogleLoginResult>((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
    })
    // A cancelled or failed sign-in may be rejected before the route consumes
    // it; keep that from surfacing as an unhandled rejection.
    void result.catch(() => {})

    const finish = (error?: Error, value?: GoogleLoginResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        server?.close()
        if (error !== undefined) rejectResult(error)
        else resolveResult(value!)
    }

    const sendPage = (res: import('node:http').ServerResponse, status: number, html: string): void => {
        try {
            res.writeHead(status, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': Buffer.byteLength(html),
                connection: 'close',
                'cache-control': 'no-store',
            })
            res.end(html)
        } catch {
            /* the browser tab was closed or the listener was cancelled */
        }
    }

    const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
        let requestUrl: URL
        try {
            requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        } catch {
            sendPage(res, 400, defaultErrorPage('Malformed callback request'))
            return
        }
        if (requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
            sendPage(res, 404, defaultErrorPage('Unknown callback path'))
            return
        }
        if (requestUrl.searchParams.get('state') !== state) {
            // A stray or forged callback must not kill the legitimate flow.
            sendPage(res, 400, defaultErrorPage('The sign-in state did not match. Try again.'))
            return
        }
        const oauthError = requestUrl.searchParams.get('error')
        if (oauthError !== null) {
            const description = requestUrl.searchParams.get('error_description') ?? oauthError
            sendPage(res, 400, (options.errorPage ?? defaultErrorPage)(description))
            finish(new Error(`Google sign-in failed: ${description}`))
            return
        }
        const code = requestUrl.searchParams.get('code')
        if (code === null || code.length === 0) {
            sendPage(res, 400, (options.errorPage ?? defaultErrorPage)('No authorization code was returned.'))
            finish(new Error('Google sign-in returned no authorization code'))
            return
        }
        const address = server?.address() as AddressInfo | null
        if (address === null || address === undefined) {
            sendPage(res, 500, (options.errorPage ?? defaultErrorPage)('The local callback listener is not ready.'))
            finish(new Error('the local OAuth listener is not ready'))
            return
        }
        const redirectUri = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`
        try {
            const exchange = options.exchange ?? ((value, uri, secret) => exchangeGoogleCode(value, uri, secret, {
                ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
                signal: AbortSignal.timeout(20_000),
            }))
            const value = await exchange(code, redirectUri, verifier)
            sendPage(res, 200, (options.successPage ?? defaultSuccessPage)(value))
            finish(undefined, value)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            sendPage(res, 502, (options.errorPage ?? defaultErrorPage)(message))
            finish(new Error(message))
        }
    }

    // Port 0 asks the OS for a free ephemeral port, so a fixed callback port
    // can never collide with another process. Retry the (unlikely) bind race.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = createServer(handler)
        server = candidate
        const listening = once(candidate, 'listening')
        candidate.listen(0, '127.0.0.1')
        try {
            await listening
            candidate.on('error', (error: Error) => finish(error))
            break
        } catch (error) {
            candidate.close()
            server = undefined
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EADDRINUSE' && attempt < 2) continue
            finish(error instanceof Error ? error : new Error(String(error)))
            throw error
        }
    }
    if (server === undefined) {
        const error = new Error('could not start the local OAuth listener')
        finish(error)
        throw error
    }
    const address = server.address() as AddressInfo
    const redirectUri = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`
    const url = buildGoogleAuthUrl({
        redirectUri,
        state,
        codeChallenge: challenge,
        ...(options.loginHint !== undefined && options.loginHint.trim().length > 0 ? { loginHint: options.loginHint } : {}),
    })
    timer = setTimeout(() => finish(new Error('Google sign-in timed out')), options.timeoutMs ?? 10 * 60_000)
    timer.unref?.()

    return {
        id,
        url,
        result,
        cancel() {
            finish(new Error('Google sign-in cancelled'))
        },
    }
}
