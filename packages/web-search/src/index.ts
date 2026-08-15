/**
 * @gitawego/dsh-web-search — enhanced web search provider for DeepSeek Harness.
 * Registers a `WebSearchProvider` into ctx.web (id `opencode-enhanced`) with
 * chained fallback: opencode Go (when configured) -> free Parallel -> free Exa.
 * Works without any API key via the free MCP backends. Never modifies DSH
 * source or the stock dsh-web-search-deepseek plugin.
 *
 * The model-facing `web_search` tool/schema are owned by dsh-tool-web (bundled);
 * this plugin only supplies a provider that the seam routes to.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, WEB_SEARCH_SETTINGS_NAMESPACE, createResolvedConfig, type WebSearchConfig } from './config.ts'
import { createSearchProvider, PROVIDER_ID } from './provider.ts'
import { installWebSearchWeb } from './web.ts'

export const name = '@gitawego/dsh-web-search'

export { Config, WEB_SEARCH_SETTINGS_NAMESPACE, PROVIDER_ID }
export { createResolvedConfig } from './config.ts'
export { createSearchProvider } from './provider.ts'
export type { WebSearchConfig } from './config.ts'
export type { ProviderRuntime } from './provider.ts'

export const inject = ['web', 'settings', 'credentials']

export function apply(ctx: Context, config: Partial<WebSearchConfig> = {}): () => void {
  const settings = ctx.settings.register(WEB_SEARCH_SETTINGS_NAMESPACE, Config, {
    base: config,
    applies: 'live',
    validate: (value: unknown) => createResolvedConfig(value as Partial<WebSearchConfig>),
  })

  let resolved: WebSearchConfig = createResolvedConfig(settings.get() as WebSearchConfig)
  const watch = settings.watch((next: unknown) => {
    resolved = createResolvedConfig(next as WebSearchConfig)
  })

  const provider = createSearchProvider(
    () => resolved,
    {
      resolveGoApiKey: async () => {
        const ref = resolved.go.credential
        if (!ref) return undefined
        try {
          const resolvedCred = await ctx.credentials.resolve(credentialRef(ref))
          return resolvedCred?.value
        } catch {
          return undefined
        }
      },
    },
  )

  const disposeProvider = ctx.web.registerSearchProvider(provider)

  const webSettingsLike = {
    get: () => resolved,
    update: (patch: Record<string, unknown>) => settings.update(patch as never),
  }
  installWebSearchWeb(ctx, webSettingsLike)

  return () => {
    disposeProvider()
    watch()
  }
}