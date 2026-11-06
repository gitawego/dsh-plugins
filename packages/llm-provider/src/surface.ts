/**
 * The surfaces that make the status readable: one command, one tool.
 *
 * - **`/llm-provider`** — a human command. `models` prints the gateway's list
 *   beside the harness catalog and the block to paste when they differ, `quota`
 *   prints the subscription windows, and `refresh` re-reads both. Nothing here
 *   goes to the model.
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
import { formatQuota, type QuotaSnapshot } from './gateway-api.ts'
import { modelsSnippet, type ProviderModelRow, type ProviderStatus } from './status.ts'

/** What the surfaces can ask the plugin for. */
export interface SurfaceDeps {
    /** Host route reported on. */
    route: string
    /** The last read, without touching the network. */
    status: () => ProviderStatus
    /** Re-read the status. */
    refresh: () => Promise<ProviderStatus>
    /** Fetch the quota report. */
    quotaOf: () => Promise<QuotaSnapshot>
}

/** Render a token count as `1M`, `384k`, `900`. */
function tokens(value: number): string {
    if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
    if (value >= 1000) return `${Math.round(value / 1000)}k`
    return String(value)
}

/**
 * Render one model's line for a human surface: the facts a picker shows.
 * @param row - the status row.
 * @returns one line: id, capacities, modalities, and where the id came from.
 */
export function formatModel(row: ProviderModelRow): string {
    const facts: string[] = []
    if (row.contextWindow !== undefined) facts.push(`${tokens(row.contextWindow)} ctx`)
    if (row.maxTokens !== undefined) facts.push(`${tokens(row.maxTokens)} out`)
    if (row.input !== undefined && row.input.length > 0) facts.push(row.input.join('+'))
    if (row.reasoning === true) facts.push('thinking')
    const source = row.known && row.live ? 'catalog+live' : row.known ? 'catalog' : 'live only'
    return [`${row.id} — ${facts.join(', ') || 'no capacities disclosed'}`, source].join(' · ')
}

/**
 * Render a status for a human surface.
 * @param status - the last read.
 * @returns lines ready to join.
 */
export function formatStatus(status: ProviderStatus): string[] {
    const lines: string[] = []
    const fetched = new Date(status.fetchedAt).toISOString()
    lines.push(
        `Live catalog: ${status.servedCount} served by ${status.endpoint}, ${status.knownCount} advertised by the harness catalog (read ${fetched}).`,
    )
    if (status.error !== undefined) lines.push(`Read problem: ${status.error}.`)
    if (status.unknownIds.length > 0) {
        lines.push(`Not in the installed catalog: ${status.unknownIds.join(', ')}.`)
    }
    lines.push(...status.models.map(formatModel))
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
 * @param deps - route, readers, and the last snapshot.
 * @param rawInput - text after the command name.
 * @returns the command result.
 */
export async function runProviderCommand(deps: SurfaceDeps, rawInput: string): Promise<CommandOutcome> {
    const sub = rawInput.trim().split(/\s+/u).filter(Boolean)[0] ?? 'models'

    if (sub === 'refresh') {
        return { kind: 'success', text: formatStatus(await deps.refresh()).join('\n') }
    }

    if (sub === 'quota') {
        const quota = await deps.quotaOf()
        return { kind: 'success', text: [`${deps.route} quota:`, ...formatQuota(quota)].join('\n') }
    }

    if (sub !== 'models') {
        return { kind: 'success', text: `Unknown subcommand "${sub}". Use: models, quota, refresh.` }
    }

    const status = deps.status()
    const lines = [`${deps.route} models:`, ...formatStatus(status)]
    if (status.unknownIds.length > 0) {
        lines.push('', 'To serve the ids the installed catalog does not describe, add them to llm-pi-ai.providers.' + deps.route + ':', ...modelsSnippet(status))
    }
    return { kind: 'success', text: lines.join('\n') }
}

/** Convert one quota report to the tool's structured half. */
function quotaDetails(quota: QuotaSnapshot): Record<string, JsonValue> {
    return {
        route: quota.route,
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
}

/**
 * Build the quota tool.
 *
 * The tool reports every window the provider discloses and never invents one:
 * OpenCode Go reports a rolling 5-hour window, a weekly window, and a monthly
 * window, and a provider that reports fewer simply has fewer lines.
 * @param deps - route and the quota reader.
 * @returns the tool definition to register.
 */
export function createQuotaTool(deps: SurfaceDeps): ToolDefinition {
    return defineTool({
        name: 'llm_quota',
        description:
            "Report the remaining LLM provider quota for this session's provider route: the 5-hour, weekly, and monthly allowance windows the provider discloses, with reset times. Check before launching a long-running job.",
        parameters: {} as const,
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: { text: { type: 'string', required: true }, details: { type: 'object', additionalProperties: true } },
            },
            render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
            // The structured half of the result, for the tool's own view. A tool
            // card reads `ToolResultNode.meta`, which only `presentationMeta`
            // populates — without it the view would have to parse the rendered
            // sentence back into numbers.
            presentationMeta: (_args, value) => (value as { details: JsonValue }).details,
        },
        async execute() {
            const quota = await deps.quotaOf()
            return {
                text: [`${quota.route} quota:`, ...formatQuota(quota)].join('\n'),
                details: quotaDetails(quota),
            }
        },
    })
}
