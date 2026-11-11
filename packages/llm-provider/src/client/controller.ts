/**
 * The dashboard's client state.
 *
 * One route, two reads, no writes to anything but this plugin's own four
 * settings fields. The card cannot change a model catalog, a credential, or a
 * route: those belong to the host adapter's profile, and this plugin's job is
 * to *show* what that profile is currently getting.
 *
 * Reads go through the plugin's guarded loopback routes (`quota-route.ts`):
 * neither the model status nor the allowance has a host seam.
 *
 * @module @gitawego/dsh-llm-provider/client/controller
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { QUOTA_ROUTE_PATH, STATUS_ROUTE_PATH } from '../quota-path.ts'
import type { MonitorProfile } from '../config.ts'
import { parseQuotaView, type QuotaView } from './quota-format.ts'
import { createQuotaReader } from './quota-client.ts'

/** Minimal shape of the host `llm-pi-ai` provider profile this card edits. */
interface PiAiProviderProfile {
    models?: Array<{ id?: unknown } | string>
}

/** Minimal shape of the host `llm-pi-ai` settings namespace. */
interface PiAiSettings {
    providers?: Record<string, PiAiProviderProfile>
}

/** One model row, as the card renders it. */
export interface ModelRow {
    id: string
    name: string
    /** The installed catalog describes this id. */
    known: boolean
    /** The gateway currently serves this id. */
    live: boolean
    contextWindow?: number
    maxTokens?: number
    input?: readonly ('text' | 'image')[]
    reasoning?: boolean
}

/** The card's whole state. */
export interface DashboardSnapshot {
    /** Settings-namespace sync state. */
    status: 'loading' | 'ready' | 'unavailable'
    /** False when the host document refuses writes (memory mode, read-only). */
    writable: boolean
    /** Host route reported on. */
    route: string
    /** Endpoint the reporting calls use. */
    endpoint: string
    /** Credential-reference name the reporting calls resolve. */
    credential: string
    /** Whether that reference resolved. */
    credentialPresent: boolean
    /** Every model row: catalog ∪ live. */
    models: ModelRow[]
    /** Ids the gateway served. */
    servedCount: number
    /** Ids the installed catalog describes. */
    knownCount: number
    /** Served ids the installed catalog does not describe. */
    unknownIds: string[]
    /** When the model status was read. */
    fetchedAt: number
    /** Why the model status is empty, when it is. */
    error?: string
    /** Last allowance report, or a placeholder while it loads. */
    quota: QuotaView
    /**
     * Ids explicitly enabled in `llm-pi-ai.providers.<route>.models`, or null
     * when that field is absent (the whole catalog is enabled).
     */
    enabledIds: string[] | null
    /** Whether the host `llm-pi-ai` profile accepts writes. */
    providerWritable: boolean
}

/** The card's write and refresh actions. */
export interface DashboardActions {
    /** Re-read status and allowance. */
    refresh: () => void
    /** Write one settings field. */
    edit: (field: keyof MonitorProfile, value: string | number) => void
    /** Revert one settings field to the composition default. */
    clear: (field: keyof MonitorProfile) => void
    /** Write the enabled-model allowlist, or null to restore the whole catalog. */
    setEnabledModels: (rows: readonly ModelRow[] | null) => Promise<boolean>
}

/** One dashboard instance: a stable snapshot plus actions. */
export interface Dashboard {
    getSnapshot: () => DashboardSnapshot
    subscribe: (listener: () => void) => () => void
    actions: DashboardActions
}

/** Parse one status reply into the card's view, tolerating a partial document. */
export function parseStatus(document: unknown, fallback: MonitorProfile): Omit<DashboardSnapshot, 'quota' | 'enabledIds' | 'providerWritable'> {
    const raw = typeof document === 'object' && document !== null ? (document as Record<string, unknown>) : {}
    const rows = Array.isArray(raw['models']) ? raw['models'] : []
    const models: ModelRow[] = []
    for (const entry of rows) {
        if (typeof entry !== 'object' || entry === null) continue
        const row = entry as Record<string, unknown>
        const id = typeof row['id'] === 'string' ? row['id'] : undefined
        if (id === undefined || id.length === 0) continue
        const input = Array.isArray(row['input'])
            ? row['input'].filter((m): m is 'text' | 'image' => m === 'text' || m === 'image')
            : undefined
        models.push({
            id,
            name: typeof row['name'] === 'string' && row['name'].length > 0 ? row['name'] : id,
            known: row['known'] === true,
            live: row['live'] === true,
            ...(typeof row['contextWindow'] === 'number' ? { contextWindow: row['contextWindow'] } : {}),
            ...(typeof row['maxTokens'] === 'number' ? { maxTokens: row['maxTokens'] } : {}),
            ...(input !== undefined && input.length > 0 ? { input } : {}),
            ...(typeof row['reasoning'] === 'boolean' ? { reasoning: row['reasoning'] } : {}),
        })
    }
    const unknownIds = Array.isArray(raw['unknownIds']) ? raw['unknownIds'].filter((id): id is string => typeof id === 'string') : []
    return {
        status: 'ready',
        writable: false,
        route: typeof raw['route'] === 'string' ? raw['route'] : fallback.route,
        endpoint: typeof raw['endpoint'] === 'string' ? raw['endpoint'] : fallback.baseURL,
        credential: typeof raw['credential'] === 'string' ? raw['credential'] : fallback.apiKeyEnv,
        credentialPresent: raw['credentialPresent'] === true,
        models,
        servedCount: typeof raw['servedCount'] === 'number' ? raw['servedCount'] : 0,
        knownCount: typeof raw['knownCount'] === 'number' ? raw['knownCount'] : 0,
        unknownIds,
        fetchedAt: typeof raw['fetchedAt'] === 'number' ? raw['fetchedAt'] : 0,
        ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
    }
}

/** An empty value for the settings section, before its profile arrives. */
const EMPTY_PROFILE: MonitorProfile = { route: '', baseURL: '', apiKeyEnv: '', refreshMinutes: 15 }

/** An empty allowance report. */
function emptyQuota(route: string): QuotaView {
    return { route, windows: [] }
}

/**
 * Build the dashboard for the plugin's single settings section.
 *
 * Writes go through the shared `ConfigForm`, so the card and any other editor of
 * this namespace share one revision fence; reads go through the guarded routes,
 * so the card never touches a credential or a provider endpoint directly.
 * @param ctx - the client context (only `ctx.effect` is used, for the refresher).
 * @param scope - the `llm-provider` entry's config form.
 * @param fetchImpl - fetch implementation; defaults to the global one.
 * @returns the dashboard.
 */
export function createDashboard(ctx: ClientContext, scope: ConfigForm<MonitorProfile>, fetchImpl?: typeof fetch): Dashboard {
    const doFetch = fetchImpl ?? fetch
    const readQuota = createQuotaReader(doFetch)
    const providerScope = ctx.configForms.get<PiAiSettings>('llm-pi-ai')
    const listeners = new Set<() => void>()

    let local: DashboardSnapshot = {
        status: 'loading',
        writable: false,
        route: EMPTY_PROFILE.route,
        endpoint: EMPTY_PROFILE.baseURL,
        credential: EMPTY_PROFILE.apiKeyEnv,
        credentialPresent: false,
        models: [],
        servedCount: 0,
        knownCount: 0,
        unknownIds: [],
        fetchedAt: 0,
        quota: emptyQuota(EMPTY_PROFILE.route),
        enabledIds: null,
        providerWritable: false,
    }
    let snapshot: DashboardSnapshot = local
    let generation = 0

    const publish = (): void => {
        // Rebuilt only on change: a snapshot that rebuilt itself per call would
        // re-render forever (useSyncExternalStore compares by identity).
        snapshot = { ...local, ...profileFacts(), quota: local.quota }
        for (const listener of listeners) listener()
    }

    /** The host provider profile this dashboard edits, for the current route. */
    const providerProfile = (): PiAiProviderProfile | undefined => {
        const value = providerScope.getSnapshot().value
        const route = profile().route
        if (route.length === 0 || value === undefined) return undefined
        return value.providers?.[route]
    }

    /** The explicit allowlist, or null when `models` is absent. */
    const enabledIds = (): string[] | null => {
        const models = providerProfile()?.models
        if (!Array.isArray(models)) return null
        const ids: string[] = []
        for (const entry of models) {
            const id = typeof entry === 'string' ? entry : typeof entry?.id === 'string' ? entry.id : undefined
            if (id !== undefined && id.length > 0 && !ids.includes(id)) ids.push(id)
        }
        return ids
    }

    /** The settings profile as the form currently holds it. */
    const profile = (): MonitorProfile => {
        const form = scope.getSnapshot()
        const value = (form.value ?? {}) as Partial<MonitorProfile>
        return {
            route: typeof value.route === 'string' ? value.route : EMPTY_PROFILE.route,
            baseURL: typeof value.baseURL === 'string' ? value.baseURL : EMPTY_PROFILE.baseURL,
            apiKeyEnv: typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : EMPTY_PROFILE.apiKeyEnv,
            refreshMinutes: typeof value.refreshMinutes === 'number' ? value.refreshMinutes : EMPTY_PROFILE.refreshMinutes,
        }
    }

    const profileFacts = (): Pick<
        DashboardSnapshot,
        'status' | 'writable' | 'route' | 'endpoint' | 'credential' | 'enabledIds' | 'providerWritable'
    > => {
        const form = scope.getSnapshot()
        const provider = providerScope.getSnapshot()
        const current = profile()
        return {
            status: form.status,
            writable: form.writable,
            route: current.route,
            endpoint: current.baseURL,
            credential: current.apiKeyEnv,
            enabledIds: enabledIds(),
            providerWritable: provider.status === 'ready' && provider.writable,
        }
    }

    /** Read the model status from the guarded route. */
    const readStatus = async (sequence: number): Promise<void> => {
        const current = profile()
        const query = current.route.length > 0 ? `?route=${encodeURIComponent(current.route)}` : ''
        try {
            const response = await doFetch(`${STATUS_ROUTE_PATH}${query}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            if (!response.ok) throw new Error(`status read refused (${response.status})`)
            const parsed = parseStatus(await response.json(), { ...current, route: current.route })
            if (sequence !== generation) return
            local = { ...local, ...parsed, writable: scope.getSnapshot().writable, quota: local.quota }
            if (parsed.error === undefined) delete local.error
        } catch (error) {
            if (sequence !== generation) return
            local = { ...local, status: scope.getSnapshot().status, error: error instanceof Error ? error.message : String(error) }
        }
        publish()
    }

    /** Read the allowance from the guarded route. */
    const readQuotaNow = async (sequence: number): Promise<void> => {
        const route = profile().route
        if (route.length === 0) return
        try {
            const view = await readQuota(route)
            if (sequence !== generation) return
            local = { ...local, quota: view }
        } catch (error) {
            if (sequence !== generation) return
            local = { ...local, quota: { route, windows: [], error: error instanceof Error ? error.message : String(error) } }
        }
        publish()
    }

    const refresh = (): void => {
        generation += 1
        const sequence = generation
        void readStatus(sequence)
        void readQuotaNow(sequence)
    }

    // Follow the settings form: a field write changes the route or endpoint the
    // next read has to ask about.
    scope.subscribe(() => {
        publish()
        refresh()
    })
    ctx.effect(() => providerScope.subscribe(() => { publish() }), 'llm-provider: host provider profile')
    ctx.effect(() => () => { generation += 1 }, 'llm-provider: dashboard stop')
    // First paint reflects the profile immediately; the two reads follow.
    publish()
    refresh()

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        actions: {
            refresh,
            edit: (field, value) => {
                void scope.set(field as never, value as never)
            },
            clear: (field) => {
                void scope.unset(field as never)
            },
            setEnabledModels: async (rows) => {
                const route = profile().route
                if (route.length === 0) return false
                const entries = rows?.map((row) => ({
                    id: row.id,
                    ...(row.name.length > 0 && row.name !== row.id ? { name: row.name } : {}),
                    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
                    ...(row.maxTokens !== undefined ? { maxTokens: row.maxTokens } : {}),
                    ...(row.input !== undefined && row.input.length > 0 ? { input: [...row.input] } : {}),
                }))
                try {
                    const ops = entries === undefined
                        ? [{ op: 'unset' as const, path: ['providers', route, 'models'] }]
                        : [{ op: 'set' as const, path: ['providers', route, 'models'], value: entries }]
                    const accepted = await providerScope.mutate(ops)
                    publish()
                    return accepted
                } catch {
                    return false
                }
            },
        },
    }
}
