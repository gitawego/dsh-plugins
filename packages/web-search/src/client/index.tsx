/* @gitawego/dsh-web-search browser plugin: the Web search settings section.
 *
 * **Settings → Web search**, its own entry beside Models, Plugins, LSP and LLM
 * providers — not a card in the plugin list, for the same reason the LLM
 * provider settings moved out: this is a configuration surface, and the plugin
 * list is where you look for one plugin's toggle.
 *
 * The layout is the *fallback chain*, because that is what a search provider
 * is. The chain tries backends in order, so the order is information: each row
 * carries its position, and the shipped endpoints are visibly different from the
 * ones you can edit —
 *
 *   1  Custom LLM endpoint        (you own every field)
 *   2  OpenCode Go                (endpoint and model fixed; credential reference)
 *   3  Parallel                   (endpoint fixed; optional token)
 *   4  Exa                        (endpoint fixed; optional token)
 *   5  Your servers               (endpoint, tool and token, added or removed)
 *
 * A shipped endpoint is read-only on purpose: it is the address this plugin was
 * tested against, and an editable one turns a working free backend into a typo
 * that silently falls through the chain. The token lives on the same row as its
 * endpoint, which is what the previous layout got wrong.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import './remote-types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BUILTIN_MCP_SERVERS } from '../mcp-servers.ts'
import {
    createWebSearchSection,
    type TokenState,
    type WebSearchSectionController,
    type WebSearchSnapshot,
} from './controller.ts'
import { en, zh } from './strings.ts'

const NS = 'web-search-enhanced'

/* Pure-type augmentation for the locale namespace this section registers, so a
 * missing translation is a compile error rather than a key shown to the user. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'web-search-enhanced': keyof typeof en
    }
}

/** Copy lookup bound to this plugin's namespace. */
export type Translate = (key: keyof typeof en) => string

/** The face the section's slot entry injects. */
export interface WebSearchSectionFace {
    hooks: { webSearchSection: { getSnapshot: () => WebSearchSnapshot; subscribe: (listener: () => void) => () => void } }
    t: Translate
    controller: WebSearchSectionController
}

const CSS = `
.wss{display:flex;flex-direction:column;gap:16px}
.wss-head{display:flex;flex-direction:column;gap:4px}
.wss-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
.wss-intro{margin:0;max-width:62ch;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wss-group{display:flex;flex-direction:column;gap:8px}
.wss-group-title{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.wss-chain{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.wss-step{display:grid;grid-template-columns:28px 1fr;gap:12px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.wss-step:last-child{border-bottom:0}
.wss-rank{display:grid;place-items:center;width:20px;height:20px;margin-top:2px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;font-variant-numeric:tabular-nums}
.wss-body{display:flex;flex-direction:column;gap:8px;min-width:0}
.wss-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.wss-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wss-tag{padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.wss-note{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wss-token{display:flex;gap:8px}
.wss-token input{flex:1}
.wss-error{color:var(--dsw-alias-label-error)!important}
.wss-url{margin:0;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;user-select:all}
.wss-fields{display:grid;gap:12px 14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:start}
/* A field's own rows must keep their natural height: a stretched cell with a
 * hint redistributes its extra space and pushes its input out of line with the
 * input beside it. */
.wss-field{display:grid;gap:4px;min-width:0;align-content:start}
/* An endpoint, a credential name, or a model id is longer than half a column. */
.wss-field--wide{grid-column:1/-1}
.wss-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wss-field input,.wss-field select{width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}
.wss-field input[aria-invalid="true"]{border-color:var(--dsw-alias-label-error)}
.wss-field small{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wss-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wss-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.wss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wss-btn:disabled{opacity:.45;cursor:default}
.wss-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:#0000}
.wss-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.wss-server{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.wss-empty{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wss-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.wss-state{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wss-state[data-tone="warn"]{color:var(--dsw-alias-label-error)}
`

/** Install the section's stylesheet once, and remove it with the plugin. */
function installStyles(): () => void {
    const selector = 'style[data-plugin-css="dsh-web-search/section"]'
    if (document.querySelector(selector) !== null) return () => {}
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-web-search'
    style.dataset.pluginCss = 'dsh-web-search/section'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => {
        style.remove()
    }
}

/** One labelled control. */
function Field(props: {
    id: string
    label: string
    value: string
    hint?: string
    invalid?: boolean
    disabled: boolean
    /** Claim the full grid width; for values longer than half a column. */
    wide?: boolean
    onChange: (text: string) => void
}): JSX.Element {
    return (
        <div className={props.wide === true ? 'wss-field wss-field--wide' : 'wss-field'}>
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

/** One labelled choice. */
function Choice(props: {
    id: string
    label: string
    value: string
    options: { value: string; label: string }[]
    disabled: boolean
    onChange: (text: string) => void
}): JSX.Element {
    return (
        <div className="wss-field">
            <label htmlFor={props.id}>{props.label}</label>
            <select id={props.id} value={props.value} disabled={props.disabled} onChange={(event) => { props.onChange(event.target.value) }}>
                {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
        </div>
    )
}

/**
 * The token control for one backend.
 *
 * A stored token is a secret the browser never receives, so this field cannot be
 * seeded: it starts blank, a blank draft writes nothing, and the only facts it
 * shows are whether a token is configured and whether the last write landed. The
 * reference beside it is what the *config* stores; the literal goes to the
 * credential store.
 */
function TokenField(props: {
    t: Translate
    id: string
    reference: string
    state: TokenState
    disabled: boolean
    onEdit: (text: string) => void
    onSave: () => void
}): JSX.Element {
    const { t, state } = props
    const named = props.reference.trim().length > 0
    const status = !named
        ? t('tokenNeedsReference')
        : state.configured === undefined
            ? t('tokenUnknown')
            : state.configured ? t('tokenStored') : t('tokenMissing')
    const canSave = !props.disabled && !state.saving && named && state.draft.trim().length > 0
    return (
        <div className="wss-field wss-field--wide">
            <label htmlFor={props.id}>{t('token')}</label>
            <div className="wss-token">
                <input
                    id={props.id}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={state.draft}
                    disabled={props.disabled || state.saving || !named}
                    placeholder={state.configured === true ? '••••••••' : ''}
                    onChange={(event) => { props.onEdit(event.target.value) }}
                />
                <button type="button" className="wss-btn" disabled={!canSave} onClick={props.onSave}>
                    {state.saving ? t('saving') : t('storeToken')}
                </button>
            </div>
            <small className={state.error !== undefined ? 'wss-error' : undefined}>
                {state.error ?? (state.saved ? `${t('tokenSaved')} ${status}` : status)}
            </small>
            <small>{t('tokenHint')}</small>
        </div>
    )
}

/** The numeral that carries one step's position in the chain. */
function Rank({ n }: { n: number }): JSX.Element {
    return <span className="wss-rank" aria-hidden="true">{n}</span>
}

/**
 * The section.
 * @param props - the section's owner props plus the injected face.
 * @returns the section element tree.
 */
export function WebSearchSection(props: PropsRuntime<'settings.section'> & InjectFace<WebSearchSectionFace>): JSX.Element {
    const t = props.t
    const controller = props.controller
    const state = props.useWebSearchSection((value) => value)
    const { draft } = state
    const disabled = !state.writable || state.saving
    const [showLlm, setShowLlm] = useState(false)
    const invalid = new Set(state.invalid)
    const tokenFor = (reference: string): TokenState => state.tokens[reference] ?? { configured: undefined, draft: '', saving: false, saved: false, error: undefined }
    const referenceOf = (field: 'parallelCredential' | 'exaCredential'): string =>
        field === 'parallelCredential' ? draft.free.parallelCredential : draft.free.exaCredential

    useEffect(() => {
        // One read per reference when the section opens, and whenever a reference
        // changes: it reports whether a token is stored, never the token.
        void controller.refreshTokens()
    }, [draft.free.parallelCredential, draft.free.exaCredential, draft.free.servers.length])

    return (
        <div className="wss">
            <header className="wss-head">
                <h2 className="wss-title">{t('sectionTitle')}</h2>
                <p className="wss-intro">{t('sectionIntro')}</p>
            </header>

            <section className="wss-group">
                <h3 className="wss-group-title">{t('chainTitle')}</h3>
                <ol className="wss-chain">
                    {/* 1 — the custom endpoint: the only backend whose every field is yours. */}
                    <li className="wss-step">
                        <Rank n={1} />
                        <div className="wss-body">
                            <div className="wss-row">
                                <span className="wss-name">{t('llmTitle')}</span>
                                <span className="wss-tag">{draft.llm.enabled ? t('on') : t('off')}</span>
                                <button type="button" className="wss-btn" onClick={() => { setShowLlm((value) => !value) }}>
                                    {showLlm ? t('hide') : t('edit')}
                                </button>
                            </div>
                            <p className="wss-note">{t('llmNote')}</p>
                            {showLlm
                                ? (
                                    <div className="wss-fields">
                                        <Choice
                                            id="wss-llm-enabled" label={t('enabled')} disabled={disabled}
                                            value={draft.llm.enabled ? 'true' : 'false'}
                                            options={[{ value: 'true', label: t('on') }, { value: 'false', label: t('off') }]}
                                            onChange={(text) => { controller.editLlm('enabled', text) }}
                                        />
                                        <Choice
                                            id="wss-llm-protocol" label={t('protocol')} disabled={disabled}
                                            value={draft.llm.protocol}
                                            options={[{ value: 'anthropic', label: t('protocolAnthropic') }, { value: 'openai', label: t('protocolOpenai') }]}
                                            onChange={(text) => { controller.editLlm('protocol', text) }}
                                        />
                                        <Field
                                            wide id="wss-llm-baseurl" label={t('baseUrl')} hint={t('baseUrlHint')} disabled={disabled}
                                            value={draft.llm.baseUrl} onChange={(text) => { controller.editLlm('baseUrl', text) }}
                                        />
                                        <Field
                                            wide id="wss-llm-credential" label={t('credential')} hint={t('credentialHint')} disabled={disabled}
                                            value={draft.llm.credential} onChange={(text) => { controller.editLlm('credential', text) }}
                                        />
                                        <Field
                                            wide id="wss-llm-model" label={t('model')} hint={t('modelHint')} disabled={disabled}
                                            value={draft.llm.model} onChange={(text) => { controller.editLlm('model', text) }}
                                        />
                                        <Field
                                            id="wss-llm-timeout" label={t('llmTimeout')} disabled={disabled} invalid={invalid.has('llm.timeoutMs')}
                                            value={draft.llm.timeoutMs} onChange={(text) => { controller.editLlm('timeoutMs', text) }}
                                        />
                                    </div>
                                )
                                : null}
                        </div>
                    </li>

                    {/* 2 — OpenCode Go: a shipped route with a shipped model. */}
                    <li className="wss-step">
                        <Rank n={2} />
                        <div className="wss-body">
                            <div className="wss-row">
                                <span className="wss-name">{t('goTitle')}</span>
                                <span className="wss-tag">{t('builtIn')}</span>
                            </div>
                            <p className="wss-url">https://opencode.ai/zen/go/v1 · deepseek-v4.1-flash</p>
                            <p className="wss-note">{t('goNote')}</p>
                            <div className="wss-fields">
                                <Field
                                    wide id="wss-go-credential" label={t('goCredential')} hint={t('goCredentialHint')} disabled={disabled}
                                    value={draft.llm.credential === '' ? '' : draft.llm.credential}
                                    onChange={(text) => { controller.editLlm('credential', text) }}
                                />
                            </div>
                        </div>
                    </li>

                    {/* 3 & 4 — the shipped MCP servers: fixed endpoint, optional token. */}
                    {BUILTIN_MCP_SERVERS.map((server, index) => (
                        <li className="wss-step" key={server.id}>
                            <Rank n={index + 3} />
                            <div className="wss-body">
                                <div className="wss-row">
                                    <span className="wss-name">{server.label}</span>
                                    <span className="wss-tag">{t('builtIn')}</span>
                                    <span className="wss-tag">{t('free')}</span>
                                </div>
                                <p className="wss-url">{server.url}</p>
                                <div className="wss-fields">
                                    <Field
                                        wide id={`wss-${server.id}-ref`}
                                        label={t('credential')}
                                        hint={t('credentialHint')}
                                        disabled={disabled}
                                        value={server.credentialField === 'parallelCredential' ? draft.free.parallelCredential : draft.free.exaCredential}
                                        onChange={(text) => { controller.editFree(server.credentialField, text) }}
                                    />
                                    <TokenField
                                        t={t}
                                        id={`wss-${server.id}-token`}
                                        reference={server.credentialField === 'parallelCredential' ? draft.free.parallelCredential : draft.free.exaCredential}
                                        state={tokenFor(server.credentialField === 'parallelCredential' ? draft.free.parallelCredential : draft.free.exaCredential)}
                                        disabled={disabled}
                                        onEdit={(text) => { controller.editToken(referenceOf(server.credentialField), text) }}
                                        onSave={() => { void controller.saveToken(referenceOf(server.credentialField)) }}
                                    />
                                </div>
                            </div>
                        </li>
                    ))}

                    {/* 5 — servers you add, tried in the order listed. */}
                    <li className="wss-step">
                        <Rank n={BUILTIN_MCP_SERVERS.length + 3} />
                        <div className="wss-body">
                            <div className="wss-row">
                                <span className="wss-name">{t('serversTitle')}</span>
                                <button type="button" className="wss-btn" disabled={disabled} onClick={() => { controller.addServer() }}>
                                    {t('addServer')}
                                </button>
                            </div>
                            <p className="wss-note">{t('serversNote')}</p>
                            {draft.free.servers.length === 0
                                ? <p className="wss-empty">{t('serversEmpty')}</p>
                                : draft.free.servers.map((server, index) => (
                                    <div className="wss-server" key={server.id}>
                                        <div className="wss-fields">
                                            <Field
                                                wide id={`wss-server-${server.id}-url`} label={t('serverUrl')} disabled={disabled}
                                                invalid={invalid.has(`free.servers.${index}.url`)}
                                                value={server.url} onChange={(text) => { controller.editServer(server.id, 'url', text) }}
                                            />
                                            <Field
                                                id={`wss-server-${server.id}-label`} label={t('serverLabel')} disabled={disabled}
                                                value={server.label} onChange={(text) => { controller.editServer(server.id, 'label', text) }}
                                            />
                                            <Field
                                                wide id={`wss-server-${server.id}-ref`} label={t('credential')} hint={t('credentialHint')} disabled={disabled}
                                                value={server.credential} onChange={(text) => { controller.editServer(server.id, 'credential', text) }}
                                            />
                                            <TokenField
                                                t={t} id={`wss-server-${server.id}-token`}
                                                reference={server.credential}
                                                state={tokenFor(server.credential)}
                                                disabled={disabled}
                                                onEdit={(text) => { controller.editToken(server.credential, text) }}
                                                onSave={() => { void controller.saveToken(server.credential) }}
                                            />
                                            <Field
                                                id={`wss-server-${server.id}-tool`} label={t('serverTool')} hint={t('serverToolHint')} disabled={disabled}
                                                value={server.tool} onChange={(text) => { controller.editServer(server.id, 'tool', text) }}
                                            />
                                        </div>
                                        <div className="wss-actions">
                                            <button type="button" className="wss-btn" disabled={disabled} onClick={() => { controller.removeServer(server.id) }}>
                                                {t('removeServer')}
                                            </button>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </li>
                </ol>
            </section>

            <section className="wss-group">
                <h3 className="wss-group-title">{t('limitsTitle')}</h3>
                <div className="wss-fields">
                    <Field
                        id="wss-free-timeout" label={t('freeTimeout')} disabled={disabled} invalid={invalid.has('free.timeoutMs')}
                        value={draft.free.timeoutMs} onChange={(text) => { controller.editFree('timeoutMs', text) }}
                    />
                    <Field
                        id="wss-snippet" label={t('snippetMaxChars')} disabled={disabled} invalid={invalid.has('free.snippetMaxChars')}
                        value={draft.free.snippetMaxChars} onChange={(text) => { controller.editFree('snippetMaxChars', text) }}
                    />
                    <Field
                        id="wss-max-results" label={t('maxResults')} disabled={disabled} invalid={invalid.has('free.maxResults')}
                        value={draft.free.maxResults} onChange={(text) => { controller.editFree('maxResults', text) }}
                    />
                </div>
            </section>

            <div className="wss-foot">
                <p className="wss-state" data-tone={state.failed ? 'warn' : undefined}>
                    {state.failed ? t('saveFailed') : state.overridden ? t('configured') : t('notConfigured')}
                </p>
                <div className="wss-actions">
                    <button type="button" className="wss-btn" disabled={disabled} onClick={() => { controller.discard() }}>{t('discard')}</button>
                    <button
                        type="button"
                        className="wss-btn wss-btn--primary"
                        disabled={disabled || state.invalid.length > 0}
                        onClick={() => { void controller.save() }}
                    >
                        {state.saving ? t('saving') : t('save')}
                    </button>
                </div>
            </div>
        </div>
    )
}

/**
 * Build the section's face: one controller over the bound settings scope.
 * @param ctx - the client context.
 * @param scope - the bound `web-search-enhanced` scope.
 * @returns the injected face.
 */
export function createSectionFace(ctx: ClientContext, scope: SettingsScope<unknown>): WebSearchSectionFace {
    /**
     * The credentials domain, bound in a fiber that declares it: cordis refuses
     * `ctx.remote.credentials` from a context that has not declared the scoped
     * namespace ("cannot get property ... without inject").
     */
    let remote: ClientContext['remote'] | undefined
    ctx.inject(['remote', 'remote.credentials'], (injected: ClientContext) => {
        remote = injected.remote
        return () => {
            remote = undefined
        }
    })
    const controller = createWebSearchSection({
        scope: scope as never,
        describeCredential: async (reference) => {
            if (remote === undefined) throw new Error('the Remote carrier is still connecting')
            const response = await remote.credentials.describe([reference])
            if (!response.ok) throw new Error(response.error.message)
            return response.value[reference]?.configured === true
        },
        writeCredential: async (reference, value) => {
            if (remote === undefined) throw new Error('the Remote carrier is still connecting')
            const response = await remote.credentials.set(reference, value)
            if (!response.ok) throw new Error(response.error.message)
        },
    })
    return {
        hooks: {
            webSearchSection: {
                getSnapshot: controller.getSnapshot,
                subscribe: controller.subscribe,
            },
        },
        t: ctx.locale.bind(NS) as unknown as Translate,
        controller,
    }
}

/** Services this client half uses. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the section.
 * @param ctx - the plugin's client context.
 */
export function apply(ctx: ClientContext): void {
    ctx.effect(installStyles, 'dsh-web-search: section styles')
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-web-search: section locale')
    const scope = ctx.settingsScope.bind<unknown>({ namespace: NS })
    const face = createSectionFace(ctx, scope)
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'web-search',
        order: 45,
        label: () => face.t('nav'),
        locale: NS,
        inject: () => face,
    }, WebSearchSection as never))
}

export type { WebSearchSnapshot }
