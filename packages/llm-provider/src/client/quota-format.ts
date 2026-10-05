/**
 * The quota gauge's data layer: parsing the tool's payload, the tone thresholds,
 * and the reset countdown.
 *
 * Split from `quota-view.tsx` so it carries no JSX — the server project
 * typechecks `tests/`, and a test importing a `.tsx` module would need a `jsx`
 * option that project does not set. The same payload shape arrives from the tool
 * card's `presentationMeta` and from the host's quota route, so both surfaces
 * share this parse.
 *
 * @module @gitawego/dsh-llm-provider/client/quota-format
 */

/** One window as the tool reported it. */
export interface QuotaWindowView {
    id: string
    label: string
    percentUsed: number
    percentRemaining: number
    status: string
    /** ISO reset timestamp, when the provider disclosed one. */
    resetsAt?: string
    /** Tone for the meter, from the share already spent. */
    tone: 'ok' | 'warn' | 'critical'
}

/** What the view renders. */
export interface QuotaView {
    route: string
    windows: QuotaWindowView[]
    /** Why there is nothing to draw, when there is nothing. */
    error?: string
    /** When the report was read (epoch ms), when known. */
    fetchedAt?: number
}

/** Read a finite number, or undefined. */
function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a non-empty string, or undefined. */
function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Tone from the share spent. The thresholds are the point at which the number
 * stops being informational: four fifths spent is worth noticing during a long
 * task, and almost everything spent is worth stopping for.
 * @param percentUsed - spent share, 0-100.
 * @returns the meter's tone.
 */
export function toneFor(percentUsed: number): QuotaWindowView['tone'] {
    if (percentUsed >= 95) return 'critical'
    if (percentUsed >= 80) return 'warn'
    return 'ok'
}

/**
 * Narrow the tool's `presentationMeta` into what the view draws.
 *
 * Deliberately tolerant: this runs against a value produced by a host process
 * that may be older or newer than the client, so an unexpected shape degrades to
 * "nothing to draw for this window" rather than throwing inside a slot renderer
 * (a throw there takes the whole card down).
 * @param meta - the tool result's meta, of unknown shape.
 * @returns the view, or undefined when there is nothing structured to draw.
 */
export function parseQuotaView(meta: unknown): QuotaView | undefined {
    if (typeof meta !== 'object' || meta === null) return undefined
    const record = meta as Record<string, unknown>
    const route = str(record['route'])
    if (route === undefined) return undefined
    const rawWindows = Array.isArray(record['windows']) ? record['windows'] : []
    const windows: QuotaWindowView[] = []
    for (const raw of rawWindows) {
        if (typeof raw !== 'object' || raw === null) continue
        const window = raw as Record<string, unknown>
        const used = num(window['percentUsed'])
        const left = num(window['percentRemaining'])
        const label = str(window['label'])
        if (used === undefined || label === undefined) continue
        windows.push({
            id: str(window['id']) ?? label,
            label,
            percentUsed: used,
            percentRemaining: left ?? Math.round((100 - used) * 100) / 100,
            status: str(window['status']) ?? 'unknown',
            ...(str(window['resetsAt']) !== undefined ? { resetsAt: str(window['resetsAt'])! } : {}),
            tone: toneFor(used),
        })
    }
    return {
        route,
        windows,
        ...(str(record['error']) !== undefined ? { error: str(record['error'])! } : {}),
        ...(num(record['fetchedAt']) !== undefined ? { fetchedAt: num(record['fetchedAt'])! } : {}),
    }
}

/**
 * A short countdown to a reset, from an ISO timestamp.
 * @param iso - the reset timestamp.
 * @param now - the reading clock.
 * @returns e.g. `in 3h 12m`, or the raw timestamp when it cannot be parsed.
 */
export function formatCountdown(iso: string, now: number): string {
    const at = Date.parse(iso)
    if (Number.isNaN(at)) return iso
    const minutes = Math.round((at - now) / 60_000)
    if (minutes <= 0) return 'resetting'
    if (minutes < 60) return `in ${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `in ${hours}h ${minutes % 60}m`
    return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

