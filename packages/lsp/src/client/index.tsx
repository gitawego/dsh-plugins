/** dsh-lsp browser plugin (M3): an editable LSP settings section + an
 *  lsp_diagnostics tool card. Migration to rc.7:
 *    - Live session status: was \`fetch(/_dsh/lsp)\` (a bespoke HTTP route
 *      hosted by the server). Now subscribes to the host-side
 *      \`lsp/status\` event; the host fires it on a 2s interval when at
 *      least one client is subscribed.
 *    - Settings: was \`fetch(/_dsh/lsp/settings)\` (POST backdrop). Now
 *      \`ctx.settingsScope.bind({ namespace: 'lsp' })\` — the standard
 *      settings scope, accessed via the \`settingsScope\` host service. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ClientContext, ToolCallBlock, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LspSettings } from '../config.js'

const NS = 'lsp'

// Augment the cordis event map with the dsh-lsp client events. The host
// uses these to maintain a refcount (lsp/status/subscribe increments,
// lsp/status/unsubscribe decrements) and to fire the live status
// snapshot (lsp/status).
declare module '@deepseek-ai/cordis' {
  interface Events {
    'lsp/status': (snapshot: unknown) => void
    'lsp/status/subscribe': () => void
    'lsp/status/unsubscribe': () => void
  }
}

type LspTranslate = TranslateNS<'lsp'>

const en = {
  nav: 'LSP',
  settingsTitle: 'Language Servers',
  settingsIntro: 'Configure LSP servers and progressive diagnostics. Defaults come from the official server catalog; set a tsServerPath to point at a real typescript installation (typescript-language-server needs it when typescript is not in the project).',
  unavailable: 'The LSP status route is unavailable here — run this in the Web profile.',
  configured: 'Configured servers',
  noServers: '(none)',
  sessions: 'Live sessions',
  noSessions: 'No live LSP sessions yet.',
  connected: 'connected',
  error: 'error',
  diagnostics: 'LSP diagnostics',
  running: 'Checking…',
  failed: 'failed',
  loading: 'Loading…',
  reload: 'Reload',
  readOnly: 'The active Settings provider is read-only.',
  save: 'Save and apply',
  saving: 'Saving…',
  saved: 'Settings applied.',
  saveFailed: 'Save failed',
  result: 'Result',
  file: 'File',
  severity: 'Severity',
  message: 'Message',
  noDiagnostics: 'No diagnostics reported.',
  advanced: 'Advanced',
  timeout: 'Timeout (ms)',
  binDir: 'Bin dir',
  progressive: 'Progressive diagnostics',
  inject: 'Inject mode',
  maxDiagnostics: 'Max diagnostics',
  quietMs: 'Quiet (ms)',
  enabled: 'Enabled',
  tsServerPath: 'tsserver.path',
  tsServerPathHint: 'Absolute path to typescript/lib/tsserver.js. typescript-language-server uses it instead of resolving typescript from the project.',
  payloadVersion: 'TypeScript payload version',
  payloadVersionHint: 'Managed typescript version installed into the LSP bin dir when neither a project nor a tsserver.path provides one. Defaults to 6 (still ships lib/tsserver.js).',
  serverCommand: 'Server command (JSON array)',
  serverCommandHint: 'Override the spawn argv for this server, e.g. ["typescript-language-server","--stdio"]',
  invalidJson: 'Invalid JSON in a server command field.',
  noDiagnosticsHint: 'Run lsp_diagnostics to start a session; its results show here.',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  nav: '语言服务',
  settingsTitle: '语言服务器',
  settingsIntro: '配置语言服务器与渐进式诊断。默认来自官方服务器目录；当项目内没有 typescript 时，可设置 tsServerPath 指向真实的 typescript 安装以启用 TypeScript LSP。',
  unavailable: '此处无法获取 LSP 状态——请在 Web 配置文件中运行。',
  configured: '已配置服务器',
  noServers: '（无）',
  sessions: '实时会话',
  noSessions: '暂无实时 LSP 会话。',
  connected: '已连接',
  error: '错误',
  diagnostics: 'LSP 诊断',
  running: '检查中…',
  failed: '失败',
  loading: '加载中…',
  reload: '重新加载',
  readOnly: '当前 Settings 提供方为只读。',
  save: '保存并应用',
  saving: '保存中…',
  saved: '设置已生效。',
  saveFailed: '保存失败',
  result: '结果',
  file: '文件',
  severity: '级别',
  message: '消息',
  noDiagnostics: '未返回诊断。',
  advanced: '高级',
  timeout: '超时（ms）',
  binDir: '二进制目录',
  progressive: '渐进式诊断',
  inject: '注入模式',
  maxDiagnostics: '最大诊断数',
  quietMs: '静默（ms）',
  enabled: '启用',
  tsServerPath: 'tsserver.path',
  tsServerPathHint: 'typescript/lib/tsserver.js 的绝对路径。当项目内无 typescript 时，typescript-language-server 使用它。',
  payloadVersion: 'TypeScript 负载版本',
  payloadVersionHint: '当项目或 tsserver.path 均未提供时，将安装到 LSP bin 目录的受管 typescript 版本。默认为 6（仍提供 lib/tsserver.js）。',
  serverCommand: '服务器命令（JSON 数组）',
  serverCommandHint: '覆盖该服务器的启动参数，例如 ["typescript-language-server","--stdio"]',
  invalidJson: '服务器命令字段包含无效 JSON。',
  noDiagnosticsHint: '运行 lsp_diagnostics 以启动会话；其结果会显示在这里。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-lsp status + editor + tool card copy. */
    'lsp': LocaleKey
  }
}

export interface LspServerConfig {
  command?: string[]
  extensions?: string[]
  languageId?: string
  rootMarkers?: string[]
  env?: Record<string, string>
  initialization?: Record<string, unknown>
  autoDownload?: boolean
  disabled?: boolean
}

export interface LspSessionRow {
  id: string
  name: string
  root: string
  status: 'connected' | 'error'
}

export interface LspSnapshot {
  writable: boolean
  configured: {
    timeout: number
    binDir: string
    progressive: { enabled: boolean; inject: string; maxDiagnostics: number; quietMs: number }
    servers: Record<string, LspServerConfig>
  }
  sessions: LspSessionRow[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── status store (live sessions + configured servers) ──────────────────────

interface StatusState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: LspSnapshot
  error?: string
}

export class StatusController {
  private state: StatusState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): StatusState => this.state

  private set(next: StatusState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** Bind the controller to the host-side lsp/status event. The host
   *  fires the event on a 2s interval when at least one client is
   *  subscribed. The subscribe/unsubscribe refcount is maintained by
   *  the host (lsp/status/subscribe and lsp/status/unsubscribe). */
  bind(ctx: ClientContext): () => void {
    ctx.emit('lsp/status/subscribe')
    const off = ctx.on('lsp/status', (snapshot) => {
      this.set({ status: 'ready', snapshot: snapshot as LspSnapshot })
    })
    return () => {
      off()
      ctx.emit('lsp/status/unsubscribe')
    }
  }
}

// ── settings store (GET snapshot + POST save) ──────────────────────────────

export interface LspSettingsSnapshot {
  writable: boolean
  value: {
    timeout: number
    binDir: string
    progressive: { enabled: boolean; inject: string; maxDiagnostics: number; quietMs: number }
    servers: Record<string, LspServerConfig>
  }
}

interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'saving'
  snapshot?: LspSettingsSnapshot
  error?: string
}

export class SettingsController {
  private state: SettingsState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private scope: SettingsScope<LspSettings> | undefined
  private updateScope: ((patch: Record<string, unknown>) => Promise<void>) | undefined

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): SettingsState => this.state

  private set(next: SettingsState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** Bind to the settings scope. Replaces the previous fetch-based
   *  GET/POST backdrop with the rc.7 settingsScope service. */
  bind(
    scope: SettingsScope<LspSettings>,
    updateScope: (patch: Record<string, unknown>) => Promise<void>,
  ): void {
    this.scope = scope
    this.updateScope = updateScope
    this.refresh()
    scope.subscribe(() => { this.refresh() })
  }

  refresh(): void {
    const scope = this.scope
    if (scope === undefined) return
    const raw = scope.getSnapshot()
    if (raw.value === undefined) {
      this.set({ status: 'idle' })
      return
    }
    const snapshot: LspSettingsSnapshot = {
      writable: raw.writable === true,
      value: raw.value as LspSettingsSnapshot['value'],
    }
    this.set({ status: 'ready', snapshot })
  }

  async save(patch: Record<string, unknown>): Promise<void> {
    this.set({ ...this.state, status: 'saving', error: undefined })
    try {
      await this.updateScope?.(patch)
      this.refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.set({ ...this.state, status: 'error', error: message })
      throw error
    }
  }
}

// ── lsp_diagnostics tool card ──────────────────────────────────────────────

type ToolViewProps = PropsRuntime<'tool.call.toolview'> & { t?: LspTranslate }

function argsRawOf(block: ToolCallBlock): string {
  return 'call' in block ? (block.call?.argsRaw ?? '') : block.argsRaw
}

function resultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  return block.content
    .filter((entry): entry is Extract<typeof entry, { type: 'text' }> => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n')
    .trim()
}

const enFallback: LspTranslate = (key) => (en as Record<string, string>)[key] ?? key

function DiagnosticsView({ block, t = enFallback }: ToolViewProps) {
  const [open, setOpen] = useState(true)
  const running = !('kind' in block)
  const isError = !running && block.isError
  const raw = argsRawOf(block)
  const text = resultText(block)
  const paths = (() => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (Array.isArray(parsed.paths)) return parsed.paths.filter((x): x is string => typeof x === 'string')
      return []
    } catch {
      return []
    }
  })()
  return (
    <section className="dls-tool" data-state={running ? 'running' : isError ? 'error' : 'success'}>
      <button type="button" className="dls-tool-head" onClick={() => { setOpen((v) => !v) }} aria-expanded={open}>
        <span className="dls-tool-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 3h8v10H4z M7 3v10 M2 6h2 M12 6h2" /></svg>
        </span>
        <span className="dls-tool-title">{t('diagnostics')}</span>
        {paths.length ? <span className="dls-tool-summary">{paths.join(', ')}</span> : null}
        <span className="dls-chevron" data-open={open || undefined} aria-hidden="true">⌄</span>
      </button>
      {!open ? null : (
        <div className="dls-tool-body">
          {running ? <p className="dls-muted">{t('running')}</p> : isError ? <p className="dls-muted">{text || t('failed')}</p> : (
            <pre className="dls-result">{text.length ? text : t('noDiagnostics')}</pre>
          )}
        </div>
      )}
    </section>
  )
}

// ── LSP settings section (editable form + live status) ─────────────────────

type SettingsViewProps = PropsRuntime<'settings.section'> & {
  ctx: ClientContext
  t?: LspTranslate
  status?: StatusController
  settings?: SettingsController
}

function SettingsSection({ status, settings, t = enFallback, ctx }: SettingsViewProps) {
  if (settings === undefined || status === undefined) {
    return <div className="dls-settings"><div className="dls-loading">{t('loading')}</div></div>
  }
  return <LoadedSettings status={status} settings={settings} t={t} ctx={ctx} />
}

interface Draft {
  timeout: string
  binDir: string
  progressiveEnabled: boolean
  inject: string
  maxDiagnostics: string
  quietMs: string
  tsServerPath: string
  payloadVersion: string
  serverCommandsJSON: string
}

function strField(raw: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = raw?.[key]
  return typeof value === 'string' ? value : fallback
}
function numField(raw: Record<string, unknown> | undefined, key: string, fallback: number): string {
  const value = raw?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : String(fallback)
}

function draftOf(value: LspSettingsSnapshot['value']): Draft {
  const prog = value.progressive ?? {}
  const typescript = value.servers?.typescript
  const init = isRecord(typescript?.initialization) ? typescript.initialization : undefined
  const tsserver = isRecord(init?.tsserver) ? init.tsserver : undefined
  return {
    timeout: numField(value, 'timeout', 30000),
    binDir: strField(value, 'binDir', ''),
    progressiveEnabled: typeof prog.enabled === 'boolean' ? prog.enabled : true,
    inject: strField(prog, 'inject', 'status'),
    maxDiagnostics: numField(prog, 'maxDiagnostics', 20),
    quietMs: numField(prog, 'quietMs', 2000),
    tsServerPath: strField(tsserver, 'path'),
    payloadVersion: strField(value.servers?.typescript as Record<string, unknown> | undefined, 'payloadVersion', '6'),
    serverCommandsJSON: JSON.stringify(Object.fromEntries(
      Object.entries(value.servers ?? {}).map(([id, s]) => [id, s.command ?? []]),
    ), null, 1),
  }
}

function LoadedSettings({ status, settings, t, ctx }: { status: StatusController; settings: SettingsController; t: LspTranslate; ctx: ClientContext }) {
  const statusState = useSyncExternalStore(status.subscribe, status.getSnapshot)
  const settingsState = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [message, setMessage] = useState<string | undefined>(undefined)

  useEffect(() => status.bind(ctx), [status])
  useEffect(() => {
    if (settingsState.snapshot !== undefined) setDraft(draftOf(settingsState.snapshot.value))
  }, [settingsState.snapshot])

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setMessage(undefined)
    setDraft((current) => (current === undefined ? current : { ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setMessage(undefined)
    // Parse the per-server command JSON map; reject invalid JSON chunk-by-chunk.
    let serversPatch: Record<string, unknown>
    try {
      const parsed = JSON.parse(draft.serverCommandsJSON) as Record<string, unknown>
      if (!isRecord(parsed)) throw new Error('root must be an object')
      serversPatch = parsed
    } catch (error) {
      setMessage(`${t('invalidJson')} ${error instanceof Error ? error.message : ''}`)
      return
    }
    const patch: Record<string, unknown> = {
      timeout: Number(draft.timeout) || 30000,
      binDir: draft.binDir.trim().length ? draft.binDir.trim() : (settingsState.snapshot?.value.binDir ?? ''),
      progressive: {
        enabled: draft.progressiveEnabled,
        inject: draft.inject,
        maxDiagnostics: Number(draft.maxDiagnostics) || 20,
        quietMs: Number(draft.quietMs) || 2000,
      },
      servers: {
        typescript: {
          command: Array.isArray(serversPatch.typescript) ? (serversPatch.typescript as string[]) : (serversPatch.typescript ?? undefined),
          payloadVersion: draft.payloadVersion.trim().length ? draft.payloadVersion.trim() : '6',
          initialization: {
            ...(draft.tsServerPath.trim().length === 0
              ? {}
              : { tsserver: { path: draft.tsServerPath.trim() } }),
          },
        },
      },
    }
    try {
      await settings.save(patch)
      setMessage(t('saved'))
    } catch (error) {
      setMessage(`${t('saveFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const snapshot = settingsState.snapshot
  const sessions = statusState.snapshot?.sessions ?? []
  const writable = snapshot?.writable ?? false

  if (draft === undefined) {
    return <div className="dls-settings"><div className="dls-loading">{t('loading')}</div></div>
  }

  return (
    <div className="dls-settings">
      <header className="dls-settings-header">
        <h2>{t('settingsTitle')}</h2>
        <p>{t('settingsIntro')}</p>
      </header>
      {statusState.status === 'error' ? <div className="dls-alert error">{statusState.error ?? t('unavailable')}</div> : null}
      {!writable ? <div className="dls-alert warning">{t('readOnly')}</div> : null}
      {message === undefined ? null : <div className="dls-alert success">{message}</div>}

      <section className="dls-panel"><h3>{t('advanced')}</h3><div className="dls-grid">
        <label className="dls-field"><span>{t('timeout')}</span><input inputMode="numeric" value={draft.timeout} onChange={(e) => { update('timeout', e.target.value) }} /></label>
        <label className="dls-field dls-span2"><span>{t('binDir')}</span><input value={draft.binDir} onChange={(e) => { update('binDir', e.target.value) }} placeholder="~/.cache/dsh-lsp/bin" /></label>
      </div></section>

      <section className="dls-panel"><h3>{t('progressive')}</h3><div className="dls-grid">
        <label className="dls-check dls-span2"><input type="checkbox" checked={draft.progressiveEnabled} onChange={(e) => { update('progressiveEnabled', e.target.checked) }} />{t('enabled')}</label>
        <label className="dls-field"><span>{t('inject')}</span>
          <select value={draft.inject} onChange={(e) => { update('inject', e.target.value) }}>
            <option value="status">status</option><option value="conversation">conversation</option><option value="none">none</option>
          </select>
        </label>
        <label className="dls-field dls-span2"><span>{t('maxDiagnostics')}</span><input inputMode="numeric" value={draft.maxDiagnostics} onChange={(e) => { update('maxDiagnostics', e.target.value) }} /></label>
        <label className="dls-field dls-span2"><span>{t('quietMs')}</span><input inputMode="numeric" value={draft.quietMs} onChange={(e) => { update('quietMs', e.target.value) }} /></label>
      </div></section>

      <section className="dls-panel"><h3>TypeScript ({t('tsServerPath')})</h3><div className="dls-grid">
        <label className="dls-field dls-span2"><span>{t('tsServerPath')}</span>
          <input value={draft.tsServerPath} onChange={(e) => { update('tsServerPath', e.target.value) }} placeholder={t('tsServerPath')} />
          <small className="dls-hint">{t('tsServerPathHint')}</small>
        </label>
        <label className="dls-field dls-span2"><span>{t('payloadVersion')}</span>
          <input value={draft.payloadVersion} onChange={(e) => { update('payloadVersion', e.target.value) }} placeholder="6" />
          <small className="dls-hint">{t('payloadVersionHint')}</small>
        </label>
        <label className="dls-field dls-span2"><span>{t('serverCommand')}</span>
          <textarea rows={5} value={draft.serverCommandsJSON} onChange={(e) => { update('serverCommandsJSON', e.target.value) }} />
          <small className="dls-hint">{t('serverCommandHint')}</small>
        </label>
      </div></section>

      <section className="dls-panel"><h3>{t('sessions')}</h3>
        {sessions.length === 0 ? <p className="dls-muted">{t('noSessions')}</p> : (
          <table className="dls-table">
            <thead><tr><th>Server</th><th>Root</th><th>Status</th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={`${s.root}-${s.id}`}>
                  <td><code>{s.id}</code></td>
                  <td><code>{s.root}</code></td>
                  <td><span className="dls-badge" data-status={s.status}>{s.status === 'connected' ? t('connected') : t('error')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dls-save-row">
          <button type="button" className="dls-primary" disabled={!writable || settingsState.status === 'saving'} onClick={() => { void save() }}>{settingsState.status === 'saving' ? t('saving') : t('save')}</button>
          <button type="button" className="dls-outline" disabled={statusState.status === 'loading'} onClick={() => { void settings.refresh() }}>{t('reload')}</button>
        </div>
      </section>
    </div>
  )
}

const CSS = `
/* dsh-lsp surfaces, restyled on the DSH design system (dsw alias tokens).
   Canonical references (shipped bundles):
   - cards: bg-layer-3 + border-l2 + radius 12 (settings-plugins .YyYd_a_card)
   - inputs: bg-layer-3 + border-l2 + radius 8 + brand focus border (settings-plugins .At1oFq_input)
   - selects: bg-module-platform pill, radius 18, no border (agent-preset ._5QVD0a_selector)
   - buttons: radius-18 pills, 36px, label-primary-foreground (settings-models .zGbnIq_*)
   - focus rings: buttons box-shadow 0 0 0 2px border-l3 (settings-models); inputs border-color brand */
.dls-tool{margin:4px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.dls-tool-head{width:100%;min-height:38px;display:flex;align-items:center;gap:8px;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font:inherit}
.dls-tool-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dls-tool-icon{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);flex:none}
.dls-tool-title{font-size:13px;font-weight:600;white-space:nowrap}
.dls-tool-summary{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.dls-chevron{transition:transform .16s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));opacity:.55}.dls-chevron[data-open=true]{transform:rotate(180deg)}
.dls-tool-body{padding:2px 12px 12px}
.dls-result{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);max-height:240px;overflow:auto}
.dls-muted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dls-settings{display:grid;gap:18px;max-width:720px;padding:10px 2px 44px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.dls-settings-header h2{font-size:20px;font-weight:500;letter-spacing:0;margin:0 0 6px}
.dls-settings-header p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;max-width:680px}
.dls-alert{padding:10px 13px;border-radius:10px;font-size:13px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1)}
.dls-alert.warning{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-primary)}
.dls-alert.success{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);color:var(--dsw-alias-state-success-primary)}
.dls-alert.error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.dls-panel{display:grid;gap:14px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.dls-panel h3{font-size:14px;font-weight:500;margin:0}
.dls-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dls-table th,.dls-table td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.dls-table th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);font-weight:500}
.dls-table code,.dls-panel code{font-size:12px;color:var(--dsw-alias-label-primary)}
.dls-badge{font-size:11px;font-weight:500;padding:1px 8px;border-radius:999px;line-height:17px}
.dls-badge[data-status=connected]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);color:var(--dsw-alias-state-success-primary)}
.dls-badge[data-status=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);color:var(--dsw-alias-state-error-primary)}
.dls-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.dls-grid .dls-span2{grid-column:1/-1}
.dls-field{display:grid;gap:6px;align-content:start;min-width:0}
.dls-field span{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dls-field .dls-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dls-field input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;outline:none;transition:border-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.dls-field input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dls-field input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dls-field input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dls-field select{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;outline:none;appearance:auto}
.dls-field select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dls-field select:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.dls-field textarea{box-sizing:border-box;width:100%;min-width:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;outline:none;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;transition:border-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.dls-field textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dls-field textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.dls-check{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dsw-alias-label-primary);min-height:22px;cursor:pointer}
.dls-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;flex:none;margin:0}
.dls-save-row{display:flex;gap:10px;align-items:center}
.dls-primary,.dls-outline{box-sizing:border-box;height:36px;padding:0 14px;border-radius:18px;font:inherit;font-size:14px;line-height:22px;cursor:pointer;transition:background-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.dls-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:0}
.dls-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dls-primary:disabled,.dls-outline:disabled{opacity:.4;cursor:default}
.dls-outline{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dls-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dls-primary:focus-visible,.dls-outline:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.dls-loading{padding:26px;border-radius:12px;background:var(--dsw-alias-bg-layer-3);font-size:13px;color:var(--dsw-alias-label-tertiary)}
@media(max-width:720px){.dls-grid{grid-template-columns:1fr}}
`

function installStyles(): () => void {
  const selector = 'style[data-plugin-css="dsh-lsp/client"]'
  const existing = document.querySelector<HTMLStyleElement>(selector)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-lsp'
  style.dataset.pluginCss = 'dsh-lsp/client'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Required client services. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register the lsp_diagnostics tool card and the editable LSP settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-lsp: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-lsp: locale')
  const t = ctx.locale.bind(NS)
  const status = new StatusController()
  const settings = new SettingsController()
  // Bind the controllers to the rc.7 host services. `settingsScope` is the
  // standard settings seam exposed by dsh-client-ui-settings; the live
  // status comes from the host-side `lsp/status` event (subscribed via
  // `ctx.on`). The host maintains a refcount via lsp/status/subscribe so
  // the 2s interval only fires when at least one client is listening.
  status.bind(ctx)
  const settingsScope = ctx.settingsScope.bind<LspSettings>({ namespace: 'lsp' })
  settings.bind(settingsScope, async (patch) => {
    // Write each editable field through the rc.7 settings scope directly.
    // The client cannot import `src/settings-patch.ts` because that helper
    // pulls in `@deepseek-ai/schemastery` (host-only). The scope's own
    // schema rejects malformed values on `set`, so a minimal client-side
    // shape check (object only) is enough UX-side; missing optional
    // fields are simply skipped.
    if (!isRecord(patch)) throw new TypeError('settings value must be an object')
    if (patch.timeout !== undefined) await settingsScope.set('timeout', patch.timeout as never)
    if (patch.binDir !== undefined) await settingsScope.set('binDir', patch.binDir as never)
    if (patch.progressive !== undefined) await settingsScope.set('progressive', patch.progressive as never)
    if (patch.servers !== undefined) await settingsScope.set('servers', patch.servers as never)
  })

  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'lsp_diagnostics', inject: () => ({ t }) }, DiagnosticsView)
  })

  // The slot's inject factory is the only place with access to the host
  // services; the owner-props face doesn't carry ctx, so the component
  // captures it via a closure. We wrap SettingsSection in a small
  // function that injects ctx as an additional prop.
  const SettingsSectionWithCtx = (
    props: Omit<SettingsViewProps, 'ctx'>,
  ): JSX.Element => SettingsSection({ ...props, ctx })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'lsp',
    order: 40,
    label: () => t('nav'),
    inject: () => ({ t, status, settings }),
  }, SettingsSectionWithCtx))
}
