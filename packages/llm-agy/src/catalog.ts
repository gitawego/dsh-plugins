/**
 * Model metadata comes from one of exactly two places:
 *
 * 1. **ACP discovery** — `session/new`'s `configOptions.model` supplies the
 *    accepted model ids and names, and `configOptions.thought_level` supplies
 *    the effort vocabulary. ACP discloses no context window, output cap, or
 *    per-model effort map, so those fields are left absent rather than guessed.
 * 2. **Explicit configuration** — the profile's `models` list. A user who knows
 *    a model's capacity can declare it; the adapter never invents one.
 *
 * There is no shipped model table. Adding or removing a model in `agy` changes
 * the route's catalog on the next discovery without a package release.
 *
 * @module @gitawego/dsh-llm-agy/catalog
 */
import { findConfigOption, selectOptions, type AcpSessionConfigOption } from './protocol.ts'

/** One selectable reasoning effort, as data. */
export interface CatalogEffort {
    id: string
    name: string
}

/** One model the route accepts. */
export interface CatalogModel {
    id: string
    name: string
    description?: string
    /** Combined context window, only when the profile declared it. */
    contextWindow?: number
    /** Default output cap, only when the profile declared it. */
    maxTokens?: number
    efforts: readonly CatalogEffort[]
    defaultEffort?: string
}

/** A model supplied by profile configuration. */
export interface ConfiguredModel {
    id: string
    name?: string
    description?: string
    contextWindow?: number
    maxTokens?: number
    efforts?: readonly string[]
    defaultEffort?: string
}

/** One resolved catalog. */
export interface Catalog {
    source: 'acp' | 'config'
    models: readonly CatalogModel[]
    /** Model ACP currently has selected; absent when ACP did not disclose one. */
    currentModel?: string
}

/** Build a catalog from explicit configuration. */
export function configCatalog(models: readonly ConfiguredModel[], defaultModel?: string): Catalog {
    const resolved: CatalogModel[] = []
    const seen = new Set<string>()
    for (const entry of models) {
        const id = entry.id.trim()
        if (id.length === 0 || seen.has(id)) continue
        seen.add(id)
        const efforts = (entry.efforts ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .map((value) => ({ id: value, name: value }))
        const defaultEffort = entry.defaultEffort?.trim()
        resolved.push({
            id,
            name: entry.name?.trim() || id,
            ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
            ...(entry.contextWindow !== undefined && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
            ...(entry.maxTokens !== undefined && entry.maxTokens > 0 ? { maxTokens: entry.maxTokens } : {}),
            efforts,
            ...(defaultEffort !== undefined && defaultEffort.length > 0 ? { defaultEffort } : {}),
        })
    }
    const current = defaultModel?.trim()
    return {
        source: 'config',
        models: resolved,
        ...(current !== undefined && current.length > 0 ? { currentModel: current } : {}),
    }
}

/** Build a catalog from one `session/new` response's config options. */
export function sessionCatalog(options: readonly AcpSessionConfigOption[]): Catalog {
    const modelOption = findConfigOption(options, 'model', 'model')
    if (modelOption === undefined) return { source: 'acp', models: [] }

    const effortOption = findConfigOption(options, 'thought_level', 'thought_level')
    const efforts = effortVocabulary(effortOption)
    const defaultEffort = typeof effortOption?.currentValue === 'string' ? effortOption.currentValue : undefined

    const values = selectOptions(modelOption)
    const currentModel = typeof modelOption.currentValue === 'string' ? modelOption.currentValue : undefined
    const models: CatalogModel[] = values.map((option) => ({
        id: option.value,
        name: option.name.length > 0 ? option.name : option.value,
        efforts,
        ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    }))
    if (models.length === 0 && currentModel !== undefined) {
        models.push({
            id: currentModel,
            name: currentModel,
            efforts,
            ...(defaultEffort !== undefined ? { defaultEffort } : {}),
        })
    }

    return {
        source: 'acp',
        models,
        ...(currentModel !== undefined ? { currentModel } : {}),
    }
}

/** Extract the effort vocabulary from an ACP option, without inventing one. */
function effortVocabulary(option: AcpSessionConfigOption | undefined): CatalogEffort[] {
    if (option === undefined) return []
    const values = selectOptions(option)
    if (values.length > 0) return values.map((entry) => ({ id: entry.value, name: entry.name.length > 0 ? entry.name : entry.value }))
    const current = typeof option.currentValue === 'string' && option.currentValue.length > 0 ? option.currentValue : undefined
    return current === undefined ? [] : [{ id: current, name: current }]
}
