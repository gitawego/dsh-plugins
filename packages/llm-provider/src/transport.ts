/**
 * The pi-ai-backed transport behind the plugin's routes.
 *
 * One route is one pi-ai `Provider` built from its installed catalog, with the
 * profile and the latest live catalog applied, and the two things the harness
 * requires on every dispatch layered on:
 *
 * 1. **Attribution** — `attributionHeaders()` merged into every request, last,
 *    so a profile cannot shadow the product identity. pi-ai's `headers` request
 *    option is the wire hook.
 * 2. **Session routing** — the `x-opencode-session` header, derived from the
 *    harness session id. This is the fix for `400 MissingSessionID`.
 *
 * The transport deliberately does NOT go through pi-ai's `Models` collection:
 * that layer exists to resolve pi-ai's own credential store and OAuth logins,
 * and this plugin resolves its credential through the harness credential seam
 * instead (one credential model in one place). Calling the provider directly
 * also keeps every request's options visible in one function, which is what
 * makes the header behaviour unit-testable.
 *
 * The advertised model list is a merge of the installed catalog, the gateway's
 * live id list, and models.dev metadata — see `catalog-feed.ts`. This module
 * owns the *state*: which catalog generation a route is currently serving, and
 * rebuilding a route when either its profile or its live catalog moves.
 *
 * @module @gitawego/dsh-llm-provider/transport
 */
import type {
    Api,
    AssistantMessageEventStream,
    Context as PiContext,
    Model,
    Provider,
    SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogProviderFactory, type CatalogProviderFactory } from './catalog.ts'
import { mergeCatalog, type LiveCatalog } from './catalog-feed.ts'
import { resolveProfile, type GatewayProfile, type ProviderSettings } from './config.ts'
import { withSessionHeader, type SessionHeaderedOptions } from './session-header.ts'
import type { GatewayDefinition } from './gateways.ts'

/** pi-ai request options this plugin forwards. */
export type PiRequestOptions = SimpleStreamOptions & SessionHeaderedOptions

/**
 * The transport seam the adapter depends on. Declared separately from its
 * pi-ai implementation so adapter tests can drive a fake stream without a
 * network, a catalog, or pi-ai's event plumbing.
 */
export interface GatewayTransport {
    /**
     * Models one route currently advertises, in merge order and already
     * filtered by the profile's allowlist.
     * @param route - registered route key.
     * @returns the route's models; empty for an unknown or unbuildable route.
     */
    listModels(route: string): readonly Model<Api>[]
    /**
     * Resolve one exact model.
     * @param route - registered route key.
     * @param modelId - model id from the request.
     * @returns the model, or undefined when the route does not serve it.
     */
    getModel(route: string, modelId: string): Model<Api> | undefined
    /**
     * Address one pi-ai assistant event stream. The returned lazy stream
     * surfaces provider and auth failures as terminal `error` events, matching
     * pi-ai's own contract.
     * @param route - registered route key.
     * @param modelId - exact model id.
     * @param context - converted pi-ai conversation context.
     * @param options - forwarded request options, including the session id.
     * @returns the pi-ai event stream.
     */
    stream(route: string, modelId: string, context: PiContext, options: PiRequestOptions): AssistantMessageEventStream
}

/** A transport whose profiles and catalogs can follow their sources. */
export interface MutableGatewayTransport extends GatewayTransport {
    /**
     * Install a new resolved profile set and rebuild only the routes whose
     * profile actually changed. A route's live catalog survives the rebuild, so
     * a settings edit does not throw away a fresh model list.
     * @param profiles - resolved profiles keyed by route.
     */
    setProfiles(profiles: ProviderSettings): void
    /**
     * Install a freshly fetched live catalog for one route.
     * @param route - route the catalog belongs to.
     * @param live - ids plus metadata, and when they were read.
     */
    setCatalog(route: string, live: LiveCatalog): void
    /**
     * The route's installed pi-ai catalog, before any live merge.
     * @param route - route to read.
     * @returns the catalog the installed pi-ai build describes.
     */
    installedModels(route: string): readonly Model<Api>[]
    /**
     * The route's current live catalog, when one has been fetched.
     * @param route - route to read.
     * @returns the live inputs, or undefined before the first successful fetch.
     */
    liveCatalog(route: string): LiveCatalog | undefined
    /**
     * The endpoint a route currently calls.
     * @param route - route to read.
     * @returns the profile override when set, otherwise the gateway default.
     */
    endpointOf(route: string): string
}

/** One route's built state. */
interface RouteState {
    profile: GatewayProfile
    provider: Provider | undefined
    installed: readonly Model<Api>[]
    models: readonly Model<Api>[]
    live: LiveCatalog | undefined
    buildable: boolean
}

/**
 * Merge attribution over caller headers, dropping caller keys that collide
 * case-insensitively with the attribution set — the same precedence
 * `dsh-llm-pi-ai` applies, so an installed deployment cannot silently replace
 * the harness's `user-agent`.
 * @param headers - caller/provider headers, when any.
 * @returns headers with attribution guaranteed present.
 */
export function withAttribution(headers: Record<string, string | null> | undefined): Record<string, string | null> {
    const attribution = attributionHeaders()
    const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))
    const kept = Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))
    return { ...Object.fromEntries(kept), ...attribution }
}

/**
 * Wrap a catalog provider so every dispatch carries the header stack.
 * The model list is owned by the transport, not the catalog provider, so
 * `getModels` is replaced too.
 * @param gateway - the gateway being built.
 * @param profile - the resolved profile.
 * @param base - the catalog provider.
 * @param models - the merged model list this route advertises.
 * @returns the provider the transport dispatches through.
 */
function wrapProvider(
    gateway: GatewayDefinition,
    profile: GatewayProfile,
    base: Provider,
    models: readonly Model<Api>[],
): Provider {
    /**
     * Layer the session-routing and attribution headers onto one dispatch's
     * options. Generic in the options type so the result stays assignable to
     * the pi-ai stream signature it came from.
     */
    function headerised<T>(options: T): T {
        const routed = withSessionHeader(options as SessionHeaderedOptions | undefined)
        if (routed === undefined) return options
        return { ...(routed as object), headers: withAttribution(routed.headers) } as T
    }

    return {
        ...base,
        id: gateway.id,
        ...(profile.baseURL.length > 0 ? { baseUrl: profile.baseURL } : {}),
        getModels: () => models,
        stream(model, context, options) {
            return base.stream(model, context, headerised(options))
        },
        streamSimple(model, context, options) {
            return base.streamSimple(model, context, headerised(options))
        },
    }
}

/**
 * Build the real pi-ai-backed transport.
 * @param gateways - routes to serve.
 * @param profiles - initial resolved profiles.
 * @param factories - catalog factory table; an explicit table *replaces* the
 *   installed catalogs rather than extending them, so a caller can ask for a
 *   route with no catalog at all and see what production would do when pi-ai
 *   ships none.
 * @returns the mutable transport.
 */
export function createGatewayTransport(
    gateways: readonly GatewayDefinition[],
    profiles: ProviderSettings,
    factories?: Readonly<Record<string, CatalogProviderFactory>>,
): MutableGatewayTransport {
    const resolveFactory = (key: string): CatalogProviderFactory | undefined =>
        factories === undefined ? catalogProviderFactory(key) : factories[key]
    const routes = new Map<string, RouteState>()

    const rebuild = (gateway: GatewayDefinition, profile: GatewayProfile, live: LiveCatalog | undefined): RouteState => {
        const factory = resolveFactory(gateway.catalogProvider)
        if (factory === undefined) {
            // A gateway whose catalog this pi-ai build does not ship stays
            // registered (so a request fails loudly with UNKNOWN_MODEL rather
            // than NO_ADAPTER) but advertises nothing.
            return { profile, provider: undefined, installed: [], models: [], live, buildable: false }
        }
        const base = factory()
        const installed = base.getModels()
        const models = mergeCatalog({ gateway, profile, installed, ...(live !== undefined ? { live } : {}) })
        return { profile, provider: wrapProvider(gateway, profile, base, models), installed, models, live, buildable: true }
    }

    const install = (next: ProviderSettings): void => {
        for (const gateway of gateways) {
            const profile = resolveProfile(gateway, next[gateway.id])
            const current = routes.get(gateway.id)
            if (current !== undefined && sameProfile(current.profile, profile)) continue
            routes.set(gateway.id, rebuild(gateway, profile, current?.live))
        }
    }

    install(profiles)

    return {
        setProfiles: install,
        setCatalog: (route, live) => {
            const gateway = gateways.find((entry) => entry.id === route)
            if (gateway === undefined) return
            const current = routes.get(route)
            const profile = current?.profile ?? resolveProfile(gateway, profiles[route])
            routes.set(route, rebuild(gateway, profile, live))
        },
        installedModels: (route) => routes.get(route)?.installed ?? [],
        liveCatalog: (route) => routes.get(route)?.live,
        endpointOf: (route) => {
            const state = routes.get(route)
            if (state === undefined) return ''
            return state.profile.baseURL.length > 0 ? state.profile.baseURL : state.models[0]?.baseUrl ?? ''
        },
        listModels: (route) => routes.get(route)?.models ?? [],
        getModel: (route, modelId) => routes.get(route)?.models.find((model) => model.id === modelId),
        stream: (route, modelId, context, options) => {
            const state = routes.get(route)
            if (state === undefined || state.provider === undefined) {
                throw new LlmUnavailableError(`llm-provider does not serve route "${route}" in this build`)
            }
            const model = state.models.find((entry) => entry.id === modelId)
            if (model === undefined) {
                throw new LlmUnavailableError(`route "${route}" does not serve model "${modelId}"`)
            }
            return state.provider.streamSimple(model, context, options)
        },
    }
}

/** Raised by the transport when a route or model cannot be served at all. */
export class LlmUnavailableError extends Error {}

/** Field-wise profile comparison, so a no-op settings commit rebuilds nothing. */
function sameProfile(left: GatewayProfile, right: GatewayProfile): boolean {
    return (
        left.apiKeyEnv === right.apiKeyEnv &&
        left.baseURL === right.baseURL &&
        left.sessionRouting === right.sessionRouting &&
        left.reasoning === right.reasoning &&
        left.maxRequestImageBytes === right.maxRequestImageBytes &&
        left.requestImagePixelBudget === right.requestImagePixelBudget &&
        left.requestImageMaxBytes === right.requestImageMaxBytes &&
        left.models.length === right.models.length &&
        left.models.every((id, index) => id === right.models[index]) &&
        JSON.stringify(left.extraModels) === JSON.stringify(right.extraModels)
    )
}
