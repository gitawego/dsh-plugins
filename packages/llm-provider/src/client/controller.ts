/**
 * Card logic, deliberately outside React.
 *
 * Everything the card decides — what the route currently advertises, which
 * models the user pinned, whether a write is in flight, why the catalog read
 * failed — lives here as a plain object with an injected settings scope and an
 * injected discovery call. The React component only renders a snapshot and
 * forwards clicks, so the interesting behaviour is testable in Node with no
 * DOM, no browser, and no network.
 *
 * Two facts shape the design:
 *
 * 1. **The allowlist is a decision, not a filter.** An empty `models` list means
 *    "every model this provider serves"; a non-empty one means "exactly these".
 *    The card therefore shows both states honestly instead of pretending an
 *    empty list means none, and pinning is how the second state is entered.
 * 2. **Live data is a fetch, and fetches fail.** The catalog comes from the
 *    host's discovery offer, which reaches the provider endpoint and the
 *    models.dev dataset. The card keeps the last good list and reports the
 *    failure rather than emptying the screen.
 *
 * @module @gitawego/dsh-llm-provider/client/controller
 */

/** The subset of the settings scope this card uses. */
export interface SettingsScopeLike<T> {
    getSnapshot(): {
        status: 'loading' | 'ready' | 'unavailable'
        value: T | undefined
        writable: boolean
        revision: number | undefined
    }
    subscribe(listener: () => void): () => void
    mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** One path-addressed settings edit. */
export type SettingsPathOp =
    | { op: 'set'; path: string[]; value: unknown }
    | { op: 'unset'; path: string[] }

/** One model the host discovery reported. */
export interface DiscoveredModel {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
}

/** One gateway section inside the `llm-provider` namespace. */
export interface GatewaySection {
    apiKeyEnv?: string
    baseURL?: string
    models?: string[]
    sessionRouting?: boolean
    reasoning?: string
    maxRequestImageBytes?: number
    requestImagePixelBudget?: number
    requestImageMaxBytes?: number
}

/** The namespace value: one section per served route. */
export type ProviderSections = Record<string, GatewaySection | undefined>

/** How the last catalog read went. */
export type CatalogRead =
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'ready'; at: number; count: number }
    | { state: 'failed'; reason: string }

/** One row in the model list. */
export interface ModelRow {
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    /** Whether this route may use the model right now. */
    advertised: boolean
    /** Whether the user pinned it explicitly. */
    pinned: boolean
    /**
     * Whether the provider's live list still contains it. A pinned id the
     * provider dropped stays on screen — the stored allowlist is a decision the
     * user made, and silently hiding it would leave an unresolvable pin behind
     * the UI — but it is marked so the removal is obvious.
     */
    served: boolean
}

/** Everything the view renders. */
export interface CardSnapshot {
    /** Settings-namespace sync state. */
    status: 'loading' | 'ready' | 'unavailable'
    /** False when the host document refuses writes (memory mode, read-only). */
    writable: boolean
    /** Route this card edits. */
    route: string
    /** Effective endpoint. */
    endpoint: string
    /** Credential-reference name the route resolves. */
    credential: string
    /** Whether the required routing header is sent. */
    sessionRouting: boolean
    /** Whether the allowlist is empty (= every model is available). */
    advertisesAll: boolean
    /** Advertised models, pinned first, then the rest by id. */
    models: ModelRow[]
    /** How many models the route may use. */
    advertisedCount: number
    /** How many the provider serves. */
    servedCount: number
    /** Last catalog read. */
    catalog: CatalogRead
    /** Draft field values, keyed by field. */
    drafts: Readonly<Record<string, string>>
    /** Whether saving would write anything. */
    dirty: boolean
    /** A field draft that is not a value the schema accepts. */
    invalid: Readonly<Record<string, boolean>>
    saving: boolean
    /** A rejected or failed save. */
    saveFailed: boolean
    /** The namespace revision the last write was fenced against. */
    revision: number | undefined
}

/** Editable fields, and how their text maps to the stored value. */
export const FIELDS = {
    apiKeyEnv: { kind: 'text', path: 'apiKeyEnv' },
    baseURL: { kind: 'text', path: 'baseURL' },
    reasoning: { kind: 'enum', path: 'reasoning' },
    sessionRouting: { kind: 'boolean', path: 'sessionRouting' },
    maxRequestImageBytes: { kind: 'number', path: 'maxRequestImageBytes' },
    requestImagePixelBudget: { kind: 'number', path: 'requestImagePixelBudget' },
    requestImageMaxBytes: { kind: 'number', path: 'requestImageMaxBytes' },
} as const

/** Editable field names. */
export type FieldName = keyof typeof FIELDS

/** Reasoning levels the schema accepts, in display order. */
export const REASONING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Everything the controller needs. */
export interface CardOptions {
    /** Bound settings scope for the `llm-provider` namespace. */
    scope: SettingsScopeLike<ProviderSections>
    /** Ask the host to read the provider's model list. */
    discover: (route: string) => Promise<DiscoveredModel[]>
    /** Route this card edits. */
    route: string
    /** Clock, injectable for deterministic tests. */
    now?: () => number
}

/** The card's public surface. */
export interface ProviderCard {
    /** @returns the current immutable snapshot. */
    getSnapshot(): CardSnapshot
    /** @param listener - invoked after every snapshot change. */
    subscribe(listener: () => void): () => void
    /** Read the provider's model list now. */
    refresh(): Promise<void>
    /** Pin or unpin one model, writing the allowlist. */
    togglePin(modelId: string): Promise<void>
    /** Clear the allowlist, so the route serves every model again. */
    useAll(): Promise<void>
    /** Stage text for one configuration field. */
    edit(field: FieldName, text: string): void
    /** Drop every staged edit. */
    discard(): void
    /** Write every staged edit. */
    save(): Promise<void>
}

/**
 * Build the card controller.
 * @param options - scope, discovery, route, and clock.
 * @returns the controller.
 */
export function createProviderCard(options: CardOptions): ProviderCard {
    const now = options.now ?? Date.now
    const route = options.route
    const listeners = new Set<() => void>()
    /**
     * The memoized snapshot and what it was derived from.
     *
     * `useSyncExternalStore` compares snapshots by identity, so a `getSnapshot()`
     * that builds a fresh object on every call reads as "the store changed" on
     * every render and loops until React throws (#185, maximum update depth).
     * Invalidation is OURS, not the scope's: `publish()` marks the cache stale
     * (every mutation path calls it, as does the scope's own subscription), and
     * the namespace revision is a second signal for a change that arrived
     * without a notification. Depending on the scope's snapshot being a stable
     * reference would work against the real implementation and break against
     * any double that is not — the contract we must not rely on.
     */
    let cached: CardSnapshot | undefined
    let cachedRevision: number | undefined
    let stale = true
    let drafts = new Map<FieldName, string>()
    /** Discovered models, before the allowlist projection. */
    let models: Omit<ModelRow, 'advertised' | 'pinned' | 'served'>[] = []
    let catalog: CatalogRead = { state: 'idle' }
    let saving = false
    let saveFailed = false

    /** The resolved section for this route. */
    const section = (): GatewaySection => options.scope.getSnapshot().value?.[route] ?? {}

    /** The stored allowlist. */
    const allowlist = (): string[] => section().models ?? []

    /** Project the stored section + discovered models into rows. */
    const buildRows = (): ModelRow[] => {
        const pinned = new Set(allowlist())
        const advertisesAll = pinned.size === 0
        const served = new Set(models.map((model) => model.id))
        const rows: ModelRow[] = models.map((model) => ({
            ...model,
            pinned: pinned.has(model.id),
            advertised: advertisesAll || pinned.has(model.id),
            served: true,
        }))
        for (const id of [...pinned].filter((modelId) => !served.has(modelId)).sort()) {
            rows.push({ id, name: id, advertised: true, pinned: true, served: false })
        }
        return rows
    }

    const snapshot = (): CardSnapshot => {
        const raw = options.scope.getSnapshot()
        if (cached !== undefined && !stale && raw.revision === cachedRevision) return cached
        cachedRevision = raw.revision
        stale = false
        const current = section()
        const rows = buildRows()
        const pinnedCount = rows.filter((row) => row.pinned).length
        const invalid: Record<string, boolean> = {}
        for (const [field, text] of drafts) {
            const spec = FIELDS[field]
            if (spec.kind === 'number' && text.trim().length > 0 && !Number.isFinite(Number(text))) invalid[field] = true
            if (spec.kind === 'enum' && !(REASONING_LEVELS as readonly string[]).includes(text)) invalid[field] = true
        }
        cached = {
            status: raw.status,
            // A scope that is still loading reports `writable: false` before the
            // describe read lands; only a ready, explicitly read-only document
            // should disable the controls.
            writable: raw.status === 'ready' ? raw.writable === true : true,
            route,
            endpoint: current.baseURL ?? '',
            credential: current.apiKeyEnv ?? '',
            sessionRouting: current.sessionRouting ?? true,
            advertisesAll: pinnedCount === 0,
            models: rows,
            advertisedCount: pinnedCount === 0 ? rows.filter((row) => row.served).length : pinnedCount,
            servedCount: rows.length,
            catalog,
            drafts: Object.fromEntries(drafts),
            dirty: drafts.size > 0,
            invalid,
            saving,
            saveFailed,
            revision: raw.revision,
        }
        return cached
    }

    /** Announce a change: the next `getSnapshot()` recomputes once, then caches. */
    const publish = (): void => {
        stale = true
        for (const listener of listeners) listener()
    }

    const write = async (ops: readonly SettingsPathOp[]): Promise<void> => {
        saving = true
        saveFailed = false
        publish()
        try {
            await options.scope.mutate(ops, options.scope.getSnapshot().revision)
        } catch {
            saveFailed = true
        } finally {
            saving = false
            publish()
        }
    }

    options.scope.subscribe(() => publish())

    return {
        getSnapshot: snapshot,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        async refresh() {
            catalog = { state: 'loading' }
            publish()
            try {
                const discovered = await options.discover(route)
                models = discovered
                    .map((model) => ({
                        id: model.id,
                        name: model.name ?? model.id,
                        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
                        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
                    }))
                    .sort((left, right) => left.id.localeCompare(right.id))
                catalog = { state: 'ready', at: now(), count: models.length }
            } catch (error) {
                // Keep the previous list: a failed read is a freshness problem,
                // not a reason to claim the route serves nothing.
                catalog = { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
            }
            publish()
        },
        async togglePin(modelId) {
            const pinned = new Set(allowlist())
            if (pinned.has(modelId)) pinned.delete(modelId)
            else pinned.add(modelId)
            const next = [...pinned]
            await write([{ op: 'set', path: [route, 'models'], value: next }])
            // Reflect the write locally at once: the namespace commit is
            // asynchronous, and a pin that appears to do nothing reads as broken.
            models = models.map((model) => ({ ...model, pinned: next.includes(model.id) }))
            publish()
        },
        async useAll() {
            await write([{ op: 'unset', path: [route, 'models'] }])
            models = models.map((model) => ({ ...model, pinned: false }))
            publish()
        },
        edit(field, text) {
            drafts.set(field, text)
            publish()
        },
        discard() {
            drafts = new Map()
            saveFailed = false
            publish()
        },
        async save() {
            if (drafts.size === 0) return
            const ops: SettingsPathOp[] = []
            for (const [field, text] of drafts) {
                const spec = FIELDS[field]
                const trimmed = text.trim()
                if (spec.kind === 'text') ops.push({ op: 'set', path: [route, spec.path], value: trimmed })
                else if (spec.kind === 'enum') ops.push({ op: 'set', path: [route, spec.path], value: trimmed })
                else if (spec.kind === 'boolean') ops.push({ op: 'set', path: [route, spec.path], value: trimmed === 'true' })
                else if (trimmed.length === 0) ops.push({ op: 'unset', path: [route, spec.path] })
                else ops.push({ op: 'set', path: [route, spec.path], value: Number(trimmed) })
            }
            await write(ops)
            // A rejected write keeps the drafts so the user can fix them.
            if (!saveFailed) drafts = new Map()
            publish()
        },
    }
}
