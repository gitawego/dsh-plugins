/**
 * Model metadata from [models.dev](https://models.dev), the catalog the OpenCode
 * ecosystem publishes.
 *
 * The gateway's own `GET /v1/models` answers *which ids this key can call* and
 * nothing else — no context window, no output cap, no thinking levels. The
 * installed pi-ai catalog carries that metadata but is a snapshot: it knows 27
 * of the 36 models the gateway serves, and the one the live configuration runs
 * (`deepseek-v4.1-flash`) is not among them.
 *
 * models.dev closes both gaps: it describes 33 `opencode-go` models with
 * `limit.context`, `limit.output`, `reasoning_options`, input modalities, cost,
 * and `family` — and it is the same source the OpenCode client itself reads.
 *
 * This module is parsing plus one HTTP call, deliberately free of harness and
 * pi-ai types so the shapes can be unit-tested from a recorded fixture.
 *
 * @module @gitawego/dsh-llm-provider/models-dev
 */

/** Public catalog endpoint. Not configurable: it is a fixed public dataset. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Provider key this plugin reads inside that dataset. */
export const MODELS_DEV_PROVIDER = 'opencode-go'

/** How a provider lets a caller choose reasoning effort. */
export interface ReasoningOptions {
    /**
     * Selectable effort levels, in provider order, exactly as the dataset
     * spells them (`low`, `medium`, `high`, `xhigh`, `max`, and sometimes
     * `none`). `none` is not a pi-ai level; it means "thinking can be turned
     * off", which pi-ai expresses by *omitting* the effort.
     */
    effort: string[]
    /** Whether the provider exposes on/off thinking rather than levels. */
    toggle: boolean
    /** Token budget cap when the provider takes a budget instead of a level. */
    budgetMax?: number
}

/** One model's metadata, normalized to what this plugin consumes. */
export interface ModelMetadata {
    /** Request id. */
    id: string
    /** Display name. */
    name: string
    /** Dataset family (`deepseek-flash`, `gpt-luna`, …); used to group models. */
    family?: string
    /** Description when the dataset carries one. */
    description?: string
    /** Exact context capacity in tokens, when disclosed. */
    contextWindow?: number
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number
    /** Input modalities this plugin can actually send. */
    input: ('text' | 'image')[]
    /** Whether the model exposes reasoning at all. */
    reasoning: boolean
    /** How effort is selected, when the model reasons. */
    options?: ReasoningOptions
    /** Provider-visible reasoning field, when the dataset names one. */
    reasoningField?: string
    /** Per-million-token rates, zeroed when the dataset reports free access. */
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
    /** Release date, when disclosed. */
    releasedAt?: string
}

/** Read one finite non-negative number, or undefined. */
function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Read a non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Narrow the dataset's `reasoning_options` list to what this plugin can act on.
 *
 * The dataset lists capabilities rather than a level set, and different models
 * list different subsets: `[{type:'toggle'}]`, `[{type:'effort',values:[...]}]`,
 * `[{type:'budget_tokens',max}]`, or several at once. Effort values are the only
 * ones that map onto the harness's reasoning-effort vocabulary, so they win;
 * `toggle` is recorded because it tells us thinking can be turned off.
 * @param raw - the dataset's `reasoning_options` value.
 * @returns the normalized options, or undefined when none are disclosed.
 */
export function parseReasoningOptions(raw: unknown): ReasoningOptions | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    let effort: string[] = []
    let toggle = false
    let budgetMax: number | undefined
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue
        const option = entry as Record<string, unknown>
        if (option['type'] === 'toggle') toggle = true
        if (option['type'] === 'effort') {
            const values = Array.isArray(option['values']) ? option['values'] : []
            // `none` is kept: it is evidence thinking can be off, and
            // `thinkingLevelMap` needs that to offer pi-ai's `off`.
            effort = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        }
        if (option['type'] === 'budget_tokens') budgetMax = num(option['max'])
    }
    if (effort.length === 0 && !toggle && budgetMax === undefined) return undefined
    return { effort, toggle, ...(budgetMax !== undefined ? { budgetMax } : {}) }
}

/** Narrow the dataset's input modalities to the ones pi-ai can actually send. */
function parseInput(raw: unknown): ('text' | 'image')[] {
    const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['input'] : undefined
    if (!Array.isArray(input)) return ['text']
    const modalities: ('text' | 'image')[] = []
    if (input.includes('text')) modalities.push('text')
    // `pdf`, `audio`, and `video` are deliberately dropped: pi-ai has no
    // request form for them, and claiming a capability the wire cannot carry
    // would let a request fail inside the provider instead of at admission.
    if (input.includes('image')) modalities.push('image')
    return modalities.length > 0 ? modalities : ['text']
}

/** Normalize one dataset entry. */
function parseModel(id: string, raw: unknown): ModelMetadata {
    const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const limit = (typeof entry['limit'] === 'object' && entry['limit'] !== null ? entry['limit'] : {}) as Record<string, unknown>
    const cost = (typeof entry['cost'] === 'object' && entry['cost'] !== null ? entry['cost'] : {}) as Record<string, unknown>
    const interleaved = (typeof entry['interleaved'] === 'object' && entry['interleaved'] !== null ? entry['interleaved'] : {}) as Record<string, unknown>
    const reasoning = entry['reasoning'] === true
    const options = reasoning ? parseReasoningOptions(entry['reasoning_options']) : undefined
    const rates = {
        input: num(cost['input']) ?? 0,
        output: num(cost['output']) ?? 0,
        cacheRead: num(cost['cache_read']) ?? 0,
        cacheWrite: num(cost['cache_write']) ?? 0,
    }
    return {
        id,
        name: str(entry['name']) ?? id,
        ...(str(entry['family']) !== undefined ? { family: str(entry['family'])! } : {}),
        ...(str(entry['description']) !== undefined ? { description: str(entry['description'])! } : {}),
        ...(num(limit['context']) !== undefined ? { contextWindow: num(limit['context'])! } : {}),
        ...(num(limit['output']) !== undefined ? { maxTokens: num(limit['output'])! } : {}),
        input: parseInput(entry['modalities']),
        reasoning,
        ...(options !== undefined ? { options } : {}),
        ...(str(interleaved['field']) !== undefined ? { reasoningField: str(interleaved['field'])! } : {}),
        cost: rates,
        ...(str(entry['release_date']) !== undefined ? { releasedAt: str(entry['release_date'])! } : {}),
    }
}

/**
 * Read one provider's model metadata out of the dataset document.
 * @param document - the parsed `api.json` value, of unknown shape.
 * @param provider - provider key to read; defaults to `opencode-go`.
 * @returns metadata keyed by model id; empty when the provider is absent.
 */
export function parseModelsDevCatalog(document: unknown, provider = MODELS_DEV_PROVIDER): Map<string, ModelMetadata> {
    const catalog = new Map<string, ModelMetadata>()
    if (typeof document !== 'object' || document === null) return catalog
    const providerEntry = (document as Record<string, unknown>)[provider]
    if (typeof providerEntry !== 'object' || providerEntry === null) return catalog
    const models = (providerEntry as Record<string, unknown>)['models']
    if (typeof models !== 'object' || models === null) return catalog
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
        if (id.trim().length === 0) continue
        catalog.set(id, parseModel(id, raw))
    }
    return catalog
}

/** Injectable fetch, so every network path in this plugin is testable. */
export type FetchLike = typeof fetch

/**
 * Fetch the metadata catalog.
 *
 * A failure is never fatal: this is enrichment on top of the installed pi-ai
 * catalog, so a catalog service that is down, rate-limited, or unreachable
 * degrades metadata instead of taking a route offline.
 * @param options - provider key, fetch implementation, and cancellation.
 * @returns metadata keyed by model id, or an empty map when the fetch failed.
 */
export async function fetchModelsDevCatalog(options: {
    provider?: string
    fetch?: FetchLike
    signal?: AbortSignal
    url?: string
} = {}): Promise<Map<string, ModelMetadata>> {
    const doFetch = options.fetch ?? fetch
    try {
        const response = await doFetch(options.url ?? MODELS_DEV_URL, {
            headers: { accept: 'application/json', ...attributionHeader() },
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        if (!response.ok) return new Map()
        return parseModelsDevCatalog(await response.json(), options.provider ?? MODELS_DEV_PROVIDER)
    } catch {
        return new Map()
    }
}

/**
 * The attribution header for catalog calls.
 *
 * Imported lazily from the harness seam would drag dsh-llm into a module whose
 * whole point is being harness-free; the dataset is a public read, so the
 * product token is inlined here and asserted against `attributionHeaders()` in
 * the plugin's own test.
 */
function attributionHeader(): Record<string, string> {
    return { 'user-agent': 'dsh-llm-provider (+https://github.com/gitawego/dsh-plugins)' }
}
