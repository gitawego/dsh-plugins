/**
 * @gitawego/dsh-web-search — enhanced web search provider for DeepSeek Harness.
 * Registers a `WebSearchProvider` into ctx.web (id `opencode-enhanced`) with
 * chained fallback: opencode Go (when configured) -> free Parallel -> free Exa.
 * Works without any API key via the free MCP backends. Never modifies DSH
 * source or the stock dsh-web-search-deepseek plugin.
 *
 * The model-facing `web_search` tool/schema are owned by dsh-tool-web (bundled);
 * this plugin only supplies a provider that the seam routes to.
 *
 * Lifecycle: `apply` registers the settings namespace and the search provider
 * on this plugin's fiber. Both `ctx.settings.register` and `ctx.web.registerSearchProvider`
 * are effect-scoped, but the search-provider effect lives on the WebRuntime's
 * own fiber (not ours), so `apply` returns a disposer that drops it manually;
 * the settings registration is cleaned up by the fiber itself.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, WEB_SEARCH_SETTINGS_NAMESPACE, createResolvedConfig, readConfig, type WebSearchConfig, type WebSearchConfigRefs } from './config.ts'
import { createSearchProvider, PROVIDER_ID } from './provider.ts'

export const name = '@gitawego/dsh-web-search'

export { Config, WEB_SEARCH_SETTINGS_NAMESPACE, PROVIDER_ID }
export { createResolvedConfig } from './config.ts'
export { createSearchProvider } from './provider.ts'
export type { WebSearchConfig } from './config.ts'
export type { ProviderRuntime } from './provider.ts'

export const inject = ['web', 'credentials']

export function apply(ctx: Context, config: WebSearchConfigRefs): () => void {
  // 0.2 derives the configuration form from this plugin's exported `Config`
  // and hands `apply` stable volatile refs. Reading them per call is what
  // makes a form write live without re-installing the plugin.
  const current = (): WebSearchConfig => createResolvedConfig(readConfig(config))

  /** Resolve one optional free-backend credential reference. */
  const resolveFreeToken = async (ref: string | undefined): Promise<string | undefined> => {
    if (ref === undefined) return undefined
    try {
      const resolvedCred = await ctx.credentials.resolve(credentialRef(ref))
      return resolvedCred?.value
    } catch {
      return undefined
    }
  }

  const provider = createSearchProvider(
    current,
    {
      resolveGoApiKey: async () => {
        const ref = current().llm.credential
        if (!ref) return undefined
        try {
          const resolvedCred = await ctx.credentials.resolve(credentialRef(ref))
          return resolvedCred?.value
        } catch {
          return undefined
        }
      },
      // Hardcoded opencode-Go default fallback. Silently undefined when the
      // credential isn't configured — the chain skips step 2 in that case.
      resolveOpenCodeGoApiKey: async () => {
        try {
          const resolvedCred = await ctx.credentials.resolve(credentialRef('OPENCODE_GO_API_KEY'))
          return resolvedCred?.value
        } catch {
          return undefined
        }
      },
      // Optional tokens for the hosted MCP endpoints: a reference that resolves
      // to nothing keeps the anonymous free path rather than failing the search.
      resolveParallelApiKey: async () => resolveFreeToken(current().free.parallelCredential),
      resolveExaApiKey: async () => resolveFreeToken(current().free.exaCredential),
    },
  )

  const disposeProvider = ctx.web.registerSearchProvider(provider)

  return () => {
    disposeProvider()
  }
}