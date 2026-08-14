/** /vision slash command — typed subcommands mirroring pi-vision, writing
 *  through the DSH Settings namespace. The Web client renders the interactive
 *  settings form; this command covers power users and headless. */
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { VisionGate } from './exposure.ts'
import type { VisionCache } from './cache.ts'
import type { ResolvedVisionConfig, VisionConfig } from './config.ts'
import {
  MARKER_STYLES, PASTE_MODES, REASONING_LEVELS, DEFAULT_CONFIG,
} from './config.ts'
import { clearAuditLog, countAuditLog, resolveAuditPath, tailAuditLog } from './audit.ts'
import { loadImage } from './image.ts'
import type { VisionModelCandidate } from './defaults.ts'

export interface SettingsLike {
  get(): VisionConfig
  update(patch: Record<string, unknown>): Promise<void>
  mutate(ops: Array<{ op: 'set'; path: string; value?: unknown } | { op: 'unset'; path: string }>): Promise<void>
  replace(section: Record<string, unknown>): Promise<void>
}

export interface VisionCommandDeps {
  settings: SettingsLike
  config: () => ResolvedVisionConfig
  gate: VisionGate
  cache: () => VisionCache | undefined
  home: string
  detect: () => Promise<VisionModelCandidate | undefined>
}

function ok(text: string): CommandResult { return { kind: 'success', text } }
function err(text: string): CommandResult { return { kind: 'error', text } }

function truncatePreview(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function formatConfigStatus(c: ResolvedVisionConfig): string {
  return [
    'Vision tool config:',
    `  enabled:          ${c.enabled}`,
    `  provider/model:   ${c.provider && c.model ? `${c.provider}/${c.model}` : '(not set)'}`,
    `  delegation:       ${c.delegation} (native uses provider/model; http uses the http block)`,
    `  http endpoint:    ${c.http.baseUrl ? `${c.http.baseUrl} model=${c.http.model ?? '(unset)'} credential=${c.http.credential ? String(c.http.credential) : '(unset)'}` : '(not set)'}`,
    `  maxDimension:     ${c.maxDimension}px`,
    `  jpegQuality:      ${c.jpegQuality}`,
    `  reasoning:        ${c.defaultReasoningEffort}`,
    `  systemPrompt:     ${c.systemPrompt ? truncatePreview(c.systemPrompt, 40) : '(none)'}`,
    `  cache:            ${c.cacheEnabled ? 'on' : 'off'}${c.cachePersist ? ` (persisted, max ${c.cacheMaxEntries})` : ''}`,
    `  retry:            ${c.retryAttempts} attempts, ${c.retryBackoffMs}ms backoff`,
    `  fallback:         ${c.fallbackProvider && c.fallbackModel ? `${c.fallbackProvider}/${c.fallbackModel}` : '(none)'}`,
    `  markerStyle:      ${c.markerStyle}`,
    `  textOnlyPaste:    ${c.textOnlyPasteMode}`,
    `  autoTimeout:      ${c.autoDelegateTimeoutMs}ms`,
    `  composePreview:   ${c.composePreview}`,
    `  batchConcurrency: ${c.batchConcurrency}`,
    `  localOnly:        ${c.localOnly ? 'on' : 'off'}`,
    `  auditLog:         ${c.auditLog ? 'on' : 'off'}`,
    `  autoDetect:       ${c.autoDetectVisionModel ? 'on' : 'off'}`,
  ].join('\n')
}

function parsePair(value: string): { provider?: string; model?: string } | undefined {
  const slash = value.indexOf('/')
  if (slash > 0 && slash < value.length - 1) {
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
  }
  return undefined
}

/** Number arg with bounds; returns undefined + message on invalid input. */
function numberArg(raw: string | undefined, min: number, max: number, label: string): { n: number } | { error: string } {
  const n = Number(raw)
  if (!Number.isFinite(n)) return { error: `Usage: /vision ${label} <${min}-${max}>` }
  return { n: Math.min(max, Math.max(min, Math.round(n))) }
}

export function createVisionCommand(deps: VisionCommandDeps): CommandDefinition {
  return {
    name: 'vision',
    description: 'Vision tool configuration. Subcommands: show, on, off, provider <p>, model [<id>], max-dim <px>, quality <1-100>, reasoning-effort <level>, system-prompt [<text>|clear], cache <clear|show>, fallback [<p/m>|clear], clear, paste-mode [hint|auto|off], marker-style [s], auto-prompt [<text>|clear], preview <path>, batch-concurrency [<1-20>], local-only [on|off], audit <clear|show|path|on|off>, audit-path [<path>|clear], auto-detect [on|off].',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? ''
      const settings = deps.settings
      const c = deps.config()

      switch (sub) {
        case '':
          return ok(formatConfigStatus(c) + '\n\nUse the Web Settings (Vision section) for the interactive form.')
        case 'show':
          return ok(formatConfigStatus(c))
        case 'on': {
          await settings.update({ enabled: true })
          deps.gate.resyncAll()
          return ok('Vision tool enabled.')
        }
        case 'off': {
          await settings.update({ enabled: false })
          deps.gate.resyncAll()
          return ok('Vision tool disabled. Use /vision on to re-enable.')
        }
        case 'provider': {
          const value = parts[1]
          if (!value) return err('Usage: /vision provider <name>')
          await settings.update({ provider: value })
          return ok(`Vision provider set to ${value}.`)
        }
        case 'model': {
          const value = parts.slice(1).join(' ')
          if (!value) {
            const detected = await deps.detect()
            return detected
              ? ok(`Vision-capable models (auto-detect prefers ${detected.provider}/${detected.model}). Usage: /vision model <provider/model> or /vision model <id>`)
              : ok('No vision-capable models found in the registered providers. Configure one via the Web Models page, then /vision model <provider/model>.')
          }
          const pair = parsePair(value)
          if (pair) {
            await settings.update({ provider: pair.provider, model: pair.model })
            return ok(`Vision model set to ${pair.provider}/${pair.model}.`)
          }
          await settings.update({ model: value })
          return ok(`Vision model set to ${value}.`)
        }
        case 'max-dim': {
          const parsed = numberArg(parts[1], 1, 8000, 'max-dim')
          if ('error' in parsed) return err(parsed.error)
          await settings.update({ maxDimension: parsed.n })
          return ok(`Max dimension set to ${parsed.n}px.`)
        }
        case 'quality': {
          const parsed = numberArg(parts[1], 1, 100, 'quality')
          if ('error' in parsed) return err(parsed.error)
          await settings.update({ jpegQuality: parsed.n })
          return ok(`JPEG quality set to ${parsed.n}.`)
        }
        case 'reasoning-effort': {
          const raw = parts[1]
          if (!raw || !(REASONING_LEVELS as readonly string[]).includes(raw)) {
            return err(`Usage: /vision reasoning-effort <${REASONING_LEVELS.join('|')}>`)
          }
          await settings.update({ defaultReasoningEffort: raw })
          return ok(`Default reasoning effort set to ${raw}.`)
        }
        case 'clear':
          await settings.replace({})
          deps.gate.resyncAll()
          return ok('Vision config reset to defaults.')
        case 'system-prompt': {
          const value = parts.slice(1).join(' ').trim()
          if (value === 'clear') {
            await settings.mutate([{ op: 'unset', path: 'systemPrompt' }])
            return ok('Vision system prompt cleared.')
          }
          if (value) {
            await settings.update({ systemPrompt: value })
            return ok('Vision system prompt set.')
          }
          return err('Usage: /vision system-prompt <text> (or /vision system-prompt clear)')
        }
        case 'cache': {
          const action = parts[1]
          const cache = deps.cache()
          if (action === 'clear') {
            await cache?.clear()
            return ok('Vision cache cleared (memory + disk).')
          }
          if (action === 'show') {
            const s = cache ? await cache.stats() : undefined
            return ok(s
              ? `Vision cache: ${s.memoryEntries} memory, ${s.diskEntries} disk (max ${s.maxEntries}, persisted ${s.persisted}).`
              : 'Vision cache is not configured.')
          }
          return err('Usage: /vision cache <clear|show>')
        }
        case 'fallback': {
          const value = parts.slice(1).join(' ').trim()
          if (!value) return err('Usage: /vision fallback <provider/model> (or /vision fallback clear)')
          if (value === 'clear') {
            await settings.mutate([{ op: 'unset', path: 'fallbackProvider' }, { op: 'unset', path: 'fallbackModel' }])
            return ok('Fallback vision model cleared.')
          }
          const pair = parsePair(value)
          if (pair) {
            await settings.update({ fallbackProvider: pair.provider, fallbackModel: pair.model })
            return ok(`Fallback vision model set to ${pair.provider}/${pair.model}.`)
          }
          await settings.update({ fallbackModel: value })
          return ok(`Fallback vision model set to ${value}.`)
        }
        case 'paste-mode': {
          const value = parts[1]
          if (!value) {
            const order = PASTE_MODES as readonly string[]
            const next = order[(order.indexOf(c.textOnlyPasteMode) + 1) % order.length] ?? 'hint'
            await settings.update({ textOnlyPasteMode: next })
            return ok(`Text-only paste mode set to ${next}.`)
          }
          if (!(PASTE_MODES as readonly string[]).includes(value)) return err(`Invalid paste mode. Valid: ${PASTE_MODES.join(', ')}`)
          await settings.update({ textOnlyPasteMode: value })
          return ok(`Text-only paste mode set to ${value}.`)
        }
        case 'marker-style': {
          const value = parts[1]
          if (!value) return ok(`Marker style: ${c.markerStyle}. Valid: ${MARKER_STYLES.join(', ')}`)
          if (!(MARKER_STYLES as readonly string[]).includes(value)) return err(`Invalid style. Valid: ${MARKER_STYLES.join(', ')}`)
          await settings.update({ markerStyle: value })
          return ok(`Marker style set to ${value}.`)
        }
        case 'auto-prompt': {
          const value = parts.slice(1).join(' ').trim()
          if (value === 'clear') {
            await settings.update({ autoDelegatePrompt: DEFAULT_CONFIG.autoDelegatePrompt })
            return ok('Auto-delegate prompt reset to default.')
          }
          if (value) {
            await settings.update({ autoDelegatePrompt: value })
            return ok('Auto-delegate prompt set.')
          }
          return err('Usage: /vision auto-prompt <text> (or /vision auto-prompt clear)')
        }
        case 'preview': {
          const path = parts.slice(1).join(' ')
          if (!path) return err('Usage: /vision preview <image-path>')
          const workspace = invocation.agent.session.header.cwd ?? process.cwd()
          const loaded = await loadImage(path, { cwd: workspace })
          if (!loaded.ok) {
            return err(`Vision preview error: ${loaded.error.message ?? loaded.error.code}`)
          }
          // Best-effort intrinsic dimensions via sharp metadata.
          let dims = ''
          try {
            const mod = (await import('sharp')) as { default?: unknown }
            const sharp = mod.default as ((b: Buffer) => { metadata(): Promise<{ width?: number; height?: number }> }) | undefined
            if (typeof sharp === 'function') {
              const meta = await sharp(Buffer.from(loaded.image.data, 'base64')).metadata()
              if (meta.width && meta.height) dims = ` ${meta.width}x${meta.height}`
            }
          } catch { /* dims optional */ }
          return ok(`[Image: ${path}] ${loaded.image.mimeType}${dims} ${loaded.image.bytes} bytes`)
        }
        case 'batch-concurrency': {
          if (!parts[1]) return ok(`Batch concurrency: ${c.batchConcurrency} (1–20). 1 = serial, 20 = aggressive.`)
          const parsed = numberArg(parts[1], 1, 20, 'batch-concurrency')
          if ('error' in parsed) return err(parsed.error)
          await settings.update({ batchConcurrency: parsed.n })
          return ok(`Batch concurrency set to ${parsed.n}.`)
        }
        case 'local-only': {
          const value = parts[1]
          if (!value) {
            return ok(`Local-only mode: ${c.localOnly ? 'on' : 'off'}. When on, image bytes never leave the machine (cache hits still work; a cache miss refuses). Toggle via /vision local-only on|off.`)
          }
          if (value !== 'on' && value !== 'off') return err('Usage: /vision local-only <on|off>')
          await settings.update({ localOnly: value === 'on' })
          return ok(`Local-only mode ${value === 'on' ? 'enabled' : 'disabled'}.`)
        }
        case 'audit': {
          const action = parts[1]
          const path = resolveAuditPath(c.auditLogPath, deps.home)
          if (action === 'clear') {
            await clearAuditLog(path)
            return ok(`Audit log cleared (${path}).`)
          }
          if (action === 'show') {
            const entries = await tailAuditLog(path, 10)
            const total = await countAuditLog(path)
            const lines = entries.map((e) =>
              `[${e.ts}] ${e.provider}/${e.model} ${e.cached ? '(cached)' : e.fallback ? '(fallback)' : ''} ok=${e.ok}${e.error_code ? ` err=${e.error_code}` : ''}${e.local_only ? ' local-only' : ''} ${e.latency_ms}ms ${e.image_path}`)
            return ok(`Audit log (${path}) - ${total} entries, last 10:\n${lines.join('\n') || '(empty)'}`)
          }
          if (action === 'path') return ok(`Audit log path: ${path}`)
          if (action === 'on' || action === 'off') {
            await settings.update({ auditLog: action === 'on' })
            return ok(`Audit logging ${action === 'on' ? 'on' : 'off'} (${path}).`)
          }
          return err('Usage: /vision audit <clear|show|path|on|off>')
        }
        case 'audit-path': {
          const value = parts.slice(1).join(' ').trim()
          if (!value) return ok(`Audit log path: ${resolveAuditPath(c.auditLogPath, deps.home)}${c.auditLogPath ? ' (custom)' : ' (default)'}`)
          if (value === 'clear') {
            await settings.mutate([{ op: 'unset', path: 'auditLogPath' }])
            return ok('Audit log path reset to default.')
          }
          await settings.update({ auditLogPath: value })
          return ok(`Audit log path set to ${value}.`)
        }
        case 'auto-detect': {
          const value = parts[1]
          if (!value) return ok(`Auto-detect: ${c.autoDetectVisionModel ? 'on' : 'off'}`)
          if (value !== 'on' && value !== 'off') return err('Usage: /vision auto-detect <on|off>')
          await settings.update({ autoDetectVisionModel: value === 'on' })
          return ok(`Auto-detect ${value === 'on' ? 'enabled' : 'disabled'}.`)
        }
        default:
          return err(`Unknown /vision subcommand: ${sub}. Available: show, on, off, provider, model, max-dim, quality, reasoning-effort, system-prompt, cache, fallback, clear, paste-mode, marker-style, auto-prompt, preview, batch-concurrency, local-only, audit, audit-path, auto-detect (or /vision for the summary).`)
      }
    },
  }
}
