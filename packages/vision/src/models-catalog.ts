/** Domain-level helpers for the vision model catalog — builds a snapshot
 *  of the live LLM registry (image-capable models, registered providers,
 *  default detection) for any consumer. Extracted from the rc.6 bespoke
 *  HTTP route so the same logic powers both the host-side /vision command
 *  and the rc.7 client-side catalog dropdown (via api.llm.models RPC).
 *  Not HTTP-coupled. */
import type { ResolvedVisionConfig } from './config.ts'
import { detectVisionModel, type VisionModelCandidate } from './defaults.ts'

export interface VisionProviderRow {
  id: string
  name: string
}

export interface VisionModelRow extends VisionModelCandidate {
  default?: boolean
}

export interface VisionModelsSnapshot {
  providers: VisionProviderRow[]
  visionModels: VisionModelRow[]
  configured: { provider: string | undefined; model: string | undefined }
  detected: VisionModelRow | undefined
  available: boolean
}

export async function buildModelsSnapshot(
  ctx: { llm: { listProviders: () => Array<{ id: string; name: string }>; listModels: (provider: string) => Promise<Array<{ id: string; name: string; inputModalities?: readonly string[] }>> } },
  resolved: ResolvedVisionConfig,
): Promise<VisionModelsSnapshot> {
  let providers: VisionProviderRow[] = []
  try {
    providers = ctx.llm.listProviders().map((p) => ({ id: p.id, name: p.name }))
  } catch {
    providers = []
  }
  const visionModels: VisionModelRow[] = []
  for (const { id } of providers) {
    let models
    try {
      models = await ctx.llm.listModels(id)
    } catch {
      continue
    }
    for (const m of models) {
      const inputModalities = m.inputModalities ?? []
      if (!inputModalities.includes('image')) continue
      visionModels.push({ provider: id, model: m.id, name: m.name })
    }
  }
  const detected = await detectVisionModel(ctx.llm as never, { primaryProvider: resolved.provider })
  const detectedRow: VisionModelRow | undefined = detected === undefined
    ? undefined
    : { provider: detected.provider, model: detected.model, name: detected.name, default: true }
  const configured = { provider: resolved.provider, model: resolved.model }
  const available = providers.length > 0
  return { providers, visionModels, configured, detected: detectedRow, available }
}
