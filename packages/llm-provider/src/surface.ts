/**
 * The surfaces that make a fetched catalog and a quota report visible.
 *
 * Two of them, because they answer two different questions:
 *
 * - **`/llm-provider`** — a human command. `models` prints the live catalog with
 *   the facts a model picker needs (context window, output cap, thinking
 *   levels), `quota` prints the subscription windows, and `refresh` re-reads
 *   both. Nothing here goes to the model.
 * - **`llm_quota`** — a tool, so the agent can ask the same question mid-task.
 *   OpenCode Go's allowances are per-window shares of a monthly budget, and an
 *   agent about to launch a long job is the one caller who benefits from
 *   knowing the 5-hour window is nearly spent.
 *
 * Both read the same snapshots, so the command is also how you verify what the
 * tool will answer.
 *
 * @module @gitawego/dsh-plugins/llm-provider/surface
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type { CatalogFeed, RouteCatalogSnapshot } from './catalog-feed.ts'
import { formatQuota, type QuotaSnapshot } from './gateway-api.ts'

/** What the surfaces can ask the plugin for. */
export interface SurfaceDeps {
    /** Routes this build serves. */
    routes: readonly string[]
    /** The catalog feed. */
    feed: CatalogFeed
    /** Advertised models for one route. */
    modelsOf: (route: string) => readonly Model<Api>[]
    /** Fetch a route's quota report. */
    quotaOf: (route: string) => Promise<QuotaSnapshot>
}

/** Pick the route a subcommand addresses, defaulting to the only/primary one. */
function routeOf(routes: readonly string[], requested: string | undefined): string | undefined {
    if (requested !== undefined) return routes.includes(requested) ? requested : undefined
    return routes[0]
}

/**
 * Render one model's line for a human surface: the facts a picker shows.
 * @param model - the advertised model.
 * @returns one line: id, context window, output cap, and thinking levels.
 */
export function formatModel(model: Model<Api>): string {
    const context = `${Math.round(model.contextWindow / 1000)}k ctx`
    const output = `${Math.round(model.maxTokens / 1000)}k out`
    const levels = getSupportedThinkingLevels(model)
    const thinking = model.reasoning ? `thinking: ${levels.join('/')}` : 'no thinking'
    const modalities = model.input.join('+')
    return `${model.id} — ${context}, ${output}, ${thinking}, ${modalities}, ${model.api}`
}

/**
 * Render a catalog snapshot and its models for a human surface.
 * @param snapshot - the last refresh's summary.
 * @param models - the models the route advertises.
 * @returns lines ready to join.
 */
export function formatCatalog(snapshot: RouteCatalogSnapshot | undefined, models: readonly Model<Api>[]): string[] {
    const lines: string[] = []
    if (snapshot !== undefined) {
        const fetched = new Date(snapshot.fetchedAt).toISOString()
        lines.push(
            snapshot.liveCount > 0
                ? `Live catalog: ${snapshot.liveCount} models from the gateway, ${snapshot.modelCount} advertised (read ${fetched}).`
                : `No live catalog read (${snapshot.error ?? 'not refreshed yet'}); ${snapshot.modelCount} advertised from the installed catalog.`,
        )
        if (snapshot.discovered.length > 0) {
            lines.push(`New since this pi-ai build: ${snapshot.discovered.join(', ')}`)
        }
        lines.push(snapshot.metadataLoaded ? 'Capacities and thinking levels: models.dev.' : 'models.dev metadata unavailable; capacities fall back to the installed catalog.')
    }
    lines.push(...models.map(formatModel))
    return lines
}

/** One successful command result. */
export interface CommandOutcome {
    kind: 'success'
    text: string
}

/**
 * Run one `/llm-provider` invocation.
 *
 * Kept as a plain function over explicit dependencies so the command's exact
 * output is unit-testable without a cordis context, a network, or a registry.
 * @param deps - routes, feed, and readers.
 * @param rawInput - text after the command name.
 * @returns the command result.
 */
export async function runProviderCommand(deps: SurfaceDeps, rawInput: string): Promise<CommandOutcome> {
    const parts = rawInput.trim().split(/\s+/u).filter(Boolean)
    const sub = parts[0] ?? 'models'
    const requested = parts[1]
    const route = routeOf(deps.routes, requested)
    if (route === undefined) {
        return { kind: 'success', text: `Unknown route "${requested}". Served routes: ${deps.routes.join(', ')}.` }
    }

    if (sub === 'refresh') {
        const refreshed = await deps.feed.refresh(route)
        const snapshot = refreshed[0] ?? deps.feed.snapshot(route)
        return { kind: 'success', text: formatCatalog(snapshot, deps.modelsOf(route)).join('\n') }
    }

    if (sub === 'quota') {
        const quota = await deps.quotaOf(route)
        return { kind: 'success', text: [`${route} quota:`, ...formatQuota(quota)].join('\n') }
    }

    if (sub !== 'models') {
        return { kind: 'success', text: `Unknown subcommand "${sub}". Use: models [route], quota [route], refresh [route].` }
    }
    return { kind: 'success', text: [`${route} models:`, ...formatCatalog(deps.feed.snapshot(route), deps.modelsOf(route))].join('\n') }
}

/**
 * Build the quota tool.
 *
 * The tool reports every window the provider discloses and never invents one:
 * OpenCode Go reports a rolling 5-hour window, a weekly window, and a monthly
 * window, and a provider that reports fewer simply has fewer lines.
 * @param deps - routes and the quota reader.
 * @returns the tool definition to register.
 */
export function createQuotaTool(deps: SurfaceDeps): ToolDefinition {
    return defineTool({
        name: 'llm_quota',
        description:
            'Report the remaining LLM provider quota for this session\'s provider route: the 5-hour, weekly, and monthly allowance windows the provider discloses, with reset times. Check before launching a long-running job.',
        parameters: {
            route: {
                type: 'string',
                description: `Provider route to report; defaults to ${deps.routes[0] ?? 'the only route'}. Served: ${deps.routes.join(', ')}.`,
            },
        } as const,
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } },
            },
            render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
        },
        async execute(args) {
            // Tool arguments arrive from the model, so they are validated here
            // rather than trusted: a missing or non-string route falls back to
            // the primary route instead of failing the call.
            const raw = (args as { route?: unknown }).route
            const requested = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
            const route = routeOf(deps.routes, requested)
            if (route === undefined) {
                const details: Record<string, JsonValue> = { route: requested ?? null, windows: [], error: 'unknown route', fetchedAt: 0 }
                return { text: `Unknown provider route "${requested}". Served routes: ${deps.routes.join(', ')}.`, details }
            }
            const quota = await deps.quotaOf(route)
            const details: Record<string, JsonValue> = {
                route,
                error: quota.error ?? null,
                fetchedAt: quota.fetchedAt,
                windows: quota.windows.map((window) => ({
                    id: window.id,
                    label: window.label,
                    percentUsed: window.percentUsed,
                    percentRemaining: window.percentRemaining,
                    status: window.status,
                    resetsAt: window.resetsAt ?? null,
                })),
            }
            return { text: [`${route} quota:`, ...formatQuota(quota)].join('\n'), details }
        },
    })
}
