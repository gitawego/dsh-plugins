/**
 * The settings section's logic: one controller per served route, and the faces
 * the slot registrations inject.
 *
 * Split from `index.tsx` so it carries no JSX. The server project typechecks
 * `tests/`, and a test importing a `.tsx` module would need a `jsx` option that
 * project does not set — the same reason `controller.ts` and `quota-format.ts`
 * are separate from their views.
 *
 * @module @gitawego/dsh-llm-provider/client/section-face
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares `ctx.locale`, which this module reads.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
    createProviderCard,
    type CardSnapshot,
    type DiscoveredModel,
    type FieldName,
    type ProviderCard,
    type ProviderSections,
} from './controller.ts'
import { createQuotaReader } from './quota-client.ts'
import { en } from './strings.ts'

/** Settings namespace this section owns; also the slot keys it registers. */
export const NS = 'llm-provider'

/** Copy lookup bound to the plugin's namespace. */
export type Translate = (key: keyof typeof en) => string

/** One route's actions, as the section's face exposes them. */
export interface ProviderActions {
    refresh: () => void
    togglePin: (modelId: string) => void
    useAll: () => void
    edit: (field: FieldName, text: string) => void
    discard: () => void
    save: () => void
    editApiKey: (text: string) => void
    saveApiKey: () => void
    refreshQuota: () => void
    openPicker: () => void
    closePicker: () => void
    togglePickerModel: (modelId: string) => void
    selectAllModels: () => void
    clearSelection: () => void
    applyPicker: () => void
}

/** One route's rendered panel state, as the section's snapshot carries it. */
export interface ProviderEntry {
    route: string
    card: CardSnapshot
}

/** The section's snapshot: one entry per served route. */
export interface ProvidersSnapshot {
    providers: ProviderEntry[]
}

/** What the section's slot entry injects. */
export interface LlmProvidersFace {
    hooks: { providers: { getSnapshot: () => ProvidersSnapshot; subscribe: (listener: () => void) => () => void } }
    t: Translate
    byRoute: Record<string, ProviderActions>
}

/**
 * The actions for one already-built controller.
 *
 * Takes the controller rather than building one: the section renders one
 * controller's snapshot and drives it through these actions, and two
 * constructions per route means the buttons act on a controller nobody is
 * looking at — which is exactly how the allowance and the catalog both went
 * blank (an orphan controller answered `refresh()` while the rendered one stayed
 * idle).
 * @param controller - the route's controller.
 * @returns that route's actions.
 */
export function actionsFor(controller: ProviderCard): ProviderActions {
    return {
        refresh: () => { void controller.refresh() },
        togglePin: (modelId) => { void controller.togglePin(modelId) },
        useAll: () => { void controller.useAll() },
        edit: (field, text) => { controller.edit(field, text) },
        discard: () => { controller.discard() },
        save: () => { void controller.save() },
        editApiKey: (text) => { controller.editApiKey(text) },
        saveApiKey: () => { void controller.saveApiKey() },
        refreshQuota: () => { void controller.refreshQuota() },
        openPicker: () => { controller.openPicker() },
        closePicker: () => { controller.closePicker() },
        togglePickerModel: (modelId) => { controller.togglePickerModel(modelId) },
        selectAllModels: () => { controller.selectAllModels() },
        clearSelection: () => { controller.clearSelection() },
        applyPicker: () => { void controller.applyPicker() },
    }
}

/**
 * Build the section's face: one controller per route, projected through a single
 * memoized snapshot.
 *
 * One store rather than one hook per panel: a slot component gets exactly one
 * injected hook, and a snapshot that rebuilt itself per call would re-render
 * forever (`useSyncExternalStore` compares by identity — React error #185, the
 * failure this card already shipped once).
 * @param ctx - the client context.
 * @param scope - the bound `llm-provider` settings scope.
 * @param routes - routes to render a panel for.
 * @returns the section's injected face.
 */
export function createSectionFace(
    ctx: ClientContext,
    scope: SettingsScope<ProviderSections>,
    routes: readonly string[],
): LlmProvidersFace {
    const t = ctx.locale.bind(NS) as unknown as Translate
    const byRoute: Record<string, ProviderActions> = {}
    const controllers: { route: string; card: ProviderCard }[] = []
    for (const route of routes) {
        // ONE controller per route: the snapshot below and the actions above are
        // two views of the same object. Building it twice is how the catalog and
        // the allowance both went blank.
        const controller = createProviderCard({
            scope,
            route,
            readQuota: createQuotaReader(),
            describeCredential: credentialDescriber(ctx),
            writeCredential: credentialWriter(ctx),
            discover: modelDiscovery(ctx),
        })
        controllers.push({ route, card: controller })
        byRoute[route] = actionsFor(controller)
    }

    let cached: ProvidersSnapshot | undefined
    let stale = true
    const listeners = new Set<() => void>()
    // Subscribe at construction, not per consumer: staleness has to be tracked
    // whether or not anyone is watching, or a read taken between subscriptions
    // serves a cached snapshot that no longer matches its panels.
    for (const entry of controllers) {
        entry.card.subscribe(() => {
            stale = true
            for (const listener of listeners) listener()
        })
    }
    const compute = (): ProvidersSnapshot => ({
        providers: controllers.map((entry) => ({ route: entry.route, card: entry.card.getSnapshot() })),
    })
    const store = {
        getSnapshot: (): ProvidersSnapshot => {
            if (cached !== undefined && !stale) return cached
            stale = false
            cached = compute()
            return cached
        },
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
    }
    return { hooks: { providers: store }, t, byRoute }
}

/** The Remote carrier, bound in a fiber that declares the scoped namespaces. */
function carrierOf(ctx: ClientContext): () => ClientContext['remote'] {
    let remote: ClientContext['remote'] | undefined
    ctx.inject(['remote', 'remote.llm', 'remote.credentials'], (injected: ClientContext) => {
        remote = injected.remote
        return () => {
            remote = undefined
        }
    })
    return () => {
        if (remote === undefined) throw new Error('the Remote carrier is still connecting; try again in a moment')
        return remote
    }
}

/** The credential read one route's profile names. */
function credentialDescriber(ctx: ClientContext) {
    const carrier = carrierOf(ctx)
    return async (reference: string): Promise<boolean> => {
        const response = await carrier().credentials.describe([reference])
        if (!response.ok) throw new Error(response.error.message)
        return response.value[reference]?.configured === true
    }
}

/** The credential write behind the API key field. */
function credentialWriter(ctx: ClientContext) {
    const carrier = carrierOf(ctx)
    return async (reference: string, value: string): Promise<void> => {
        const response = await carrier().credentials.set(reference, value)
        if (!response.ok) throw new Error(response.error.message)
    }
}

/** The live catalog read. */
function modelDiscovery(ctx: ClientContext) {
    const carrier = carrierOf(ctx)
    return async (route: string): Promise<DiscoveredModel[]> => {
        const result = await carrier().llm.discoverModels(NS, { provider: route })
        if (!result.ok) throw new Error(result.error.message)
        return result.value.map((model) => ({
            id: model.id,
            ...(model.name !== undefined ? { name: model.name } : {}),
            ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
            ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        }))
    }
}

