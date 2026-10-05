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
import { formatCountdown, parseQuotaView, type QuotaView } from './quota-format.ts'

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
 * The gauges themselves: one meter per window the provider disclosed.
 *
 * Shared by the tool card and the settings card, because the two surfaces show
 * the same three numbers and must not drift into two visual languages.
 * @param props - the parsed report.
 * @returns the gauge block.
 */
export function QuotaGauges({ view }: { view: QuotaView }): JSX.Element {
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
    return <QuotaGauges view={view} />
}

/**
 * Styles for the gauge.
 *
 * Colour roles follow the host's own progress meter
 * (`dsh-client-ui-attachment`): the unfilled track is
 * `--dsw-alias-fill-tertiary` — a translucent neutral that reads on either
 * theme, which is why `bg-layer-3` was invisible here — and the fill carries
 * state, since a meter's job is to say how much is spent:
 * `state-success-primary` while there is room, `state-warn-primary` past four
 * fifths, `state-error-primary` past 95%. The percentage takes the same ink as
 * its bar, so the number and the length cannot disagree.
 *
 * Fallbacks are the host's convention for state tokens (`#d54941` is its own
 * error fallback); they keep the meter legible on a theme that predates a token.
 *
 * Installed once with the card's sheet, so the tool card and the settings card
 * draw the same gauge.
 */
export const QUOTA_CSS = `
.lpq{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.lpq-head{display:flex;align-items:baseline;gap:8px}
.lpq-title{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-primary)}
.lpq-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lpq-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.lpq-row{display:grid;grid-template-columns:64px minmax(48px,1fr) 76px 66px;align-items:center;gap:10px}
.lpq-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.lpq-track{height:8px;border-radius:999px;background:var(--dsw-alias-fill-tertiary,#00000014);overflow:hidden}
.lpq-fill{display:block;height:100%;min-width:2px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#2da44e);transition:width .18s ease}
.lpq-row[data-tone="warn"] .lpq-fill{background:var(--dsw-alias-state-warn-primary,#bf8700)}
.lpq-row[data-tone="critical"] .lpq-fill{background:var(--dsw-alias-state-error-primary,#d54941)}
.lpq-value{font-size:11px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}
.lpq-row[data-tone="warn"] .lpq-value{color:var(--dsw-alias-state-warn-primary,#bf8700)}
.lpq-row[data-tone="critical"] .lpq-value{color:var(--dsw-alias-state-error-primary,#d54941)}
.lpq-reset{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}
.lpq-fallback{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
`
