/* @gitawego/dsh-web-search browser plugin: the Web Search Settings section.
 * Settings reads/writes go through the plugin's own same-origin route
 * (/_dsh/web-search/settings) over the settings seam — the harness settings
 * proxy does not expose plugin namespaces by default. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'web-search'
const SETTINGS_ROUTE = '/_dsh/web-search/settings'

type WebSearchTranslate = TranslateNS<'web-search'>

const en = {
  nav: 'Web Search',
  title: 'Web Search',
  intro: 'Configures the enhanced web search provider (opencode-enhanced) — the currently active provider. Free backends (Parallel / Exa) need no API key; the optional opencode Go backend runs first when a base URL and credential are set.',
  whereTitle: 'What this page configures',
  whereActive: 'ACTIVE provider is opencode-enhanced (switched via profile config web.searchProvider)',
  whereUrl: 'opencode Go endpoint + credential — OPTIONAL for this plugin; leave empty to use free backends',
  whereFree: 'Free Parallel / Exa endpoints — no key needed, always available',
  builtinTitle: 'About the built-in DeepSeek web search',
  builtinHint: 'DSH also ships its own DeepSeek web search (provider id deepseek-official), configured separately under DeepSeek settings / Models — not here. This page only tunes opencode-enhanced.',
  credentialHint: 'Name of a credential in the harness store (e.g. OPENCODE_GO_API_KEY). Not the built-in DEEPSEEK_API_KEY used by DSH built-in search.',
  goTitle: 'opencode Go backend',
  goHint: 'Used first when a base URL is set and the credential resolves. Leave base URL empty to skip it and use the free backends directly.',
  baseUrl: 'Base URL',
  credential: 'Credential reference',
  model: 'Model',
  timeoutMs: 'Timeout (ms)',
  freeTitle: 'Free backends (no API key)',
  freeHint: 'Used when Go is unavailable; Parallel runs first, then Exa.',
  parallelUrl: 'Parallel endpoint',
  exaUrl: 'Exa endpoint',
  freeTimeoutMs: 'Free timeout (ms)',
  snippetMaxChars: 'Snippet max chars',
  maxResults: 'Max results',
  behavior: 'Behavior',
  activeProvider: 'Active provider',
  activeProviderHint: 'Set in the profile cordis.patch.yml (web.searchProvider). This plugin registers id "opencode-enhanced".',
  save: 'Save and apply',
  saving: 'Saving…',
  saved: 'Settings applied.',
  reload: 'Reload',
  readOnly: 'The active Settings provider is read-only.',
  unset: '— unset —',
  running: 'Loading…',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  nav: '网页搜索',
  title: '网页搜索',
  intro: '配置增强搜索提供方（opencode-enhanced）——当前生效的提供方。免费后端（Parallel / Exa）无需 API key；可选的开源 Go 后端在配置 base URL 与凭据后优先使用。',
  whereTitle: '本页面配置了什么',
  whereActive: '生效提供方为 opencode-enhanced（通过 profile 配置 web.searchProvider 切换）',
  whereUrl: '本插件的 Go 端点与凭据——可选；留空则走免费后端',
  whereFree: '免费 Parallel / Exa 端点——无需 key，始终可用',
  builtinTitle: '关于内置的 DeepSeek 网页搜索',
  builtinHint: 'DSH 还内置独立的 DeepSeek 网页搜索（提供方 id deepseek-official），在 DeepSeek 设置 / Models 中单独配置，并非本页面。本页面仅调节 opencode-enhanced。',
  credentialHint: '凭据库中的凭据名称（如 OPENCODE_GO_API_KEY）。非内置搜索使用的 DEEPSEEK_API_KEY。',
  goTitle: 'opencode Go 后端',
  goHint: '配置了 base URL 且凭据可解析时优先使用。留空 base URL 则跳过并直接使用免费后端。',
  baseUrl: '服务地址',
  credential: 'Credential 引用',
  model: '模型',
  timeoutMs: '超时（ms）',
  freeTitle: '免费后端（无需 API key）',
  freeHint: '当 Go 不可用时使用；先 Parallel 后 Exa。',
  parallelUrl: 'Parallel 端点',
  exaUrl: 'Exa 端点',
  freeTimeoutMs: '免费超时（ms）',
  snippetMaxChars: '摘要最大字符数',
  maxResults: '最大结果数',
  behavior: '行为',
  activeProvider: '当前生效提供方',
  activeProviderHint: '在 profile 的 cordis.patch.yml 中设置（web.searchProvider）。本插件注册 id 为 “opencode-enhanced”。',
  save: '保存并应用',
  saving: '保存中…',
  saved: '设置已生效。',
  reload: '重新加载',
  readOnly: '当前 Settings 提供方为只读。',
  unset: '— 未设置 —',
  running: '加载中…',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-search': LocaleKey
  }
}

export interface WebSearchSettingsSnapshot {
  writable: boolean
  value: Record<string, unknown>
}

interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: WebSearchSettingsSnapshot
  error?: string
}

interface ApiEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SettingsController {
  private state: SettingsState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): SettingsState => this.state

  private set(next: SettingsState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.state, status: 'loading', error: undefined })
    try {
      const response = await fetch(SETTINGS_ROUTE, { credentials: 'same-origin' })
      const body = await response.json() as ApiEnvelope<WebSearchSettingsSnapshot>
      if (generation !== this.generation) return
      if (!response.ok || !body.ok || body.value === undefined) throw new Error(body.error?.message ?? 'Web Search settings request failed')
      this.set({ status: 'ready', snapshot: body.value })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  async save(patch: Record<string, unknown>): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.state, status: 'loading', error: undefined })
    try {
      const response = await fetch(SETTINGS_ROUTE, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const body = await response.json() as ApiEnvelope<WebSearchSettingsSnapshot>
      if (generation !== this.generation) return
      if (!response.ok || !body.ok || body.value === undefined) throw new Error(body.error?.message ?? 'Web Search settings save failed')
      this.set({ status: 'ready', snapshot: body.value })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

function strField(raw: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = raw?.[key]
  return typeof value === 'string' ? value : fallback
}
function numField(raw: Record<string, unknown> | undefined, key: string, fallback: number): string {
  const value = raw?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : String(fallback)
}

interface Draft {
  goBaseUrl: string
  goCredential: string
  goModel: string
  goTimeoutMs: string
  parallelUrl: string
  exaUrl: string
  freeTimeoutMs: string
  snippetMaxChars: string
  maxResults: string
}

function draftOf(raw: Record<string, unknown> | undefined): Draft {
  const go = isRecord(raw?.go) ? raw.go : undefined
  const free = isRecord(raw?.free) ? raw.free : undefined
  return {
    goBaseUrl: strField(go, 'baseUrl'),
    goCredential: strField(go, 'credential'),
    goModel: strField(go, 'model'),
    goTimeoutMs: numField(go, 'timeoutMs', 20000),
    parallelUrl: strField(free, 'parallelUrl'),
    exaUrl: strField(free, 'exaUrl'),
    freeTimeoutMs: numField(free, 'timeoutMs', 15000),
    snippetMaxChars: numField(free, 'snippetMaxChars', 300),
    maxResults: numField(free, 'maxResults', 8),
  }
}

type SettingsViewProps = PropsRuntime<'settings.section'> & { t?: WebSearchTranslate; settings?: SettingsController }

const enFallback: WebSearchTranslate = (key) => (en as Record<string, string>)[key] ?? key

function SettingsSection({ settings, t = enFallback }: SettingsViewProps) {
  if (settings === undefined) return <div className="wss-settings"><div className="wss-loading">{t('running')}</div></div>
  return <LoadedSettings settings={settings} t={t} />
}

function LoadedSettings({ settings, t }: { settings: SettingsController; t: WebSearchTranslate }) {
  const state = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  useEffect(() => { void settings.load() }, [settings])
  useEffect(() => {
    if (state.snapshot !== undefined) setDraft(draftOf(state.snapshot.value))
  }, [state.snapshot])

  if (draft === undefined) return <div className="wss-settings"><div className="wss-loading">{t('running')}</div></div>

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setMessage(undefined)
    setDraft((current) => (current === undefined ? current : { ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    setBusy(true); setMessage(undefined)
    try {
      await settings.save({
        go: {
          ...(draft.goBaseUrl.trim().length === 0 ? {} : { baseUrl: draft.goBaseUrl.trim() }),
          ...(draft.goCredential.trim().length === 0 ? {} : { credential: draft.goCredential.trim() }),
          ...(draft.goModel.trim().length === 0 ? {} : { model: draft.goModel.trim() }),
          timeoutMs: Number(draft.goTimeoutMs) || 20000,
        },
        free: {
          parallelUrl: draft.parallelUrl.trim(),
          exaUrl: draft.exaUrl.trim(),
          timeoutMs: Number(draft.freeTimeoutMs) || 15000,
          snippetMaxChars: Number(draft.snippetMaxChars) || 300,
          maxResults: Number(draft.maxResults) || 8,
        },
      })
      setMessage(t('saved'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  return (
    <div className="wss-settings">
      <header className="wss-settings-header">
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
      </header>
      {state.snapshot?.writable === false ? <div className="wss-alert warning">{t('readOnly')}</div> : null}
      {state.error === undefined ? null : <div className="wss-alert error">{state.error}</div>}
      {message === undefined ? null : <div className="wss-alert success">{message}</div>}


      <section className="wss-panel"><h3>{t('whereTitle')}</h3>
        <div className="wss-rows">
          <p className="wss-row"><span className="wss-dot active" />{t('whereActive')}</p>
          <p className="wss-row"><span className="wss-dot go" />{t('whereUrl')}</p>
          <p className="wss-row"><span className="wss-dot free" />{t('whereFree')}</p>
        </div>
        <div className="wss-builtin"><strong>{t('builtinTitle')}</strong><span>{t('builtinHint')}</span></div>
      </section>
      <section className="wss-panel"><h3>{t('behavior')}</h3>
        <div className="wss-field wss-span2"><span>{t('activeProvider')}</span>
          <code className="wss-badge">opencode-enhanced</code>
          <small className="wss-hint">{t('activeProviderHint')}</small>
        </div>
      </section>

      <section className="wss-panel"><h3>{t('goTitle')}</h3>
        <div className="wss-grid">
          <label className="wss-field"><span>{t('baseUrl')}</span><input value={draft.goBaseUrl} onChange={(e) => update('goBaseUrl', e.target.value)} placeholder="https://opencode.ai/zen/go/v1" /></label>
          <label className="wss-field"><span>{t('credential')}</span><input value={draft.goCredential} onChange={(e) => update('goCredential', e.target.value)} placeholder="OPENCODE_GO_API_KEY" />
            <small className="wss-hint">{t('credentialHint')}</small>
          </label>
          <label className="wss-field"><span>{t('model')}</span><input value={draft.goModel} onChange={(e) => update('goModel', e.target.value)} placeholder="deepseek-v4-flash" /></label>
          <label className="wss-field"><span>{t('timeoutMs')}</span><input inputMode="numeric" value={draft.goTimeoutMs} onChange={(e) => update('goTimeoutMs', e.target.value)} /></label>
        </div>
        <small className="wss-hint">{t('goHint')}</small>
      </section>

      <section className="wss-panel"><h3>{t('freeTitle')}</h3>
        <div className="wss-grid">
          <label className="wss-field"><span>{t('parallelUrl')}</span><input value={draft.parallelUrl} onChange={(e) => update('parallelUrl', e.target.value)} placeholder="https://search.parallel.ai/mcp" /></label>
          <label className="wss-field"><span>{t('exaUrl')}</span><input value={draft.exaUrl} onChange={(e) => update('exaUrl', e.target.value)} placeholder="https://mcp.exa.ai/mcp" /></label>
          <label className="wss-field"><span>{t('freeTimeoutMs')}</span><input inputMode="numeric" value={draft.freeTimeoutMs} onChange={(e) => update('freeTimeoutMs', e.target.value)} /></label>
          <label className="wss-field"><span>{t('snippetMaxChars')}</span><input inputMode="numeric" value={draft.snippetMaxChars} onChange={(e) => update('snippetMaxChars', e.target.value)} /></label>
          <label className="wss-field"><span>{t('maxResults')}</span><input inputMode="numeric" value={draft.maxResults} onChange={(e) => update('maxResults', e.target.value)} /></label>
        </div>
        <small className="wss-hint">{t('freeHint')}</small>
      </section>

      <div className="wss-save-row">
        <button type="button" className="wss-primary" disabled={state.snapshot?.writable === false || busy} onClick={() => { void save() }}>{busy ? t('saving') : t('save')}</button>
        <button type="button" className="wss-outline" disabled={busy} onClick={() => { void settings.load() }}>{t('reload')}</button>
      </div>
    </div>
  )
}

const CSS = `
.wss-settings{display:grid;gap:18px;max-width:920px;padding:10px 2px 44px;color:var(--dsw-alias-label-primary,#f5f5f7);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.wss-settings-header h2{font-size:24px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}
.wss-settings-header p{margin:0;color:var(--dsw-alias-label-secondary,#c8c8cf);font-size:13.5px;line-height:1.6;max-width:680px}
.wss-alert{padding:10px 13px;border-radius:10px;font-size:13px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.wss-alert.warning{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a237) 12%,transparent);color:var(--dsw-alias-state-warn-primary,#e0a237)}
.wss-alert.success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#309a64) 12%,transparent);color:var(--dsw-alias-state-success-primary,#309a64)}
.wss-alert.error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e04c5a) 12%,transparent);color:var(--dsw-alias-state-error-primary,#e04c5a)}
.wss-panel{display:grid;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#191920)}
.wss-panel h3{font-size:14px;font-weight:600;margin:0}
.wss-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.wss-grid .wss-span2{grid-column:1/-1}
.wss-field{display:grid;gap:6px;align-content:start;min-width:0}
.wss-field span{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-secondary,#c8c8cf)}
.wss-field .wss-hint,.wss-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.wss-field input{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#14141a);color:var(--dsw-alias-label-primary,#f5f5f7);font:inherit;font-size:13px;outline:none;transition:border-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.wss-field input:focus{border-color:var(--dsw-alias-brand-primary,#4d7ef7);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d7ef7) 25%,transparent)}
.wss-field input{color:#e8e8ee}.wss-field input::placeholder{color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.wss-rows{display:grid;gap:7px;margin:2px 0 6px}
.wss-row{display:flex;align-items:baseline;gap:9px;margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#c8c8cf)}
.wss-dot{flex:none;width:9px;height:9px;border-radius:50%;align-self:center}
.wss-dot.active{background:var(--dsw-alias-state-success-primary,#309a64)}
.wss-dot.go{background:var(--dsw-alias-state-warn-primary,#e0a237)}
.wss-dot.free{background:var(--dsw-alias-state-business-primary,#4d7ef7)}
.wss-builtin{margin-top:12px;padding:11px 13px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a237) 10%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));display:grid;gap:4px}
.wss-builtin strong{font-size:12.5px;color:var(--dsw-alias-state-warn-primary,#e0a237)}
.wss-builtin span{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#c8c8cf)}
.wss-badge{display:inline-block;width:fit-content;font-size:12px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d7ef7) 14%,transparent);color:var(--dsw-alias-state-business-primary,#6d94f7)}
.wss-save-row{display:flex;gap:10px;align-items:center}
.wss-primary,.wss-outline{height:34px;padding:0 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;transition:background-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.wss-primary{background:var(--dsw-alias-button-primary-fill,#4d7ef7);color:var(--dsw-alias-label-primary-inverted,#17171c);border:0}
.wss-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3f66d9)}
.wss-primary:disabled,.wss-outline:disabled{opacity:.45;cursor:default}
.wss-outline{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#f5f5f7)}
.wss-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.wss-loading{padding:26px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#14141a);font-size:13px;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
@media(max-width:720px){.wss-grid{grid-template-columns:1fr}}
`

function installStyles(): () => void {
  const selector = 'style[data-plugin-css="dsh-web-search/client"]'
  const existing = document.querySelector<HTMLStyleElement>(selector)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-web-search'
  style.dataset.pluginCss = 'dsh-web-search/client'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-web-search: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-web-search: locale')
  const t = ctx.locale.bind(NS)
  const settings = new SettingsController()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'web-search',
    order: 40,
    label: () => t('nav'),
    inject: () => ({ t, settings }),
  }, SettingsSection))
}