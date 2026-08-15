/** Data-driven vision-model auto-detect (SPEC §13): scan the live LLM adapter
 *  catalogs for models whose inputModalities include 'image'. Prefers the
 *  active primary's provider first; never hardcodes provider/model ids. */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

export interface VisionModelCandidate {
  provider: string
  model: string
  name: string
}

/** Tier-1 live catalog scan. primaryProvider is preferred first. */
export async function detectVisionModel(
  llm: Pick<LlmRuntime, 'listProviders' | 'listModels'>,
  opts: { primaryProvider?: string } = {},
): Promise<VisionModelCandidate | undefined> {
  const providers = llm.listProviders()
  const order = [...providers].sort((a, b) => {
    if (opts.primaryProvider !== undefined) {
      if (a.id === opts.primaryProvider) return -1
      if (b.id === opts.primaryProvider) return 1
    }
    return 0
  })
  for (const { id } of order) {
    let models
    try {
      models = await llm.listModels(id)
    } catch {
      continue // a provider failing to list models is skipped, not fatal
    }
    const vision = models.find((m) => m.inputModalities?.includes('image'))
    if (vision !== undefined) return { provider: id, model: vision.id, name: vision.name }
  }
  return undefined
}
