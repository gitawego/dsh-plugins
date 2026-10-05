/**
 * The gateways this plugin can serve, as data.
 *
 * A "gateway" is a provider route the harness did not ship an adapter for, but
 * whose wire protocol and model catalog pi-ai already describes. Keeping them
 * in one table is what makes "support OpenCode Go first" cheap to extend: a new
 * gateway is one entry here (plus, if it needs different plumbing, a new
 * field), not a new adapter.
 *
 * @module @gitawego/dsh-llm-provider/gateways
 */

/** One servable provider route. */
export interface GatewayDefinition {
    /** Route key requests select with `GenerateOptions.provider`. */
    id: string
    /** Human-readable name for selectors and diagnostics. */
    displayName: string
    /**
     * pi-ai built-in provider id whose model catalog and protocol
     * implementations this route reuses. The catalog is the source of truth for
     * models, per-model endpoints, compat switches, and reasoning levels — the
     * plugin never hand-copies them.
     */
    catalogProvider: string
    /** Default endpoint, used when the settings profile does not override it. */
    baseURL: string
    /** Default credential reference name resolved through the harness seam. */
    apiKeyEnv: string
    /**
     * Whether this gateway requires the `x-opencode-session` routing header.
     * True for OpenCode Go, whose 400 `MissingSessionID` is the failure this
     * plugin exists to remove.
     */
    sessionRouting: boolean
}

/** OpenCode Go — `https://opencode.ai/zen/go`. */
export const OPENCODE_GO: GatewayDefinition = {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    catalogProvider: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    sessionRouting: true,
}

/**
 * Every route this build can register. Order is registration order, which is
 * the order the model selector and `ctx.llm.listProviders()` report.
 */
export const GATEWAYS: readonly GatewayDefinition[] = [OPENCODE_GO]

/**
 * Look one gateway up by route key.
 * @param id - route key.
 * @returns the definition, or undefined when this build does not serve it.
 */
export function gatewayById(id: string): GatewayDefinition | undefined {
    return GATEWAYS.find((gateway) => gateway.id === id)
}
