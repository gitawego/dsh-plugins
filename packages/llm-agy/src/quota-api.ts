/**
 * Read one account's plan quota directly from Google, without touching the
 * active CLI login.
 *
 * `agy --print /usage` uses whatever token is in the keyring, so reading a
 * different account's quota that way would require switching accounts first.
 * The Cloud Code Assist API behind the CLI accepts a bearer token directly:
 *
 * 1. `loadCodeAssist` resolves the account's Cloud AI Companion project;
 * 2. `retrieveUserQuotaSummary` returns the same grouped buckets the CLI
 *    prints.
 *
 * The token is the account's own access token, refreshed locally when needed.
 * The active keyring account is never changed.
 *
 * @module @gitawego/dsh-llm-agy/quota-api
 */
import { parseQuotaGroups, type AgyQuota, type UsageGroup } from './quota.ts'

const ENDPOINTS = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
] as const

/** User agent the CLI and the desktop app use for this API. */
const USER_AGENT = 'antigravity/cli/1.1.25 (aidev_client; os_type=linux; arch=amd64; cl=975399401; auth_method=consumer)'

/** Fallback project when loadCodeAssist does not name one. */
const DEFAULT_PROJECT = 'aicode-consumers'

/** Options for one direct read. */
export interface ReadAccountQuotaOptions {
    fetch?: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
    now?: () => number
}

/** One POST returning parsed JSON, or a short failure description. */
async function postJson(
    fetchImpl: typeof fetch,
    url: string,
    accessToken: string,
    body: unknown,
    signal: AbortSignal,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    let response: Response
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json',
                accept: 'application/json',
                'user-agent': USER_AGENT,
            },
            body: JSON.stringify(body),
            signal,
        })
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { ok: false, error: `HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 160)}` : ''}` }
    }
    try {
        return { ok: true, value: await response.json() }
    } catch {
        return { ok: false, error: 'the quota endpoint returned invalid JSON' }
    }
}

/** Resolve the account's project and plan from loadCodeAssist. */
function loadProject(value: unknown): { project: string; plan?: string } {
    if (value === null || typeof value !== 'object') return { project: DEFAULT_PROJECT }
    const raw = value as Record<string, unknown>
    const project = typeof raw['cloudaicompanionProject'] === 'string' && raw['cloudaicompanionProject'].trim().length > 0
        ? raw['cloudaicompanionProject'].trim()
        : DEFAULT_PROJECT
    const tier = (raw['paidTier'] ?? raw['currentTier']) as Record<string, unknown> | undefined
    const plan = tier !== null && typeof tier === 'object' && typeof tier['name'] === 'string' && tier['name'].trim().length > 0
        ? tier['name'].trim()
        : undefined
    return { project, ...(plan !== undefined ? { plan } : {}) }
}

/**
 * Fetch one account's quota with its own access token.
 * @param accessToken - a valid bearer token for the account.
 * @param options - fetch, clock, timeout, and cancellation injection.
 * @returns the parsed quota; transport failures are returned as `error`.
 */
export async function readAccountQuota(accessToken: string, options: ReadAccountQuotaOptions = {}): Promise<AgyQuota> {
    const fetchedAt = (options.now ?? Date.now)()
    const token = accessToken.trim()
    if (token.length === 0) return { windows: [], fetchedAt, error: 'account has no access token' }
    const fetchImpl = options.fetch ?? fetch
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000)
    let lastError = 'the quota endpoint returned no groups'
    for (const endpoint of ENDPOINTS) {
        const loaded = await postJson(
            fetchImpl,
            `${endpoint}/v1internal:loadCodeAssist`,
            token,
            { metadata: { ideType: 'ANTIGRAVITY' } },
            signal,
        )
        const project = loaded.ok ? loadProject(loaded.value).project : DEFAULT_PROJECT
        const quota = await postJson(
            fetchImpl,
            `${endpoint}/v1internal:retrieveUserQuotaSummary`,
            token,
            { project },
            signal,
        )
        if (!quota.ok) {
            lastError = quota.error
            continue
        }
        if (quota.value === null || typeof quota.value !== 'object') {
            lastError = 'the quota endpoint returned an unexpected body'
            continue
        }
        const groups = (quota.value as Record<string, unknown>)['groups']
        if (!Array.isArray(groups) || groups.length === 0) {
            lastError = 'the quota endpoint returned no quota groups'
            continue
        }
        const windows = parseQuotaGroups(groups as UsageGroup[], fetchedAt)
        if (windows.length > 0) return { windows, fetchedAt }
        lastError = 'the quota endpoint returned no measured buckets'
    }
    return { windows: [], fetchedAt, error: lastError }
}
