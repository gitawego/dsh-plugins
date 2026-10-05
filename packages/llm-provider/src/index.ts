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
 * - a **live model catalog**: the gateway's own `GET {baseURL}/models` list,
 *   enriched with capacities, output caps, and thinking levels from models.dev,
 *   merged over the installed catalog so a model released after this pi-ai
 *   build is servable without a code change;
 * - a **quota report**: the 5-hour, weekly, and monthly allowance windows the
 *   provider discloses, exposed as `/llm-provider quota` and as the `llm_quota`
 *   tool;
 * - a `llm-provider` settings namespace with one tuning profile per route
 *   (credential reference, endpoint override, model allowlist, image budgets);
 * - a configurable-provider directory entry and a model-discovery offer per
 *   route, so the Models page can list and probe the route like any other.
 *
 * Lifecycle: `apply` registers everything on this plugin's fiber, so the
 * settings namespace, the adapter, the directory entry, the discovery offer,
 * the command, and the tool all disappear together when the bundle layer does.
 *
 * @module @gitawego/dsh-llm-provider
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { INVALID_CREDENTIAL_CODE, LlmError, type LlmDiscoveredModel, type LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { GatewayAdapter } from './adapter.ts'
import { createCatalogFeed, type CatalogFeed, type LiveCatalog } from './catalog-feed.ts'
import {
    Config,
    LLM_PROVIDER_SETTINGS_NAMESPACE,
    defaultProfile,
    resolveProfiles,
    type ProviderSettings,
} from './config.ts'
import { declareRoutes, describeSkips } from './directory.ts'
import { fetchModelIds, fetchQuota, type QuotaSnapshot } from './gateway-api.ts'
import { registerQuotaRoute } from './quota-route.ts'
import { GATEWAYS, gatewayById, type GatewayDefinition } from './gateways.ts'
import { fetchModelsDevCatalog } from './models-dev.ts'
import { createQuotaTool, runProviderCommand, type SurfaceDeps } from './surface.ts'
import { createGatewayTransport } from './transport.ts'

/** Plugin display name for diagnostics. */
export const name = '@gitawego/dsh-llm-provider'

/**
 * Services this plugin mounts below. `llm` is the seam it registers into;
 * `settings` owns the profile document; `credentials` resolves the profile's
 * credential reference. The attachment store (image input), the command
 * registry, and the tool registry are attached optionally, so a composition
 * without one still serves text models.
 */
export const inject = ['llm', 'settings', 'credentials']

/** Route keys this build registers, in gateway order. */
export const ROUTES: readonly string[] = GATEWAYS.map((gateway) => gateway.id)

export { Config, LLM_PROVIDER_SETTINGS_NAMESPACE, GATEWAYS, type ProviderSettings }
export { OPENCODE_SESSION_HEADER, withSessionHeader } from './session-header.ts'
export { createGatewayTransport } from './transport.ts'
export { createCatalogFeed, mergeCatalog, thinkingLevelMapFor } from './catalog-feed.ts'
export { declareRoutes, describeSkips } from './directory.ts'
export { fetchModelIds, fetchQuota, formatQuota, parseModelIds, parseQuota } from './gateway-api.ts'
export { fetchModelsDevCatalog, parseModelsDevCatalog } from './models-dev.ts'
export { QUOTA_ROUTE_PATH, createQuotaHandler, isTrustedLocalRequest, quotaPayload, registerQuotaRoute } from './quota-route.ts'
export { formatCatalog, formatModel, runProviderCommand, createQuotaTool } from './surface.ts'
export { GatewayAdapter } from './adapter.ts'
export { resolveProfiles, resolveProfile, defaultProfile } from './config.ts'
export { GATEWAYS as gatewayDefinitions, gatewayById, protocolFor } from './gateways.ts'

/** How long a fetched catalog stays authoritative before a request-path refresh. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Mount the provider routes.
 * @param ctx - the plugin's context.
 * @returns a disposer releasing the settings watcher, the adapter routes, and
 *   the configurable-provider entries.
 */
/**
 * Register the settings namespace, with the plugin's own configuration as its
 * composition base.
 *
 * The namespace resolves in three layers — schema defaults, then this base, then
 * the user document (`settings.yaml`, or the card's writes). Putting a
 * deployment's profile in the base is what the Models page calls *not yours to
 * delete*: it offers Delete only for a profile that exists in the user layer
 * and nowhere else, so a reference supplied by composition does not present as a
 * removable user choice. It also means the page can see the profile's
 * `apiKeyEnv` — and therefore report the credential as configured — without
 * anyone having to write a settings section first.
 *
 * Exported as a function over an explicit settings face so the wiring (rather
 * than the whole plugin) can be tested.
 * @param settings - the settings service.
 * @param config - the plugin's configuration, used as the base layer.
 * @returns the namespace's owner scope.
 */
export function mountSettings(
    settings: Pick<Context['settings'], 'register'>,
    config: ProviderSettings,
): ReturnType<Context['settings']['register']> {
    return settings.register(LLM_PROVIDER_SETTINGS_NAMESPACE, Config, { applies: 'live', base: config })
}

/**
 * Mount the provider routes.
 * @param ctx - the plugin's context.
 * @param config - deployment configuration, applied as the settings base layer.
 * @returns a disposer releasing the settings watcher, the adapter routes, and
 *   the configurable-provider entries.
 */
export function apply(ctx: Context, config: ProviderSettings = {}): () => void {
    const settings = mountSettings(ctx.settings, config)

    let profiles: ProviderSettings = resolveProfiles(settings.get())
    const transport = createGatewayTransport(GATEWAYS, profiles)

    const profileFor = (route: string): ProviderSettings[string] => {
        const profile = profiles[route]
        if (profile !== undefined) return profile
        const gateway: GatewayDefinition | undefined = gatewayById(route)
        return defaultProfile(gateway ?? fallbackGateway(route))
    }

    const resolveApiKey = async (route: string): Promise<string | undefined> => {
        const ref = profileFor(route).apiKeyEnv
        if (ref.length === 0) return undefined
        try {
            const resolved = await ctx.credentials.resolve(credentialRef(ref))
            // `undefined` is the normal "this reference holds nothing" answer,
            // not an error: pi-ai then tries the gateway's own ambient provider
            // auth (`OPENCODE_API_KEY`).
            return resolved?.value
        } catch (error) {
            throw new LlmError(
                `credential reference "${ref}" for route "${route}" could not be resolved`,
                INVALID_CREDENTIAL_CODE,
                { cause: error },
            )
        }
    }

    /** The endpoint a route currently calls. */
    const baseURLFor = (route: string): string => {
        const override = profileFor(route).baseURL
        if (override.length > 0) return override
        return gatewayById(route)?.baseURL ?? override
    }

    const feed: CatalogFeed = createCatalogFeed({
        gateways: GATEWAYS,
        profileOf: profileFor,
        resolveApiKey,
        installedModels: (route) => transport.installedModels(route),
        apply: (route: string, live: LiveCatalog) => transport.setCatalog(route, live),
    })

    const adapter = new GatewayAdapter({
        transport,
        displayName: (route) => gatewayById(route)?.displayName ?? route,
        profileOf: profileFor,
        resolveApiKey,
        resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
    })

    const registration = ctx.llm.registerAdapter([...ROUTES], adapter)
    // A route key another plugin already declared is left to that plugin: the
    // directory is a presentation surface, and a collision there must not take
    // the boot down. See `directory.ts`.
    const outcome = declareRoutes(ctx.llm, GATEWAYS, LLM_PROVIDER_SETTINGS_NAMESPACE)
    const log = ctx.logger(name)
    for (const line of describeSkips(outcome)) log.warn('%s', line)

    // A draft provider in the Models page has no stored route to name, so the
    // request carries its endpoint and one-shot credential directly.
    const discovery = ctx.llm.registerModelDiscovery(
        LLM_PROVIDER_SETTINGS_NAMESPACE,
        async (request: LlmModelDiscoveryRequest, signal?: AbortSignal): Promise<readonly LlmDiscoveredModel[]> => {
            const route = request.provider !== undefined && gatewayById(request.provider) !== undefined ? request.provider : ROUTES[0]
            const baseURL = request.baseURL !== undefined && request.baseURL.trim().length > 0
                ? request.baseURL.trim()
                : route !== undefined ? baseURLFor(route) : undefined
            if (baseURL === undefined) return []
            const apiKey = request.apiKey ?? (route !== undefined ? await resolveApiKey(route) : undefined)
            const [ids, metadata] = await Promise.all([
                fetchModelIds({
                    baseURL,
                    ...(apiKey !== undefined ? { apiKey } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                }),
                fetchModelsDevCatalog({ ...(signal !== undefined ? { signal } : {}) }),
            ])
            return ids.map((id) => {
                const meta = metadata.get(id)
                return {
                    id,
                    ...(meta?.name !== undefined ? { name: meta.name } : {}),
                    ...(meta?.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
                    ...(meta?.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
                }
            })
        },
    )

    /** Read one route's credential and endpoint, then ask for its quota. */
    const quotaOf = async (route: string): Promise<QuotaSnapshot> => {
        const apiKey = await resolveApiKey(route)
        return fetchQuota(
            { baseURL: baseURLFor(route), ...(apiKey !== undefined ? { apiKey } : {}) },
            route,
        )
    }

    // The browser's only path to a live allowance read. Guarded and read-only;
    // see `quota-route.ts` for why this is a route rather than a seam.
    registerQuotaRoute(ctx, { routes: ROUTES, quotaOf })

    const surfaces: SurfaceDeps = {
        routes: ROUTES,
        feed,
        modelsOf: (route) => transport.listModels(route),
        quotaOf,
    }

    // Both surfaces attach through `ctx.inject`, so a composition without a
    // command or tool registry still gets the route itself. Cordis unloads the
    // injected children with this plugin's fiber, so neither needs a manual
    // disposer here.
    ctx.inject(['commands'], (injected: Context) => {
        injected.commands.register({
            name: 'llm-provider',
            description:
                'Show the live LLM provider catalog (context window, output cap, thinking levels) or the subscription quota windows (5-hour, weekly, monthly), or refresh both from the provider.',
            handler: (invocation) => runProviderCommand(surfaces, invocation.rawInput),
        })
    })
    ctx.inject(['tools'], (injected: Context) => {
        injected.tools.register(createQuotaTool(surfaces))
    })

    // Prime the live catalog in the background: a boot that cannot reach the
    // gateway must still serve the installed catalog, so nothing waits on this.
    const boot = new AbortController()
    void feed.refresh(undefined, boot.signal).catch(() => undefined)

    const watch = settings.watch((next: unknown) => {
        const previous = profiles
        profiles = resolveProfiles(next)
        transport.setProfiles(profiles)
        // A route pointed at another endpoint is describing a different
        // catalog; re-read it rather than serving the previous endpoint's.
        const moved = GATEWAYS.filter((gateway) => previous[gateway.id]?.baseURL !== profiles[gateway.id]?.baseURL)
        for (const gateway of moved) void feed.refresh(gateway.id, boot.signal).catch(() => undefined)
    })

    return () => {
        boot.abort('llm-provider unloaded')
        watch()
        discovery()
        registration()
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
        protocols: { byId: {}, default: 'openai-completions' },
    }
}
