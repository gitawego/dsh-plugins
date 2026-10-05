/**
 * The web search section's state.
 *
 * The old card staged one flat field per control and wrote a whole sub-section
 * on save. That shape cannot carry a list of servers, and it produced the layout
 * this replaces: an endpoint and its token separated by unrelated fields, with
 * no sign of which backend is tried first. So the draft is the **whole section**
 * — the two sub-sections exactly as the wire stores them — and every control
 * edits one path in it. Save writes the sub-sections that changed.
 *
 * @module @gitawego/dsh-web-search/client/controller
 */
import type { McpServerEntry } from '../mcp-servers.ts'

/** The subset of the settings scope this section uses. */
export interface SettingsScopeLike<T> {
    getSnapshot(): {
        status: 'loading' | 'ready' | 'unavailable'
        value: T | undefined
        user?: unknown
        writable: boolean
        revision: number | undefined
    }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
}

/** The custom-LLM backend, as the section edits it. */
export interface LlmDraft {
    enabled: boolean
    protocol: 'anthropic' | 'openai'
    baseUrl: string
    credential: string
    model: string
    timeoutMs: string
}

/** The free-backend settings, as the section edits them. */
export interface FreeDraft {
    parallelCredential: string
    exaCredential: string
    servers: McpServerEntry[]
    timeoutMs: string
    snippetMaxChars: string
    maxResults: string
}

/** The whole namespace section, staged. */
export interface WebSearchDraft {
    llm: LlmDraft
    free: FreeDraft
}

/** What the section renders. */
export interface WebSearchSnapshot {
    status: 'loading' | 'ready' | 'unavailable'
    writable: boolean
    draft: WebSearchDraft
    /** Whether a user layer exists, so a field can be marked overridden. */
    overridden: boolean
    dirty: boolean
    /** Field paths whose draft text is not a value the schema accepts. */
    invalid: readonly string[]
    saving: boolean
    failed: boolean
}

/** Editable fields of the custom-LLM backend. */
export type LlmField = keyof LlmDraft
/** Editable free-backend fields that are not the server list. */
export type FreeField = Exclude<keyof FreeDraft, 'servers'>
/** Editable fields of one added server. */
export type ServerField = keyof McpServerEntry

/** The section's public surface. */
export interface WebSearchSectionController {
    /** @returns the current snapshot. */
    getSnapshot(): WebSearchSnapshot
    /** @param listener - invoked after every change. */
    subscribe(listener: () => void): () => void
    /** Edit one custom-LLM field. */
    editLlm(field: LlmField, value: string): void
    /** Edit one free-backend field. */
    editFree(field: FreeField, value: string): void
    /** Append a server and return its id. */
    addServer(): string
    /** Remove one server. */
    removeServer(id: string): void
    /** Edit one server's field. */
    editServer(id: string, field: ServerField, value: string): void
    /** Write the staged sub-sections. */
    save(): Promise<void>
    /** Drop every staged edit. */
    discard(): void
}

/** The shipped defaults, mirrored from `src/config.ts`. */
export const DEFAULTS: WebSearchDraft = {
    llm: { enabled: false, protocol: 'anthropic', baseUrl: '', credential: '', model: 'deepseek-v4.1-flash', timeoutMs: '20000' },
    free: { parallelCredential: '', exaCredential: '', servers: [], timeoutMs: '15000', snippetMaxChars: '300', maxResults: '8' },
}

/** Read a string field out of an unknown section. */
function str(source: unknown, key: string): string {
    if (typeof source !== 'object' || source === null) return ''
    const value = (source as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : ''
}

/** Read a boolean field, defaulting to the shipped value. */
function bool(source: unknown, key: string, fallback: boolean): boolean {
    if (typeof source !== 'object' || source === null) return fallback
    const value = (source as Record<string, unknown>)[key]
    return typeof value === 'boolean' ? value : fallback
}

/** Read a number field as draft text. */
function numText(source: unknown, key: string, fallback: string): string {
    if (typeof source !== 'object' || source === null) return fallback
    const value = (source as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
}

/**
 * Project the stored section into a draft.
 * @param section - the resolved namespace value, of unknown shape.
 * @returns the draft, with every field materialized.
 */
export function draftOf(section: unknown): WebSearchDraft {
    const llm = typeof section === 'object' && section !== null ? (section as Record<string, unknown>)['llm'] : undefined
    const free = typeof section === 'object' && section !== null ? (section as Record<string, unknown>)['free'] : undefined
    const rawServers = typeof free === 'object' && free !== null ? (free as Record<string, unknown>)['servers'] : undefined
    return {
        llm: {
            enabled: bool(llm, 'enabled', DEFAULTS.llm.enabled),
            protocol: str(llm, 'protocol') === 'openai' ? 'openai' : 'anthropic',
            baseUrl: str(llm, 'baseUrl'),
            credential: str(llm, 'credential'),
            model: str(llm, 'model') || DEFAULTS.llm.model,
            timeoutMs: numText(llm, 'timeoutMs', DEFAULTS.llm.timeoutMs),
        },
        free: {
            parallelCredential: str(free, 'parallelCredential'),
            exaCredential: str(free, 'exaCredential'),
            servers: Array.isArray(rawServers)
                ? rawServers.map((entry, index) => ({
                    id: str(entry, 'id') || `server-${index + 1}`,
                    label: str(entry, 'label'),
                    url: str(entry, 'url'),
                    credential: str(entry, 'credential'),
                    tool: str(entry, 'tool') || 'web_search',
                }))
                : [],
            timeoutMs: numText(free, 'timeoutMs', DEFAULTS.free.timeoutMs),
            snippetMaxChars: numText(free, 'snippetMaxChars', DEFAULTS.free.snippetMaxChars),
            maxResults: numText(free, 'maxResults', DEFAULTS.free.maxResults),
        },
    }
}

/** Whether one numeric draft field is usable. */
function numericOk(text: string): boolean {
    const trimmed = text.trim()
    return trimmed.length === 0 || Number.isFinite(Number(trimmed))
}

/** Coerce draft text into the number the schema stores. */
function toNumber(text: string, fallback: number): number {
    const trimmed = text.trim()
    if (trimmed.length === 0) return fallback
    const value = Number(trimmed)
    return Number.isFinite(value) ? value : fallback
}

/**
 * Build the section controller.
 * @param options - the bound settings scope and an id minter for added servers.
 * @returns the controller.
 */
export function createWebSearchSection(options: {
    scope: SettingsScopeLike<unknown>
    /** Id minter; injectable so a test can assert a stable id. */
    mintId?: () => string
}): WebSearchSectionController {
    const mintId = options.mintId ?? (() => `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    const listeners = new Set<() => void>()
    let draft = draftOf(options.scope.getSnapshot().value)
    let saving = false
    let failed = false

    /** A fresh draft from the scope, discarding staged edits. */
    const reload = (): void => {
        draft = draftOf(options.scope.getSnapshot().value)
    }

    const invalidPaths = (): string[] => {
        const paths: string[] = []
        if (!numericOk(draft.llm.timeoutMs)) paths.push('llm.timeoutMs')
        for (const field of ['timeoutMs', 'snippetMaxChars', 'maxResults'] as const) {
            if (!numericOk(draft.free[field])) paths.push(`free.${field}`)
        }
        draft.free.servers.forEach((server, index) => {
            if (server.url.trim().length === 0) paths.push(`free.servers.${index}.url`)
        })
        return paths
    }

    let cached: WebSearchSnapshot | undefined
    let stale = true

    const snapshot = (): WebSearchSnapshot => {
        const raw = options.scope.getSnapshot()
        if (cached !== undefined && !stale) return cached
        stale = false
        cached = {
            status: raw.status,
            writable: raw.status === 'ready' ? raw.writable === true : true,
            draft,
            overridden: raw.user !== undefined,
            dirty: true,
            invalid: invalidPaths(),
            saving,
            failed,
        }
        return cached
    }

    /** Announce a change: the next read recomputes once, then caches. */
    const publish = (): void => {
        stale = true
        for (const listener of listeners) listener()
    }

    const setDraft = (next: WebSearchDraft): void => {
        draft = next
        publish()
    }

    options.scope.subscribe(() => {
        // Our own write commits through the same subscription. Reloading then
        // would rebuild the draft from the half-written section and discard the
        // edits staged for the other sub-section — which is exactly how a save
        // once dropped every added server.
        if (saving) return
        reload()
        publish()
    })

    /** Write both sub-sections; the wire accepts whole sub-section objects. */
    const write = async (): Promise<void> => {
        saving = true
        failed = false
        publish()
        try {
            await options.scope.set('llm', {
                enabled: draft.llm.enabled,
                protocol: draft.llm.protocol,
                baseUrl: draft.llm.baseUrl.trim(),
                credential: draft.llm.credential.trim(),
                model: draft.llm.model.trim() || DEFAULTS.llm.model,
                timeoutMs: toNumber(draft.llm.timeoutMs, Number(DEFAULTS.llm.timeoutMs)),
            })
            await options.scope.set('free', {
                parallelCredential: draft.free.parallelCredential.trim(),
                exaCredential: draft.free.exaCredential.trim(),
                servers: draft.free.servers.map((server) => ({
                    id: server.id,
                    label: server.label.trim() || server.url.trim(),
                    url: server.url.trim(),
                    credential: server.credential.trim(),
                    tool: server.tool.trim() || 'web_search',
                })),
                timeoutMs: toNumber(draft.free.timeoutMs, Number(DEFAULTS.free.timeoutMs)),
                snippetMaxChars: toNumber(draft.free.snippetMaxChars, Number(DEFAULTS.free.snippetMaxChars)),
                maxResults: toNumber(draft.free.maxResults, Number(DEFAULTS.free.maxResults)),
            })
        } catch {
            failed = true
        } finally {
            saving = false
        }
        // A successful save leaves the stored section equal to the draft, so
        // re-reading it is safe; a refused one must keep the draft so it can be
        // corrected and retried.
        if (!failed) reload()
        publish()
    }

    return {
        getSnapshot: snapshot,
        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        editLlm(field, value) {
            setDraft({ ...draft, llm: { ...draft.llm, [field]: field === 'protocol' ? (value === 'openai' ? 'openai' : 'anthropic') : field === 'enabled' ? value === 'true' : value } as LlmDraft })
        },
        editFree(field, value) {
            setDraft({ ...draft, free: { ...draft.free, [field]: value } })
        },
        addServer() {
            const id = mintId()
            setDraft({ ...draft, free: { ...draft.free, servers: [...draft.free.servers, { id, label: '', url: '', credential: '', tool: 'web_search' }] } })
            return id
        },
        removeServer(id) {
            setDraft({ ...draft, free: { ...draft.free, servers: draft.free.servers.filter((server) => server.id !== id) } })
        },
        editServer(id, field, value) {
            setDraft({
                ...draft,
                free: {
                    ...draft.free,
                    servers: draft.free.servers.map((server) => (server.id === id ? { ...server, [field]: value } : server)),
                },
            })
        },
        async save() {
            await write()
        },
        discard() {
            reload()
            failed = false
            publish()
        },
    }
}
