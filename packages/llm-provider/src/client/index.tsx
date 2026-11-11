/* @gitawego/dsh-llm-provider browser plugin: the OpenCode Go card.
 *
 * What the card is for: the route's model decision. An OpenCode Go
 * subscription serves far more models than any one agent should be pointed at,
 * and the choice is per-route, not per-request — so the card shows the models
 * this route has enabled and lets the user choose from the served catalog.
 *
 * The card reads and writes the host provider profile
 * (`llm-pi-ai.providers.<route>.models`), because that route belongs to
 * `dsh-llm-pi-ai`; the dashboard does not serve a second wire.
 *
 * Design notes:
 * - Ids are monospaced and figures use tabular numerals, so the columns read as
 *   a spec sheet instead of ragged text.
 * - The picker is a native `<dialog>`: focus containment, Esc, and stacking
 *   above a scrolling settings panel are the platform's job.
 * - Every colour comes from the host's `--dsw-alias-*` tokens, so the card
 *   follows the theme (including dark mode) without its own palette.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
.lp-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.lp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.lp-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.lp-sub{margin:2px 0 0;font-family:var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.lp-chip{flex:none;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.lp-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.lp-section{display:flex;flex-direction:column;gap:8px}
.lp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lp-row--head{justify-content:space-between}
.lp-h{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.lp-state{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.lp-state[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.lp-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.lp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.lp-btn:disabled{opacity:.45;cursor:default}
.lp-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
.lp-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.lp-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.lp-model{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.lp-model:last-child{border-bottom:0}
.lp-id{font-family:var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-model[data-served="false"] .lp-id{color:var(--dsw-alias-state-warn-primary)}
.lp-num{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.lp-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lp-empty{padding:16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.lp-cfg{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
.lp-cfg>summary{cursor:pointer;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.lp-fields{display:grid;gap:10px;margin-top:12px}
.lp-field{display:grid;gap:4px}
.lp-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.lp-field input{width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.lp-field small{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lp-keyerror{color:var(--dsw-alias-state-error-primary)!important}
.lp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.lp-foot p{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lp-actions{display:flex;gap:8px}
.lp-note{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lpq-dialog{width:min(560px,92vw);max-height:80vh;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.lpq-dialog::backdrop{background:#0009}
.lp-dialog-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.lp-filter{flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.lp-list--dialog{max-height:46vh;overflow-y:auto;margin-top:8px}
.lp-list--dialog .lp-model{grid-template-columns:auto 1fr auto}
.lp-check{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary)}
${QUOTA_CSS}
`

/** Install the card's stylesheet once. */
function installStyles(): () => void {
    const style = document.createElement('style')
    style.dataset['dshLlmProvider'] = 'dashboard'
    style.textContent = CSS
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
        <div className="lp-field">
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

/** One enabled model row. */
function ModelLine(props: { row: ModelRow; t: LlmProvidersFace['t'] }): JSX.Element {
    const row = props.row
    const facts: string[] = []
    if (row.contextWindow !== undefined) facts.push(`${formatTokens(row.contextWindow)} ctx`)
    if (row.maxTokens !== undefined) facts.push(`${formatTokens(row.maxTokens)} out`)
    if (row.input !== undefined && row.input.length > 0) facts.push(row.input.join('+'))
    if (row.reasoning === true) facts.push('thinking')
    if (!row.live) facts.push(props.t('notServed'))
    return (
        <li className="lp-model" data-served={row.live}>
            <span className="lp-id">{row.id}</span>
            <span className="lp-num">{facts.join(' · ') || '—'}</span>
        </li>
    )
}

/** The full-catalog picker. */
function ModelPicker(props: {
    t: LlmProvidersFace['t']
    open: boolean
    rows: readonly ModelRow[]
    selected: readonly string[]
    error?: string
    onToggle: (id: string) => void
    onAll: () => void
    onNone: () => void
    onClose: () => void
    onApply: () => void
}): JSX.Element {
    const ref = useRef<HTMLDialogElement | null>(null)
    const [filter, setFilter] = useState('')
    useEffect(() => {
        const dialog = ref.current
        if (dialog === null) return
        if (props.open && !dialog.open) dialog.showModal()
        if (!props.open && dialog.open) dialog.close()
    }, [props.open])
    const selected = new Set(props.selected)
    const needle = filter.trim().toLowerCase()
    const visible = needle.length === 0
        ? props.rows
        : props.rows.filter((row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
    return (
        <dialog
            ref={ref}
            className="lpq-dialog"
            aria-label={props.t('pickModels')}
            onClose={props.onClose}
            onCancel={props.onClose}
        >
            <div className="lp-dialog-head">
                <h4 className="lp-title">{props.t('pickModels')}</h4>
                <span className="lp-state">
                    {fill(props.t('pickerCount'), { n: selected.size, total: props.rows.length })}
                </span>
            </div>
            <div className="lp-row">
                <input
                    className="lp-filter"
                    type="search"
                    value={filter}
                    placeholder={props.t('filterPlaceholder')}
                    onChange={(event) => { setFilter(event.target.value) }}
                />
                <div className="lp-actions">
                    <button type="button" className="lp-btn" onClick={props.onAll}>{props.t('pickAll')}</button>
                    <button type="button" className="lp-btn" onClick={props.onNone}>{props.t('pickNone')}</button>
                </div>
            </div>
            <ul className="lp-list lp-list--dialog">
                {visible.length === 0
                    ? <li className="lp-empty">{props.rows.length === 0 ? props.t('noModels') : props.t('noMatch')}</li>
                    : visible.map((row) => (
                        <li className="lp-model" key={row.id} data-served={row.live}>
                            <input
                                className="lp-check"
                                type="checkbox"
                                checked={selected.has(row.id)}
                                aria-label={row.id}
                                onChange={() => { props.onToggle(row.id) }}
                            />
                            <span className="lp-id">{row.id}</span>
                            <span className="lp-num">
                                {row.contextWindow !== undefined ? `${formatTokens(row.contextWindow)} ctx` : '—'}
                                {row.live ? '' : ` · ${props.t('notServed')}`}
                            </span>
                        </li>
                    ))}
            </ul>
            {props.error !== undefined ? <p className="lp-hint lp-keyerror">{props.error}</p> : null}
            <div className="lp-foot">
                <p>{props.t('pickHint')}</p>
                <div className="lp-actions">
                    <button type="button" className="lp-btn" onClick={props.onClose}>{props.t('cancel')}</button>
                    <button type="button" className="lp-btn lp-btn--primary" onClick={props.onApply}>{props.t('apply')}</button>
                </div>
            </div>
        </dialog>
    )
}

/** The dashboard card. */
export function LlmProvidersPanel(props: PropsRuntime<'settings.section'> & InjectFace<LlmProvidersFace>): JSX.Element {
    const t = props.t
    const snapshot = props.useDashboard((value) => value)
    const [pickerOpen, setPickerOpen] = useState(false)
    const [draft, setDraft] = useState<string[]>([])
    const [writeError, setWriteError] = useState<string | undefined>()

    const served = useMemo(() => snapshot.models.filter((row) => row.live), [snapshot.models])
    const enabledRows = useMemo(() => {
        if (snapshot.enabledIds === null) return served
        const byId = new Map(snapshot.models.map((row) => [row.id, row]))
        return snapshot.enabledIds.map((id): ModelRow => byId.get(id) ?? {
            id,
            name: id,
            known: false,
            live: false,
        })
    }, [served, snapshot.enabledIds, snapshot.models])
    const pickerRows = useMemo(() => {
        const rows = [...served]
        const seen = new Set(rows.map((row) => row.id))
        for (const row of enabledRows) {
            if (!seen.has(row.id)) {
                rows.push(row)
                seen.add(row.id)
            }
        }
        return rows
    }, [served, enabledRows])
    const enabledLabel = snapshot.enabledIds === null
        ? fill(t('allEnabled'), { n: served.length })
        : fill(t('enabledOf'), { n: enabledRows.length, total: pickerRows.length })

    const openPicker = (): void => {
        setDraft(snapshot.enabledIds ?? served.map((row) => row.id))
        setWriteError(undefined)
        setPickerOpen(true)
    }
    const closePicker = (): void => { setPickerOpen(false) }
    const toggle = (id: string): void => {
        setDraft((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
    }
    const apply = (): void => {
        const selected = draft
            .map((id) => pickerRows.find((row) => row.id === id))
            .filter((row): row is ModelRow => row !== undefined)
        void props.actions.setEnabledModels(selected).then((accepted) => {
            if (accepted) setPickerOpen(false)
            else setWriteError(t('writeFailed'))
        })
    }

    return (
        <div className="lp-card">
            <div className="lp-head">
                <div>
                    <h2 className="lp-title">{t('sectionTitle')}</h2>
                    <p className="lp-sub">{snapshot.endpoint || '—'}</p>
                </div>
                <span className="lp-chip" data-on={snapshot.credentialPresent}>
                    {snapshot.credentialPresent ? t('credentialPresent') : t('credentialMissing')}
                </span>
            </div>
            <div className="lp-row">
                <span className="lp-id">{snapshot.route || '—'}</span>
                <span className="lp-state">
                    {snapshot.fetchedAt === 0 ? t('never') : fill(t('readAt'), { age: formatAge(snapshot.fetchedAt, Date.now()) })}
                </span>
                <button className="lp-btn" type="button" onClick={props.actions.refresh}>{t('refresh')}</button>
            </div>
            {snapshot.error !== undefined ? <p className="lp-hint lp-keyerror">{`${t('failed')}: ${snapshot.error}`}</p> : null}
            <div className="lp-section">
                <div className="lp-row lp-row--head">
                    <h3 className="lp-h">{t('models')}</h3>
                    <span className="lp-state">{enabledLabel}</span>
                    <button
                        className="lp-btn"
                        type="button"
                        disabled={!snapshot.providerWritable || served.length === 0}
                        onClick={openPicker}
                    >
                        {t('chooseModels')}
                    </button>
                </div>
                {enabledRows.length === 0
                    ? <p className="lp-hint">{t('noEnabled')}</p>
                    : (
                        <ul className="lp-list">
                            {enabledRows.map((row) => <ModelLine key={row.id} row={row} t={t} />)}
                        </ul>
                    )}
            </div>
            <details className="lp-cfg">
                <summary>{t('routeSettings')}</summary>
                <div className="lp-fields">
                    <Field
                        id="lp-route"
                        label={t('route')}
                        hint={t('routeHint')}
                        value={snapshot.route}
                        disabled={!snapshot.writable}
                        onCommit={(text) => { props.actions.edit('route', text) }}
                    />
                    <Field
                        id="lp-endpoint"
                        label={t('endpoint')}
                        hint={t('endpointHint')}
                        value={snapshot.endpoint}
                        disabled={!snapshot.writable}
                        onCommit={(text) => { props.actions.edit('baseURL', text) }}
                    />
                    <Field
                        id="lp-credential"
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
            </details>
            <QuotaGauges view={snapshot.quota} />
            <ModelPicker
                t={t}
                open={pickerOpen}
                rows={pickerRows}
                selected={draft}
                {...(writeError !== undefined ? { error: writeError } : {})}
                onToggle={toggle}
                onAll={() => { setDraft(pickerRows.map((row) => row.id)) }}
                onNone={() => { setDraft([]) }}
                onClose={closePicker}
                onApply={apply}
            />
        </div>
    )
}

/**
 * Render the `models:` block a user pastes into `llm-pi-ai.providers.<route>`.
 *
 * A declared list replaces the route's catalog, so the block spells out every
 * id the route should offer. Only served ids belong here; a catalog-only id
 * cannot be made selectable by declaring it.
 * @param snapshot - the panel state.
 * @returns YAML lines, or an empty list when nothing was read.
 */
export function buildSnippet(snapshot: DashboardSnapshot): string[] {
    const served = snapshot.models.filter((row) => row.live)
    if (served.length === 0) return []
    const lines = [`providers:`, `  ${snapshot.route || 'opencode-go'}:`, `    models:`]
    for (const row of served) {
        lines.push(`      - id: ${row.id}`)
        if (row.contextWindow !== undefined) lines.push(`        contextWindow: ${row.contextWindow}`)
        if (row.maxTokens !== undefined) lines.push(`        maxTokens: ${row.maxTokens}`)
        if (row.input !== undefined && row.input.length > 0) lines.push(`        input: [${row.input.join(', ')}]`)
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
