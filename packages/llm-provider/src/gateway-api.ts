/**
 * The gateway's own HTTP surface: the model list and the usage/quota report.
 *
 * Two endpoints, both verified against the live service:
 *
 * ```text
 * GET {baseURL}/models   → {"object":"list","data":[{"id":"deepseek-v4.1-flash",…
 * GET {baseURL}/usage    → {"usage":{"rolling":{"status":"ok","percent":2,
 *                            "resetsAt":"2026-10-05T19:56:40.000Z"},"weekly":…,
 *                            "monthly":…}}
 * ```
 *
 * `/models` answers ids only — no capacities, no thinking levels — which is why
 * `models-dev.ts` exists beside it. `/usage` is the quota report: OpenCode Go
 * defines each model's allowance as 5-hour (20% of monthly), weekly (50%), and
 * monthly (100%) shares, and reports the percent consumed plus when each window
 * resets.
 *
 * Neither call is required for a request to work, so every failure here is a
 * degraded answer, never a broken route. Both send the attribution header the
 * gateway asks clients to identify themselves with; neither sends a session
 * header, because neither is a conversation (verified: both answer 200 without
 * one) and a fabricated session id would add routing lanes that mean nothing.
 *
 * @module @gitawego/dsh-llm-provider/gateway-api
 */
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { FetchLike } from './models-dev.ts'

/** One quota window the gateway reports. */
export interface QuotaWindow {
    /** Wire id: `rolling` (5-hour), `weekly`, `monthly`. */
    id: string
    /** Display label for the window. */
    label: string
    /** Share of the allowance consumed, 0-100. */
    percentUsed: number
    /** Share still available, 0-100. */
    percentRemaining: number
    /** Provider-reported window status (`ok`, …). */
    status: string
    /** ISO timestamp when the window resets, when disclosed. */
    resetsAt?: string
}

/** One provider's quota report. */
export interface QuotaSnapshot {
    /** Route the report belongs to. */
    route: string
    /** Windows in the order the provider reports them, 5-hour first. */
    windows: QuotaWindow[]
    /** When this report was fetched (epoch ms). */
    fetchedAt: number
    /** Why the report is empty, when the fetch failed. */
    error?: string
}

/** Window labels and order. Unknown keys keep their id as the label. */
const WINDOW_META: Readonly<Record<string, { label: string; order: number }>> = {
    rolling: { label: '5-hour', order: 0 },
    weekly: { label: 'weekly', order: 1 },
    monthly: { label: 'monthly', order: 2 },
}

/**
 * Read model ids out of a `/models` reply.
 *
 * Accepts both the standard OpenAI `data` array and a bare array, because the
 * endpoint is a gateway and the two spellings are one compatibility change
 * apart. Entries without a usable id are skipped rather than failing the list.
 * @param document - the parsed reply, of unknown shape.
 * @returns ids in provider order.
 */
export function parseModelIds(document: unknown): string[] {
    if (typeof document !== 'object' || document === null) return []
    const root = document as Record<string, unknown>
    const list = Array.isArray(root['data']) ? root['data'] : Array.isArray(document) ? document : []
    const ids: string[] = []
    for (const entry of list) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
            ids.push(entry.trim())
            continue
        }
        if (typeof entry !== 'object' || entry === null) continue
        const id = (entry as Record<string, unknown>)['id']
        if (typeof id === 'string' && id.trim().length > 0) ids.push(id.trim())
    }
    return [...new Set(ids)]
}

/**
 * Read the quota report out of a `/usage` reply.
 * @param document - the parsed reply, of unknown shape.
 * @param route - route the report belongs to, for the returned snapshot.
 * @param fetchedAt - fetch time; injectable so a test can assert it.
 * @returns the snapshot; `windows` is empty when the reply carries none.
 */
export function parseQuota(document: unknown, route: string, fetchedAt = Date.now()): QuotaSnapshot {
    if (typeof document !== 'object' || document === null) {
        return { route, windows: [], fetchedAt, error: 'usage reply was not an object' }
    }
    const usage = (document as Record<string, unknown>)['usage']
    if (typeof usage !== 'object' || usage === null) {
        return { route, windows: [], fetchedAt, error: 'usage reply carried no `usage` object' }
    }
    const windows: QuotaWindow[] = []
    for (const [id, raw] of Object.entries(usage as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = raw as Record<string, unknown>
        const percent = typeof entry['percent'] === 'number' && Number.isFinite(entry['percent']) ? entry['percent'] : undefined
        if (percent === undefined) continue
        const used = Math.min(100, Math.max(0, percent))
        const resetsAt = typeof entry['resetsAt'] === 'string' && entry['resetsAt'].trim().length > 0 ? entry['resetsAt'] : undefined
        windows.push({
            id,
            label: WINDOW_META[id]?.label ?? id,
            percentUsed: used,
            percentRemaining: Math.round((100 - used) * 100) / 100,
            status: typeof entry['status'] === 'string' ? entry['status'] : 'unknown',
            ...(resetsAt !== undefined ? { resetsAt } : {}),
        })
    }
    windows.sort((left, right) => (WINDOW_META[left.id]?.order ?? 99) - (WINDOW_META[right.id]?.order ?? 99))
    return { route, windows, fetchedAt }
}

/** Options shared by both gateway calls. */
export interface GatewayCallOptions {
    /** Endpoint root, e.g. `https://opencode.ai/zen/go/v1`. */
    baseURL: string
    /** Resolved credential; absent leaves the call unauthenticated. */
    apiKey?: string
    fetch?: FetchLike
    signal?: AbortSignal
}

/** Build one authenticated gateway request. */
function requestInit(options: GatewayCallOptions): RequestInit {
    return {
        headers: {
            accept: 'application/json',
            ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...attributionHeaders(),
        },
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }
}

/** Join the configured root with one path segment, tolerating a trailing slash. */
function endpoint(baseURL: string, segment: string): string {
    return `${baseURL.replace(/\/+$/u, '')}/${segment}`
}

/**
 * Fetch the models this credential can call.
 * @param options - endpoint root, credential, fetch, and cancellation.
 * @returns the ids, or an empty list when the endpoint is unreachable or refuses.
 */
export async function fetchModelIds(options: GatewayCallOptions): Promise<string[]> {
    const doFetch = options.fetch ?? fetch
    try {
        const response = await doFetch(endpoint(options.baseURL, 'models'), requestInit(options))
        if (!response.ok) return []
        return parseModelIds(await response.json())
    } catch {
        return []
    }
}

/**
 * Fetch one route's quota report.
 * @param options - endpoint root, credential, fetch, and cancellation.
 * @param route - route the report belongs to.
 * @returns the snapshot; `error` explains an empty report.
 */
export async function fetchQuota(options: GatewayCallOptions, route: string): Promise<QuotaSnapshot> {
    const doFetch = options.fetch ?? fetch
    const fetchedAt = Date.now()
    try {
        const response = await doFetch(endpoint(options.baseURL, 'usage'), requestInit(options))
        if (!response.ok) {
            return { route, windows: [], fetchedAt, error: `usage endpoint answered ${response.status}` }
        }
        return parseQuota(await response.json(), route, fetchedAt)
    } catch (error) {
        return { route, windows: [], fetchedAt, error: error instanceof Error ? error.message : String(error) }
    }
}

/**
 * Render a quota report for a human- or model-facing surface.
 * @param snapshot - the report.
 * @returns one line per window, or the reason the report is empty.
 */
export function formatQuota(snapshot: QuotaSnapshot): string[] {
    if (snapshot.windows.length === 0) {
        return [`No quota reported for ${snapshot.route}${snapshot.error !== undefined ? `: ${snapshot.error}` : '.'}`]
    }
    return snapshot.windows.map((window) => {
        const reset = window.resetsAt !== undefined ? `, resets ${window.resetsAt}` : ''
        const status = window.status !== 'ok' ? ` [${window.status}]` : ''
        return `${window.label}: ${window.percentRemaining}% left (${window.percentUsed}% used${reset})${status}`
    })
}
