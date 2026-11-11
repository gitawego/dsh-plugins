/* @gitawego/dsh-llm-provider browser plugin: the OpenCode Go dashboard.
 *
 * What the panel is for: the two facts the harness has no seam for — which
 * models the provider actually serves (versus what the installed pi-ai catalog
 * knows), and how much of the subscription is left. Both are read-only.
 *
 * Design notes:
 * - The model list is a comparison, not an editor: a row states whether the
 *   catalog knows it and whether the provider still serves it, and the block a
 *   user has to paste when those differ is right below it.
 * - Ids are monospaced and figures use tabular numerals, so the columns read as
 *   a spec sheet instead of ragged text.
 * - Every colour comes from the host's `--dsw-alias-*` tokens, so the panel
 *   follows the theme (including dark mode) without its own palette.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MonitorProfile } from '../config.ts'
import type { DashboardSnapshot, ModelRow } from './controller.ts'
import { NS, createSectionFace, type LlmProvidersFace } from './section-face.ts'
import { en, zh } from './strings.ts'
import { QUOTA_CSS, QuotaGauges, QuotaToolView } from './quota-view.tsx'

/* Pure-type augmentation for the locale namespace this plugin registers, so a
 * missing translation is a compile error rather than a key shown to the user.
 * The slot types it contributes to (`settings.section`) are declared by their
 * owning packages. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'llm-provider': keyof typeof en
    }
}

const CSS = `
.lpd { display: flex; flex-direction: column; gap: 16px; }
.lpd-head h2 { margin: 0 0 4px; font-size: 16px; font-weight: 500; line-height: 24px; }
.lpd-head p { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; max-width: 72ch; }
.lpd-card { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border: .5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-settings-card-fill); }
.lpd-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lpd-route { font-family: var(--dsh-font-family-code-default, ui-monospace); font-size: 13px; font-weight: 600; line-height: 18px; }
.lpd-badge { font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: var(--dsw-radius-xs); border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.lpd-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.lpd-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.lpd-endpoint { font-family: var(--dsh-font-family-code-default, ui-monospace); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.lpd-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px 14px; }
.lpd-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lpd-field label { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.lpd-field input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; min-width: 0; }
.lpd-field input:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.lpd-field small { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.lpd-section { display: flex; flex-direction: column; gap: 8px; }
.lpd-section h3 { margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; }
.lpd-section p { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 18px; }
.lpd-counts { display: flex; gap: 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.lpd-list-head { display: grid; grid-template-columns: minmax(14ch, 24ch) 1fr; gap: 12px; align-items: baseline; font-size: 11px; font-weight: 500; line-height: 16px; color: var(--dsw-alias-label-tertiary); padding: 0 0 4px; }
.lpd-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0; }
.lpd-item { display: grid; grid-template-columns: minmax(14ch, 24ch) 1fr; gap: 12px; align-items: baseline; font-size: 12px; line-height: 18px; padding: 4px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.lpd-item:last-child { border-bottom: 0; }
.lpd-id { font-family: var(--dsh-font-family-code-default, ui-monospace); font-size: 12.5px; line-height: 18px; overflow-wrap: anywhere; }
.lpd-facts { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.lpd-details { margin-top: 2px; }
.lpd-details summary { cursor: pointer; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.lpd-details summary:hover { color: var(--dsw-alias-label-primary); }
.lpd-snippet { margin: 8px 0 0; padding: 10px 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l4); overflow: auto; max-height: 320px; }
.lpd-snippet code { font-family: var(--dsh-font-family-code-default, ui-monospace); font-size: 12px; line-height: 18px; white-space: pre; }
.lpd-actions { display: flex; gap: 8px; align-items: center; }
.lpd-btn { box-sizing: border-box; height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); border: .5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.lpd-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lpd-btn:disabled { opacity: .4; cursor: default; }
.lpd-when { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.lpd-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
`

/** Install the panel's stylesheet once. */
function installStyles(): () => void {
    const style = document.createElement('style')
    style.dataset['dshLlmProvider'] = 'dashboard'
    style.textContent = `${CSS}\n${QUOTA_CSS}`
    document.head.appendChild(style)
    return () => style.remove()
}

/** Render a token count as `1M`, `384k`, `900`. */
export function formatTokens(value: number | undefined): string {
    if (value === undefined) return '—'
    if (value >= 1_000_000) {
        const millions = value / 1_000_000
        return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 100) / 100}M`
    }
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

/** A relative age, so freshness is readable without parsing a timestamp. */
export function formatAge(at: number, now: number): string {
    if (at === 0) return 'never'
    const seconds = Math.max(0, Math.round((now - at) / 1000))
    if (seconds < 10) return 'just now'
    if (seconds < 90) return `${seconds}s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 90) return `${minutes}m ago`
    return `${Math.round(minutes / 60)}h ago`
}

/** Fill `{name}` placeholders in one copy line. */
function fill(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/gu, (match, key: string) => (key in values ? String(values[key]) : match))
}

/** One labelled text field, saving on blur. */
function Field(props: {
    id: string
    label: string
    hint: string
    value: string
    disabled: boolean
    onCommit: (text: string) => void
}): JSX.Element {
    const [draft, setDraft] = useState(props.value)
    useEffect(() => { setDraft(props.value) }, [props.value])
    return (
        <div className="lpd-field">
            <label htmlFor={props.id}>{props.label}</label>
            <input
                id={props.id}
                value={draft}
                disabled={props.disabled}
                onChange={(event) => { setDraft(event.target.value) }}
                onBlur={() => {
                    if (draft !== props.value) props.onCommit(draft.trim())
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                }}
            />
            <small>{props.hint}</small>
        </div>
    )
}

/** One selected model row: id and capacities. */
function ModelLine(props: { row: ModelRow }): JSX.Element {
    const row = props.row
    const facts: string[] = []
    if (row.contextWindow !== undefined) facts.push(`${formatTokens(row.contextWindow)} ctx`)
    if (row.maxTokens !== undefined) facts.push(`${formatTokens(row.maxTokens)} out`)
    if (row.input !== undefined && row.input.length > 0) facts.push(row.input.join('+'))
    if (row.reasoning === true) facts.push('thinking')
    return (
        <li className="lpd-item">
            <span className="lpd-id">{row.id}</span>
            <span className="lpd-facts">{facts.join(' · ') || '—'}</span>
        </li>
    )
}

/**
 * The dashboard panel.
 * @param props - slot props plus the section's injected face.
 * @returns the rendered panel.
 */
export function LlmProvidersPanel(props: PropsRuntime<'settings.section'> & InjectFace<LlmProvidersFace>): JSX.Element {
    const t = props.t
    const snapshot = props.useDashboard((value) => value)
    const [copied, setCopied] = useState(false)
    const snippet = useMemo(() => buildSnippet(snapshot), [snapshot])
    // The picker can offer an id only when the endpoint serves it and the
    // installed catalog describes it. Catalog-only ids are not selectable, and
    // live-only ids belong in the warning section below.
    const selected = useMemo(() => snapshot.models.filter((row) => row.live && row.known), [snapshot.models])

    useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => { setCopied(false) }, 1500)
        return () => clearTimeout(timer)
    }, [copied])

    return (
        <div className="lpd">
            <header className="lpd-head">
                <h2>{t('sectionTitle')}</h2>
                <p>{t('sectionIntro')}</p>
            </header>
            <section className="lpd-card">
                <div className="lpd-row">
                    <span className="lpd-route">{snapshot.route || '—'}</span>
                    <span className={`lpd-badge ${snapshot.credentialPresent ? 'ok' : 'warn'}`}>
                        {snapshot.credentialPresent ? t('credentialPresent') : t('credentialMissing')}
                    </span>
                    <span className="lpd-when">
                        {snapshot.fetchedAt === 0 ? t('never') : fill(t('readAt'), { age: formatAge(snapshot.fetchedAt, Date.now()) })}
                    </span>
                    <button className="lpd-btn" type="button" onClick={props.actions.refresh}>{t('refresh')}</button>
                </div>
                <div className="lpd-endpoint">{snapshot.endpoint || '—'}</div>
                {snapshot.error !== undefined ? <p className="lpd-error">{`${t('failed')}: ${snapshot.error}`}</p> : null}
                <div className="lpd-fields">
                    <Field
                        id="lpd-route"
                        label={t('route')}
                        hint={t('routeHint')}
                        value={snapshot.route}
                        disabled={!snapshot.writable}
                        onCommit={(text) => { props.actions.edit('route', text) }}
                    />
                    <Field
                        id="lpd-endpoint"
                        label={t('endpoint')}
                        hint={t('endpointHint')}
                        value={snapshot.endpoint}
                        disabled={!snapshot.writable}
                        onCommit={(text) => { props.actions.edit('baseURL', text) }}
                    />
                    <Field
                        id="lpd-credential"
                        label={t('credential')}
                        hint={t('credentialHint')}
                        value={snapshot.credential}
                        disabled={!snapshot.writable}
                        onCommit={(text) => {
                            if (text.length === 0) props.actions.clear('apiKeyEnv')
                            else props.actions.edit('apiKeyEnv', text)
                        }}
                    />
                </div>
            </section>
            <section className="lpd-section">
                <h3>{t('models')}</h3>
                <div className="lpd-counts">
                    <span>{fill(t('served'), { n: snapshot.servedCount })}</span>
                    <span>{fill(t('known'), { n: snapshot.knownCount })}</span>
                </div>
                {selected.length === 0
                    ? <p>{t('empty')}</p>
                    : (
                        <>
                            <div className="lpd-list-head" aria-hidden="true">
                                <span>{t('modelColumn')}</span>
                                <span>{t('detailsColumn')}</span>
                            </div>
                            <ul className="lpd-list">
                                {selected.map((row) => <ModelLine key={row.id} row={row} />)}
                            </ul>
                        </>
                    )}
            </section>
            {snapshot.unknownIds.length > 0 ? (
                <section className="lpd-section">
                    <h3>{fill(t('unknownTitle'), { n: snapshot.unknownIds.length })}</h3>
                    <p>{t('unknownIntro')}</p>
                    <span className="lpd-id">{snapshot.unknownIds.join(', ')}</span>
                </section>
            ) : null}
            <section className="lpd-section">
                <h3>{fill(t('snippetTitle'), { route: snapshot.route })}</h3>
                <p>{fill(t('snippetIntro'), { route: snapshot.route })}</p>
                <div className="lpd-row">
                    <button
                        className="lpd-btn"
                        type="button"
                        disabled={snippet.length === 0}
                        onClick={() => {
                            void navigator.clipboard?.writeText(snippet.join('\n'))
                            setCopied(true)
                        }}
                    >
                        {copied ? t('copied') : t('copy')}
                    </button>
                </div>
                <details className="lpd-details">
                    <summary>{t('showSnippet')}</summary>
                    <pre className="lpd-snippet"><code>{snippet.join('\n') || '—'}</code></pre>
                </details>
            </section>
            <QuotaGauges view={snapshot.quota} />
        </div>
    )
}

/**
 * Render the `models:` block a user pastes into `llm-pi-ai.providers.<route>`.
 *
 * A declared list replaces the route's catalog, so the block spells out every
 * id: the ones the installed catalog already knows plus the gateway-only ones.
 * @param snapshot - the panel state.
 * @returns YAML lines, or an empty list when nothing was read.
 */
export function buildSnippet(snapshot: DashboardSnapshot): string[] {
    // Only ids the endpoint actually serves belong in the override block. A
    // catalog-only id cannot be made selectable by declaring it.
    const served = snapshot.models.filter((row) => row.live)
    if (served.length === 0) return []
    const lines = [`providers:`, `  ${snapshot.route || 'opencode-go'}:`, `    models:`]
    for (const row of served) {
        lines.push(`      - id: ${row.id}`)
        if (row.contextWindow !== undefined) lines.push(`        contextWindow: ${row.contextWindow}`)
        if (row.maxTokens !== undefined) lines.push(`        maxTokens: ${row.maxTokens}`)
        if (row.input !== undefined && row.input.length > 0) lines.push(`        input: [${row.input.join(', ')}]`)
        if (row.reasoning === true) lines.push('        reasoning: true')
    }
    return lines
}

/**
 * Services that must be present before this panel registers.
 *
 * Only the boot-time ones: a `keyed` slot carries no `order`, so registering
 * with the boot-time group is as stable a position as this host allows.
 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the panel.
 * @param ctx - the plugin's client context.
 */
export function apply(ctx: ClientContext): void {
    ctx.effect(installStyles, 'dsh-llm-provider: panel styles')
    // The quota gauge rides the tool-card slot, keyed by the tool name, exactly
    // as a diagnostics card rides it: one component per tool call.
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'llm_quota',
        locale: NS,
        inject: () => ({}),
    }, QuotaToolView as never))
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-llm-provider: section locale')
    const scope = ctx.configForms.get<MonitorProfile>(NS)
    const face = createSectionFace(ctx, scope)
    // A section, not a plugin card: `settings.section` is a list slot whose
    // `order` makes the position stable.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'llm-providers',
        order: 50,
        label: () => face.t('sectionNav'),
        locale: NS,
        inject: () => face,
    }, LlmProvidersPanel as never))
}

export type { DashboardSnapshot, ModelRow } from './controller.ts'
export type { LlmProvidersFace, Translate } from './section-face.ts'
export { createSectionFace, NS } from './section-face.ts'
