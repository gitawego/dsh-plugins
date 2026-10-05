/**
 * Declaring routes in the configurable-provider directory, tolerantly.
 *
 * The directory is a single namespace of provider keys shared by every mounted
 * adapter plugin, and registration is all-or-nothing: one taken key throws
 * `DUPLICATE_DIRECTORY` for the whole set. That is the right contract for the
 * seam — two plugins must not silently claim one route — but the wrong
 * behaviour for a boot: a directory collision is a *presentation* problem (one
 * row of the Models page), and taking the whole harness down over it turns a
 * cosmetic overlap into an outage. It already did once:
 *
 * ```text
 * Error: dsh: plugin tree failed to load: failed to apply loader entry
 *   llm-provider (@gitawego/dsh-llm-provider):
 *   configurable provider "opencode-go" is already declared
 * ```
 *
 * `dsh-llm-pi-ai` declares an entry for every provider in pi-ai's catalog. This
 * module declares only the routes whose key is still free, and reports the ones
 * it stepped over so the outcome is visible instead of silent.
 *
 * @module @gitawego/dsh-llm-provider/directory
 */
import type { LlmConfigurableProvider, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GatewayDefinition } from './gateways.ts'

/** The part of the LLM runtime this module uses. */
export type DirectoryHost = Pick<LlmRuntime, 'listConfigurableProviders' | 'registerConfigurableProviders'>

/** What one declaration pass did. */
export interface DirectoryOutcome {
    /** Routes whose entries this plugin owns now. */
    declared: string[]
    /** Routes left to the plugin that declared them first, with its namespace. */
    skipped: { provider: string; owner: string }[]
}

/** The display name of one route's entry. */
function displayNameOf(gateway: GatewayDefinition): string {
    return gateway.displayName
}

/**
 * Declare this plugin's routes, skipping any key another registration owns.
 * @param llm - the LLM runtime.
 * @param gateways - routes this build serves.
 * @param settingsNs - settings namespace the entries point at.
 * @returns what was declared and what was left alone.
 */
export function declareRoutes(
    llm: DirectoryHost,
    gateways: readonly GatewayDefinition[],
    settingsNs: string,
): DirectoryOutcome {
    const taken = new Map<string, string>()
    for (const entry of llm.listConfigurableProviders()) taken.set(entry.provider, entry.settingsNs)

    const free: LlmConfigurableProvider[] = []
    const skipped: DirectoryOutcome['skipped'] = []
    for (const gateway of gateways) {
        const owner = taken.get(gateway.id)
        if (owner !== undefined) {
            skipped.push({ provider: gateway.id, owner })
            continue
        }
        free.push({
            provider: gateway.id,
            displayName: displayNameOf(gateway),
            settingsNs,
            // The profile for a route lives under its key inside the namespace.
            settingsPath: [gateway.id],
            // The adapter ships knowledge of this route; it is not a gateway a
            // user hand-declared in settings.
            declared: false,
        })
    }
    if (free.length > 0) llm.registerConfigurableProviders(free)
    return { declared: free.map((entry) => entry.provider), skipped }
}

/**
 * Render one line per skipped route, for the plugin's logger.
 * @param outcome - the result of a declaration pass.
 * @returns log lines; empty when nothing was skipped.
 */
export function describeSkips(outcome: DirectoryOutcome): string[] {
    return outcome.skipped.map(
        (entry) =>
            `configurable provider "${entry.provider}" is already declared by settings namespace "${entry.owner}"; the route still serves requests, but its Models-page row belongs to that plugin`,
    )
}
