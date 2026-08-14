/** dsh-vision — capability-aware vision + paste extension for DeepSeek
 *  Harness (pi-vision port). M1: describe_image tool with the v0.2–v0.5
 *  resilience pipeline, per-agent capability gating, /vision command, and
 *  data-driven auto-detect. Paste UX (M2) and Web client (M3) follow. */
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
import { detectVisionModel } from './defaults.ts'
import { VisionGate } from './exposure.ts'
import { createDescribeImageTool } from './tool.ts'

export const name = 'dsh-vision'

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

  const tool = createDescribeImageTool({
    config: () => resolved,
    gate,
    cache: () => cache,
    home,
    resolveCredential: (ref) => ctx.credentials.resolve(ref),
    llm: ctx.llm,
    attachments: ctx.attachments,
  })
  ctx.tools.register(tool)

  const command = createVisionCommand({
    settings: {
      get: () => settings.get() as VisionConfig,
      update: (patch) => settings.update(patch),
      mutate: (ops) => ctx.settings.mutate(VISION_SETTINGS_NAMESPACE, ops.map((o) => o.op === 'set'
        ? { op: 'set' as const, path: [o.path], value: o.value as never }
        : { op: 'unset' as const, path: [o.path] })),
      replace: (section) => settings.replace(section),
    },
    config: () => resolved,
    gate,
    cache: () => cache,
    home,
    detect: () => detectVisionModel(ctx.llm),
  })
  ctx.commands.register(command)

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

  return () => {
    gateDisposer()
    autoDetect()
    settingsWatch()
  }
}
