/**
 * pi-ai catalog providers, by catalog key.
 *
 * A gateway definition names a `catalogProvider` key; this table resolves it to
 * the pi-ai factory that builds the route's model catalog, per-model endpoints,
 * wire protocols, and compatibility switches. Keeping the import here (rather
 * than in the data-only `gateways.ts`) means the gateway table and the config
 * schema stay loadable — and testable — without pulling pi-ai in.
 *
 * @module @gitawego/dsh-llm-provider/catalog
 */
import type { Provider } from '@earendil-works/pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'

/** One pi-ai catalog provider factory. */
export type CatalogProviderFactory = () => Provider

/**
 * Every catalog this build reuses, by {@link GatewayDefinition.catalogProvider}
 * key. `opencode-go` is shipped by pi-ai 0.85.1 and its catalog is the
 * authority for the route's models (`deepseek-v4.1-flash` and friends),
 * including each model's own endpoint under `opencode.ai/zen/go`.
 */
export const CATALOG_PROVIDERS: Readonly<Record<string, CatalogProviderFactory>> = {
    'opencode-go': opencodeGoProvider,
}

/**
 * Resolve one catalog factory.
 * @param key - the gateway's `catalogProvider` value.
 * @returns the factory, or undefined when the installed pi-ai build does not
 *   ship that catalog (a newer gateway definition loaded against an older
 *   pi-ai) — the route is then registered but reports no models.
 */
export function catalogProviderFactory(key: string): CatalogProviderFactory | undefined {
    return CATALOG_PROVIDERS[key]
}
