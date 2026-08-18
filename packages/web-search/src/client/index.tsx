/* @gitawego/dsh-web-search browser plugin: the Web Search plugin card.
 *
 * Registers one `settings.plugin.item` slot entry keyed by the
 * `web-search-enhanced` settings namespace the host serves. The card lives
 * inside the Plugins → Plugin configuration tab (`dsh-client-ui-settings-plugins`)
 * and reads/writes its namespace through the standard DSH settings scope
 * (`ctx.settingsScope.bind({ namespace })`); no plugin-owned HTTP route is
 * needed.
 *
 * The bundle-purity gate forbids importing the shipped
 * `dsh-client-ui-settings-plugins` card chrome or form model as values, so
 * this plugin owns its own disclosure chrome, form staging, and save flow —
 * mirror of the shipped card layout, scoped to the web-search namespace. The
 * slot type augmentation for `settings.plugin.item` is duplicated here as a
 * pure `declare module` augmentation (no value imports) so the slot call
 * stays compile-time checked without taking a runtime dependency on
 * `dsh-client-ui-settings-plugins`. */
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ClientContext, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InjectFace, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/* The settings namespace is also declared on the Host via `settingsNamespace('web-search-enhanced')`
 * in src/config.ts; both sides agree on this string literal so the host
 * serves the namespace and the browser card pairs it. */
const WEB_SEARCH_SETTINGS_NAMESPACE = 'web-search-enhanced'
const NS = 'web-search-enhanced'

/* Pure-type augmentation for the `settings.plugin.item` slot, mirroring
 * `dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts`. The
 * tab owns the slot kind/scope, this plugin only contributes one keyed entry. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: SettingsPluginItemOwnerProps
    }
  }
}
interface SettingsPluginItemOwnerProps {
  children?: never
}

type WebSearchTranslate = TranslateNS<typeof NS>

const en = {
  cardTitle: 'Web Search (enhanced)',
  cardDescription: 'Chained web search: custom LLM → opencode Go default → Parallel → Exa. The free backends need no API key; the opencode-Go step uses OPENCODE_GO_API_KEY when set.',
  sectionIntro: 'Configure the bundled enhanced search provider.',
  llmTitle: 'LLM-backed web search (Anthropic web_search_20250305 / OpenAI-compatible)',
  enableGo: 'Enable the LLM backend',
  enableGoHint: 'When disabled, the free Parallel/Exa backends handle every query (no API key needed).',
  protocol: 'Protocol',
  protocolAnthropic: 'anthropic (/v1/messages)',
  protocolOpenai: 'openai (/chat/completions)',
  baseUrl: 'Base URL',
  baseUrlHint: 'Empty disables the LLM backend.',
  credential: 'Credential reference',
  credentialHint: 'Name of a credential in the harness store (e.g. OPENCODE_GO_API_KEY). Not the DEEPSEEK_API_KEY used by the built-in DeepSeek search.',
  model: 'Model',
  modelHint: 'Default: deepseek-v4-flash (the cheapest paid Anthropic-format model known to implement web_search_20250305). Other Anthropic routes (e.g. xiaomi/mimo-v2.5 at the same price) may work — depends on whether the gateway implements the server tool.',
  timeoutMs: 'Timeout (ms)',
  freeTitle: 'Free backends (no API key)',
  parallelUrl: 'Parallel endpoint',
  exaUrl: 'Exa endpoint',
  freeTimeoutMs: 'Free timeout (ms)',
  snippetMaxChars: 'Snippet max chars',
  maxResults: 'Max results',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  reset: 'Reset to default',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
} as const

const zh: Record<keyof typeof en, string> = {
  cardTitle: '网页搜索（增强）',
  cardDescription: '链式网页搜索：自定义 LLM → opencode Go 默认 → Parallel → Exa。免费后端无需 API key；opencode Go 默认步骤使用 OPENCODE_GO_API_KEY（若已设置）。',
  sectionIntro: '配置增强搜索提供方。',
  llmTitle: 'LLM 网页搜索（Anthropic web_search_20250305 / OpenAI 兼容）',
  enableGo: '启用 LLM 后端',
  enableGoHint: '关闭时所有请求走免费 Parallel/Exa（无需 API key）。',
  protocol: '协议',
  protocolAnthropic: 'anthropic (/v1/messages)',
  protocolOpenai: 'openai (/chat/completions)',
  baseUrl: '服务地址',
  baseUrlHint: '留空则禁用 LLM 后端。',
  credential: '凭据引用',
  credentialHint: '凭据库中的凭据名称（如 OPENCODE_GO_API_KEY）。非内置 DeepSeek 搜索使用的 DEEPSEEK_API_KEY。',
  model: '模型',
  modelHint: '默认值 deepseek-v4-flash（已知实现 web_search_20250305 的最便宜付费 Anthropic 格式模型）。其他 Anthropic 路由（如同价的 xiaomi/mimo-v2.5）也可能可用 —— 取决于网关是否实现该服务端工具。',
  timeoutMs: '超时（ms）',
  freeTitle: '免费后端（无需 API key）',
  parallelUrl: 'Parallel 端点',
  exaUrl: 'Exa 端点',
  freeTimeoutMs: '免费超时（ms）',
  snippetMaxChars: '摘要最大字符数',
  maxResults: '最大结果数',
  save: '保存',
  saving: '保存中…',
  discard: '撤销',
  reset: '恢复默认',
  unsaved: '未保存',
  saveFailed: '部署未接受这些值；已保留以便修正。',
  invalidNumber: '请输入数字，或留空使用默认值。',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-search-enhanced': keyof typeof en
  }
}

/* ─── schema shape (mirrors src/config.ts) ──────────────────────────────── */

interface LlmSection {
  enabled?: boolean
  protocol?: 'anthropic' | 'openai'
  baseUrl?: string
  credential?: string
  model?: string
  timeoutMs?: number
}
interface FreeSection {
  parallelUrl?: string
  exaUrl?: string
  timeoutMs?: number
  snippetMaxChars?: number
  maxResults?: number
}
interface WebSearchSection {
  llm?: LlmSection
  free?: FreeSection
}

/* ─── field staging model ───────────────────────────────────────────────── */

export interface WebSearchFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}
export interface WebSearchCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  llmEnabled: WebSearchFieldState
  llmProtocol: WebSearchFieldState
  llmBaseUrl: WebSearchFieldState
  llmCredential: WebSearchFieldState
  llmModel: WebSearchFieldState
  llmTimeoutMs: WebSearchFieldState
  parallelUrl: WebSearchFieldState
  exaUrl: WebSearchFieldState
  freeTimeoutMs: WebSearchFieldState
  snippetMaxChars: WebSearchFieldState
  maxResults: WebSearchFieldState
}

type DraftValue = string | number | boolean
type SubSection = 'llm' | 'free'

interface FieldSpec<T extends DraftValue> {
  /** Sub-section under the root namespace. The scope writes the whole
   *  sub-section object in one `set`, which is what the wire contract accepts. */
  sub: SubSection
  /** Field name inside the sub-section. */
  name: string
  /** Stored value → draft text. */
  format(value: unknown): string
  /** Draft text → stored value; undefined means invalid (blocks save). */
  parse(text: string): T | undefined
}

function textField(sub: SubSection, name: string): FieldSpec<string> {
  return {
    sub, name,
    format(value) { return typeof value === 'string' ? value : '' },
    parse(text) { return text },
  }
}
function numberField(sub: SubSection, name: string): FieldSpec<number> {
  return {
    sub, name,
    format(value) { return typeof value === 'number' && Number.isFinite(value) ? String(value) : '' },
    parse(text) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return undefined
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : undefined
    },
  }
}
function booleanField(sub: SubSection, name: string): FieldSpec<boolean> {
  return {
    sub, name,
    format(value) { return value === true ? 'true' : 'false' },
    parse(text) { return text === 'true' ? true : text === 'false' ? false : undefined },
  }
}
function enumField<T extends string>(sub: SubSection, name: string, options: readonly T[]): FieldSpec<T> {
  return {
    sub, name,
    format(value) { return typeof value === 'string' && (options as readonly string[]).includes(value) ? value : options[0]! },
    parse(text) { return (options as readonly string[]).includes(text) ? (text as T) : undefined },
  }
}

const FIELDS = {
  llmEnabled: booleanField('llm', 'enabled'),
  llmProtocol: enumField('llm', 'protocol', ['anthropic', 'openai'] as const),
  llmBaseUrl: textField('llm', 'baseUrl'),
  llmCredential: textField('llm', 'credential'),
  llmModel: textField('llm', 'model'),
  llmTimeoutMs: numberField('llm', 'timeoutMs'),
  parallelUrl: textField('free', 'parallelUrl'),
  exaUrl: textField('free', 'exaUrl'),
  freeTimeoutMs: numberField('free', 'timeoutMs'),
  snippetMaxChars: numberField('free', 'snippetMaxChars'),
  maxResults: numberField('free', 'maxResults'),
} as const
type FieldKey = keyof typeof FIELDS

/** Schema defaults projected as a `WebSearchSection` for the loading state
 *  (before the host scope has answered) and the unavailable state (where the
 *  wire would otherwise return undefined). Mirrors the host-side `Config`
 *  schema in `src/config.ts` so the form always shows the same baseline
 *  regardless of scope state. */
function schemaDefaults(): WebSearchSection {
  return {
    llm: {
      enabled: false,
      protocol: 'anthropic',
      baseUrl: '',
      credential: '',
      model: 'deepseek-v4-flash',
      timeoutMs: 20_000,
    },
    free: {
      parallelUrl: 'https://search.parallel.ai/mcp',
      exaUrl: 'https://mcp.exa.ai/mcp',
      timeoutMs: 15_000,
      snippetMaxChars: 300,
      maxResults: 8,
    },
  }
}

function readField(section: WebSearchSection, key: FieldKey): unknown {
  const { sub, name } = FIELDS[key]
  const child = section[sub]
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return undefined
  return (child as Record<string, unknown>)[name]
}

/** Whether the user-layer object carries this sub-section field. */
function userLayerCarries(userLayer: unknown, key: FieldKey): boolean {
  const { sub, name } = FIELDS[key]
  if (userLayer === null || typeof userLayer !== 'object') return false
  const subNode = (userLayer as Record<string, unknown>)[sub]
  if (subNode === null || typeof subNode !== 'object' || Array.isArray(subNode)) return false
  return Object.hasOwn(subNode as object, name)
}

function fieldStateOf(section: WebSearchSection, userLayer: unknown, drafts: ReadonlyMap<FieldKey, string>, key: FieldKey): WebSearchFieldState {
  const spec = FIELDS[key]
  const stored = readField(section, key)
  const draft = drafts.get(key)
  const baseText = spec.format(stored)
  const text = draft ?? baseText
  const parsed = spec.parse(text)
  const overridden = userLayerCarries(userLayer, key) || draft !== undefined
  const invalid = parsed === undefined && text.length > 0
  return { text, overridden, invalid }
}

/* ─── snapshot + actions ────────────────────────────────────────────────── */

interface WebSearchCardFace {
  hooks: { webSearchCard: SnapshotStore<WebSearchCardState> }
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

type WebSearchCardProps = PropsRuntime<'settings.plugin.item'> & InjectFace<WebSearchCardFace> & { t: WebSearchTranslate }

/** Tiny snapshot store: subscribe + getSnapshot, rebuild on demand. */
function makeSnapshotStore<T>(compute: () => T): SnapshotStore<T> {
  let last: T = compute()
  const listeners = new Set<() => void>()
  return {
    getSnapshot(): T { return last },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T): void {
      last = next
      for (const l of listeners) l()
    },
    update(mutator: (draft: T) => void): void {
      mutator(last)
      for (const l of listeners) l()
    },
  }
}

/**
 * Build the card controller: bridges the bound settings scope onto a
 * revision-fenced staging form. The controller is the `inject()` face the
 * slot registration returns — the framework hands it to the component as
 * `props.useWebSearchCard`, `props.edit`, `props.resetField`, `props.save`,
 * `props.discard`.
 */
export class WebSearchCardController {
  private readonly scope: SettingsScope<WebSearchSection>
  private readonly drafts = new Map<FieldKey, string>()
  private readonly listeners = new Set<() => void>()
  private readonly store: SnapshotStore<WebSearchCardState>
  private generation = 0
  private saving = false
  private failed = false

  constructor(scope: SettingsScope<WebSearchSection>) {
    this.scope = scope
    this.store = makeSnapshotStore<WebSearchCardState>(() => this.computeSnapshot())
    scope.subscribe(() => { this.publish() })
  }

  /** Stage text for one field. Drafts live on the form, not in the wire scope. */
  edit(field: FieldKey, text: string): void {
    this.drafts.set(field, text)
    this.failed = false
    this.publish()
  }

  /** Drop a field's draft; the next save leaves no override. */
  resetField(field: FieldKey): void {
    this.drafts.delete(field)
    this.failed = false
    this.publish()
  }

  /** Drop every draft. */
  discard(): void {
    this.drafts.clear()
    this.failed = false
    this.publish()
  }

  private isInvalid(): boolean {
    for (const [field, text] of this.drafts) {
      if (FIELDS[field].parse(text) === undefined && text.length > 0) return true
    }
    return false
  }

  private computeSnapshot(): WebSearchCardState {
    const raw = this.scope.getSnapshot()
    const section = (raw.value ?? {}) as WebSearchSection
    const userLayer = raw.user
    // Render the chrome whenever the namespace is exposed to this client —
    // including during loading — so the user always sees the card. While
    // `value` is undefined we project the schema's defaults through the field
    // formatters, so the loading state never looks like "empty configuration".
    // The chrome only hides on `unavailable` (the namespace is genuinely
    // not served, e.g. the host plugin did not load).
    const projected: WebSearchSection = raw.value === undefined
      ? schemaDefaults()
      : section
    return {
      available: raw.status !== 'unavailable',
      // The SettingsScopeController initializes `writable: false` and only
      // updates it once the describe RPC completes. While loading (or while
      // the websocket is reconnecting), `raw.writable` is `false` even when
      // the host is genuinely writable. Treat the writable flag as opt-in:
      // only consider the host read-only when the scope is `ready` AND the
      // host explicitly reports `writable: false`. While loading, default
      // to writable so the user can stage drafts; the Save button itself
      // still guards on the actual write attempt.
      writable: raw.status === 'ready' ? raw.writable === true : true,
      dirty: this.drafts.size > 0,
      invalid: this.isInvalid(),
      saving: this.saving,
      failed: this.failed,
      llmEnabled: fieldStateOf(projected, userLayer, this.drafts, 'llmEnabled'),
      llmProtocol: fieldStateOf(projected, userLayer, this.drafts, 'llmProtocol'),
      llmBaseUrl: fieldStateOf(projected, userLayer, this.drafts, 'llmBaseUrl'),
      llmCredential: fieldStateOf(projected, userLayer, this.drafts, 'llmCredential'),
      llmModel: fieldStateOf(projected, userLayer, this.drafts, 'llmModel'),
      llmTimeoutMs: fieldStateOf(projected, userLayer, this.drafts, 'llmTimeoutMs'),
      parallelUrl: fieldStateOf(projected, userLayer, this.drafts, 'parallelUrl'),
      exaUrl: fieldStateOf(projected, userLayer, this.drafts, 'exaUrl'),
      freeTimeoutMs: fieldStateOf(projected, userLayer, this.drafts, 'freeTimeoutMs'),
      snippetMaxChars: fieldStateOf(projected, userLayer, this.drafts, 'snippetMaxChars'),
      maxResults: fieldStateOf(projected, userLayer, this.drafts, 'maxResults'),
    }
  }

  private publish(): void {
    // Refresh the cached snapshot BEFORE notifying listeners so the next
    // `getSnapshot()` returns the new state. `useSyncExternalStore` only
    // re-renders when the snapshot reference differs, so updating `last`
    // to a fresh object here is what triggers the React re-render.
    this.store.set(this.computeSnapshot())
  }

  /**
   * Write every staged edit. `SettingsScope.set` accepts one top-level
   * field at a time, so each sub-section whose drafts are non-empty is
   * written in one call carrying the merged sub-section object. A blank
   * draft omits its field, so the next read re-inherits the composition
   * default. A sub-section whose every field was blanked becomes an unset.
   */
  async save(): Promise<void> {
    const generation = ++this.generation
    if (!this.scope.getSnapshot().writable || this.isInvalid() || this.drafts.size === 0) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const section = (this.scope.getSnapshot().value ?? {}) as WebSearchSection
      const bySub: Record<SubSection, Record<string, DraftValue>> = { llm: {}, free: {} }
      for (const [field, text] of this.drafts) {
        const spec = FIELDS[field]
        const parsed = spec.parse(text)
        if (parsed === undefined) continue
        bySub[spec.sub][spec.name] = parsed
      }
      for (const sub of ['llm', 'free'] as const) {
        const updates = bySub[sub]
        if (Object.keys(updates).length === 0) continue
        const existing = (section[sub] ?? {}) as Record<string, unknown>
        const merged: Record<string, unknown> = { ...existing, ...updates }
        // Drop fields the user explicitly blanked: the next read re-inherits
        // the composition default instead of carrying an empty override.
        for (const [name, value] of Object.entries(merged)) {
          if (value === '') delete merged[name]
          if (typeof value === 'number' && Number.isNaN(value)) delete merged[name]
        }
        if (Object.keys(merged).length === 0) {
          await this.scope.unset(sub)
        } else {
          await this.scope.set(sub, merged)
        }
      }
      if (generation !== this.generation) return
      this.drafts.clear()
      this.failed = false
    } catch (error) {
      if (generation !== this.generation) return
      this.failed = true
      // eslint-disable-next-line no-console
      console.warn('dsh-web-search: settings save failed', error)
    } finally {
      if (generation === this.generation) {
        this.saving = false
        this.publish()
      }
    }
  }

  /** Build the slot entry's inject face. */
  inject(): WebSearchCardFace {
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => { this.edit(field as FieldKey, text) },
      resetField: (field) => { this.resetField(field as FieldKey) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }
}

/* ─── value field control ───────────────────────────────────────────────── */

interface ValueFieldProps {
  id: string
  label: string
  hint?: string
  invalidLabel?: string
  resetLabel: string
  overriddenLabel: string
  numeric: boolean
  disabled: boolean
  state: WebSearchFieldState
  onEdit: (text: string) => void
  onReset: () => void
}

function ValueField(props: ValueFieldProps): JSX.Element {
  const { id, label, hint, invalidLabel, resetLabel, overriddenLabel, numeric, disabled, state, onEdit, onReset } = props
  const showOverridden = state.overridden
  const showInvalid = state.invalid
  return (
    <div className="wsc-field">
      <label htmlFor={id} className="wsc-field-label">{label}</label>
      <div className="wsc-field-row">
        <input
          id={id}
          type={numeric ? 'number' : 'text'}
          inputMode={numeric ? 'numeric' : undefined}
          value={state.text}
          disabled={disabled}
          onChange={(event) => { onEdit(event.target.value) }}
          className="wsc-input"
          aria-invalid={showInvalid || undefined}
        />
        {showOverridden ? (
          <button type="button" className="wsc-reset" disabled={disabled} onClick={onReset}>{resetLabel}</button>
        ) : null}
      </div>
      {hint !== undefined && !showInvalid ? <small className="wsc-hint">{hint}</small> : null}
      {showInvalid && invalidLabel !== undefined ? <small className="wsc-invalid">{invalidLabel}</small> : null}
      {showOverridden ? <small className="wsc-overridden">{overriddenLabel}</small> : null}
    </div>
  )
}

/* ─── boolean toggle control ────────────────────────────────────────────── */

interface ToggleFieldProps {
  id: string
  label: string
  hint?: string
  disabled: boolean
  state: WebSearchFieldState
  onEdit: (text: string) => void
}

function ToggleField(props: ToggleFieldProps): JSX.Element {
  const { id, label, hint, disabled, state, onEdit } = props
  const checked = state.text === 'true'
  // Mobile-first: the whole row is the touch target (min 44px tall). The
  // toggle is a native <button> with role="switch" and aria-checked — no
  // hidden checkbox, no label/htmlFor click-forwarding dance. Tapping the
  // pill, the label, or anywhere in the row fires a real click that runs
  // our onClick. The checkbox state lives in React state.text only.
  //
  // The `disabled` HTML attribute is forwarded so the browser blocks the
  // click when the host reports read-only (memory mode). Visual read-only
  // state (transient undefined writable or explicit false) is shown via
  // data-disabled styling instead, so the user still sees what the host
  // thinks but isn't blocked from staging a draft on mobile.
  const handleClick = (): void => {
    onEdit(checked ? 'false' : 'true')
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      onEdit(checked ? 'false' : 'true')
    }
  }
  return (
    <div className="wsc-field">
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={checked ? 'wsc-toggle-row wsc-toggle-row-on' : 'wsc-toggle-row'}
        data-checked={checked || undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span className="wsc-toggle-pill" aria-hidden="true">
          <span className="wsc-toggle-knob" />
        </span>
        <span className="wsc-toggle-label">{label}</span>
      </button>
      {hint !== undefined ? <small className="wsc-hint">{hint}</small> : null}
    </div>
  )
}

/* ─── enum select control ───────────────────────────────────────────────── */

interface SelectFieldProps {
  id: string
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  disabled: boolean
  state: WebSearchFieldState
  onEdit: (text: string) => void
}

function SelectField(props: SelectFieldProps): JSX.Element {
  const { id, label, options, disabled, state, onEdit } = props
  return (
    <div className="wsc-field">
      <label htmlFor={id} className="wsc-field-label">{label}</label>
      <select id={id} className="wsc-input" value={state.text} disabled={disabled} onChange={(event) => { onEdit(event.target.value) }}>
        {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </div>
  )
}

/* ─── disclosure chrome (mirrors shipped PluginCard) ────────────────────── */

function PluginCardShell(props: {
  t: WebSearchTranslate
  state: WebSearchCardState
  titleKey: keyof typeof en
  descriptionKey: keyof typeof en
  children: React.ReactNode
  onSave: () => void
  onDiscard: () => void
}): JSX.Element | null {
  const { t, state, titleKey, descriptionKey, children, onSave, onDiscard } = props
  // Open by default so the toggle is immediately visible on mobile — the
  // plugin's whole purpose is to surface the LLM backend controls, and a
  // collapsed card hides the toggle behind a tap that the user often doesn't
  // realize they need to make.
  const [open, setOpen] = useState(true)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li className={open ? 'wsc-card wsc-card-open' : 'wsc-card'}>
      <button
        type="button"
        className="wsc-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t(titleKey)}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="wsc-head-text">
          <span className="wsc-name">{t(titleKey)}</span>
          <span className="wsc-description">{t(descriptionKey)}</span>
        </span>
        {state.dirty ? <span className="wsc-pending">{t('unsaved')}</span> : null}
        <span className={open ? 'wsc-chevron wsc-chevron-open' : 'wsc-chevron'}>v</span>
      </button>
      {open ? (
        <div className="wsc-body">
          {!state.writable ? <p className="wsc-read-only" role="status">{t('readOnly')}</p> : null}
          {children}
          <div className="wsc-footer">
            {state.failed ? <p className="wsc-failed" role="status">{t('saveFailed')}</p> : <span className="wsp-footer-spacer" />}
            <button type="button" className="wsc-discard" disabled={!state.dirty || state.saving} onClick={onDiscard}>{t('discard')}</button>
            <button type="button" className="wsc-save" disabled={blocked} onClick={onSave}>{t(state.saving ? 'saving' : 'save')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/* ─── the card component ────────────────────────────────────────────────── */

export function WebSearchCard(props: WebSearchCardProps): JSX.Element | null {
  const state = props.useWebSearchCard((snapshot) => snapshot)
  const enFallback: WebSearchTranslate = (key) => (en as Record<string, string>)[key] ?? key
  const tr: WebSearchTranslate = props.t ?? enFallback
  return (
    <PluginCardShell
      t={tr}
      state={state}
      titleKey="cardTitle"
      descriptionKey="cardDescription"
      onSave={props.save}
      onDiscard={props.discard}
    >
      <p className="wsc-intro">{tr('sectionIntro')}</p>
      <fieldset className="wsc-section">
        <legend>{tr('llmTitle')}</legend>
        <ToggleField
          id="wsc-llm-enabled" label={tr('enableGo')} hint={tr('enableGoHint')} disabled={!state.writable}
          state={state.llmEnabled} onEdit={(text) => { props.edit('llmEnabled', text) }}
        />
        <SelectField
          id="wsc-llm-protocol" label={tr('protocol')} disabled={!state.writable}
          options={[
            { value: 'anthropic', label: tr('protocolAnthropic') },
            { value: 'openai', label: tr('protocolOpenai') },
          ]}
          state={state.llmProtocol} onEdit={(text) => { props.edit('llmProtocol', text) }}
        />
        <ValueField
          id="wsc-llm-baseurl" label={tr('baseUrl')} hint={tr('baseUrlHint')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={false} disabled={!state.writable}
          state={state.llmBaseUrl} onEdit={(text) => { props.edit('llmBaseUrl', text) }} onReset={() => { props.resetField('llmBaseUrl') }}
        />
        <ValueField
          id="wsc-llm-credential" label={tr('credential')} hint={tr('credentialHint')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={false} disabled={!state.writable}
          state={state.llmCredential} onEdit={(text) => { props.edit('llmCredential', text) }} onReset={() => { props.resetField('llmCredential') }}
        />
        <ValueField
          id="wsc-llm-model" label={tr('model')} hint={tr('modelHint')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={false} disabled={!state.writable}
          state={state.llmModel} onEdit={(text) => { props.edit('llmModel', text) }} onReset={() => { props.resetField('llmModel') }}
        />
        <ValueField
          id="wsc-llm-timeout" label={tr('timeoutMs')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={true} disabled={!state.writable}
          state={state.llmTimeoutMs} onEdit={(text) => { props.edit('llmTimeoutMs', text) }} onReset={() => { props.resetField('llmTimeoutMs') }}
        />
      </fieldset>
      <fieldset className="wsc-section">
        <legend>{tr('freeTitle')}</legend>
        <ValueField
          id="wsc-parallel-url" label={tr('parallelUrl')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={false} disabled={!state.writable}
          state={state.parallelUrl} onEdit={(text) => { props.edit('parallelUrl', text) }} onReset={() => { props.resetField('parallelUrl') }}
        />
        <ValueField
          id="wsc-exa-url" label={tr('exaUrl')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={false} disabled={!state.writable}
          state={state.exaUrl} onEdit={(text) => { props.edit('exaUrl', text) }} onReset={() => { props.resetField('exaUrl') }}
        />
        <ValueField
          id="wsc-free-timeout" label={tr('freeTimeoutMs')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={true} disabled={!state.writable}
          state={state.freeTimeoutMs} onEdit={(text) => { props.edit('freeTimeoutMs', text) }} onReset={() => { props.resetField('freeTimeoutMs') }}
        />
        <ValueField
          id="wsc-snippet-chars" label={tr('snippetMaxChars')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={true} disabled={!state.writable}
          state={state.snippetMaxChars} onEdit={(text) => { props.edit('snippetMaxChars', text) }} onReset={() => { props.resetField('snippetMaxChars') }}
        />
        <ValueField
          id="wsc-max-results" label={tr('maxResults')} resetLabel={tr('reset')} overriddenLabel={tr('unsaved')} invalidLabel={tr('invalidNumber')}
          numeric={true} disabled={!state.writable}
          state={state.maxResults} onEdit={(text) => { props.edit('maxResults', text) }} onReset={() => { props.resetField('maxResults') }}
        />
      </fieldset>
    </PluginCardShell>
  )
}

/* ─── client bundle entry ───────────────────────────────────────────────── */

const CSS = `
.wsc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.wsc-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.wsc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.wsc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.wsc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.wsc-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.wsc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.wsc-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.wsc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.wsc-chevron-open{transform:rotate(180deg)}
.wsc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:14px 0}
.wsc-intro{color:var(--dsw-alias-label-secondary);margin:0 0 14px;font-size:13px;line-height:1.55}
.wsc-read-only{color:var(--dsw-alias-label-tertiary);margin:0 0 10px;font-size:12px;line-height:1.5}
.wsc-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.wsc-section{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:10px;margin:0 0 14px;padding:12px 14px}
.wsc-section legend{color:var(--dsw-alias-label-primary);padding:0 6px;font-size:13px;font-weight:600}
.wsc-field{display:grid;gap:5px;margin-bottom:12px}
.wsc-field:last-child{margin-bottom:0}
.wsc-field-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:550}
.wsc-field-row{display:flex;gap:8px;align-items:center}
.wsc-input{flex:1;min-width:0;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.wsc-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent)}
.wsc-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary,#e04c5a)}
.wsc-reset{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 12px;font-size:12px}
.wsc-reset:disabled{opacity:.45;cursor:default}
.wsc-hint,.wsc-invalid,.wsc-overridden{font-size:11.5px;line-height:1.5}
.wsc-hint{color:var(--dsw-alias-label-tertiary)}
.wsc-invalid{color:var(--dsw-alias-state-error-primary,#e04c5a)}
.wsc-overridden{color:var(--dsw-alias-state-business-primary,#4d7ef7)}
/* Toggle (mobile-first): the whole thing is a < <button> with no native
 * * checkbox + htmlFor dance — taps land on the real button, fires onClick.
 * * Touch target ≥ 44px, custom pill/knob visual, clear on/off state. */
.wsc-toggle-row{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;min-height:44px;padding:6px 8px;margin:-6px -8px;border-radius:8px;background:transparent;border:0;text-align:left;width:calc(100% + 16px);font-family:inherit;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.wsc-toggle-row:active:not([data-disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.wsc-toggle-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d7ef7);outline-offset:-2px}
.wsc-toggle-row[data-disabled]{opacity:.6;cursor:not-allowed}
.wsc-toggle-pill{position:relative;flex:none;width:36px;height:22px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#14141a);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));transition:background-color .14s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.wsc-toggle-row-on .wsc-toggle-pill{background:var(--dsw-alias-state-business-primary,#4d7ef7);border-color:transparent}
.wsc-toggle-knob{position:absolute;top:1px;left:1px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-primary,#f5f5f7);transition:transform .14s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.wsc-toggle-row-on .wsc-toggle-knob{transform:translateX(14px)}
.wsc-toggle-label{flex:1;min-width:0}
.wsc-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 0;display:flex}
.wsp-footer-spacer{flex:1}
.wsc-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.wsc-discard,.wsc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.wsc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.wsc-discard:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wsc-save{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:#0000}
.wsc-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.wsc-discard:disabled,.wsc-save:disabled{opacity:.45;cursor:default}
`

function installStyles(): () => void {
  const selector = 'style[data-plugin-css="dsh-web-search/card"]'
  if (document.querySelector(selector) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-web-search'
  style.dataset.pluginCss = 'dsh-web-search/card'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-web-search: card styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-web-search: card locale')
  const controller = new WebSearchCardController(ctx.settingsScope.bind({ namespace: WEB_SEARCH_SETTINGS_NAMESPACE }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: WEB_SEARCH_SETTINGS_NAMESPACE,
    locale: NS,
    inject: () => controller.inject(),
  }, WebSearchCard))
}