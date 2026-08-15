/** dsh-vision browser plugin (M3): a describe_image Tool card and the Vision
 *  Settings section. Everything is DATA-DRIVEN: the provider/model selectors
 *  are populated from the live host LLM catalog (/_dsh/vision/models) and the
 *  detected image-capable default is the catalog scan's preference — no
 *  provider or model id is hardcoded anywhere. Settings reads/writes go through
 *  the plugin's own same-origin route (/_dsh/vision/settings) over the settings
 *  seam — the harness settings proxy does not expose plugin namespaces by
 *  default, so the form must not depend on ctx.settingsScope. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'vision'
const MODELS_ROUTE = '/_dsh/vision/models'
const SETTINGS_ROUTE = '/_dsh/vision/settings'

type VisionTranslate = TranslateNS<'vision'>

const en = {
  nav: 'Vision',
  settingsTitle: 'Vision',
  settingsIntro: 'Configure the vision provider/model used for describe_image delegation and paste auto-delegation. Providers and models are discovered from the live harness catalog; nothing is hardcoded.',
  catalogUnavailable: 'The live model catalog is unavailable here — enter a configured provider/model manually, or run this in the Web profile.',
  detectedDefault: 'Detected vision-capable default',
  provider: 'Provider',
  model: 'Model',
  delegation: 'Delegation',
  delegationHint: 'auto — native sub-agent with the vision model (falls back to the direct http endpoint when the harness cannot deliver images natively); native — same as auto but never falls back; http — plugin-owned direct endpoint call (base64 image).',
  http: 'HTTP endpoint',
  baseUrl: 'Base URL',
  credential: 'Credential reference',
  httpModel: 'HTTP model',
  protocol: 'Protocol',
  paste: 'Paste behavior',
  textOnlyPasteMode: 'Text-only paste mode',
  markerStyle: 'Marker style',
  limits: 'Limits',
  maxDimension: 'Max dimension (px)',
  jpegQuality: 'JPEG quality',
  cacheMaxEntries: 'Cache entries',
  retryAttempts: 'Retry attempts',
  autoDelegateTimeoutMs: 'Auto-delegate timeout (ms)',
  behavior: 'Behavior',
  enabled: 'Enabled',
  localOnly: 'Local-only (never send bytes)',
  cacheEnabled: 'Cache delegation results',
  cachePersist: 'Persist cache to disk',
  auditLog: 'Audit log',
  autoDetectVisionModel: 'Auto-detect vision model',
  save: 'Save and apply',
  saving: 'Saving…',
  saved: 'Settings applied.',
  reload: 'Reload',
  readOnly: 'The active Settings provider is read-only.',
  unset: '— unset —',
  running: 'Analyzing…',
  failed: 'Failed',
  cached: 'cached',
  fallback: 'fallback',
  images: 'image(s)',
  prompt: 'Prompt',
  noPrompt: 'No prompt',
  imagesHint: 'Image paths (click to open)',
  describe: 'Describe image(s)',
  result: 'Result',
  detectedBadge: 'detected',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  nav: '视觉',
  settingsTitle: '视觉',
  settingsIntro: '配置 describe_image 委派与粘贴自动委派使用的视觉 provider/model。provider 与模型均来自 Harness 实时目录，无任何硬编码。',
  catalogUnavailable: '此处无法获取实时模型目录——请手动输入已配置的 provider/model，或在 Web 配置文件中运行。',
  detectedDefault: '检测到的视觉模型默认值',
  provider: 'Provider',
  model: 'Model',
  delegation: '委派方式',
  delegationHint: 'auto——以视觉模型启动原生子代理（宿主无法原生投递图片时回退到 http 直连）；native——与 auto 相同但不回退；http——插件自有端点直连（base64 图片）。',
  http: 'HTTP 端点',
  baseUrl: '服务地址',
  credential: 'Credential 引用',
  httpModel: 'HTTP 模型',
  protocol: '协议',
  paste: '粘贴行为',
  textOnlyPasteMode: '纯文本模型粘贴模式',
  markerStyle: '标记样式',
  limits: '限制',
  maxDimension: '最大边长（px）',
  jpegQuality: 'JPEG 质量',
  cacheMaxEntries: '缓存条目数',
  retryAttempts: '重试次数',
  autoDelegateTimeoutMs: '自动委派超时（ms）',
  behavior: '行为',
  enabled: '启用',
  localOnly: '仅本地（不发送图像字节）',
  cacheEnabled: '缓存委派结果',
  cachePersist: '缓存持久化到磁盘',
  auditLog: '审计日志',
  autoDetectVisionModel: '自动检测视觉模型',
  save: '保存并应用',
  saving: '保存中…',
  saved: '设置已生效。',
  reload: '重新加载',
  readOnly: '当前 Settings 提供方为只读。',
  unset: '— 未设置 —',
  running: '分析中…',
  failed: '失败',
  cached: '已缓存',
  fallback: '回退',
  images: '张图片',
  prompt: '提示词',
  noPrompt: '无提示词',
  imagesHint: '图片路径（点击打开）',
  describe: '描述图片',
  result: '结果',
  detectedBadge: '已检测',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-vision Tool cards and Settings copy. */
    'vision': LocaleKey
  }
}

// ── data-driven catalog mirror of the host /_dsh/vision/models route ───────

export interface VisionModelRow {
  provider: string
  model: string
  name: string
  default?: boolean
}

export interface VisionModelsSnapshot {
  providers: Array<{ id: string; name: string }>
  visionModels: VisionModelRow[]
  configured: { provider: string | undefined; model: string | undefined }
  detected: VisionModelRow | undefined
  available: boolean
}

interface CatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: VisionModelsSnapshot
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

/** Small external store fetching the live catalog once + on reload. */
export class CatalogController {
  private state: CatalogState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): CatalogState => this.state

  private set(next: CatalogState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.state, status: 'loading', error: undefined })
    try {
      const response = await fetch(MODELS_ROUTE, { credentials: 'same-origin' })
      const body = await response.json() as ApiEnvelope<VisionModelsSnapshot>
      if (generation !== this.generation) return
      if (!response.ok || !body.ok || body.value === undefined) {
        throw new Error(body.error?.message ?? `Vision catalog request failed with HTTP ${response.status}`)
      }
      this.set({ status: 'ready', snapshot: body.value })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Wire mirror of the host /_dsh/vision/settings route. */
export interface VisionSettingsSnapshot {
  writable: boolean
  value: Record<string, unknown>
}

interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: VisionSettingsSnapshot
  error?: string
}

/** External store over the plugin's own settings route (the harness settings
 *  proxy does not expose plugin namespaces by default). */
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
      const body = await response.json() as ApiEnvelope<VisionSettingsSnapshot>
      if (generation !== this.generation) return
      if (!response.ok || !body.ok || body.value === undefined) {
        throw new Error(body.error?.message ?? `Vision settings request failed with HTTP ${response.status}`)
      }
      this.set({ status: 'ready', snapshot: body.value })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** POST one form submission; throws with the server message on failure. */
  async save(patch: Record<string, unknown>): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.state, status: 'loading', error: undefined })
    try {
      const response = await fetch(SETTINGS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await response.json() as ApiEnvelope<VisionSettingsSnapshot>
      if (generation !== this.generation) return
      if (!response.ok || !body.ok || body.value === undefined) {
        throw new Error(body.error?.message ?? `Vision settings save failed with HTTP ${response.status}`)
      }
      this.set({ status: 'ready', snapshot: body.value })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

// ── describe_image Tool card ───────────────────────────────────────────────

type ToolViewProps = PropsRuntime<'tool.call.toolview'> & { t?: VisionTranslate }

function argsRawOf(block: ToolCallBlock): string {
  return 'call' in block ? (block.call?.argsRaw ?? '') : block.argsRaw
}

function parseArgs(argsRaw: string): { images: string[]; prompt: string } {
  try {
    const parsed = JSON.parse(argsRaw) as Record<string, unknown>
    const images: string[] = []
    if (Array.isArray(parsed.image_paths)) {
      for (const entry of parsed.image_paths) if (typeof entry === 'string') images.push(entry)
    }
    if (typeof parsed.image_path === 'string') images.push(parsed.image_path)
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : ''
    return { images, prompt }
  } catch {
    return { images: [], prompt: '' }
  }
}

function resultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  return block.content
    .filter((entry): entry is Extract<typeof entry, { type: 'text' }> => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n')
    .trim()
}

function detailsOf(block: ToolCallBlock): Record<string, unknown> {
  if (!('kind' in block)) return {}
  const meta = block.meta
  if (!isRecord(meta)) return {}
  const details = meta.details
  return isRecord(details) ? details : {}
}

function resolveOpenPath(path: string, cwd: string | undefined): string {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path
  return cwd === undefined || cwd.length === 0 ? path : `${cwd.replace(/\/+$/, '')}/${path}`
}

const enFallback: VisionTranslate = (key) => (en as Record<string, string>)[key] ?? key

function DescribeImageView({ block, openFile, cwd, t = enFallback }: ToolViewProps) {
  const [open, setOpen] = useState(true)
  const running = !('kind' in block)
  const isError = !running && block.isError
  const args = parseArgs(argsRawOf(block))
  const details = detailsOf(block)
  const text = resultText(block)
  const summary = args.images.length > 0 ? `${args.images.length} ${t('images')}` : undefined
  const model = typeof details.model === 'string' ? details.model : undefined
  const transport = typeof details.transport === 'string' ? details.transport : undefined
  const cached = details.cached === true
  const fallback = details.fallback === true
  const status = running ? t('running') : isError ? t('failed') : model === undefined ? undefined : `${transport === undefined ? '' : transport + ' · '}${model}`
  return (
    <section className="dvs-tool" data-state={running ? 'running' : isError ? 'error' : 'success'}>
      <button type="button" className="dvs-tool-head" onClick={() => { setOpen((value) => !value) }} aria-expanded={open}>
        <span className="dvs-tool-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M3 5V3h2M11 3h2v2M13 11v2h-2M5 13H3v-2M5 8h6" /></svg>
        </span>
        <span className="dvs-tool-title">{t('describe')}</span>
        {summary === undefined ? null : <span className="dvs-tool-summary">{summary}</span>}
        {status === undefined ? null : <span className="dvs-tool-status">{status}</span>}
        <span className="dvs-chevron" data-open={open || undefined} aria-hidden="true">⌄</span>
      </button>
      {!open ? null : (
        <div className="dvs-tool-body">
          {isError ? <p className="dvs-muted">{text || t('failed')}</p> : (
            <div className="dvs-stack">
              <div className="dvs-meta">
                {cached ? <span className="dvs-tag">{t('cached')}</span> : null}
                {fallback ? <span className="dvs-tag">{t('fallback')}</span> : null}
              </div>
              <div className="dvs-block"><span className="dvs-label">{t('prompt')}</span><p>{args.prompt.trim().length === 0 ? t('noPrompt') : args.prompt}</p></div>
              {args.images.length === 0 ? null : (
                <div className="dvs-block"><span className="dvs-label">{t('imagesHint')}</span>
                  <ul className="dvs-paths">{args.images.map((path, index) => (
                    <li key={`${index}-${path}`}><button type="button" onClick={() => { openFile(resolveOpenPath(path, cwd)) }}>{path}</button></li>
                  ))}</ul>
                </div>
              )}
              {text.length === 0 ? null : <div className="dvs-block"><span className="dvs-label">{t('result')}</span><pre className="dvs-result">{text}</pre></div>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Dropdown options for the provider select: every registered provider from
 *  the live catalog (data-driven), the detected default, and a configured
 *  provider that left the catalog (retained so the current config is never
 *  invisible or unselectable). */
export function providerOptions(
  snapshot: VisionModelsSnapshot | undefined,
  configured: string,
  detected: string | undefined,
): string[] {
  const out: string[] = []
  for (const p of snapshot?.providers ?? []) out.push(p.id)
  if (detected !== undefined && !out.includes(detected)) out.push(detected)
  const configuredTrimmed = configured.trim()
  if (configuredTrimmed.length > 0 && !out.includes(configuredTrimmed)) out.push(configuredTrimmed)
  return out
}

export interface ModelOption {
  value: string
  /** True when this is the catalog-scan preferred default. */
  detected: boolean
  /** True when the current config names a model absent from the catalog. */
  retained: boolean
}

/** Dropdown options for the model select: vision models of the selected
 *  provider (data-driven), the detected default marked, and a configured
 *  model that left the catalog retained. No provider selected → none. */
export function modelOptions(
  snapshot: VisionModelsSnapshot | undefined,
  provider: string,
  configured: string,
  detected: string | undefined,
): ModelOption[] {
  const providerTrimmed = provider.trim()
  if (providerTrimmed.length === 0) return []
  const out: ModelOption[] = []
  for (const m of snapshot?.visionModels ?? []) {
    if (m.provider === providerTrimmed) {
      out.push({ value: m.model, detected: detected === m.model, retained: false })
    }
  }
  const configuredTrimmed = configured.trim()
  if (configuredTrimmed.length > 0 && !out.some((o) => o.value === configuredTrimmed)) {
    out.push({ value: configuredTrimmed, detected: detected === configuredTrimmed, retained: true })
  }
  return out
}

// ── Vision Settings section ────────────────────────────────────────────────

type SettingsViewProps = PropsRuntime<'settings.section'> & { t?: VisionTranslate; settings?: SettingsController; catalog?: CatalogController }

interface Draft {
  provider: string
  model: string
  enabled: boolean
  delegation: string
  baseUrl: string
  credential: string
  httpModel: string
  protocol: string
  textOnlyPasteMode: string
  markerStyle: string
  maxDimension: string
  jpegQuality: string
  cacheEnabled: boolean
  cachePersist: boolean
  cacheMaxEntries: string
  retryAttempts: string
  autoDelegateTimeoutMs: string
  localOnly: boolean
  auditLog: boolean
  autoDetectVisionModel: boolean
}

function strField(raw: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = raw?.[key]
  return typeof value === 'string' ? value : fallback
}

function boolField(raw: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const value = raw?.[key]
  return typeof value === 'boolean' ? value : fallback
}

function numField(raw: Record<string, unknown> | undefined, key: string, fallback: number): string {
  const value = raw?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : String(fallback)
}

function draftOf(raw: Record<string, unknown> | undefined): Draft {
  const http = isRecord(raw?.http) ? raw.http : undefined
  return {
    provider: strField(raw, 'provider'),
    model: strField(raw, 'model'),
    enabled: boolField(raw, 'enabled', true),
    delegation: strField(raw, 'delegation', 'auto'),
    baseUrl: strField(http, 'baseUrl'),
    credential: strField(http, 'credential'),
    httpModel: strField(http, 'model'),
    protocol: strField(http, 'protocol', 'openai'),
    textOnlyPasteMode: strField(raw, 'textOnlyPasteMode', 'hint'),
    markerStyle: strField(raw, 'markerStyle', 'code'),
    maxDimension: numField(raw, 'maxDimension', 1568),
    jpegQuality: numField(raw, 'jpegQuality', 85),
    cacheEnabled: boolField(raw, 'cacheEnabled', true),
    cachePersist: boolField(raw, 'cachePersist', false),
    cacheMaxEntries: numField(raw, 'cacheMaxEntries', 256),
    retryAttempts: numField(raw, 'retryAttempts', 2),
    autoDelegateTimeoutMs: numField(raw, 'autoDelegateTimeoutMs', 30000),
    localOnly: boolField(raw, 'localOnly', false),
    auditLog: boolField(raw, 'auditLog', true),
    autoDetectVisionModel: boolField(raw, 'autoDetectVisionModel', true),
  }
}

function SettingsSection({ settings, catalog, t = enFallback }: SettingsViewProps) {
  if (settings === undefined || catalog === undefined) return <div className="dvs-settings"><div className="dvs-loading">{t('running')}</div></div>
  return <LoadedSettings settings={settings} catalog={catalog} t={t} />
}

function LoadedSettings({ settings, catalog, t }: { settings: SettingsController; catalog: CatalogController; t: VisionTranslate }) {
  const settingsState = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const seededRef = useRef(false)

  useEffect(() => { void catalog.load() }, [catalog])
  useEffect(() => { void settings.load() }, [settings])
  useEffect(() => {
    if (settingsState.snapshot !== undefined) setDraft(draftOf(settingsState.snapshot.value))
  }, [settingsState.snapshot])

  // Offer the detected vision-capable default once, only when fields are unset.
  useEffect(() => {
    if (seededRef.current) return
    const snapshot = catalogState.snapshot
    if (snapshot === undefined || snapshot.detected === undefined) return
    seededRef.current = true
    setDraft((current) => {
      if (current === undefined) return current
      const next = { ...current }
      if (next.provider.trim().length === 0) next.provider = snapshot.detected!.provider
      if (next.model.trim().length === 0) next.model = snapshot.detected!.model
      return next
    })
  }, [catalogState.snapshot])

  if (draft === undefined) {
    return <div className="dvs-settings"><div className="dvs-loading">{t('running')}</div></div>
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setMessage(undefined)
    setDraft((current) => (current === undefined ? current : { ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      await settings.save({
        provider: draft.provider.trim(),
        model: draft.model.trim(),
        enabled: draft.enabled,
        delegation: draft.delegation,
        textOnlyPasteMode: draft.textOnlyPasteMode,
        markerStyle: draft.markerStyle,
        maxDimension: Number(draft.maxDimension) || 1568,
        jpegQuality: Number(draft.jpegQuality) || 85,
        cacheEnabled: draft.cacheEnabled,
        cachePersist: draft.cachePersist,
        cacheMaxEntries: Number(draft.cacheMaxEntries) || 256,
        retryAttempts: Number(draft.retryAttempts) || 2,
        autoDelegateTimeoutMs: Number(draft.autoDelegateTimeoutMs) || 30000,
        localOnly: draft.localOnly,
        auditLog: draft.auditLog,
        autoDetectVisionModel: draft.autoDetectVisionModel,
        http: {
          ...(draft.baseUrl.trim().length === 0 ? {} : { baseUrl: draft.baseUrl.trim() }),
          ...(draft.credential.trim().length === 0 ? {} : { credential: draft.credential.trim() }),
          ...(draft.httpModel.trim().length === 0 ? {} : { model: draft.httpModel.trim() }),
          protocol: draft.protocol,
        },
      })
      setMessage(t('saved'))
      void catalog.load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const snapshot = catalogState.snapshot
  const detected = snapshot?.detected

  return (
    <div className="dvs-settings">
      <header className="dvs-settings-header">
        <h2>{t('settingsTitle')}</h2>
        <p>{t('settingsIntro')}</p>
      </header>
      {snapshot?.available === false ? <div className="dvs-alert warning">{t('catalogUnavailable')}</div> : null}
      {detected === undefined ? null : (
        <div className="dvs-alert notice">{t('detectedDefault')}: <strong>{detected.provider}/{detected.model}</strong> <span className="dvs-badge">{t('detectedBadge')}</span></div>
      )}
      {settingsState.snapshot?.writable === false ? <div className="dvs-alert warning">{t('readOnly')}</div> : null}
      {settingsState.error === undefined ? null : <div className="dvs-alert error">{settingsState.error}</div>}
      {message === undefined ? null : <div className="dvs-alert success">{message}</div>}

      <section className="dvs-panel"><h3>{t('provider')} / {t('model')}</h3><div className="dvs-grid">
        <label className="dvs-field"><span>{t('provider')}</span>
          <select value={draft.provider} onChange={(event) => { update('provider', event.target.value); update('model', '') }}>
            <option value="">{t('unset')}</option>
            {providerOptions(snapshot, draft.provider, detected?.provider).map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="dvs-field"><span>{t('model')}</span>
          <select value={draft.model} onChange={(event) => { update('model', event.target.value) }}>
            <option value="">{t('unset')}</option>
            {modelOptions(snapshot, draft.provider, draft.model, detected?.model).map((option) => (
              <option key={option.value} value={option.value}>
                {option.value}{option.detected ? ` (${t('detectedBadge')})` : option.retained ? ' (configured)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div></section>

      <section className="dvs-panel"><h3>{t('behavior')}</h3>
        <div className="dvs-grid">
          <label className="dvs-field dvs-span2"><span>{t('delegation')}</span>
            <select value={draft.delegation} onChange={(event) => { update('delegation', event.target.value) }}>
              <option value="auto">auto</option>
              <option value="native">native</option>
              <option value="http">http</option>
            </select>
            <small className="dvs-hint">{t('delegationHint')}</small>
          </label>
        </div>
        <div className="dvs-grid">
          <label className="dvs-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => { update('enabled', event.target.checked) }} />{t('enabled')}</label>
          <label className="dvs-check"><input type="checkbox" checked={draft.autoDetectVisionModel} onChange={(event) => { update('autoDetectVisionModel', event.target.checked) }} />{t('autoDetectVisionModel')}</label>
          <label className="dvs-check"><input type="checkbox" checked={draft.localOnly} onChange={(event) => { update('localOnly', event.target.checked) }} />{t('localOnly')}</label>
        </div>
      </section>

      {draft.delegation === 'native' ? null : (
        <section className="dvs-panel"><h3>{t('http')}</h3><div className="dvs-grid">
          <label className="dvs-field"><span>{t('baseUrl')}</span><input value={draft.baseUrl} onChange={(event) => { update('baseUrl', event.target.value) }} placeholder="https://…" /></label>
          <label className="dvs-field"><span>{t('credential')}</span><input value={draft.credential} onChange={(event) => { update('credential', event.target.value) }} placeholder="VISION_API_KEY" /></label>
          <label className="dvs-field"><span>{t('httpModel')}</span><input value={draft.httpModel} onChange={(event) => { update('httpModel', event.target.value) }} placeholder="model" /></label>
          <label className="dvs-field"><span>{t('protocol')}</span>
            <select value={draft.protocol} onChange={(event) => { update('protocol', event.target.value) }}><option value="openai">openai</option><option value="anthropic">anthropic</option></select>
          </label>
        </div></section>
      )}

      <section className="dvs-panel"><h3>{t('paste')}</h3><div className="dvs-grid">
        <label className="dvs-field"><span>{t('textOnlyPasteMode')}</span>
          <select value={draft.textOnlyPasteMode} onChange={(event) => { update('textOnlyPasteMode', event.target.value) }}>
            <option value="hint">hint</option><option value="auto">auto</option><option value="off">off</option>
          </select>
        </label>
        <label className="dvs-field"><span>{t('markerStyle')}</span>
          <select value={draft.markerStyle} onChange={(event) => { update('markerStyle', event.target.value) }}>
            <option value="code">code</option><option value="bold">bold</option><option value="plain">plain</option>
          </select>
        </label>
      </div></section>

      <section className="dvs-panel"><h3>{t('limits')}</h3><div className="dvs-grid">
        <label className="dvs-field"><span>{t('maxDimension')}</span><input inputMode="numeric" value={draft.maxDimension} onChange={(event) => { update('maxDimension', event.target.value) }} /></label>
        <label className="dvs-field"><span>{t('jpegQuality')}</span><input inputMode="numeric" value={draft.jpegQuality} onChange={(event) => { update('jpegQuality', event.target.value) }} /></label>
        <label className="dvs-field"><span>{t('cacheMaxEntries')}</span><input inputMode="numeric" value={draft.cacheMaxEntries} onChange={(event) => { update('cacheMaxEntries', event.target.value) }} /></label>
        <label className="dvs-field"><span>{t('retryAttempts')}</span><input inputMode="numeric" value={draft.retryAttempts} onChange={(event) => { update('retryAttempts', event.target.value) }} /></label>
        <label className="dvs-field"><span>{t('autoDelegateTimeoutMs')}</span><input inputMode="numeric" value={draft.autoDelegateTimeoutMs} onChange={(event) => { update('autoDelegateTimeoutMs', event.target.value) }} /></label>
      </div>
      <div className="dvs-grid">
        <label className="dvs-check"><input type="checkbox" checked={draft.cacheEnabled} onChange={(event) => { update('cacheEnabled', event.target.checked) }} />{t('cacheEnabled')}</label>
        <label className="dvs-check"><input type="checkbox" checked={draft.cachePersist} onChange={(event) => { update('cachePersist', event.target.checked) }} />{t('cachePersist')}</label>
        <label className="dvs-check"><input type="checkbox" checked={draft.auditLog} onChange={(event) => { update('auditLog', event.target.checked) }} />{t('auditLog')}</label>
      </div></section>

      <div className="dvs-save-row">
        <button type="button" className="dvs-primary" disabled={settingsState.snapshot?.writable === false || busy} onClick={() => { void save() }}>{busy ? t('saving') : t('save')}</button>
        <button type="button" className="dvs-outline" disabled={busy} onClick={() => { void catalog.load() }}>{t('reload')}</button>
      </div>
    </div>
  )
}

// ── styles ─────────────────────────────────────────────────────────────────

const CSS = `
.dvs-tool{margin:4px 0;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#191920);overflow:hidden;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.dvs-tool-head{width:100%;min-height:38px;display:flex;align-items:center;gap:8px;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#f5f5f7);text-align:left;cursor:pointer;font:inherit}
.dvs-tool-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d7ef7);outline-offset:-2px}
.dvs-tool-icon{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;color:var(--dsw-alias-state-business-primary,#4d7ef7);background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4d7ef7) 14%, transparent);flex:none}
.dvs-tool-title{font-size:13px;font-weight:600;white-space:nowrap}
.dvs-tool-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.dvs-tool-status{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary,#c8c8cf);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvs-tool[data-state=error] .dvs-tool-status{color:var(--dsw-alias-state-error-primary,#f2666e)}
.dvs-chevron{transition:transform .16s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));opacity:.55}.dvs-chevron[data-open=true]{transform:rotate(180deg)}
.dvs-tool-body{padding:2px 12px 12px}
.dvs-stack{display:grid;gap:12px}
.dvs-block{display:grid;gap:5px}
.dvs-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.dvs-block p{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#f5f5f7);white-space:pre-wrap}
.dvs-result{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#14141a);color:var(--dsw-alias-label-primary,#f5f5f7);max-height:240px;overflow:auto}
.dvs-paths{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.dvs-paths button{border:0;background:none;padding:2px 0;color:var(--dsw-alias-brand-primary,#4d7ef7);font-size:12px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dvs-meta{display:flex;gap:6px}
.dvs-tag{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4d7ef7) 14%, transparent);color:var(--dsw-alias-state-business-primary,#6d94f7)}
.dvs-muted{margin:0;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:13px}
.dvs-settings{display:grid;gap:18px;max-width:920px;padding:10px 2px 44px;color:var(--dsw-alias-label-primary,#f5f5f7);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.dvs-settings-header h2{font-size:24px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}
.dvs-settings-header p{margin:0;color:var(--dsw-alias-label-secondary,#c8c8cf);font-size:13.5px;line-height:1.6;max-width:680px}
.dvs-alert{padding:10px 13px;border-radius:10px;font-size:13px;line-height:1.55;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.dvs-alert.notice{background:rgba(77,126,247,.12);background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4d7ef7) 12%, transparent);color:var(--dsw-alias-state-business-primary,#6d94f7)}
.dvs-alert.warning{background:rgba(224,162,55,.12);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#e0a237) 12%, transparent);color:var(--dsw-alias-state-warn-primary,#e0a237)}
.dvs-alert.success{background:rgba(48,154,100,.12);background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#309a64) 12%, transparent);color:var(--dsw-alias-state-success-primary,#309a64)}
.dvs-alert.error{background:rgba(224,76,90,.12);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e04c5a) 12%, transparent);color:var(--dsw-alias-state-error-primary,#e04c5a)}
.dvs-alert strong{font-weight:600}
.dvs-badge{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#309a64) 16%, transparent);color:var(--dsw-alias-state-success-primary,#309a64);margin-left:2px}
.dvs-panel{display:grid;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#191920)}
.dvs-panel h3{font-size:14px;font-weight:600;margin:0}
.dvs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.dvs-grid .dvs-span2{grid-column:1/-1}
.dvs-field{display:grid;gap:6px;align-content:start;min-width:0}
.dvs-field span{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-secondary,#c8c8cf)}
.dvs-field .dvs-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.dvs-field input,.dvs-field select{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#14141a);color:var(--dsw-alias-label-primary,#f5f5f7);font:inherit;font-size:13px;outline:none;transition:border-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)),box-shadow .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.dvs-field input:focus,.dvs-field select:focus{border-color:var(--dsw-alias-brand-primary,#4d7ef7);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary,#4d7ef7) 25%, transparent)}
.dvs-field input::placeholder{color:var(--dsw-alias-label-dimmed,#6f6f78)}
.dvs-check{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dsw-alias-label-primary,#f5f5f7);min-height:22px;cursor:pointer}
.dvs-check input{accent-color:var(--dsw-alias-brand-primary,#4d7ef7);width:15px;height:15px;flex:none;margin:0}
.dvs-save-row{display:flex;gap:10px;align-items:center}
.dvs-primary,.dvs-outline{height:34px;padding:0 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;transition:background-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.dvs-primary{background:var(--dsw-alias-button-primary-fill,#4d7ef7);color:var(--dsw-alias-label-primary-inverted,#17171c);border:0}
.dvs-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3f66d9)}
.dvs-primary:disabled,.dvs-outline:disabled{opacity:.45;cursor:default}
.dvs-outline{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#f5f5f7)}
.dvs-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dvs-loading{padding:26px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#14141a);font-size:13px;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
@media(max-width:720px){.dvs-grid{grid-template-columns:1fr}}
`

function installStyles(): () => void {
  const selector = 'style[data-plugin-css="dsh-vision/client"]'
  const existing = document.querySelector<HTMLStyleElement>(selector)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-vision'
  style.dataset.pluginCss = 'dsh-vision/client'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Required client services. */
export const inject = ['slots', 'locale']

/** Register the describe_image Tool card and the Vision Settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-vision: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-vision: locale')
  const t = ctx.locale.bind(NS)
  const settings = new SettingsController()
  const catalog = new CatalogController()

  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'describe_image', inject: () => ({ t }) }, DescribeImageView)
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'vision',
    order: 30,
    label: () => t('nav'),
    inject: () => ({ t, settings, catalog }),
  }, SettingsSection))
}

