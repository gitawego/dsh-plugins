/** dsh-vision — capability-aware vision + paste extension for DeepSeek
 *  Harness (pi-vision port). M1: describe_image tool with the v0.2–v0.5
 *  resilience pipeline, per-agent capability gating, /vision command, and
 *  data-driven auto-detect. M2: paste UX via agent/pre-step (markers,
 *  ImageBlock attach for multimodal primaries, hint / auto-delegate for
 *  text-only primaries). M3: Web client plugin (describe_image tool card,
 *  data-driven Vision settings section, /_dsh/vision/models catalog route). */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VisionCache } from './cache.ts'
import { createVisionCommand } from './commands.ts'
import { Config, VISION_SETTINGS_NAMESPACE, mergeConfig, resolveConfig, type ResolvedVisionConfig, type VisionConfig } from './config.ts'
import { delegateToVisionModel, type DelegateDeps } from './delegate.ts'
import { detectVisionModel } from './defaults.ts'
import { VisionGate } from './exposure.ts'
import { MarkerRegistry } from './marker.ts'
import { createPasteHook } from './paste.ts'
import { createVisionSubagent } from './subagent.ts'
import type { SettingsLike } from './commands.ts'
import { installVisionWeb } from './web.ts'
import { createDescribeImageTool } from './tool.ts'

export const name = 'dsh-vision'

/** 1x1 PNG used by the attachment-store liveness probe (native delivery). */
const PROBE_PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export { Config }

export const inject = ['tools', 'agents', 'llm', 'credentials', 'attachments', 'settings', 'commands']

export function apply(ctx: Context, config: Partial<VisionConfig> = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')

  const settings = ctx.settings.register(VISION_SETTINGS_NAMESPACE, Config, {
    base: config,
    applies: 'live',
    validate: (value: unknown) => { resolveConfig(mergeConfig(value)) },
  })

  let resolved: ResolvedVisionConfig = resolveConfig(mergeConfig(settings.get()))
  let cache = new VisionCache({
    dir: resolved.cachePersist ? join(home, 'cache', 'dsh-vision') : undefined,
    maxEntries: resolved.cacheMaxEntries,
  })
  const rebuildCache = (): void => {
    cache = new VisionCache({
      dir: resolved.cachePersist ? join(home, 'cache', 'dsh-vision') : undefined,
      maxEntries: resolved.cacheMaxEntries,
    })
  }

  // Marker → real-path bridge (paste hook records; describe_image resolves).
  const markers = new MarkerRegistry()
  const markersDisposer = ctx.on('agent/disposed', ({ agent }) => { markers.detach(agent) })

  const gate = new VisionGate(
    ctx,
    async (provider, model) => {
      if (provider === undefined || model === undefined) return false
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model)
        return info.inputModalities?.includes('image') ?? false
      } catch {
        return false // unknown → text-only (safe default)
      }
    },
    () => resolved.enabled,
  )

  // NATIVE-first delivery probe: the sub-agent path attaches the image via
  // the harness attachment store (ImageBlock). On Android/Termux the store's
  // durability walk cannot open /data/data (EACCES), so the native path is
  // unusable there; auto delegation then falls back to the http endpoint.
  // Probe once per process (the failure is environmental, not transient).
  let storeCanWrite: boolean | undefined
  const canDeliverImage = async (): Promise<boolean> => {
    if (storeCanWrite !== undefined) return storeCanWrite
    try {
      await ctx.attachments.saveImage({
        data: new Uint8Array(PROBE_PNG_1x1),
        mediaType: 'image/png',
        name: 'dsh-vision-store-probe',
      })
      storeCanWrite = true
    } catch {
      storeCanWrite = false
    }
    return storeCanWrite
  }

  // Shared delegation entry point (tool + paste auto mode). Workspace and the
  // per-call cancellation signal differ per use; the rest is live config.
  const delegateDepsFor = (workspace: string, signal?: AbortSignal): DelegateDeps => ({
    config: resolved,
    home,
    workspace,
    resolveCredential: (ref) => ctx.credentials.resolve(ref),
    // DESIGN RULE: the vision model is driven as a DSH subagent (public API).
    createSubagent: (opts) => createVisionSubagent(ctx.agents, opts),
    canDeliverImage,
    signal,
    cache,
  })

  const tool = createDescribeImageTool({
    config: () => resolved,
    gate,
    cache: () => cache,
    home,
    resolveCredential: (ref) => ctx.credentials.resolve(ref),
    createSubagent: (opts) => createVisionSubagent(ctx.agents, opts),
    canDeliverImage,
    markers,
  })
  const toolDisposer = ctx.tools.register(tool)

  // Shared settings write surface (commands + the Web settings route).
  const visionSettings: SettingsLike = {
    get: () => settings.get() as VisionConfig,
    update: (patch) => settings.update(patch),
    mutate: (ops) => ctx.settings.mutate(VISION_SETTINGS_NAMESPACE, ops.map((o) => o.op === 'set'
      ? { op: 'set' as const, path: [o.path], value: o.value as never }
      : { op: 'unset' as const, path: [o.path] })),
    replace: (section) => settings.replace(section),
  }

  const command = createVisionCommand({
    settings: visionSettings,
    config: () => resolved,
    gate,
    cache: () => cache,
    home,
    detect: () => detectVisionModel(ctx.llm),
  })
  const commandDisposer = ctx.commands.register(command)

  // M2: paste UX — rewrite user messages carrying image path tokens before
  // they enter a step (markers, native attachment, hint/auto-delegate).
  const pasteDisposer = ctx.on('agent/pre-step', createPasteHook({
    config: () => resolved,
    isMultimodal: (agent) => gate.current(agent)?.multimodal ?? false,
    saveAttachment: (input) => ctx.attachments.saveImage(input),
    // Text-only primaries: image BLOCKS are materialized under the DSH home
    // tmp dir (Termux: the OS tmpdir may be unwritable; home is always) and
    // converted through the shared pipeline.
    readImage: (ref, signal) => ctx.attachments.readImage(ref, signal),
    tmpDir: join(home, 'tmp', 'dsh-vision'),
    markers,
    delegateFor: (workspace) => (params, signal) => delegateToVisionModel(delegateDepsFor(workspace, signal), params),
    logger: ctx.logger,
  }))

  installVisionWeb(ctx, () => resolved, visionSettings)

  // Live re-resolution on settings changes; cache shape + mask re-sync.
  const settingsWatch = settings.watch(async (next: unknown) => {
    const nextResolved = resolveConfig(mergeConfig(next))
    const cacheShapeChanged = nextResolved.cachePersist !== resolved.cachePersist
      || nextResolved.cacheMaxEntries !== resolved.cacheMaxEntries
    resolved = nextResolved
    if (cacheShapeChanged) rebuildCache()
    gate.resyncAll()
  })

  // Data-driven auto-detect: persist once when provider+model are both unset.
  const autoDetect = ctx.on('agent/created', async ({ agent }) => {
    if (!resolved.autoDetectVisionModel || resolved.provider !== undefined || resolved.model !== undefined) return
    const detected = await detectVisionModel(ctx.llm, { primaryProvider: agent.options?.provider })
    if (detected !== undefined) {
      try {
        await settings.update({ provider: detected.provider, model: detected.model })
        ctx.logger.info('dsh-vision: auto-configured %s/%s (data-driven)', detected.provider, detected.model)
      } catch (error) {
        ctx.logger.warn('dsh-vision: auto-detect could not persist %s/%s: %s', detected.provider, detected.model, error instanceof Error ? error.message : String(error))
      }
    }
  })

  const gateDisposer = gate.install()

  ctx.logger.info(
    'dsh-vision ready (delegation=%s%s)',
    resolved.delegation,
    resolved.provider && resolved.model ? `, provider/model=${resolved.provider}/${resolved.model}` : '',
  )

  // Full lifecycle teardown (LIFO over registration order). Fiber-scoped
  // registrations (settings namespace, web routes) are also auto-disposed by
  // the loader; these explicit disposers cover every runtime seam we own.
  return () => {
    gateDisposer() // release per-agent tool masks + gate listeners
    markersDisposer() // marker registry cleanup on agent disposal
    autoDetect()
    settingsWatch()
    pasteDisposer() // agent/pre-step hook
    commandDisposer() // /vision command
    toolDisposer() // describe_image tool
  }
}

