/**
 * The `WebSearchProvider` registered into ctx.web. Chained fallback:
 * opencode Go (when a credential is configured) -> Parallel -> Exa. Each stage
 * is attempted in order; the first successful, non-empty result wins. Throws a
 * WebError only when every backend fails. Honours the abort signal and the
 * request's maxResults bound.
 */
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import type { WebSearchConfig } from './config.ts'
import { dedupeAndCap, type RawSource } from './normalize.ts'
import { parallelSearch } from './backends/parallel.ts'
import { exaSearch } from './backends/exa.ts'
import { goSearch, type GoBackendOptions } from './backends/go.ts'

export const PROVIDER_ID = 'opencode-enhanced'

/** Runtime dependencies the provider needs to perform a search. */
export interface ProviderRuntime {
  /** Resolve the opencode Go API key (undefined = no valid credential). */
  resolveGoApiKey: () => Promise<string | undefined>
  /** Inject fake fetch in tests; omitted in production. */
  fetchImpl?: typeof fetch
}

/**
 * Build the provider. `runtime` may be partial in tests. `config` is read
 * fresh on each search so settings changes apply live.
 */
export function createSearchProvider(getConfig: () => WebSearchConfig, runtime: ProviderRuntime): WebSearchProvider {
  const freeOpts = (cfg: WebSearchConfig) => ({
    timeoutMs: cfg.free.timeoutMs,
    fetchImpl: runtime.fetchImpl,
  })

  const goOpts = (cfg: WebSearchConfig, apiKey: string): GoBackendOptions => ({
    baseUrl: cfg.go.baseUrl!,
    model: cfg.go.model!,
    apiKey,
    timeoutMs: cfg.go.timeoutMs,
    fetchImpl: runtime.fetchImpl,
  })

  return {
    id: PROVIDER_ID,
    // Cheap, no network: true if any backend is configured. Go is usable only
    // when baseUrl is set (credential presence is resolved per-search); the
    // free backends are usable whenever a URL is configured.
    available() {
      const cfg = getConfig()
      const goUsable = cfg.go.baseUrl !== undefined && cfg.go.baseUrl.length > 0
      const freeUsable = cfg.free.parallelUrl.length > 0 || cfg.free.exaUrl.length > 0
      return goUsable || freeUsable
    },
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const cfg = getConfig()
      const maxResults = request.maxResults ?? cfg.free.maxResults
      const snippetMax = cfg.free.snippetMaxChars

      const candidates: Array<() => Promise<RawSource[]>> = []

      if (cfg.go.baseUrl && cfg.go.baseUrl.length > 0) {
        candidates.push(async () => {
          const apiKey = await runtime.resolveGoApiKey()
          if (!apiKey) throw new Error('opencode Go: no credential')
          const raw = await goSearch(request.query, goOpts(cfg, apiKey), signal)
          if (raw.length === 0) throw new Error('opencode Go: empty results')
          return raw
        })
      }

      if (cfg.free.parallelUrl.length > 0) {
        candidates.push(() => parallelSearch(request.query, { url: cfg.free.parallelUrl, ...freeOpts(cfg) }, signal))
      }
      if (cfg.free.exaUrl.length > 0) {
        candidates.push(() => exaSearch(request.query, { url: cfg.free.exaUrl, ...freeOpts(cfg) }, signal))
      }

      if (candidates.length === 0) {
        throw new WebError('enhanced web search has no configured backend', 'WEB_PROVIDER_UNAVAILABLE')
      }

      let lastError: unknown
      for (const candidate of candidates) {
        try {
          const raw = await candidate()
          if (raw.length > 0) {
            const { sources, truncated } = dedupeAndCap(raw, maxResults, snippetMax)
            const typed: WebSearchSource[] = sources
            const result: WebSearchResult = { sources: typed, truncated }
            return result
          }
        } catch (e) {
          lastError = e
          if (signal?.aborted) throw new WebError('enhanced web search aborted', 'WEB_ABORTED', { cause: e })
        }
      }
      throw new WebError(
        'all enhanced web search backends failed: ' + String(lastError instanceof Error ? lastError.message : lastError),
        'WEB_PROVIDER_ERROR',
        { cause: lastError },
      )
    },
  }
}