/**
 * The quota gauge — `llm_quota`'s tool view.
 *
 * OpenCode Go defines each model's allowance as three nested windows (5-hour,
 * weekly, monthly) and reports what fraction of each is spent. A sentence is the
 * wrong shape for that: the numbers are meant to be compared at a glance, and a
 * month's allowance is only legible against the week's and the day's.
 *
 * The view draws what the tool actually reported and nothing more. The provider
 * discloses a percentage per window, not a token or dollar budget, so there is
 * no honest way to label an absolute amount — and a window the provider does not
 * report is absent, not zero.
 *
 * Structured data arrives through the tool's `presentationMeta`, not by parsing
 * the rendered line: `ToolResultNode.meta` is what a tool view can read, and
 * `presentationMeta` is the only thing that populates it.
 *
 * @module @gitawego/dsh-llm-provider/client/quota-view
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

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

/** The props a `tool.call.toolview` entry receives. */
export type QuotaToolViewProps = PropsRuntime<'tool.call.toolview'>

/** Text content of a settled tool result. */
function textOf(block: { content?: readonly { type: string; text?: string }[] }): string {
    return (block.content ?? [])
        .filter((piece) => piece.type === 'text')
        .map((piece) => piece.text ?? '')
        .join('\n')
        .trim()
}

/**
 * Render one tool call: the gauges when the result carries them, the rendered
 * sentence otherwise (a running call, or a result produced before this view
 * existed).
 * @param props - the tool view's owner props.
 * @returns the card.
 */
export function QuotaToolView(props: QuotaToolViewProps): JSX.Element {
    const block = props.block as { kind?: string; meta?: unknown; content?: readonly { type: string; text?: string }[]; isError?: boolean }
    const view = block.kind === 'tool-result' ? parseQuotaView(block.meta) : undefined

    if (view === undefined) {
        const text = textOf(block)
        return (
            <div className="lpq">
                <p className="lpq-fallback">{text.length > 0 ? text : block.kind === 'tool-result' ? 'No quota reported.' : 'Reading quota…'}</p>
            </div>
        )
    }

    const now = Date.now()
    return (
        <div className="lpq">
            <div className="lpq-head">
                <span className="lpq-title">{view.route}</span>
                <span className="lpq-sub">
                    allowance{view.fetchedAt !== undefined ? ` · read ${new Date(view.fetchedAt).toISOString().slice(11, 16)}Z` : ''}
                </span>
            </div>
            {view.windows.length === 0
                ? <p className="lpq-fallback">{view.error !== undefined ? `Could not read quota: ${view.error}` : 'No quota reported.'}</p>
                : (
                    <ul className="lpq-rows">
                        {view.windows.map((window) => (
                            <li className="lpq-row" key={window.id} data-tone={window.tone}>
                                <span className="lpq-label">{window.label}</span>
                                <span className="lpq-track" role="img" aria-label={`${window.label}: ${window.percentRemaining}% left`}>
                                    <span className="lpq-fill" style={{ width: `${Math.max(0, Math.min(100, window.percentUsed))}%` }} />
                                </span>
                                <span className="lpq-value">{window.percentRemaining}% left</span>
                                <span className="lpq-reset">
                                    {window.resetsAt !== undefined ? formatCountdown(window.resetsAt, now) : (window.status !== 'ok' ? window.status : '')}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    )
}

/** Styles for the gauge; installed once with the card's sheet. */
export const QUOTA_CSS = `
.lpq{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.lpq-head{display:flex;align-items:baseline;gap:8px}
.lpq-title{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-primary)}
.lpq-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lpq-rows{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.lpq-row{display:grid;grid-template-columns:64px 1fr 76px 66px;align-items:center;gap:10px}
.lpq-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.lpq-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.lpq-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.lpq-row[data-tone="warn"] .lpq-fill{background:var(--dsw-alias-label-tertiary)}
.lpq-row[data-tone="critical"] .lpq-fill{background:var(--dsw-alias-label-error)}
.lpq-value{font-size:11px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}
.lpq-reset{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}
.lpq-fallback{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
`
