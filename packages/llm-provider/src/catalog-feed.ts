/**
 * Building a route's model list from three sources, and keeping it fresh.
 *
 * A route's catalog is the merge of:
 *
 * 1. **the installed pi-ai catalog** — offline baseline, with compat switches,
 *    costs, and capacities surveyed at pi-ai's release;
 * 2. **the gateway's live id list** (`GET {baseURL}/models`) — which ids this
 *    credential can actually call *now*, including models released after the
 *    pi-ai build;
 * 3. **models.dev metadata** — capacities, output caps, thinking levels, and
 *    cost for ids the installed catalog has never heard of;
 *
 * with the profile's own declarations layered on top as explicit intent.
 *
 * Precedence per field is declared → live metadata → installed catalog →
 * built-in default, and the merge is deliberately *additive and never
 * destructive*: a failed live fetch leaves the installed catalog serving, so a
 * gateway that is down degrades freshness rather than availability.
 *
 * @module @gitawego/dsh-llm-provider/catalog-feed
 */
import type { Api, Model, ModelCost, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { DEFAULT_API, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, type GatewayProfile, type ModelDeclaration, type ProviderSettings } from './config.ts'
import { protocolFor, type GatewayDefinition } from './gateways.ts'
import { fetchModelIds, type GatewayCallOptions } from './gateway-api.ts'
import { fetchModelsDevCatalog, type FetchLike, type ModelMetadata } from './models-dev.ts'

/** The live inputs one route's catalog can be enriched with. */
export interface LiveCatalog {
    /** Model ids the gateway reports; empty when the fetch failed or is pending. */
    ids: readonly string[]
    /** Metadata by model id, from models.dev. */
    metadata: ReadonlyMap<string, ModelMetadata>
    /** When the ids were fetched (epoch ms). */
    fetchedAt: number
    /** Why the id list is empty, when it is. */
    error?: string
}

/** Zero cost, for a model no source prices. */
const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The pi-ai levels `thinkingLevelMap` can carry, in pi-ai's own order. */
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Translate models.dev's effort list into pi-ai's `thinkingLevelMap`.
 *
 * pi-ai decides which levels a model offers from this map: a level mapped to
 * `null` is unsupported, and `xhigh`/`max` count only when they carry an
 * explicit non-null value. The value is the provider's own spelling of the
 * level, and every gateway here speaks the standard names, so the mapping is
 * the identity — spelled out rather than implied, because a provider with its
 * own vocabulary would need a real table here.
 * @param effort - selectable levels as models.dev spells them.
 * @returns the map pi-ai reads, or undefined when the model declares no levels.
 */
export function thinkingLevelMapFor(effort: readonly string[] | undefined): ThinkingLevelMap | undefined {
    if (effort === undefined || effort.length === 0) return undefined
    const map: ThinkingLevelMap = {}
    for (const level of EFFORT_LEVELS) map[level] = effort.includes(level) ? level : null
    // `off` is left unmapped on purpose: pi-ai treats an unmapped level as
    // available, and for a reasoning model `off` means "omit the effort", which
    // is the provider's own default rather than a level anyone maps.
    return map
}

/** Inputs for one merge. */
export interface CatalogInputs {
    /** Gateway serving the route. */
    gateway: GatewayDefinition
    /** The route's resolved profile. */
    profile: GatewayProfile
    /** The installed pi-ai catalog for the route. */
    installed: readonly Model<Api>[]
    /** Live inputs, when a fetch has succeeded. */
    live?: LiveCatalog | undefined
}

/** Index the installed catalog by id. */
function indexById(models: readonly Model<Api>[]): Map<string, Model<Api>> {
    const index = new Map<string, Model<Api>>()
    for (const model of models) index.set(model.id, model)
    return index
}

/**
 * Index installed models by dataset family, so a model pi-ai has never seen can
 * inherit the compat switches and protocol of its nearest surveyed relative.
 * @param installed - the installed catalog.
 * @param metadata - models.dev metadata (the only source of `family`).
 * @returns family to the first installed model of that family.
 */
function indexByFamily(installed: readonly Model<Api>[], metadata: ReadonlyMap<string, ModelMetadata>): Map<string, Model<Api>> {
    const index = new Map<string, Model<Api>>()
    for (const model of installed) {
        const family = metadata.get(model.id)?.family
        if (family === undefined || index.has(family)) continue
        index.set(family, model)
    }
    return index
}

/** Resolve the wire protocol for one model id. */
function apiFor(
    gateway: GatewayDefinition,
    id: string,
    declared: ModelDeclaration | undefined,
    installed: Model<Api> | undefined,
    familyBase: Model<Api> | undefined,
): string {
    return declared?.api ?? installed?.api ?? familyBase?.api ?? protocolFor(gateway, id) ?? DEFAULT_API
}

/** Resolve the advertised model id set: live ∪ installed ∪ declared, allowlist applied. */
function idSet(inputs: CatalogInputs, installed: Map<string, Model<Api>>): string[] {
    const live = inputs.live?.ids ?? []
    const declared = inputs.profile.extraModels
    const allowlist = inputs.profile.models.length === 0 ? undefined : new Set(inputs.profile.models)
    const ids = new Set<string>()
    for (const id of [...installed.keys(), ...live]) {
        if (allowlist !== undefined && !allowlist.has(id)) continue
        ids.add(id)
    }
    // Declaring a model is itself the decision to serve it, so an allowlist
    // never filters declarations out.
    for (const declaration of declared) ids.add(declaration.id)
    return [...ids]
}

/**
 * Merge the sources into one route catalog.
 *
 * The result always has at least the installed catalog when nothing else is
 * available, and always carries the route's provider id — pi-ai dispatches on
 * `model.provider`, so a model built here must be addressable by the route a
 * request names.
 * @param inputs - gateway, profile, installed catalog, and live inputs.
 * @returns the advertised models, installed-catalog order first.
 */
export function mergeCatalog(inputs: CatalogInputs): Model<Api>[] {
    const { gateway, profile, live } = inputs
    const installed = indexById(inputs.installed)
    const metadata = live?.metadata ?? new Map<string, ModelMetadata>()
    const families = indexByFamily(inputs.installed, metadata)
    const declared = new Map(profile.extraModels.map((entry) => [entry.id, entry]))

    return idSet(inputs, installed).map((id) => {
        const base = installed.get(id)
        const meta = metadata.get(id)
        const declaration = declared.get(id)
        const familyBase = meta?.family !== undefined ? families.get(meta.family) : undefined
        const api = apiFor(gateway, id, declaration, base, familyBase)
        const reasoning = declaration?.reasoning ?? meta?.reasoning ?? base?.reasoning ?? false
        const levelMap = reasoning
            ? (thinkingLevelMapFor(meta?.options?.effort) ?? base?.thinkingLevelMap)
            : undefined
        const cost = meta?.cost !== undefined && (meta.cost.input > 0 || meta.cost.output > 0)
            ? { ...meta.cost }
            : (base?.cost ?? NO_COST)
        // Compat is only knowable from a surveyed model: exact match first, then
        // the nearest relative by dataset family. Without one, pi-ai's own
        // URL-based detection decides, which is the right default for a model
        // nobody has surveyed.
        const compat = base?.compat ?? familyBase?.compat
        return {
            id,
            name: declaration?.name ?? meta?.name ?? base?.name ?? id,
            api: api as Api,
            provider: gateway.id,
            baseUrl: declaration?.baseURL ?? (profile.baseURL.length > 0 ? profile.baseURL : (base?.baseUrl ?? gateway.baseURL)),
            reasoning,
            ...(levelMap !== undefined ? { thinkingLevelMap: levelMap } : {}),
            input: declaration?.input ?? meta?.input ?? base?.input ?? ['text'],
            cost,
            contextWindow: declaration?.contextWindow ?? meta?.contextWindow ?? base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: declaration?.maxTokens ?? meta?.maxTokens ?? base?.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(compat !== undefined ? { compat } : {}),
        } as Model<Api>
    })
}

/** One route's catalog snapshot, as reported to a human- or model-facing surface. */
export interface RouteCatalogSnapshot {
    route: string
    /** Number of advertised models. */
    modelCount: number
    /** Ids the gateway itself reported, when the live fetch succeeded. */
    liveCount: number
    /** Ids only the live fetch knows about — the point of the refresh. */
    discovered: string[]
    /** Whether models.dev metadata was available. */
    metadataLoaded: boolean
    fetchedAt: number
    /** Why the live list is missing, when it is. */
    error?: string
}

/** The live-catalog owner: fetches, merges, and reports. */
export interface CatalogFeed {
    /**
     * Fetch the gateway's id list and the metadata dataset, then install the
     * merged catalog for `route`.
     * @param route - route to refresh; every served route when omitted.
     * @param signal - caller cancellation.
     * @returns one snapshot per refreshed route.
     */
    refresh(route?: string, signal?: AbortSignal): Promise<RouteCatalogSnapshot[]>
    /**
     * Read the last snapshot without fetching.
     * @param route - route to describe.
     * @returns the snapshot, or undefined before the first refresh.
     */
    snapshot(route: string): RouteCatalogSnapshot | undefined
    /** Every route's last snapshot, in gateway order. */
    snapshots(): RouteCatalogSnapshot[]
}

/** Everything the feed needs from the plugin's composition. */
export interface CatalogFeedOptions {
    /** Routes to refresh. */
    gateways: readonly GatewayDefinition[]
    /** The route's current profile (endpoint override + allowlist + declarations). */
    profileOf: (route: string) => GatewayProfile
    /** Resolve the route's credential through the harness seam. */
    resolveApiKey: (route: string) => Promise<string | undefined>
    /** Installed catalog for a route, before any live merge. */
    installedModels: (route: string) => readonly Model<Api>[]
    /** Install a freshly fetched live catalog for a route. */
    apply: (route: string, live: LiveCatalog) => void
    /** Fetch implementation; defaults to the global `fetch`. */
    fetch?: FetchLike
    /** Clock, injectable for deterministic tests. */
    now?: () => number
}

/**
 * Build the feed.
 *
 * The metadata dataset is fetched once per refresh pass and shared by every
 * route, because it is one public document describing every provider; the
 * per-route call is only the id list.
 * @param options - composition accessors and injection points.
 * @returns the feed.
 */
export function createCatalogFeed(options: CatalogFeedOptions): CatalogFeed {
    const now = options.now ?? Date.now
    const snapshots = new Map<string, RouteCatalogSnapshot>()
    const targets = (route?: string): GatewayDefinition[] =>
        route === undefined ? [...options.gateways] : options.gateways.filter((gateway) => gateway.id === route)

    const refreshOne = async (gateway: GatewayDefinition, metadata: ReadonlyMap<string, ModelMetadata>, signal?: AbortSignal): Promise<RouteCatalogSnapshot> => {
        const profile = options.profileOf(gateway.id)
        const apiKey = await options.resolveApiKey(gateway.id)
        const call: GatewayCallOptions = {
            baseURL: profile.baseURL.length > 0 ? profile.baseURL : gateway.baseURL,
            ...(apiKey !== undefined ? { apiKey } : {}),
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            ...(signal !== undefined ? { signal } : {}),
        }
        const ids = await fetchModelIds(call)
        const fetchedAt = now()
        const installedIds = new Set(options.installedModels(gateway.id).map((model) => model.id))
        const discovered = ids.filter((id) => !installedIds.has(id))
        if (ids.length > 0) options.apply(gateway.id, { ids, metadata, fetchedAt })
        const snapshot: RouteCatalogSnapshot = {
            route: gateway.id,
            modelCount: ids.length > 0 ? new Set([...ids, ...installedIds, ...profile.extraModels.map((entry) => entry.id)]).size : installedIds.size,
            liveCount: ids.length,
            discovered,
            metadataLoaded: metadata.size > 0,
            fetchedAt,
            ...(ids.length === 0 ? { error: 'the gateway model list could not be read; serving the installed catalog' } : {}),
        }
        snapshots.set(gateway.id, snapshot)
        return snapshot
    }

    return {
        snapshot: (route) => snapshots.get(route),
        snapshots: () => options.gateways.flatMap((gateway) => snapshots.get(gateway.id) ?? []),
        async refresh(route, signal) {
            const routes = targets(route)
            if (routes.length === 0) return []
            const metadata = await fetchModelsDevCatalog({
                ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
                ...(signal !== undefined ? { signal } : {}),
            })
            const out: RouteCatalogSnapshot[] = []
            for (const gateway of routes) out.push(await refreshOne(gateway, metadata, signal))
            return out
        },
    }
}
