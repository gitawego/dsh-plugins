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
    /**
     * Which wire protocol each model speaks, for models the installed catalog
     * does not describe.
     *
     * A gateway is not uniform: `opencode.ai/zen/go` serves `gpt-*`,
     * `grok-*`, and `muse-spark-*` over `/v1/responses`, `minimax-m2.7`/`m3`
     * and the `qwen3.7-plus`/`qwen3.8-*` tier over `/v1/messages`, and what
     * remains over `/v1/chat/completions` — which is the gateway's own
     * documented endpoint table, not a guess. A model the installed catalog
     * already describes never consults this table, and a model it does not must
     * land on a protocol *here* or on `default`; silently sending the wrong
     * protocol to a live endpoint is the failure this table exists to prevent.
     */
    protocols: {
        /** Protocol by exact model id. */
        byId: Readonly<Record<string, string>>
        /** Protocol for every other model on the route. */
        default: string
    }
}

/**
 * OpenCode Go — `https://opencode.ai/zen/go`.
 *
 * The route id is deliberately NOT the catalog provider id. `dsh-llm-pi-ai`
 * declares a configurable-provider directory entry for **every** provider in
 * pi-ai's installed catalog, and pi-ai ships `opencode-go`; a route claiming
 * that exact key collides at boot with
 *
 * ```text
 * LlmError: configurable provider "opencode-go" is already declared
 * ```
 *
 * and, worse, clicking that row in the Models page would configure the generic
 * pi-ai adapter for the same route — leaving two plugins registering one route
 * and a boot that fails outright. A route key is a contract with the harness's
 * provider topology, so this plugin takes one of its own and lets the pi-ai
 * entry stay what it is: the dormantly-declared catalog provider that does not
 * send the session header.
 */
export const OPENCODE_GO: GatewayDefinition = {
    id: 'opencode-go-session',
    displayName: 'OpenCode Go',
    catalogProvider: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    sessionRouting: true,
    protocols: {
        // The gateway's own endpoint table (`https://opencode.ai/docs/go/#endpoints`).
        // Everything it does not list — including models released after this
        // build — speaks the OpenAI-compatible chat-completions protocol.
        byId: {
            'grok-4.6': 'openai-responses',
            'grok-4.7': 'openai-responses',
            'gpt-5.6-luna': 'openai-responses',
            'gpt-6-luna': 'openai-responses',
            'muse-spark-1.2-contributor': 'openai-responses',
            'muse-spark-1.3-contributor': 'openai-responses',
            'minimax-m2.7': 'anthropic-messages',
            'minimax-m3': 'anthropic-messages',
            'qwen3.7-plus': 'anthropic-messages',
            'qwen3.8-flash': 'anthropic-messages',
            'qwen3.8-max': 'anthropic-messages',
        },
        default: 'openai-completions',
    },
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

/**
 * The wire protocol one model on a gateway speaks.
 * @param gateway - the gateway serving the model.
 * @param modelId - exact model id.
 * @returns the protocol the gateway publishes for that id, or its default.
 */
export function protocolFor(gateway: GatewayDefinition, modelId: string): string {
    return gateway.protocols.byId[modelId] ?? gateway.protocols.default
}
