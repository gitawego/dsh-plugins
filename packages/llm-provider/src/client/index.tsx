/* @gitawego/dsh-llm-provider browser plugin: the OpenCode Go card.
 *
 * Registers one `settings.plugin.item` entry keyed by the `llm-provider`
 * settings namespace, so it lands in Settings → Plugins → Plugin configuration
 * beside every other plugin card.
 *
 * What the card is for: the route's model decision. An OpenCode Go
 * subscription serves far more models than any one agent should be pointed at,
 * and the choice is per-route, not per-request — so the card shows the live
 * catalog the host reads from the provider endpoint (context window and output
 * cap per model) and lets the user pin the ones this route may use. The
 * allowance windows live in `/llm-provider quota`, because the browser has no
 * path to the provider's usage endpoint; the card says so rather than showing a
 * gauge it cannot fill.
 *
 * Design notes:
 * - Ids are monospaced and figures use tabular numerals, so the columns read as
 *   a spec sheet instead of ragged text.
 * - The pin control is the card's one interactive idea: a filled marker means
 *   "this route may use this model", and the state line above the list always
 *   states the rule in words ("all 36 available" / "2 of 36 pinned").
 * - A pinned model the provider no longer serves stays visible and marked, so a
 *   dead pin can be removed instead of hiding behind the UI.
 * - Every colour comes from the host's `--dsw-alias-*` tokens, so the card
 *   follows the theme (including dark mode) without its own palette.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import './remote-types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
    createProviderCard,
    FIELDS,
    REASONING_LEVELS,
    type CardSnapshot,
    type FieldName,
    type ProviderCard,
    type ProviderSections,
} from './controller.ts'
import { en, zh } from './strings.ts'
import { QUOTA_CSS, QuotaToolView } from './quota-view.tsx'
// The route key comes from the same table the adapter registers, so a rename
// cannot leave the card editing a section nothing serves.
import { OPENCODE_GO } from '../gateways.ts'

const NS = 'llm-provider'
const ROUTE = OPENCODE_GO.id


/* Pure-type augmentation for the `settings.plugin.item` slot, mirroring
 * `dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`. The
 * tab owns the slot; this plugin contributes one keyed entry. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'settings.plugin.item': {
            kind: 'keyed'
            scope: 'root'
            owner: { children?: never }
        }
    }
    /* Registering a namespace is what lets `ctx.locale.bind(NS)` type-check and
     * what makes a missing translation a compile error rather than a key shown
     * to the user. */
    interface LocaleNamespaceMap {
        'llm-provider': keyof typeof en
    }
}

type Translate = (key: keyof typeof en) => string

/** The face the slot registration injects into the component. */
interface OpenCodeGoCardFace {
    hooks: { card: { getSnapshot: () => CardSnapshot; subscribe: (listener: () => void) => () => void } }
    refresh: () => void
    togglePin: (modelId: string) => void
    useAll: () => void
    edit: (field: FieldName, text: string) => void
    discard: () => void
    save: () => void
    editApiKey: (text: string) => void
    saveApiKey: () => void
    openPicker: () => void
    closePicker: () => void
    togglePickerModel: (modelId: string) => void
    selectAllModels: () => void
    clearSelection: () => void
    applyPicker: () => void
}

const CSS = `
.lp-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.lp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.lp-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.lp-sub{margin:2px 0 0;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.lp-chip{flex:none;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.lp-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.lp-section{display:flex;flex-direction:column;gap:8px}
.lp-row{display:flex;align-items:center;gap:10px}
.lp-row--head{justify-content:space-between}
.lp-h{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.lp-state{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.lp-state[data-tone="warn"]{color:var(--dsw-alias-label-error)}
.lp-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.lp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.lp-btn:disabled{opacity:.45;cursor:default}
.lp-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:#0000}
.lp-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.lp-filter{width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}
.lp-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.lp-model{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.lp-model:last-child{border-bottom:0}
.lp-model[data-advertised="true"]{background:var(--dsw-alias-bg-layer-3)}
.lp-pin{display:grid;place-items:center;width:16px;height:16px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;cursor:pointer}
.lp-pin[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.lp-pin::after{content:"";width:6px;height:6px;border-radius:1px;background:var(--dsw-alias-label-primary-inverted);opacity:0}
.lp-pin[aria-pressed="true"]::after{opacity:1}
.lp-id{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-model[data-served="false"] .lp-id{color:var(--dsw-alias-label-error)}
.lp-num{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.lp-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lp-empty{padding:16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.lp-cfg{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
.lp-cfg>summary{cursor:pointer;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.lp-fields{display:grid;gap:10px;margin-top:12px}
.lp-field{display:grid;gap:4px}
.lp-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.lp-field input,.lp-field select{width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px}
.lp-field input[aria-invalid="true"]{border-color:var(--dsw-alias-label-error)}
.lp-field small{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lp-keyrow{display:flex;gap:8px}
.lp-keyrow input{flex:1}
.lp-keyerror{color:var(--dsw-alias-label-error)!important}
${QUOTA_CSS}
.lp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.lp-foot p{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lp-actions{display:flex;gap:8px}
.lp-note{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.lpq-dialog{width:min(560px,92vw);max-height:80vh;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.lpq-dialog::backdrop{background:#0009}
.lpq-dialog .lp-dialog-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.lp-list--dialog{max-height:46vh;margin-top:8px}
.lp-list--dialog .lp-model{grid-template-columns:auto 1fr auto auto auto}
`

/** Install the card's stylesheet once, and remove it with the plugin. */
function installStyles(): () => void {
    const selector = 'style[data-plugin-css="dsh-llm-provider/card"]'
    if (document.querySelector(selector) !== null) return () => {}
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-llm-provider'
    style.dataset.pluginCss = 'dsh-llm-provider/card'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => {
        style.remove()
    }
}

/** Compact token counts: `1M`, `384k`, `1.05M`. */
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
    const seconds = Math.max(0, Math.round((now - at) / 1000))
    if (seconds < 10) return 'just now'
    if (seconds < 90) return `${seconds}s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 90) return `${minutes}m ago`
    return `${Math.round(minutes / 60)}h ago`
}

/** One labelled control. */
function Field(props: {
    id: string
    label: string
    hint?: string
    value: string
    invalid?: boolean
    disabled: boolean
    onChange: (text: string) => void
    children?: never
}): JSX.Element {
    return (
        <div className="lp-field">
            <label htmlFor={props.id}>{props.label}</label>
            <input
                id={props.id}
                value={props.value}
                disabled={props.disabled}
                aria-invalid={props.invalid === true}
                onChange={(event) => { props.onChange(event.target.value) }}
            />
            {props.hint !== undefined ? <small>{props.hint}</small> : null}
        </div>
    )
}

/** One selectable configuration value. */
function Select(props: {
    id: string
    label: string
    hint?: string
    value: string
    options: { value: string; label: string }[]
    disabled: boolean
    onChange: (text: string) => void
}): JSX.Element {
    return (
        <div className="lp-field">
            <label htmlFor={props.id}>{props.label}</label>
            <select id={props.id} value={props.value} disabled={props.disabled} onChange={(event) => { props.onChange(event.target.value) }}>
                {props.options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
            {props.hint !== undefined ? <small>{props.hint}</small> : null}
        </div>
    )
}

/**
 * The API key control.
 *
 * A stored key is a secret the browser never receives, so this field cannot be
 * seeded: it starts blank, a blank draft writes nothing, and the only facts it
 * shows are whether a key is configured and whether the last write landed.
 */
function ApiKeyField(props: {
    t: Translate
    state: CardSnapshot['apiKey']
    disabled: boolean
    onEdit: (text: string) => void
    onSave: () => void
}): JSX.Element {
    const { t, state } = props
    const status = state.configured === undefined ? t('apiKeyUnknown') : state.configured ? t('apiKeyStored') : t('apiKeyMissing')
    const canSave = !props.disabled && !state.saving && state.draft.trim().length > 0 && state.reference.length > 0
    return (
        <div className="lp-field">
            <label htmlFor="lp-api-key">{t('apiKey')}</label>
            <div className="lp-keyrow">
                <input
                    id="lp-api-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={state.draft}
                    disabled={props.disabled || state.saving}
                    placeholder={state.configured === true ? '••••••••' : ''}
                    onChange={(event) => { props.onEdit(event.target.value) }}
                />
                <button type="button" className="lp-btn" disabled={!canSave} onClick={props.onSave}>
                    {state.saving ? t('apiKeySaving') : t('apiKeySave')}
                </button>
            </div>
            <small className={state.error !== undefined ? 'lp-keyerror' : undefined}>
                {state.error ?? (state.saved ? `${t('apiKeyStoredNow')} ${status}` : status)}
            </small>
            <small>{t('apiKeyHint')}</small>
        </div>
    )
}

/** The stored value of one field, as draft text. */
function draftOf(snapshot: CardSnapshot, field: FieldName): string {
    const staged = snapshot.drafts[field]
    if (staged !== undefined) return staged
    switch (field) {
        case 'apiKeyEnv': return snapshot.credential
        case 'baseURL': return snapshot.endpoint
        case 'sessionRouting': return String(snapshot.sessionRouting)
        default: return ''
    }
}

/**
 * The model picker.
 *
 * A native `<dialog>` rather than a hand-rolled overlay: focus containment, Esc,
 * and stacking above the app are the platform's job, and a settings card inside
 * a scrolling panel is exactly where a custom overlay gets those wrong.
 *
 * The dialog is the catalog browser; the card's own list is the decision. That
 * split is what lets the card show only the models this route may use without
 * hiding the ones it may not.
 */
function ModelPicker(props: {
    t: Translate
    state: CardSnapshot['picker']
    models: CardSnapshot['models']
    disabled: boolean
    onToggle: (modelId: string) => void
    onAll: () => void
    onNone: () => void
    onClose: () => void
    onApply: () => void
}): JSX.Element {
    const { t, state } = props
    const ref = useRef<HTMLDialogElement | null>(null)
    const [filter, setFilter] = useState('')

    useEffect(() => {
        const dialog = ref.current
        if (dialog === null) return
        if (props.state.open && !dialog.open) dialog.showModal()
        if (!props.state.open && dialog.open) dialog.close()
    }, [props.state.open])

    const selected = new Set(state.selected)
    const needle = filter.trim().toLowerCase()
    const visible = needle.length === 0
        ? props.models
        : props.models.filter((row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))

    return (
        <dialog
            ref={ref}
            className="lpq-dialog"
            aria-label={t('pickModels')}
            onClose={props.onClose}
            onCancel={props.onClose}
        >
            <div className="lp-dialog-head">
                <h4 className="lp-title">{t('pickModels')}</h4>
                <span className="lp-state">{t('pickerCount').replace('{n}', String(state.selected.length)).replace('{served}', String(state.served))}</span>
            </div>
            <div className="lp-row lp-row--head">
                <input
                    className="lp-filter"
                    type="search"
                    value={filter}
                    placeholder={t('filterPlaceholder')}
                    onChange={(event) => { setFilter(event.target.value) }}
                />
                <div className="lp-actions">
                    <button type="button" className="lp-btn" onClick={props.onAll}>{t('pickAll')}</button>
                    <button type="button" className="lp-btn" onClick={props.onNone}>{t('pickNone')}</button>
                </div>
            </div>
            <ul className="lp-list lp-list--dialog">
                {visible.length === 0
                    ? <li className="lp-empty">{props.models.length === 0 ? t('noModels') : t('noMatch')}</li>
                    : visible.map((row) => (
                        <li className="lp-model" key={row.id} data-advertised={String(selected.has(row.id))} data-served={String(row.served)}>
                            <input
                                type="checkbox"
                                aria-label={row.id}
                                checked={selected.has(row.id)}
                                onChange={() => { props.onToggle(row.id) }}
                            />
                            <span className="lp-id" title={row.id}>{row.id}</span>
                            <span className="lp-num">{formatTokens(row.contextWindow)} ctx</span>
                            <span className="lp-num">{formatTokens(row.maxTokens)} out</span>
                            {row.served ? null : <span className="lp-num">{t('retired')}</span>}
                        </li>
                    ))}
            </ul>
            <div className="lp-foot">
                <p>{t('pickerHint')}</p>
                <div className="lp-actions">
                    <button type="button" className="lp-btn" onClick={props.onClose}>{t('cancel')}</button>
                    <button type="button" className="lp-btn lp-btn--primary" disabled={props.disabled} onClick={props.onApply}>{t('pickApply')}</button>
                </div>
            </div>
        </dialog>
    )
}

/** One model row: the pin control, the id, and its capacities. */
function ModelRowView(props: {
    row: CardSnapshot['models'][number]
    disabled: boolean
    pinLabel: string
    unpinLabel: string
    retiredLabel: string
    onToggle: () => void
}): JSX.Element {
    const { row } = props
    return (
        <li className="lp-model" data-advertised={String(row.advertised)} data-served={String(row.served)}>
            <button
                type="button"
                className="lp-pin"
                aria-pressed={row.pinned}
                aria-label={`${row.pinned ? props.unpinLabel : props.pinLabel}: ${row.id}`}
                disabled={props.disabled}
                onClick={props.onToggle}
            />
            <span className="lp-id" title={row.id}>{row.id}</span>
            <span className="lp-num">{formatTokens(row.contextWindow)} ctx</span>
            <span className="lp-num">{formatTokens(row.maxTokens)} out</span>
            {row.served ? null : <span className="lp-num">{props.retiredLabel}</span>}
        </li>
    )
}

export type OpenCodeGoCardProps = PropsRuntime<'settings.plugin.item'> & InjectFace<OpenCodeGoCardFace> & { t: Translate }

/** The card. */
export function OpenCodeGoCard(props: OpenCodeGoCardProps): JSX.Element {
    const t = props.t
    const snapshot = props.useCard((value) => value)
    const [filter, setFilter] = useState('')
    // The clock only exists to age the "read N ago" line; re-reading it on an
    // interval would re-render the whole card every second for a label.
    const nowRef = useRef(Date.now())
    const [showFilter, setShowFilter] = useState(false)

    useEffect(() => {
        props.refresh()
    }, [])

    // The card lists what the route may use. What it may not lives in the
    // picker, where the decision is made, so the list never doubles as a
    // catalog browser.
    const needle = filter.trim().toLowerCase()
    const visible = needle.length === 0
        ? snapshot.advertisedModels
        : snapshot.advertisedModels.filter((row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))

    const stateLine = snapshot.catalog.state === 'loading'
        ? t('reading')
        : snapshot.catalog.state === 'failed'
            ? `${t('readFailed')}: ${snapshot.catalog.reason}`
            : snapshot.servedCount === 0
                ? t('noModels')
                : snapshot.advertisesAll
                    ? `${t('allAvailable').replace('{n}', String(snapshot.servedCount))}`
                    : `${t('pinnedOf').replace('{pinned}', String(snapshot.advertisedCount)).replace('{served}', String(snapshot.servedCount))}`

    const busy = snapshot.saving

    return (
        <li className="lp-card">
            <div className="lp-head">
                <div>
                    <h3 className="lp-title">{t('routeName')}</h3>
                    <p className="lp-sub">{snapshot.route}{snapshot.endpoint.length > 0 ? ` · ${snapshot.endpoint}` : ''}</p>
                </div>
                <span className="lp-chip" data-on={String(snapshot.sessionRouting)}>
                    {snapshot.sessionRouting ? t('sessionOn') : t('sessionOff')}
                </span>
            </div>

            <section className="lp-section">
                <div className="lp-row lp-row--head">
                    <h4 className="lp-h">{t('models')}</h4>
                    <span className="lp-state" data-tone={snapshot.catalog.state === 'failed' ? 'warn' : undefined}>{stateLine}</span>
                </div>
                <div className="lp-row lp-row--head">
                    <p className="lp-hint">
                        {snapshot.catalog.state === 'ready'
                            ? `${t('read')} ${formatAge(snapshot.catalog.at, nowRef.current)}`
                            : t('catalogHint')}
                    </p>
                    <div className="lp-actions">
                        {snapshot.advertisedModels.length > 8
                            ? (
                                <button type="button" className="lp-btn" onClick={() => { setShowFilter((value) => !value) }}>
                                    {showFilter ? t('hideFilter') : t('filter')}
                                </button>
                            )
                            : null}
                        <button type="button" className="lp-btn" disabled={!snapshot.writable || busy} onClick={props.openPicker}>
                            {t('pickModels')}
                        </button>
                        <button type="button" className="lp-btn" disabled={snapshot.catalog.state === 'loading'} onClick={props.refresh}>
                            {t('refresh')}
                        </button>
                    </div>
                </div>
                {showFilter && snapshot.advertisedModels.length > 8
                    ? (
                        <input
                            className="lp-filter"
                            type="search"
                            value={filter}
                            placeholder={t('filterPlaceholder')}
                            onChange={(event) => { setFilter(event.target.value) }}
                        />
                    )
                    : null}
                <ul className="lp-list">
                    {visible.length === 0
                        ? <li className="lp-empty">{snapshot.models.length === 0 ? t('noModels') : t('noMatch')}</li>
                        : visible.map((row) => (
                            <ModelRowView
                                key={row.id}
                                row={row}
                                disabled={!snapshot.writable || busy}
                                pinLabel={t('pin')}
                                unpinLabel={t('unpin')}
                                retiredLabel={t('retired')}
                                onToggle={() => { props.togglePin(row.id) }}
                            />
                        ))}
                </ul>
                {snapshot.withheldCount > 0
                    ? <p className="lp-hint">{t('withheld').replace('{n}', String(snapshot.withheldCount))}</p>
                    : null}
                <p className="lp-hint">{t('allowlistRule')}</p>
                {snapshot.advertisesAll
                    ? null
                    : (
                        <div className="lp-row">
                            <button type="button" className="lp-btn" disabled={!snapshot.writable || busy} onClick={props.useAll}>
                                {t('useAll')}
                            </button>
                        </div>
                    )}
            </section>

            <details className="lp-cfg">
                <summary>{t('configuration')}</summary>
                <div className="lp-fields">
                    <ApiKeyField
                        t={t}
                        state={snapshot.apiKey}
                        disabled={!snapshot.writable}
                        onEdit={props.editApiKey}
                        onSave={props.saveApiKey}
                    />
                    <Field
                        id="lp-credential"
                        label={t('credential')}
                        hint={t('credentialHint')}
                        value={draftOf(snapshot, 'apiKeyEnv')}
                        invalid={snapshot.invalid['apiKeyEnv']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('apiKeyEnv', text) }}
                    />
                    <Field
                        id="lp-endpoint"
                        label={t('endpoint')}
                        hint={t('endpointHint')}
                        value={draftOf(snapshot, 'baseURL')}
                        invalid={snapshot.invalid['baseURL']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('baseURL', text) }}
                    />
                    <Select
                        id="lp-session"
                        label={t('sessionRouting')}
                        hint={t('sessionRoutingHint')}
                        value={draftOf(snapshot, 'sessionRouting')}
                        options={[{ value: 'true', label: t('on') }, { value: 'false', label: t('off') }]}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('sessionRouting', text) }}
                    />
                    <Select
                        id="lp-reasoning"
                        label={t('reasoning')}
                        hint={t('reasoningHint')}
                        value={snapshot.drafts['reasoning'] ?? ''}
                        options={REASONING_LEVELS.map((level) => ({ value: level, label: level === '' ? t('providerDefault') : level }))}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('reasoning', text) }}
                    />
                    <Field
                        id="lp-pixels"
                        label={t('pixels')}
                        hint={t('pixelsHint')}
                        value={snapshot.drafts['requestImagePixelBudget'] ?? ''}
                        invalid={snapshot.invalid['requestImagePixelBudget']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('requestImagePixelBudget', text) }}
                    />
                    <Field
                        id="lp-image-bytes"
                        label={t('imageBytes')}
                        hint={t('imageBytesHint')}
                        value={snapshot.drafts['requestImageMaxBytes'] ?? ''}
                        invalid={snapshot.invalid['requestImageMaxBytes']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('requestImageMaxBytes', text) }}
                    />
                    <Field
                        id="lp-request-bytes"
                        label={t('requestBytes')}
                        hint={t('requestBytesHint')}
                        value={snapshot.drafts['maxRequestImageBytes'] ?? ''}
                        invalid={snapshot.invalid['maxRequestImageBytes']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { props.edit('maxRequestImageBytes', text) }}
                    />
                </div>
            </details>

            <div className="lp-foot">
                <p>{t('quotaHint')}</p>
                <div className="lp-actions">
                    {snapshot.saveFailed ? <span className="lp-state" data-tone="warn">{t('saveFailed')}</span> : null}
                    <button
                        type="button"
                        className="lp-btn"
                        disabled={!snapshot.dirty || busy}
                        onClick={props.discard}
                    >
                        {t('discard')}
                    </button>
                    <button
                        type="button"
                        className="lp-btn lp-btn--primary"
                        disabled={!snapshot.dirty || busy || !snapshot.writable || Object.keys(snapshot.invalid).length > 0}
                        onClick={props.save}
                    >
                        {busy ? t('saving') : t('save')}
                    </button>
                </div>
            </div>

            <ModelPicker
                t={t}
                state={snapshot.picker}
                models={snapshot.models}
                disabled={!snapshot.writable || busy}
                onToggle={props.togglePickerModel}
                onAll={props.selectAllModels}
                onNone={props.clearSelection}
                onClose={props.closePicker}
                onApply={props.applyPicker}
            />
        </li>
    )
}

/** Bring the card's face to the component, keyed by the settings namespace. */
export function createFace(ctx: ClientContext, scope: SettingsScope<ProviderSections>): OpenCodeGoCardFace {
    /**
     * The Remote face, bound in a fiber that declares the scoped namespaces.
     * Undefined until the carrier is up; every read reports that as a reason
     * rather than as a failure.
     */
    let remote: ClientContext['remote'] | undefined
    ctx.inject(['remote', 'remote.llm', 'remote.credentials'], (injected: ClientContext) => {
        remote = injected.remote
        return () => {
            remote = undefined
        }
    })
    const carrier = (): ClientContext['remote'] => {
        if (remote === undefined) throw new Error('the Remote carrier is still connecting; try again in a moment')
        return remote
    }

    const controller: ProviderCard = createProviderCard({
        scope,
        route: ROUTE,
        describeCredential: async (reference) => {
            const response = await carrier().credentials.describe([reference])
            if (!response.ok) throw new Error(response.error.message)
            return response.value[reference]?.configured === true
        },
        writeCredential: async (reference, value) => {
            const response = await carrier().credentials.set(reference, value)
            if (!response.ok) throw new Error(response.error.message)
        },
        discover: async (route) => {
            const result = await carrier().llm.discoverModels(NS, { provider: route })
            if (!result.ok) throw new Error(result.error.message)
            return result.value.map((model) => ({
                id: model.id,
                ...(model.name !== undefined ? { name: model.name } : {}),
                ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
                ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
            }))
        },
    })
    return {
        hooks: { card: { getSnapshot: controller.getSnapshot, subscribe: controller.subscribe } },
        refresh: () => { void controller.refresh() },
        togglePin: (modelId) => { void controller.togglePin(modelId) },
        useAll: () => { void controller.useAll() },
        edit: (field, text) => { controller.edit(field, text) },
        discard: () => { controller.discard() },
        save: () => { void controller.save() },
        editApiKey: (text) => { controller.editApiKey(text) },
        saveApiKey: () => { void controller.saveApiKey() },
        openPicker: () => { controller.openPicker() },
        closePicker: () => { controller.closePicker() },
        togglePickerModel: (modelId) => { controller.togglePickerModel(modelId) },
        selectAllModels: () => { controller.selectAllModels() },
        clearSelection: () => { controller.clearSelection() },
        applyPicker: () => { void controller.applyPicker() },
    }
}

/**
 * Services that must be present before this card registers.
 *
 * Only the boot-time ones. The Remote namespaces are bound separately, in a
 * child fiber (see `apply`), for two reasons:
 *
 * - **Order.** The Plugins tab renders cards in slot-registration order — a
 *   `keyed` slot carries no `order` field, so a plugin cannot ask for a
 *   position — and bundles load concurrently. Waiting on `remote.llm`, which
 *   only exists once the Remote carrier has connected, made this card register
 *   whenever the socket handshake happened to finish, so it moved between
 *   reloads. Registering with the boot-time group is as stable as this host
 *   allows.
 * - **Availability.** A card that cannot register until the carrier is up is a
 *   card the user cannot see, for as long as the carrier is down.
 *
 * The scoped namespaces are still declared — in the fiber that reads them —
 * because cordis refuses to resolve `ctx.remote.llm` from a context that has not
 * declared it (`cannot get property "remote.llm" without inject`).
 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the card.
 * @param ctx - the plugin's client context.
 */
export function apply(ctx: ClientContext): void {
    ctx.effect(installStyles, 'dsh-llm-provider: card styles')
    // The quota gauge rides the tool-card slot, keyed by the tool name, exactly
    // as a diagnostics card rides it: one component per tool call.
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'llm_quota',
        locale: NS,
        inject: () => ({}),
    }, QuotaToolView as never))
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-llm-provider: card locale')
    const scope = ctx.settingsScope.bind<ProviderSections>({ namespace: NS })
    const face = createFace(ctx, scope)
    const t = ctx.locale.bind(NS) as unknown as Translate
    const Bound = (props: OpenCodeGoCardProps): JSX.Element => <OpenCodeGoCard {...props} t={props.t ?? t} />
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        locale: NS,
        inject: () => face,
    }, Bound as never))
}

export type { ProviderSections, CardSnapshot, FieldName }
export type { TranslateNS }
export { FIELDS }
