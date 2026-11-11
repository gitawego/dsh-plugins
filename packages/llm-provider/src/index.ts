/**
 * @gitawego/dsh-llm-provider — the OpenCode Go dashboard for the DeepSeek
 * Harness.
 *
 * **Scope.** This plugin does not serve a route, build a request, parse a tool
 * call, retry a stream, or stamp a header. All of that belongs to the host's
 * `dsh-llm-pi-ai` adapter, which resolves endpoint, protocol, model catalog,
 * and the `x-opencode-session` routing header from the installed pi-ai build.
 * Re-implementing that layer is what this package used to do, and every bug it
 * ever reported — a missing session header, a legacy endpoint, markup instead
 * of tool calls — was a bug in that duplicate.
 *
 * What is left is **reporting plus one host-owned write**: the settings card
 * edits `llm-pi-ai.providers.<route>.models` through the shared config form.
 * Two read-only questions are answered over plain GETs:
 *
 * - which models the gateway serves (`GET {endpoint}/models`) versus which the
 *   installed catalog describes (`ctx.llm.listModels(route)`) — the difference
 *   is exactly the set a user declares in `llm-pi-ai.providers.<route>.models`;
 * - how much of the subscription is left (`GET {endpoint}/usage`: the rolling
 *   5-hour, weekly, and monthly windows, with reset times).
 *
 * Reported through `/llm-provider models|quota|refresh`, the `llm_quota` tool,
 * a guarded loopback HTTP route for the browser card, and a settings section.
 *
 * Lifecycle: `apply` registers everything on this plugin's fiber, so the cache,
 * the command, the tool, and the HTTP route all disappear together when the
 * bundle layer does.
 *
 * @module @gitawego/dsh-llm-provider
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import {
    Config,
    DEFAULT_API_KEY_ENV,
    DEFAULT_MONITOR_ENDPOINT,
    DEFAULT_REFRESH_MINUTES,
    DEFAULT_ROUTE,
    LLM_PROVIDER_SETTINGS_NAMESPACE,
    readMonitorProfile,
    resolveProfile,
    type MonitorConfigRefs,
    type MonitorProfile,
} from './config.ts'
import { missingCredentialMessage } from './credential-message.ts'
import { fetchQuota, type QuotaSnapshot } from './gateway-api.ts'
import { fetchModelsDevCatalog } from './models-dev.ts'
import { registerQuotaRoute } from './quota-route.ts'
import { composeStatus, readStatus, type ProviderStatus } from './status.ts'
import { createQuotaTool, runProviderCommand, type SurfaceDeps } from './surface.ts'

/** Plugin display name for diagnostics. */
export const name = '@gitawego/dsh-llm-provider'

/**
 * Services this plugin reads. `llm` answers the harness catalog for a route;
 * `credentials` resolves the reporting profile's credential reference. Neither
 * is optional: without them the dashboard has nothing to compare and nothing to
 * authenticate with.
 */
export const inject = ['llm', 'credentials']

export { Config, LLM_PROVIDER_SETTINGS_NAMESPACE, DEFAULT_ROUTE, DEFAULT_MONITOR_ENDPOINT, DEFAULT_API_KEY_ENV, DEFAULT_REFRESH_MINUTES }
export { readMonitorProfile, resolveProfile, type MonitorProfile, type MonitorConfigRefs }
export { fetchModelIds, fetchQuota, formatQuota, parseModelIds, parseQuota } from './gateway-api.ts'
export { fetchModelsDevCatalog, parseModelsDevCatalog, MODELS_DEV_URL, MODELS_DEV_PROVIDER } from './models-dev.ts'
export { composeStatus, readStatus, modelsSnippet, type ProviderStatus, type ProviderModelRow, type CatalogModel } from './status.ts'
export { QUOTA_ROUTE_PATH, STATUS_ROUTE_PATH, createQuotaHandler, createStatusHandler, isTrustedLocalRequest, quotaPayload, registerQuotaRoute } from './quota-route.ts'
export { formatModel, formatStatus, runProviderCommand, createQuotaTool } from './surface.ts'
export { missingCredentialMessage } from './credential-message.ts'

/** The state before the first read completes. */
function pendingStatus(profile: MonitorProfile): ProviderStatus {
    return composeStatus({
        route: profile.route,
        endpoint: profile.baseURL,
        credential: profile.apiKeyEnv,
        apiKey: undefined,
        knownModels: [],
        liveIds: [],
        metadata: new Map(),
        fetchedAt: 0,
        error: 'not read yet',
    })
}

/**
 * Mount the dashboard.
 * @param ctx - the plugin's context.
 * @param config - the loader-supplied configuration references.
 * @returns a disposer releasing the cache, the command, the tool, and the route.
 */
export function apply(ctx: Context, config: MonitorConfigRefs | undefined = undefined): () => void {
    const profile = (): MonitorProfile => readMonitorProfile(config)
    const boot = new AbortController()
    const log = ctx.logger(name)

    let status: ProviderStatus = pendingStatus(profile())
    let readAt = 0

    /** Resolve the reporting credential, without treating absence as an error. */
    const resolveApiKey = async (): Promise<string | undefined> => {
        const ref = profile().apiKeyEnv
        if (ref.length === 0) return undefined
        const resolved = await ctx.credentials.resolve(credentialRef(ref))
        return resolved?.value
    }

    /** Read the gateway's list and the harness catalog. */
    const read = async (): Promise<ProviderStatus> => {
        const current = profile()
        const [apiKey, metadata] = await Promise.all([
            resolveApiKey().catch((error: unknown) => {
                log.warn('credential %s could not be resolved: %s', current.apiKeyEnv, String(error))
                return undefined
            }),
            fetchModelsDevCatalog({ signal: boot.signal }).catch(() => new Map()),
        ])
        const next = await readStatus({
            route: current.route,
            endpoint: current.baseURL,
            credential: current.apiKeyEnv,
            apiKey,
            signal: boot.signal,
            deps: {
                knownModels: async (route) => {
                    try {
                        const models = await ctx.llm.listModels(route)
                        return models.map((model) => ({ id: model.id, name: model.name }))
                    } catch (error) {
                        log.warn('catalog for route %s could not be read: %s', route, String(error))
                        return []
                    }
                },
                fetchMetadata: async () => metadata,
            },
        })
        status = next
        readAt = Date.now()
        return next
    }

    /** The last read, refreshed when its TTL has expired. */
    const current = async (): Promise<ProviderStatus> => {
        const ttl = profile().refreshMinutes * 60_000
        if (readAt === 0 || Date.now() - readAt > ttl) return read()
        return status
    }

    /** Read one route's quota through the credential seam. */
    const quotaOf = async (): Promise<QuotaSnapshot> => {
        const now = profile()
        const apiKey = await resolveApiKey()
        // The card reports `error` verbatim, so an unset reference has to say
        // what is unset instead of surfacing the gateway's bare 401.
        if (apiKey === undefined) {
            return { route: now.route, windows: [], fetchedAt: Date.now(), error: missingCredentialMessage(now.route, now.apiKeyEnv) }
        }
        return fetchQuota({ baseURL: now.baseURL, apiKey, signal: boot.signal }, now.route)
    }

    const surfaces: SurfaceDeps = {
        get route() {
            return profile().route
        },
        status: () => status,
        refresh: async () => read(),
        quotaOf,
    }

    // The browser's only path to a live allowance read. Guarded and read-only;
    // see `quota-route.ts` for why this is a route rather than a seam.
    registerQuotaRoute(ctx, {
        get routes() {
            return [profile().route]
        },
        quotaOf: () => quotaOf(),
        statusOf: () => status,
    })

    // Both surfaces attach through `ctx.inject`, so a composition without a
    // command or tool registry still gets the dashboard itself. Cordis unloads
    // the injected children with this plugin's fiber.
    ctx.inject(['commands'], (injected: Context) => {
        injected.commands.register({
            name: 'llm-provider',
            description:
                'Show the provider’s live model list beside the harness catalog, or the subscription quota windows (5-hour, weekly, monthly), or refresh both from the provider.',
            handler: (invocation) => runProviderCommand(surfaces, invocation.rawInput),
        })
    })
    ctx.inject(['tools'], (injected: Context) => {
        injected.tools.register(createQuotaTool(surfaces))
    })

    // Prime the cache in the background: a boot that cannot reach the gateway
    // must not delay the composition, so nothing waits on this.
    void current().catch(() => undefined)

    return () => {
        boot.abort('llm-provider unloaded')
    }
}
