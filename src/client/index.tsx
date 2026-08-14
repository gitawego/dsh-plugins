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
  delegationAuto: 'auto (native when the configured model is image-capable, else http)',
  delegationNative: 'native (ctx.llm.stream with an ImageBlock)',
  delegationHttp: 'http (OpenAI-compatible endpoint)',
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
  delegationAuto: 'auto（配置的模型支持图像时走 native，否则 http）',
  delegationNative: 'native（ctx.llm.stream + ImageBlock）',
  delegationHttp: 'http（OpenAI 兼容端点）',
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
  const providerOptions: string[] = []
  for (const p of snapshot?.providers ?? []) providerOptions.push(p.id)
  if (detected !== undefined && !providerOptions.includes(detected.provider)) providerOptions.push(detected.provider)
  if (draft.provider.trim().length > 0 && !providerOptions.includes(draft.provider.trim())) providerOptions.push(draft.provider.trim())

  const modelOptions: string[] = []
  for (const m of snapshot?.visionModels ?? []) modelOptions.push(m.model)
  if (detected !== undefined && !modelOptions.includes(detected.model)) modelOptions.push(detected.model)
  if (draft.model.trim().length > 0 && !modelOptions.includes(draft.model.trim())) modelOptions.push(draft.model.trim())

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
          <input list="dvs-providers" value={draft.provider} onChange={(event) => { update('provider', event.target.value) }} placeholder="provider" />
          <datalist id="dvs-providers">{providerOptions.map((id) => <option key={id} value={id} />)}</datalist>
        </label>
        <label className="dvs-field"><span>{t('model')}{detected !== undefined && draft.model === detected.model ? ` (${t('detectedBadge')})` : ''}</span>
          <input list="dvs-models" value={draft.model} onChange={(event) => { update('model', event.target.value) }} placeholder="model" />
          <datalist id="dvs-models">{modelOptions.map((id) => <option key={id} value={id} />)}</datalist>
        </label>
      </div></section>

      <section className="dvs-panel"><h3>{t('behavior')}</h3><div className="dvs-grid">
        <label className="dvs-field"><span>{t('delegation')}</span>
          <select value={draft.delegation} onChange={(event) => { update('delegation', event.target.value) }}>
            <option value="auto">{t('delegationAuto')}</option>
            <option value="native">{t('delegationNative')}</option>
            <option value="http">{t('delegationHttp')}</option>
          </select>
        </label>
        <label className="dvs-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => { update('enabled', event.target.checked) }} />{t('enabled')}</label>
        <label className="dvs-check"><input type="checkbox" checked={draft.autoDetectVisionModel} onChange={(event) => { update('autoDetectVisionModel', event.target.checked) }} />{t('autoDetectVisionModel')}</label>
        <label className="dvs-check"><input type="checkbox" checked={draft.localOnly} onChange={(event) => { update('localOnly', event.target.checked) }} />{t('localOnly')}</label>
      </div></section>

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
.dvs-tool{margin:4px 0;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
.dvs-tool-head{width:100%;min-height:36px;display:flex;align-items:center;gap:7px;padding:7px 9px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.dvs-tool-head:focus-visible{outline:2px solid #7c6ff0;outline-offset:-2px}
.dvs-tool-icon{width:20px;height:20px;display:grid;place-items:center;border-radius:6px;color:#6659c7;background:rgba(111,94,219,.1);flex:none}
.dvs-tool-title{font-size:12px;font-weight:650;white-space:nowrap}
.dvs-tool-summary{font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.dvs-tool-status{margin-left:auto;font-size:11px;color:var(--dsw-alias-fg-muted,#77736d);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvs-tool[data-state=error] .dvs-tool-status{color:#c34f4f}
.dvs-chevron{transition:transform .16s ease;opacity:.55}.dvs-chevron[data-open=true]{transform:rotate(180deg)}
.dvs-tool-body{padding:0 10px 10px}
.dvs-stack{display:grid;gap:10px}
.dvs-block{display:grid;gap:4px}
.dvs-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-fg-muted,#77736d)}
.dvs-block p{margin:0;font-size:12px;line-height:1.5;white-space:pre-wrap}
.dvs-result{margin:0;font-size:11px;line-height:1.55;white-space:pre-wrap;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);max-height:220px;overflow:auto}
.dvs-paths{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.dvs-paths button{border:0;background:none;padding:2px 0;color:#6659c7;font-size:11px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dvs-meta{display:flex;gap:6px}
.dvs-tag{font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(92,108,213,.12);color:#5149a6}
.dvs-muted{margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:12px}
.dvs-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}
.dvs-settings-header h2{font-size:22px;letter-spacing:-.025em;margin:0 0 6px}
.dvs-settings-header p{margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55;max-width:640px}
.dvs-alert{padding:9px 11px;border-radius:10px;font-size:12px;line-height:1.5}
.dvs-alert.notice{background:rgba(92,108,213,.09);color:#5149a6}
.dvs-alert.warning{background:rgba(224,162,55,.12);color:#986818}
.dvs-alert.success{background:rgba(48,154,100,.1);color:#267d52}
.dvs-badge{font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(48,154,100,.14);color:#267d52;margin-left:6px}
.dvs-panel{display:grid;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff)}
.dvs-panel h3{font-size:13px;margin:0}
.dvs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dvs-field{display:grid;gap:5px;align-content:start}
.dvs-field span{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d)}
.dvs-field input,.dvs-field select{height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}
.dvs-check{display:flex;align-items:center;gap:7px;font-size:12px}
.dvs-save-row{display:flex;gap:9px}
.dvs-primary,.dvs-outline{height:32px;padding:0 15px;border-radius:999px;border:0;font-size:12px;font-weight:600;cursor:pointer}
.dvs-primary{background:#6758d4;color:#fff}
.dvs-primary:disabled,.dvs-outline:disabled{opacity:.5;cursor:default}
.dvs-outline{border:1px solid var(--dsw-alias-border-subtle,#dedbd5);background:transparent;color:inherit}
.dvs-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
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

