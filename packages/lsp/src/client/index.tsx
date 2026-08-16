/** dsh-lsp browser plugin (M3): an LSP status card in Settings + an
 *  lsp_diagnostics tool card. Everything is DATA-DRIVEN from the host
 *  /_dsh/lsp route (live sessions + configured servers). The host surface
 *  (tools, /lsp command, progressive diagnostics) runs in every profile. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ClientContext, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'lsp'
const STATUS_ROUTE = '/_dsh/lsp'

type LspTranslate = TranslateNS<'lsp'>

const en = {
  nav: 'LSP',
  settingsTitle: 'Language Servers',
  settingsIntro: 'Live LSP sessions and configured server routes (official servers by default). Configure the timeout, progressive-diagnostics behavior, and per-server overrides via the `lsp` namespace in settings.yaml or the /lsp command.',
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
  result: 'Result',
  details: 'Details',
  file: 'File',
  severity: 'Severity',
  message: 'Message',
  noDiagnostics: 'No diagnostics reported.',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  nav: '语言服务',
  settingsTitle: '语言服务器',
  settingsIntro: '实时 LSP 会话与已配置的服务器路由（默认官方服务器）。可通过 settings.yaml 中的 `lsp` 命名空间或 /lsp 命令配置超时、渐进式诊断行为及单服务器覆盖。',
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
  result: '结果',
  details: '详情',
  file: '文件',
  severity: '级别',
  message: '消息',
  noDiagnostics: '未返回诊断。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-lsp status card + tool card copy. */
    'lsp': LocaleKey
  }
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
    servers: Record<string, { command: string[]; extensions: string[] }>
  }
  sessions: LspSessionRow[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ApiEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

interface StatusState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: LspSnapshot
  error?: string
}

/** External store over the /_dsh/lsp route. */
export class StatusController {
  private state: StatusState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): StatusState => this.state

  private set(next: StatusState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.set({ status: 'loading', error: undefined })
    try {
      const response = await fetch(STATUS_ROUTE, { credentials: 'same-origin' })
      const body = await response.json() as ApiEnvelope<LspSnapshot>
      if (generation !== this.generation) return
      if (!response.ok || !body.ok || body.value === undefined) {
        throw new Error(body.error?.message ?? `LSP status request failed with HTTP ${response.status}`)
      }
      this.set({ status: 'ready', snapshot: body.value })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
}

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

type SettingsViewProps = PropsRuntime<'settings.section'> & { t?: LspTranslate; status?: StatusController }

function SettingsSection({ status, t = enFallback }: SettingsViewProps) {
  if (status === undefined) return <div className="dls-settings"><div className="dls-loading">{t('loading')}</div></div>
  return <LoadedSettings status={status} t={t} />
}

function LoadedSettings({ status, t }: { status: StatusController; t: LspTranslate }) {
  const state = useSyncExternalStore(status.subscribe, status.getSnapshot)
  useEffect(() => { void status.load() }, [status])
  const snapshot = state.snapshot
  const servers = snapshot?.configured?.servers ?? {}
  const serverEntries = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))
  const sessions = snapshot?.sessions ?? []
  return (
    <div className="dls-settings">
      <header className="dls-settings-header">
        <h2>{t('settingsTitle')}</h2>
        <p>{t('settingsIntro')}</p>
      </header>
      {state.status === 'error' ? <div className="dls-alert error">{state.error ?? t('unavailable')}</div> : null}
      {snapshot?.writable === false ? <div className="dls-alert warning">{t('readOnly')}</div> : null}

      <section className="dls-panel"><h3>{t('configured')}</h3>
        {serverEntries.length === 0 ? <p className="dls-muted">{t('noServers')}</p> : (
          <table className="dls-table">
            <thead><tr><th>Server</th><th>Extensions</th><th>Command</th></tr></thead>
            <tbody>
              {serverEntries.map(([id, server]) => (
                <tr key={id}>
                  <td><code>{id}</code></td>
                  <td><code>{server.extensions.join(' ')}</code></td>
                  <td><code>{server.command.join(' ')}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
          <button type="button" className="dls-outline" disabled={state.status === 'loading'} onClick={() => { void status.load() }}>{t('reload')}</button>
        </div>
      </section>
    </div>
  )
}

const CSS = `
.dls-tool{margin:4px 0;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#191920);overflow:hidden;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.dls-tool-head{width:100%;min-height:38px;display:flex;align-items:center;gap:8px;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#f5f5f7);text-align:left;cursor:pointer;font:inherit}
.dls-tool-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d7ef7);outline-offset:-2px}
.dls-tool-icon{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;color:var(--dsw-alias-state-business-primary,#4d7ef7);background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4d7ef7) 14%, transparent);flex:none}
.dls-tool-title{font-size:13px;font-weight:600;white-space:nowrap}
.dls-tool-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.dls-chevron{transition:transform .16s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));opacity:.55}.dls-chevron[data-open=true]{transform:rotate(180deg)}
.dls-tool-body{padding:2px 12px 12px}
.dls-result{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#14141a);color:var(--dsw-alias-label-primary,#f5f5f7);max-height:240px;overflow:auto}
.dls-muted{margin:0;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:13px}
.dls-settings{display:grid;gap:18px;max-width:920px;padding:10px 2px 44px;color:var(--dsw-alias-label-primary,#f5f5f7);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.dls-settings-header h2{font-size:24px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}
.dls-settings-header p{margin:0;color:var(--dsw-alias-label-secondary,#c8c8cf);font-size:13.5px;line-height:1.6;max-width:680px}
.dls-alert{padding:10px 13px;border-radius:10px;font-size:13px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.dls-alert.warning{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#e0a237) 12%, transparent);color:var(--dsw-alias-state-warn-primary,#e0a237)}
.dls-alert.error{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e04c5a) 12%, transparent);color:var(--dsw-alias-state-error-primary,#e04c5a)}
.dls-panel{display:grid;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#191920)}
.dls-panel h3{font-size:14px;font-weight:600;margin:0}
.dls-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dls-table th,.dls-table td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));vertical-align:top}
.dls-table th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-weight:600}
.dls-table code,.dls-panel code{font-size:12px;color:var(--dsw-alias-label-primary,#f5f5f7)}
.dls-badge{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px}
.dls-badge[data-status=connected]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#309a64) 16%, transparent);color:var(--dsw-alias-state-success-primary,#309a64)}
.dls-badge[data-status=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e04c5a) 16%, transparent);color:var(--dsw-alias-state-error-primary,#e04c5a)}
.dls-save-row{display:flex;gap:10px;align-items:center}
.dls-outline{height:34px;padding:0 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#f5f5f7);transition:background-color .12s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}
.dls-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dls-outline:disabled{opacity:.45;cursor:default}
.dls-loading{padding:26px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#14141a);font-size:13px;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
@media(max-width:720px){.dls-table{font-size:11.5px}}
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
export const inject = ['slots', 'locale']

/** Register the lsp_diagnostics tool card and the LSP status settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-lsp: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-lsp: locale')
  const t = ctx.locale.bind(NS)
  const status = new StatusController()

  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'lsp_diagnostics', inject: () => ({ t }) }, DiagnosticsView)
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'lsp',
    order: 40,
    label: () => t('nav'),
    inject: () => ({ t, status }),
  }, SettingsSection))
}
