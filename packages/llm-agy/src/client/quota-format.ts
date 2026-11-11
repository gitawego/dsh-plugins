/**
 * Pure parsing and formatting for the Antigravity quota card.
 *
 * The route payload is untrusted browser input, so every field is narrowed
 * instead of asserted; a malformed row is dropped rather than breaking the
 * whole section. Kept free of JSX and React so the server-side test project can
 * exercise it directly.
 *
 * @module @gitawego/dsh-llm-agy/client/quota-format
 */
import type { Translate } from './strings.ts'

/** One quota bucket as the card renders it. */
export interface QuotaWindow {
    id: string
    group: string
    label: string
    window: string
    percentRemaining: number
    percentUsed: number
    resetsAt?: string
    description?: string
    status: 'ok' | 'exhausted'
}

/** One quota read as the card renders it. */
export interface QuotaView {
    windows: QuotaWindow[]
    fetchedAt?: number
    error?: string
}

/** Meter tone for a used percentage. */
export function toneFor(percentUsed: number): 'ok' | 'warn' | 'critical' {
    if (percentUsed >= 95) return 'critical'
    if (percentUsed >= 80) return 'warn'
    return 'ok'
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Parse the route payload without throwing inside a slot renderer.
 * @param payload - the decoded JSON body.
 * @returns the view, or undefined when the body is not an object.
 */
export function parseQuotaView(payload: unknown): QuotaView | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined
    const raw = payload as Record<string, unknown>
    const windows: QuotaWindow[] = []
    for (const entry of Array.isArray(raw['windows']) ? raw['windows'] : []) {
        if (typeof entry !== 'object' || entry === null) continue
        const row = entry as Record<string, unknown>
        const id = str(row['id'])
        const group = str(row['group'])
        const label = str(row['label'])
        const window = str(row['window'])
        const remaining = num(row['percentRemaining'])
        const used = num(row['percentUsed'])
        if (id === undefined || group === undefined || label === undefined || window === undefined || remaining === undefined || used === undefined) continue
        const resetsAt = str(row['resetsAt'])
        const description = str(row['description'])
        windows.push({
            id,
            group,
            label,
            window,
            percentRemaining: remaining,
            percentUsed: used,
            ...(resetsAt !== undefined ? { resetsAt } : {}),
            ...(description !== undefined ? { description } : {}),
            status: row['status'] === 'exhausted' ? 'exhausted' : 'ok',
        })
    }
    const fetchedAt = num(raw['fetchedAt'])
    const error = str(raw['error'])
    return {
        windows,
        ...(fetchedAt !== undefined ? { fetchedAt } : {}),
        ...(error !== undefined ? { error } : {}),
    }
}

/**
 * Compact label for a bucket.
 *
 * The CLI reports prose such as "Weekly Limit Remaining" for every group; the
 * card already lives under the group name, so only the cadence is useful.
 * @param window - one quota bucket.
 * @param t - section copy lookup.
 * @returns the cadence label, falling back to the bucket's own name.
 */
export function labelFor(window: QuotaWindow, t: Translate): string {
    if (window.window === 'weekly') return t('weekly')
    if (window.window === '5h') return t('fiveHour')
    return window.label
}

/**
 * Render a reset time as a localized countdown.
 * @param iso - the reset timestamp.
 * @param now - epoch milliseconds for the comparison.
 * @param t - section copy lookup.
 * @returns the countdown, or the raw timestamp when it cannot be parsed.
 */
export function formatCountdown(iso: string, now: number, t: Translate): string {
    const at = Date.parse(iso)
    if (Number.isNaN(at)) return iso
    const minutes = Math.round((at - now) / 60_000)
    if (minutes <= 0) return t('resetting')
    if (minutes < 60) return t('inMinutes').replace('{n}', String(minutes))
    const hours = Math.floor(minutes / 60)
    if (hours < 24) {
        return t('inHours').replace('{n}', String(hours)).replace('{m}', String(minutes % 60))
    }
    return t('inDays').replace('{n}', String(Math.floor(hours / 24))).replace('{h}', String(hours % 24))
}
