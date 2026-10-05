/**
 * @gitawego/dsh-llm-provider — first-party LLM provider routes for the
 * DeepSeek Harness LLM seam.
 *
 * The plugin exists for one concrete reason: **OpenCode Go refuses a request
 * that carries no `x-opencode-session` header**, and that header is a
 * per-conversation value the harness already knows
 * (`GenerateOptions.sessionId`) but no installed adapter puts on the wire.
 * `dsh-llm-pi-ai` forwards the session id to pi-ai; pi-ai 0.85.1 — the build
 * the 0.1.5 host depends on — never turns it into a header, so every request
 * fails:
 *
 * ```text
 * 400 {"type":"error","error":{"type":"MissingSessionID","message":
 *   "Request is missing x-opencode-session and cannot be routed efficiently."}}
 * ```
 *
 * Provider `headers` in `settings.yaml` cannot express this: they are static
 * deployment facts and the value must change per conversation. An adapter is
 * the only seam that sees the session id, so this plugin owns one.
 *
 * What it contributes:
 *
 * - one registered route per {@link GATEWAYS} entry (`opencode-go` today),
 *   backed by the installed pi-ai catalog and pi-ai's own wire protocols;
 * - the `x-opencode-session` header, stamped per request from the harness
 *   session id, plus the mandatory attribution headers on every dispatch;
 * - a `llm-provider` settings namespace with one tuning profile per route
 *   (credential reference, endpoint override, model allowlist, image budgets);
 * - a configurable-provider directory entry per route, so the Models page can
 *   offer it the way it offers every other provider.
 *
 * Lifecycle: `apply` registers the settings namespace, the adapter, and the
 * directory entry on this plugin's fiber — all three disappear together when
 * the bundle layer does.
 *
 * @module @gitawego/dsh-llm-provider
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { GatewayAdapter } from './adapter.ts'
import {
    Config,
    LLM_PROVIDER_SETTINGS_NAMESPACE,
    defaultProfile,
    resolveProfiles,
    type ProviderSettings,
} from './config.ts'
import { GATEWAYS, gatewayById, type GatewayDefinition } from './gateways.ts'
import { createGatewayTransport } from './transport.ts'

/** Plugin display name for diagnostics. */
export const name = '@gitawego/dsh-llm-provider'

/**
 * Services this plugin mounts below. `llm` is the seam it registers into;
 * `settings` owns the profile document; `credentials` resolves the profile's
 * credential reference. The attachment store is read optionally (image input
 * only) so a composition without one still serves text models.
 */
export const inject = ['llm', 'settings', 'credentials']

/** Route keys this build registers, in gateway order. */
export const ROUTES: readonly string[] = GATEWAYS.map((gateway) => gateway.id)

export { Config, LLM_PROVIDER_SETTINGS_NAMESPACE, GATEWAYS, type ProviderSettings }
export { OPENCODE_SESSION_HEADER, withSessionHeader } from './session-header.ts'
export { createGatewayTransport } from './transport.ts'
export { GatewayAdapter } from './adapter.ts'
export { resolveProfiles, resolveProfile, defaultProfile } from './config.ts'
export { GATEWAYS as gatewayDefinitions, gatewayById } from './gateways.ts'

/**
 * Mount the provider routes.
 * @param ctx - the plugin's context.
 * @returns a disposer releasing the settings watcher, the adapter routes, and
 *   the configurable-provider entries.
 */
export function apply(ctx: Context): () => void {
    const settings = ctx.settings.register(LLM_PROVIDER_SETTINGS_NAMESPACE, Config, { applies: 'live' })

    let profiles: ProviderSettings = resolveProfiles(settings.get())
    const transport = createGatewayTransport(GATEWAYS, profiles)

    const watch = settings.watch((next: unknown) => {
        profiles = resolveProfiles(next)
        // Rebuild only what moved: a settings commit that changes nothing
        // structurally leaves every built provider in place, so an in-flight
        // request keeps the generation it started under.
        transport.setProfiles(profiles)
    })

    const profileFor = (route: string): ProviderSettings[string] => {
        const profile = profiles[route]
        if (profile !== undefined) return profile
        const gateway: GatewayDefinition | undefined = gatewayById(route)
        return gateway === undefined ? defaultProfile(fallbackGateway(route)) : defaultProfile(gateway)
    }

    const adapter = new GatewayAdapter({
        transport,
        displayName: (route) => gatewayById(route)?.displayName ?? route,
        profileOf: profileFor,
        resolveApiKey: async (route) => {
            const ref = profileFor(route).apiKeyEnv
            if (ref.length === 0) return undefined
            try {
                const resolved = await ctx.credentials.resolve(credentialRef(ref))
                // `undefined` is the normal "this reference holds nothing"
                // answer, not an error: pi-ai then tries the gateway's own
                // ambient provider auth (`OPENCODE_API_KEY`).
                return resolved?.value
            } catch (error) {
                throw new LlmError(
                    `credential reference "${ref}" for route "${route}" could not be resolved`,
                    INVALID_CREDENTIAL_CODE,
                    { cause: error },
                )
            }
        },
        resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
    })

    const registration = ctx.llm.registerAdapter([...ROUTES], adapter)
    const directory = ctx.llm.registerConfigurableProviders(
        GATEWAYS.map((gateway) => ({
            provider: gateway.id,
            displayName: gateway.displayName,
            settingsNs: LLM_PROVIDER_SETTINGS_NAMESPACE,
            settingsPath: [gateway.id],
            // The adapter ships knowledge of this route; it is not a gateway a
            // user hand-declared in settings.
            declared: false,
        })),
    )

    return () => {
        directory()
        registration()
        watch()
    }
}

/** A definition-shaped stub for a route key that is not in this build. */
function fallbackGateway(route: string): GatewayDefinition {
    return {
        id: route,
        displayName: route,
        catalogProvider: route,
        baseURL: '',
        apiKeyEnv: '',
        sessionRouting: true,
    }
}
