/**
 * The `WebSearchProvider` registered into ctx.web. Chained fallback in order:
 *
 *   1. **Custom LLM** — whatever the user configured in `llm.baseUrl` /
 *      `llm.model` / `llm.credential`. Tried first when `llm.enabled === true`.
 *   2. **opencode Go default** — hardcoded `https://opencode.ai/zen/go/v1` with
 *      `deepseek-v4-flash` and the `OPENCODE_GO_API_KEY` credential-ref name.
 *      Always tried as the next candidate (independent of `llm.enabled`), but
 *      silently skipped when the credential isn't configured.
 *   3. **Free backends** — Parallel, then Exa (no API key).
 *
 * Each stage is attempted in order; the first successful, non-empty result
 * wins. Throws a WebError only when every backend fails. Honours the abort
 * signal and the request's `maxResults` bound.
 */
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult, type WebSearchSource } from '@deepseek-ai/dsh-web'
import type { WebSearchConfig } from './config.ts'
import { dedupeAndCap, type RawSource } from './normalize.ts'
import { parallelSearch } from './backends/parallel.ts'
import { exaSearch } from './backends/exa.ts'
import { llmSearch, type LlmBackendOptions } from './backends/llm.ts'

export const PROVIDER_ID = 'opencode-enhanced'

/** opencode Go fallback constants — the shipped DSH default. Not user-configurable. */
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
const OPENCODE_GO_DEFAULT_MODEL = 'deepseek-v4-flash'
const OPENCODE_GO_CREDENTIAL_NAME = 'OPENCODE_GO_API_KEY'

/** Runtime dependencies the provider needs to perform a search. */
export interface ProviderRuntime {
  /** Resolve the user-configured custom LLM API key (undefined = no valid credential). */
  resolveGoApiKey: () => Promise<string | undefined>
  /** Resolve the opencode Go default API key (undefined = silently skip step 2). */
  resolveOpenCodeGoApiKey: () => Promise<string | undefined>
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

  const llmOpts = (cfg: WebSearchConfig, baseUrl: string, model: string, protocol: 'anthropic' | 'openai', apiKey: string, timeoutMs: number): LlmBackendOptions => ({
    protocol,
    baseUrl,
    model,
    apiKey,
    timeoutMs,
    fetchImpl: runtime.fetchImpl,
  })

  return {
    id: PROVIDER_ID,
    // Cheap, no network: true if any backend is configured. The LLM
    // candidates (custom + opencode-go default) and the free backends
    // (Parallel/Exa) are independent — at least one must be usable.
    available() {
      const cfg = getConfig()
      const customLlmUsable = cfg.llm.enabled === true && cfg.llm.baseUrl !== undefined && cfg.llm.baseUrl.length > 0
      const freeUsable = cfg.free.parallelUrl.length > 0 || cfg.free.exaUrl.length > 0
      return customLlmUsable || freeUsable
    },
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      const cfg = getConfig()
      const maxResults = request.maxResults ?? cfg.free.maxResults
      const snippetMax = cfg.free.snippetMaxChars

      const candidates: Array<() => Promise<RawSource[]>> = []

      // Step 1: user-configured custom LLM.
      if (cfg.llm.enabled === true && cfg.llm.baseUrl && cfg.llm.baseUrl.length > 0) {
        candidates.push(async () => {
          const apiKey = await runtime.resolveGoApiKey()
          if (!apiKey) throw new Error('LLM backend: no credential')
          const raw = await llmSearch(
            request.query,
            llmOpts(cfg, cfg.llm.baseUrl!, cfg.llm.model!, cfg.llm.protocol, apiKey, cfg.llm.timeoutMs),
            signal,
          )
          if (raw.length === 0) throw new Error('LLM backend: empty results')
          return raw
        })
      }

      // Step 2: opencode Go default fallback (hardcoded, always tried unless
      // no credential is configured). Skipped silently when the credential
      // is missing — this is the expected "no API key for step 2" path.
      candidates.push(async () => {
        const apiKey = await runtime.resolveOpenCodeGoApiKey()
        if (!apiKey) throw new Error('opencode-go default: no credential')
        const raw = await llmSearch(
          request.query,
          llmOpts(cfg, OPENCODE_GO_BASE_URL, OPENCODE_GO_DEFAULT_MODEL, 'anthropic', apiKey, cfg.llm.timeoutMs),
          signal,
        )
        if (raw.length === 0) throw new Error('opencode-go default: empty results')
        return raw
      })

      // Step 3: free backends.
      if (cfg.free.parallelUrl.length > 0) {
        candidates.push(() => parallelSearch(request.query, { url: cfg.free.parallelUrl, ...freeOpts(cfg) }, signal))
      }
      if (cfg.free.exaUrl.length > 0) {
        candidates.push(() => exaSearch(request.query, { url: cfg.free.exaUrl, ...freeOpts(cfg) }, signal))
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
          // Step 2's "no credential" path silently no-ops (next candidate
          // tries); other failures are remembered for the final throw.
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