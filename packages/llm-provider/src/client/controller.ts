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

/** The API key control's state. The literal never appears here — only the user's own typing. */
export interface ApiKeyState {
    /** Reference name the route resolves, from the profile. */
    reference: string
    /** Whether the credential store holds a value for that reference; undefined until it answers. */
    configured: boolean | undefined
    /** The key being typed. Blank means "write nothing", never "clear the stored key". */
    draft: string
    saving: boolean
    /** The last write succeeded. */
    saved: boolean
    /** Why the last write was refused or failed. */
    error: string | undefined
}

/** The model-picker dialog's state. */
export interface PickerState {
    /** Whether the dialog is open. */
    open: boolean
    /** Ids checked in the dialog. Seeded from the effective allowlist. */
    selected: readonly string[]
    /** Number of models the provider serves. */
    served: number
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
    /** Every model the provider serves, pinned first, then the rest by id. */
    models: ModelRow[]
    /** Only the models this route may use — what the card lists. */
    advertisedModels: ModelRow[]
    /** Models the provider serves that this route may not use. */
    withheldCount: number
    /** The picker dialog. */
    picker: PickerState
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
    /** The API key control. */
    apiKey: ApiKeyState
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
    /**
     * Whether the credential store holds a value for one reference.
     *
     * The literal key belongs in the credential store, not in `settings.yaml`:
     * a settings document is portable (it gets copied between machines and
     * pasted into issues) and the host's own provider forms write keys through
     * the credentials domain for exactly that reason. The reference name is the
     * only part this card stores.
     */
    describeCredential: (reference: string) => Promise<boolean>
    /** Store a literal key under one reference, through the credentials domain. */
    writeCredential: (reference: string, value: string) => Promise<void>
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
    /** Open the model picker, seeded from the effective allowlist. */
    openPicker(): void
    /** Close the model picker without writing. */
    closePicker(): void
    /** Check or uncheck one model in the picker. */
    togglePickerModel(modelId: string): void
    /** Check every served model in the picker. */
    selectAllModels(): void
    /** Uncheck every model in the picker. */
    clearSelection(): void
    /** Write the picker's selection as the allowlist. */
    applyPicker(): Promise<void>
    /** Drop every staged edit. */
    discard(): void
    /** Write every staged edit. */
    save(): Promise<void>
    /** Stage a key to store. Blank stages nothing. */
    editApiKey(text: string): void
    /** Store the staged key under the profile's credential reference. */
    saveApiKey(): Promise<void>
    /** Ask the credential store whether the reference is configured. */
    refreshApiKey(): Promise<void>
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
    let keyDraft = ''
    let keyConfigured: boolean | undefined
    let keySaving = false
    let keySaved = false
    let keyError: string | undefined
    let pickerOpen = false
    let pickerDraft = new Set<string>()

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
        const advertisedRows = rows.filter((row) => row.advertised)
        const invalid: Record<string, boolean> = {}
        for (const [field, text] of drafts) {
            const spec = FIELDS[field]
            if (spec.kind === 'number' && text.trim().length > 0 && !Number.isFinite(Number(text))) invalid[field] = true
            if (spec.kind === 'enum' && !(REASONING_LEVELS as readonly string[]).includes(text)) invalid[field] = true
        }
        cached = {
            apiKey: {
                reference: current.apiKeyEnv ?? '',
                configured: keyConfigured,
                draft: keyDraft,
                saving: keySaving,
                saved: keySaved,
                error: keyError,
            },
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
            advertisedModels: advertisedRows,
            withheldCount: rows.length - advertisedRows.length,
            picker: { open: pickerOpen, selected: [...pickerDraft].sort(), served: rows.length },
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

    /** Ask the store about one reference, ignoring a reply for a reference we have left. */
    const refreshKey = async (reference: string): Promise<void> => {
        if (reference.length === 0) {
            keyConfigured = undefined
            return
        }
        try {
            const configured = await options.describeCredential(reference)
            if ((section().apiKeyEnv?.trim() ?? '') !== reference) return
            keyConfigured = configured
        } catch {
            // An unreachable credential store is "unknown", not "absent": the
            // field stays quiet rather than claiming a key is missing.
            keyConfigured = undefined
        }
        publish()
    }

    options.scope.subscribe(() => publish())
    void refreshKey(section().apiKeyEnv?.trim() ?? '')

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
        openPicker() {
            // Seeded from the EFFECTIVE allowlist: with nothing pinned every
            // served model is allowed, so every box starts checked. A picker
            // that opened empty would misrepresent the current state and turn
            // one Apply into an accidental narrowing.
            const pinned = allowlist()
            pickerDraft = new Set(pinned.length > 0 ? pinned : models.map((model) => model.id))
            pickerOpen = true
            publish()
        },
        closePicker() {
            pickerOpen = false
            publish()
        },
        togglePickerModel(modelId) {
            if (pickerDraft.has(modelId)) pickerDraft.delete(modelId)
            else pickerDraft.add(modelId)
            publish()
        },
        selectAllModels() {
            pickerDraft = new Set(models.map((model) => model.id))
            publish()
        },
        clearSelection() {
            pickerDraft = new Set()
            publish()
        },
        async applyPicker() {
            const served = models.map((model) => model.id)
            const selected = [...pickerDraft].sort()
            // Selecting everything is the same statement as "nothing pinned", so
            // write it that way: the document stays minimal and the route keeps
            // following the provider as it adds models.
            const coversAll = served.length > 0 && served.every((id) => pickerDraft.has(id))
            if (coversAll) await write([{ op: 'unset', path: [route, 'models'] }])
            else await write([{ op: 'set', path: [route, 'models'], value: selected }])
            if (!saveFailed) {
                models = models.map((model) => ({ ...model, pinned: !coversAll && pickerDraft.has(model.id) }))
                pickerOpen = false
            }
            publish()
        },
        async useAll() {
            await write([{ op: 'unset', path: [route, 'models'] }])
            models = models.map((model) => ({ ...model, pinned: false }))
            publish()
        },
        edit(field, text) {
            drafts.set(field, text)
            if (field === 'apiKeyEnv') void refreshKey(text.trim())
            publish()
        },
        async refreshApiKey() {
            await refreshKey(section().apiKeyEnv?.trim() ?? '')
        },
        editApiKey(text) {
            keyDraft = text
            keySaved = false
            keyError = undefined
            publish()
        },
        async saveApiKey() {
            const reference = section().apiKeyEnv?.trim() ?? ''
            const value = keyDraft.trim()
            if (value.length === 0) return
            if (reference.length === 0) {
                keyError = 'Name a credential reference before storing a key.'
                publish()
                return
            }
            keySaving = true
            keyError = undefined
            publish()
            try {
                await options.writeCredential(reference, value)
                // The literal is dropped from this process as soon as it is
                // stored: nothing else needs it, and keeping it would leak it
                // into the next render.
                keyDraft = ''
                keyConfigured = true
                keySaved = true
            } catch (error) {
                keyError = error instanceof Error ? error.message : String(error)
            } finally {
                keySaving = false
                publish()
            }
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
