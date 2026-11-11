/**
 * The dashboard's single read: what the provider serves, what the harness
 * knows, and what is missing between the two.
 *
 * Everything here is metadata. No model request is built, no credential is
 * forwarded to a conversation, and nothing in this module can change routing:
 * the host adapter owns the route, and this module only asks two read-only
 * questions — the gateway's `GET /models`, and the host's own catalog through
 * `ctx.llm.listModels(route)`.
 *
 * That comparison is the feature. pi-ai's catalog ships with the host, so a
 * model the gateway started serving after that build is invisible to the model
 * picker even though the endpoint accepts it. The difference between the two
 * lists is exactly the set a user has to declare in
 * `llm-pi-ai.providers.<route>.models`, and {@link modelsSnippet} prints that
 * block ready to paste.
 *
 * @module @gitawego/dsh-llm-provider/status
 */
import { fetchModelIds } from './gateway-api.ts'
import type { FetchLike } from './models-dev.ts'
import type { ModelMetadata } from './models-dev.ts'

/** One model row: the union of what the gateway serves and what the harness knows. */
export interface ProviderModelRow {
    /** Request id. */
    id: string
    /** Display name: models.dev's, the catalog's, or the id. */
    name: string
    /** Whether the installed pi-ai catalog describes this id. */
    known: boolean
    /** Whether the gateway currently lists this id. */
    live: boolean
    /** Exact context capacity in tokens, when disclosed. */
    contextWindow?: number
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number
    /** Input modalities, when disclosed. */
    input?: readonly ('text' | 'image')[]
    /** Whether the model exposes reasoning at all. */
    reasoning?: boolean
}

/** One route's dashboard state. */
export interface ProviderStatus {
    /** Host route reported on. */
    route: string
    /** Endpoint that answered the reporting calls. */
    endpoint: string
    /** Credential-reference name the reporting calls resolve. */
    credential: string
    /** False when the reference resolves to nothing; quota then explains why. */
    credentialPresent: boolean
    /** Every row, pinned-first order: known and live, then live-only. */
    models: ProviderModelRow[]
    /** How many ids the gateway listed. */
    servedCount: number
    /** How many ids the harness catalog describes. */
    knownCount: number
    /** Ids the gateway serves that the installed catalog does not describe. */
    unknownIds: string[]
    /** When this read happened (epoch ms). */
    fetchedAt: number
    /** Why the live half is empty, when the gateway could not be read. */
    error?: string
}

/** One catalog entry as the host advertises it. */
export interface CatalogModel {
    id: string
    name?: string
}

/** Inputs to a pure status composition. */
export interface StatusInput {
    route: string
    endpoint: string
    credential: string
    /** Resolved credential value; absent when the reference holds nothing. */
    apiKey: string | undefined
    /** What the host advertises for the route. */
    knownModels: readonly CatalogModel[]
    /** Ids the gateway listed; empty when it could not be read. */
    liveIds: readonly string[]
    /** models.dev metadata, keyed by id. */
    metadata: ReadonlyMap<string, ModelMetadata>
    /** When the read happened. */
    fetchedAt: number
    /** Why the live half is empty, when it is. */
    error?: string
}

/**
 * Compose one status from already-fetched parts.
 *
 * Kept pure so the merge rules — which name wins, which flags are set, the row
 * order — are testable without a network, a credential store, or a context.
 * @param input - the fetched parts.
 * @returns the composed status.
 */
export function composeStatus(input: StatusInput): ProviderStatus {
    const known = new Map(input.knownModels.map((model) => [model.id, model]))
    const live = new Set(input.liveIds)
    const ids = [...new Set([...known.keys(), ...live])]
    const rows = ids.map((id): ProviderModelRow => {
        const meta = input.metadata.get(id)
        const catalogName = known.get(id)?.name
        return {
            id,
            name: (meta?.name ?? catalogName ?? id).trim() || id,
            known: known.has(id),
            live: live.has(id),
            ...(meta?.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
            ...(meta?.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
            ...(meta?.input !== undefined && meta.input.length > 0 ? { input: [...meta.input] } : {}),
            ...(meta !== undefined ? { reasoning: meta.reasoning } : {}),
        }
    })
    // Known ids first (what the picker already offers), then gateway-only ids,
    // each sorted so two reads of the same state render identically.
    rows.sort((left, right) => Number(right.known) - Number(left.known) || left.id.localeCompare(right.id))
    const unknownIds = rows.filter((row) => !row.known).map((row) => row.id)
    return {
        route: input.route,
        endpoint: input.endpoint,
        credential: input.credential,
        credentialPresent: input.apiKey !== undefined,
        models: rows,
        servedCount: live.size,
        knownCount: known.size,
        unknownIds,
        fetchedAt: input.fetchedAt,
        ...(input.error !== undefined ? { error: input.error } : {}),
    }
}

/** Fetchers the read needs, injectable so tests never touch the network. */
export interface StatusReaderDeps {
    /** Fetch the gateway's model ids. */
    fetchIds: (options: { baseURL: string; apiKey?: string; fetch?: FetchLike; signal?: AbortSignal }) => Promise<string[]>
    /** Fetch models.dev metadata. */
    fetchMetadata: (options: { signal?: AbortSignal }) => Promise<ReadonlyMap<string, ModelMetadata>>
    /** The host's catalog for one route. */
    knownModels: (route: string) => Promise<readonly CatalogModel[]>
}

/** Options for one read. */
export interface ReadStatusOptions {
    route: string
    endpoint: string
    credential: string
    apiKey: string | undefined
    signal?: AbortSignal
    /** Override the fetchers (tests). */
    deps?: Partial<StatusReaderDeps>
}

/**
 * Read one route's status.
 *
 * The two remote halves run together, and each fails independently: a
 * models.dev outage still leaves the host catalog and the gateway list, and an
 * unreachable gateway still leaves the catalog. A failure is reported as
 * `error`, never thrown, because a dashboard that cannot read is still a
 * dashboard.
 * @param options - route, endpoint, credential, and cancellation.
 * @returns the composed status.
 */
export async function readStatus(options: ReadStatusOptions): Promise<ProviderStatus> {
    const deps: StatusReaderDeps = {
        fetchIds: async (call) => fetchModelIds(call),
        fetchMetadata: async () => new Map(),
        knownModels: async () => [],
        ...options.deps,
    }
    const readIds = deps.fetchIds({
        baseURL: options.endpoint,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    const readMetadata = deps.fetchMetadata({ ...(options.signal !== undefined ? { signal: options.signal } : {}) }).catch(
        () => new Map<string, ModelMetadata>(),
    )
    const readKnown = Promise.resolve()
        .then(() => deps.knownModels(options.route))
        .catch(() => [] as readonly CatalogModel[])

    const [liveIds, metadata, knownModels] = await Promise.all([readIds, readMetadata, readKnown])
    const credentialPresent = options.apiKey !== undefined
    return composeStatus({
        route: options.route,
        endpoint: options.endpoint,
        credential: options.credential,
        apiKey: options.apiKey,
        knownModels,
        liveIds,
        metadata,
        fetchedAt: Date.now(),
        ...(liveIds.length === 0 ? { error: credentialPresent ? 'the gateway listed no models' : 'no credential resolved' } : {}),
    })
}

/**
 * Render the `models:` block a user pastes into `llm-pi-ai.providers.<route>`.
 *
 * A declared entry replaces the route's served catalog rather than extending
 * it, so the block spells out **every** id the route should offer: the ones the
 * installed catalog already knows, plus the gateway-only ones with the capacity
 * models.dev discloses (an entry with no capacity would fall back to the
 * profile defaults, which is rarely what a new model wants).
 * @param status - the read status.
 * @returns YAML lines, indented for `providers.<route>.models`.
 */
export function modelsSnippet(status: ProviderStatus): string[] {
    // A catalog-only id cannot be made selectable by declaring it; the override
    // block must list only ids the endpoint actually serves.
    const rows = status.models.filter((row) => row.live)
    if (rows.length === 0) return ['# the provider listed no served models; refresh to generate this block']
    const lines = [`    models:`]
    for (const row of rows) {
        lines.push(`      - id: ${row.id}`)
        if (row.contextWindow !== undefined) lines.push(`        contextWindow: ${row.contextWindow}`)
        if (row.maxTokens !== undefined) lines.push(`        maxTokens: ${row.maxTokens}`)
        if (row.input !== undefined && row.input.length > 0) lines.push(`        input: [${row.input.join(', ')}]`)
        if (row.reasoning === true) lines.push('        reasoning: true')
    }
    return lines
}
