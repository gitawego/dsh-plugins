/**
 * Antigravity quota section for Settings → Antigravity.
 *
 * The quota is read by the plugin's guarded loopback route; this half only
 * renders the grouped buckets (Gemini, Claude/GPT, Argon) with the same meter
 * language as the OpenCode Go card.
 *
 * @module @gitawego/dsh-llm-agy/client
 */
import { useEffect, useMemo, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { formatCountdown, labelFor, parseQuotaView, toneFor, type QuotaView, type QuotaWindow } from './quota-format.ts'
import { en, zh, type Translate } from './strings.ts'

/** Path served by the host half. */
const QUOTA_PATH = '/llm-agy/quota'

const NS = 'llm-agy-quota'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'llm-agy-quota': keyof typeof en
    }
}

const CSS = `
.aq-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.aq-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.aq-title{margin:0;font-size:15px;font-weight:600}
.aq-intro{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.aq-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.aq-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.aq-btn:disabled{opacity:.45;cursor:default}
.aq-group{display:flex;flex-direction:column;gap:6px}
.aq-group h3{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.aq-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.aq-row{display:grid;grid-template-columns:minmax(150px,1.2fr) minmax(80px,1fr) 66px 82px;align-items:center;gap:10px}
.aq-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.aq-track{height:8px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.aq-fill{display:block;height:100%;min-width:2px;border-radius:999px;background:var(--dsw-alias-state-success-primary);transition:width .18s ease}
.aq-row[data-tone="warn"] .aq-fill{background:var(--dsw-alias-state-warn-primary)}
.aq-row[data-tone="critical"] .aq-fill{background:var(--dsw-alias-state-error-primary)}
.aq-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}
.aq-row[data-tone="warn"] .aq-value{color:var(--dsw-alias-state-warn-primary)}
.aq-row[data-tone="critical"] .aq-value{color:var(--dsw-alias-state-error-primary)}
.aq-reset{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}
.aq-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.aq-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
`

function installStyles(): () => void {
    const style = document.createElement('style')
    style.dataset['dshLlmAgy'] = 'quota'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
}

/** What the section's slot entry injects. */
interface AgyQuotaFace {
    t: Translate
}

/** The quota card. */
export function AntigravityQuotaPanel(props: PropsRuntime<'settings.section'> & InjectFace<AgyQuotaFace>): JSX.Element {
    const [view, setView] = useState<QuotaView | undefined>()
    const [loading, setLoading] = useState(true)
    const [fetchedAt, setFetchedAt] = useState<number | undefined>()

    const load = async (force: boolean): Promise<void> => {
        setLoading(true)
        try {
            const response = await fetch(`${QUOTA_PATH}${force ? '?refresh=1' : ''}`, {
                headers: { accept: 'application/json' },
                credentials: 'same-origin',
            })
            if (!response.ok) throw new Error(`quota read refused (${response.status})`)
            const parsed = parseQuotaView(await response.json())
            setView(parsed)
            setFetchedAt(parsed?.fetchedAt ?? Date.now())
        } catch (error) {
            setView({ windows: [], error: error instanceof Error ? error.message : String(error) })
            setFetchedAt(Date.now())
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { void load(false) }, [])

    const groups = useMemo(() => {
        const byGroup = new Map<string, QuotaWindow[]>()
        for (const window of view?.windows ?? []) {
            const list = byGroup.get(window.group) ?? []
            list.push(window)
            byGroup.set(window.group, list)
        }
        return [...byGroup.entries()]
    }, [view])

    const now = Date.now()
    return (
        <div className="aq-card">
            <div className="aq-head">
                <div>
                    <h2 className="aq-title">{props.t('title')}</h2>
                    <p className="aq-intro">{props.t('intro')}</p>
                </div>
                <button className="aq-btn" type="button" disabled={loading} onClick={() => { void load(true) }}>
                    {loading ? props.t('reading') : props.t('refresh')}
                </button>
            </div>
            {view?.error !== undefined ? <p className="aq-error">{`${props.t('failed')}: ${view.error}`}</p> : null}
            {view !== undefined && view.windows.length === 0 && view.error === undefined ? <p className="aq-hint">{props.t('empty')}</p> : null}
            {groups.map(([group, windows]) => (
                <section className="aq-group" key={group}>
                    <h3>{group}</h3>
                    <ul className="aq-rows">
                        {windows.map((window) => {
                            const tone = toneFor(window.percentUsed)
                            const label = labelFor(window, props.t)
                            return (
                                <li className="aq-row" key={window.id} data-tone={tone}>
                                    <span className="aq-label">{label}</span>
                                    <span className="aq-track" role="img" aria-label={`${label}: ${window.percentRemaining}% left`}>
                                        <span className="aq-fill" style={{ width: `${Math.max(0, Math.min(100, window.percentUsed))}%` }} />
                                    </span>
                                    <span className="aq-value">{window.percentRemaining}{props.t('left')}</span>
                                    <span className="aq-reset">
                                        {window.resetsAt !== undefined ? formatCountdown(window.resetsAt, now, props.t) : (window.status === 'exhausted' ? props.t('exhausted') : '')}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                </section>
            ))}
            {fetchedAt !== undefined ? <p className="aq-hint">{props.t('readAt').replace('{time}', new Date(fetchedAt).toLocaleTimeString())}</p> : null}
        </div>
    )
}

/** Services required by the client half. */
export const inject = ['slots', 'locale']

/** Mount the section. */
export function apply(ctx: ClientContext): void {
    ctx.effect(installStyles, 'llm-agy: quota styles')
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'llm-agy: quota locale')
    const t = ctx.locale.bind(NS)
    const face: AgyQuotaFace = { t }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'llm-agy-quota',
        order: 51,
        label: () => t('nav'),
        locale: NS,
        inject: () => face,
    }, AntigravityQuotaPanel as never))
}

export type { QuotaView, QuotaWindow }
