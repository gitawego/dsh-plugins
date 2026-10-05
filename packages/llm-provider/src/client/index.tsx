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
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { InjectFace, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { FIELDS, REASONING_LEVELS, type CardSnapshot, type FieldName, type ProviderSections } from './controller.ts'
import {
    NS,
    createSectionFace,
    type LlmProvidersFace,
    type ProviderActions,
    type ProvidersSnapshot,
    type Translate,
} from './section-face.ts'
import { providerSummary } from './models-page.ts'
import { en, zh } from './strings.ts'
import { QUOTA_CSS, QuotaGauges, QuotaToolView } from './quota-view.tsx'
// The route key comes from the same table the adapter registers, so a rename
// cannot leave the card editing a section nothing serves.
import { GATEWAYS } from '../gateways.ts'

/** Routes this build serves, in gateway order — one panel each. */
const ROUTES: readonly string[] = GATEWAYS.map((gateway) => gateway.id)


/* Pure-type augmentation for the locale namespace this plugin registers, so a
 * missing translation is a compile error rather than a key shown to the user.
 * The slot types it contributes to (`settings.section`,
 * `settings.models.provider-card`) are declared by their owning packages. */
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
.lpp{display:flex;flex-direction:column;gap:14px}
.lpp-head{display:flex;flex-direction:column;gap:4px}
.lpp-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
.lpp-intro{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);max-width:60ch}
.lpp .lp-card{background:var(--dsw-alias-bg-layer-2)}
.lp-models-page{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.lp-path{padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
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
    /** Copy variant: the section has the reference field above it, the Models page does not. */
    hint?: string
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
            <small>{props.hint ?? t('apiKeyHint')}</small>
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

/**
 * The extension card the Models page renders inside our provider's row.
 *
 * The section's own editor cannot configure this route — its `layoutOf()`
 * recognises only `llm-deepseek` and `llm-pi-ai`, so it shows "Other fields live
 * in settings.yaml" and disables Apply, and it reports "Model 1: Model ID is
 * required" because our `models` is an allowlist of ids where it expects model
 * objects. So this card answers the two questions that page leaves open: where
 * the rest of the settings live, and how to set the key.
 *
 * A *link* to the settings screen is not available: the dialog's open state and
 * active section are component-local React state in the shell, with no store,
 * service, or hash route for a plugin to drive. The location is therefore named
 * exactly, and the one control that page exists for is offered here.
 *
 * It reads the SAME controller as the section, so the counts here and there
 * cannot disagree.
 */
export function ModelsProviderCard(
    props: PropsRuntime<'settings.models.provider-card'> & InjectFace<LlmProvidersFace>,
): JSX.Element | null {
    const t = props.t
    const snapshot = props.useProviders((value) => value)
    const entry = snapshot.providers[0]
    if (entry === undefined) return null
    const card = entry.card
    const face = props.byRoute[entry.route]
    if (face === undefined) return null
    return (
        <div className="lp-models-page">
            <p className="lp-hint">
                {t('modelsPageWhere')} <span className="lp-path">{t('modelsPageSection')}</span>
            </p>
            <p className="lp-hint">{t('modelsPageManaged')}</p>
            <p className="lp-state">{providerSummary(card, t)}</p>
            <p className="lp-hint">
                {t('modelsPageRef')}: <span className="lp-id">{card.apiKey.reference.length > 0 ? card.apiKey.reference : t('modelsPageNoRef')}</span>
            </p>
            <ApiKeyField
                t={t}
                state={card.apiKey}
                disabled={!card.writable}
                onEdit={face.editApiKey}
                onSave={face.saveApiKey}
                hint={t('apiKeyHintPage')}
            />
        </div>
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

/**
 * One provider's panel: its models, its allowance, and its configuration.
 *
 * A pure function of props rather than a slot component with hooks of its own,
 * so the section can render one per served route from a single snapshot — which
 * is what makes "we can add more providers" a data change instead of a
 * registration change.
 */
export function ProviderPanel(props: {
    t: Translate
    route: string
    card: CardSnapshot
    face: ProviderActions
}): JSX.Element {
    const t = props.t
    const face = props.face
    const snapshot = props.card
    const [filter, setFilter] = useState('')
    // The clock only exists to age the "read N ago" line; re-reading it on an
    // interval would re-render the whole card every second for a label.
    const nowRef = useRef(Date.now())
    const [showFilter, setShowFilter] = useState(false)

    useEffect(() => {
        face.refresh()
        // One allowance read per card mount: it spends the stored credential on
        // one provider request, so it is on demand rather than on a timer.
        face.refreshQuota()
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
        <section className="lp-card" aria-label={t('routeName')}>
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
                        <button type="button" className="lp-btn" disabled={!snapshot.writable || busy} onClick={face.openPicker}>
                            {t('pickModels')}
                        </button>
                        <button type="button" className="lp-btn" disabled={snapshot.catalog.state === 'loading'} onClick={face.refresh}>
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
                                onToggle={() => { face.togglePin(row.id) }}
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
                            <button type="button" className="lp-btn" disabled={!snapshot.writable || busy} onClick={face.useAll}>
                                {t('useAll')}
                            </button>
                        </div>
                    )}
            </section>

            <section className="lp-section">
                <div className="lp-row lp-row--head">
                    <h4 className="lp-h">{t('allowance')}</h4>
                    <div className="lp-actions">
                        <span className="lp-state" data-tone={snapshot.quota.state === 'failed' ? 'warn' : undefined}>
                            {snapshot.quota.state === 'loading'
                                ? t('reading')
                                : snapshot.quota.state === 'failed'
                                    ? `${t('readFailed')}: ${snapshot.quota.reason}`
                                    : snapshot.quota.state === 'ready'
                                        ? `${t('read')} ${formatAge(snapshot.quota.at, nowRef.current)}`
                                        : t('quotaHint')}
                        </span>
                        <button type="button" className="lp-btn" disabled={snapshot.quota.state === 'loading'} onClick={face.refreshQuota}>
                            {t('refresh')}
                        </button>
                    </div>
                </div>
                {snapshot.quota.state === 'ready'
                    ? <QuotaGauges view={snapshot.quota.view} />
                    : <p className="lp-hint">{t('quotaHint')}</p>}
            </section>

            <details className="lp-cfg">
                <summary>{t('configuration')}</summary>
                <div className="lp-fields">
                    <ApiKeyField
                        t={t}
                        state={snapshot.apiKey}
                        disabled={!snapshot.writable}
                        onEdit={face.editApiKey}
                        onSave={face.saveApiKey}
                    />
                    <Field
                        id="lp-credential"
                        label={t('credential')}
                        hint={t('credentialHint')}
                        value={draftOf(snapshot, 'apiKeyEnv')}
                        invalid={snapshot.invalid['apiKeyEnv']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('apiKeyEnv', text) }}
                    />
                    <Field
                        id="lp-endpoint"
                        label={t('endpoint')}
                        hint={t('endpointHint')}
                        value={draftOf(snapshot, 'baseURL')}
                        invalid={snapshot.invalid['baseURL']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('baseURL', text) }}
                    />
                    <Select
                        id="lp-session"
                        label={t('sessionRouting')}
                        hint={t('sessionRoutingHint')}
                        value={draftOf(snapshot, 'sessionRouting')}
                        options={[{ value: 'true', label: t('on') }, { value: 'false', label: t('off') }]}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('sessionRouting', text) }}
                    />
                    <Select
                        id="lp-reasoning"
                        label={t('reasoning')}
                        hint={t('reasoningHint')}
                        value={snapshot.drafts['reasoning'] ?? ''}
                        options={REASONING_LEVELS.map((level) => ({ value: level, label: level === '' ? t('providerDefault') : level }))}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('reasoning', text) }}
                    />
                    <Field
                        id="lp-pixels"
                        label={t('pixels')}
                        hint={t('pixelsHint')}
                        value={snapshot.drafts['requestImagePixelBudget'] ?? ''}
                        invalid={snapshot.invalid['requestImagePixelBudget']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('requestImagePixelBudget', text) }}
                    />
                    <Field
                        id="lp-image-bytes"
                        label={t('imageBytes')}
                        hint={t('imageBytesHint')}
                        value={snapshot.drafts['requestImageMaxBytes'] ?? ''}
                        invalid={snapshot.invalid['requestImageMaxBytes']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('requestImageMaxBytes', text) }}
                    />
                    <Field
                        id="lp-request-bytes"
                        label={t('requestBytes')}
                        hint={t('requestBytesHint')}
                        value={snapshot.drafts['maxRequestImageBytes'] ?? ''}
                        invalid={snapshot.invalid['maxRequestImageBytes']}
                        disabled={!snapshot.writable}
                        onChange={(text) => { face.edit('maxRequestImageBytes', text) }}
                    />
                </div>
            </details>

            <div className="lp-foot">
                <p>{t('quotaCommandHint')}</p>
                <div className="lp-actions">
                    {snapshot.saveFailed ? <span className="lp-state" data-tone="warn">{t('saveFailed')}</span> : null}
                    <button
                        type="button"
                        className="lp-btn"
                        disabled={!snapshot.dirty || busy}
                        onClick={face.discard}
                    >
                        {t('discard')}
                    </button>
                    <button
                        type="button"
                        className="lp-btn lp-btn--primary"
                        disabled={!snapshot.dirty || busy || !snapshot.writable || Object.keys(snapshot.invalid).length > 0}
                        onClick={face.save}
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
                onToggle={face.togglePickerModel}
                onAll={face.selectAllModels}
                onNone={face.clearSelection}
                onClose={face.closePicker}
                onApply={face.applyPicker}
            />
        </section>
    )
}

/**
 * The LLM providers section: one panel per served route.
 *
 * A section rather than a card in the plugin list, because this is a
 * configuration surface that grows — every gateway this plugin learns to serve
 * adds a panel here, and none of them belong in a list of plugin cards. It is
 * also a `list` slot, which carries an explicit `order`, so its position is
 * stable (the keyed plugin slot has none).
 *
 * @param props - the section's owner props, its locale, and the per-route faces.
 * @returns the section.
 */
export function LlmProvidersSection(props: PropsRuntime<'settings.section'> & InjectFace<LlmProvidersFace>): JSX.Element {
    const t = props.t
    const snapshot = props.useProviders((value) => value)
    return (
        <div className="lpp">
            <header className="lpp-head">
                <h2 className="lpp-title">{t('sectionTitle')}</h2>
                <p className="lpp-intro">{t('sectionIntro')}</p>
            </header>
            {snapshot.providers.length === 0
                ? <p className="lp-hint">{t('noModels')}</p>
                : snapshot.providers.map((entry) => (
                    <ProviderPanel
                        key={entry.route}
                        t={t}
                        route={entry.route}
                        card={entry.card}
                        face={props.byRoute[entry.route]!}
                    />
                ))}
        </div>
    )
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
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-llm-provider: section locale')
    const scope = ctx.settingsScope.bind<ProviderSections>({ namespace: NS })
    const face = createSectionFace(ctx, scope, ROUTES)
    // A section, not a plugin card: this surface grows with every gateway the
    // plugin learns to serve, and `settings.section` is a list slot whose
    // `order` also makes the position stable.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'llm-providers',
        order: 50,
        label: () => face.t('sectionNav'),
        locale: NS,
        inject: () => face,
    }, LlmProvidersSection as never))
    // The Models page renders this for our provider row, keyed by the settings
    // namespace that owns it — the seat it documents as existing for plugins
    // distributed outside the harness.
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: NS,
        locale: NS,
        inject: () => face,
    }, ModelsProviderCard as never))
}

export type { ProviderSections, CardSnapshot, FieldName }
export type { TranslateNS }
export { FIELDS }
