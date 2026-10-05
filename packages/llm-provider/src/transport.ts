/**
 * The pi-ai-backed transport behind the plugin's routes.
 *
 * One route is one pi-ai `Provider` built from its installed catalog, with the
 * profile applied (endpoint override, model allowlist) and the two things the
 * harness requires on every dispatch layered on:
 *
 * 1. **Attribution** — `attributionHeaders()` merged into every request, last,
 *    so a profile cannot shadow the product identity. pi-ai's `headers`
 *    request option is the wire hook.
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
 * @module @gitawego/dsh-llm-provider/transport
 */
import type {
    AssistantMessageEventStream,
    Context as PiContext,
    Model,
    Api,
    Provider,
    SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogProviderFactory, type CatalogProviderFactory } from './catalog.ts'
import {
    DEFAULT_API,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_TOKENS,
    resolveProfile,
    type GatewayProfile,
    type ProviderSettings,
} from './config.ts'
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
     * Models one route currently advertises, in catalog order and already
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

/** A transport whose profiles can follow the settings document. */
export interface MutableGatewayTransport extends GatewayTransport {
    /**
     * Install a new resolved profile set and rebuild only the routes whose
     * profile actually changed. Rebuilding is cheap (catalog objects are static
     * data) and keeps each request's options a pure function of one profile.
     * @param profiles - resolved profiles keyed by route.
     */
    setProfiles(profiles: ProviderSettings): void
}

/** One route's built state. */
interface RouteState {
    profile: GatewayProfile
    provider: Provider
    models: readonly Model<Api>[]
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
 * The wire protocols a profile-declared model may name. Anything else is
 * dropped from the catalog: pi-ai would have no implementation for it, and a
 * route that advertises an unusable model is worse than one that reports
 * `UNKNOWN_MODEL` for it.
 */
const DECLARABLE_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** Zero cost: the harness never reports spend from these routes. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * Merge a profile's declared models into a route's catalog.
 *
 * A declared id the catalog already describes is corrected field by field —
 * the catalog stays the base, so an undeclared field keeps its surveyed value.
 * A declared id the catalog does not describe is built from the profile's
 * defaults, which is what lets a route serve a model released after this
 * pi-ai build.
 *
 * The profile's `models` allowlist narrows the CATALOG; declared models are
 * always advertised, because declaring one is itself the decision to serve it.
 * @param catalog - the installed catalog's models.
 * @param profile - the resolved profile.
 * @param gateway - the gateway being built.
 * @returns the advertised model list, catalog order first.
 */
export function mergeModels(
    catalog: readonly Model<Api>[],
    profile: GatewayProfile,
    gateway: GatewayDefinition,
): Model<Api>[] {
    const allowed = profile.models.length === 0 ? undefined : new Set(profile.models)
    const merged = new Map<string, Model<Api>>()
    for (const model of catalog) {
        if (allowed !== undefined && !allowed.has(model.id)) continue
        merged.set(model.id, model)
    }
    for (const declared of profile.extraModels) {
        const api = declared.api ?? DEFAULT_API
        if (!(DECLARABLE_APIS as readonly string[]).includes(api)) continue
        const base = merged.get(declared.id)
        const endpoint = declared.baseURL ?? profile.baseURL ?? base?.baseUrl ?? gateway.baseURL
        merged.set(declared.id, {
            id: declared.id,
            name: declared.name ?? base?.name ?? declared.id,
            api: (declared.api ?? base?.api ?? DEFAULT_API) as Api,
            provider: gateway.id,
            baseUrl: endpoint,
            reasoning: declared.reasoning ?? base?.reasoning ?? false,
            input: declared.input ?? base?.input ?? ['text'],
            cost: base?.cost ?? { ...NO_COST },
            contextWindow: declared.contextWindow ?? base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: declared.maxTokens ?? base?.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(base?.compat !== undefined ? { compat: base.compat } : {}),
        } as Model<Api>)
    }
    return [...merged.values()].map((model) => ({
        ...model,
        // The route key is what a request names, so it is what the model must
        // carry: pi-ai dispatches on `model.provider`.
        provider: gateway.id,
        ...(profile.baseURL.length > 0 ? { baseUrl: profile.baseURL } : {}),
    }))
}

/**
 * Apply a profile to a catalog provider: endpoint override, model allowlist,
 * model provider id, and the per-dispatch header stack.
 * @param gateway - the gateway being built.
 * @param base - the catalog provider.
 * @param profile - the resolved profile.
 * @returns the provider the transport dispatches through, plus its models.
 */
function applyProfile(
    gateway: GatewayDefinition,
    base: Provider,
    profile: GatewayProfile,
): { provider: Provider; models: readonly Model<Api>[] } {
    const models = mergeModels(base.getModels(), profile, gateway)

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

    const provider: Provider = {
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
    return { provider, models }
}

/**
 * Build the real pi-ai-backed transport.
 * @param gateways - routes to serve.
 * @param profiles - initial resolved profiles.
 * @param factories - catalog factory table; injectable for tests.
 * @returns the mutable transport.
 */
export function createGatewayTransport(
    gateways: readonly GatewayDefinition[],
    profiles: ProviderSettings,
    factories?: Readonly<Record<string, CatalogProviderFactory>>,
): MutableGatewayTransport {
    // An explicit table REPLACES the installed catalogs rather than extending
    // them, so a caller (a test, a probe) can ask for a route with no catalog
    // at all and see exactly what production would do when pi-ai ships none.
    const resolveFactory = (key: string): CatalogProviderFactory | undefined =>
        factories === undefined ? catalogProviderFactory(key) : factories[key]
    const routes = new Map<string, RouteState>()

    const rebuild = (gateway: GatewayDefinition, profile: GatewayProfile): RouteState => {
        const factory = resolveFactory(gateway.catalogProvider)
        if (factory === undefined) {
            // A gateway whose catalog this pi-ai build does not ship stays
            // registered (so a request fails loudly with UNKNOWN_MODEL rather
            // than NO_ADAPTER) but advertises nothing.
            return { profile, provider: undefined as never, models: [], buildable: false }
        }
        const base = factory()
        const { provider, models } = applyProfile(gateway, base, profile)
        return { profile, provider, models, buildable: true }
    }

    const install = (next: ProviderSettings): void => {
        for (const gateway of gateways) {
            const profile = resolveProfile(gateway, next[gateway.id])
            const current = routes.get(gateway.id)
            if (current !== undefined && sameProfile(current.profile, profile)) continue
            routes.set(gateway.id, rebuild(gateway, profile))
        }
    }

    install(profiles)

    return {
        setProfiles: install,
        listModels: (route) => routes.get(route)?.models ?? [],
        getModel: (route, modelId) => routes.get(route)?.models.find((model) => model.id === modelId),
        stream: (route, modelId, context, options) => {
            const state = routes.get(route)
            if (state === undefined || !state.buildable) {
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
