/**
 * Settings namespace for the provider *dashboard*.
 *
 * This plugin serves no route. Requests, endpoints, protocol, the
 * `x-opencode-session` header, streaming, tool-call parsing, and retries all
 * belong to the host's `dsh-llm-pi-ai` adapter, which resolves them from the
 * installed pi-ai catalog. What is left here is the one thing no host seam
 * owns: **reporting** a provider's live model list and subscription quota.
 *
 * So the profile answers three questions and nothing else:
 *
 * - which host route to report on ({@link DEFAULT_ROUTE});
 * - which endpoint speaks the gateway's `/models` and `/usage` JSON
 *   ({@link DEFAULT_MONITOR_ENDPOINT} — the same `inference/go` family pi-ai
 *   sends model calls to, verified to answer both);
 * - which credential reference authenticates those two read-only calls.
 *
 * Resolution never throws: a hand-edited `settings.yaml` degrades to the
 * shipped default rather than blanking the dashboard.
 *
 * @module @gitawego/dsh-llm-provider/config
 */
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/**
 * Settings namespace key. A plain literal: the seam's `SettingsNamespace`
 * brand is applied by `ctx.settings.register`'s generic.
 */
export const LLM_PROVIDER_SETTINGS_NAMESPACE = 'llm-provider'

/**
 * Host route reported on by default.
 *
 * The route key is the host adapter's, not ours: `dsh-llm-pi-ai` declares a
 * directory entry for every pi-ai provider it ships, and `opencode-go` is one
 * of them, so the route exists once the profile sets a credential reference.
 */
export const DEFAULT_ROUTE = 'opencode-go'

/**
 * Default endpoint for the gateway's reporting API.
 *
 * `https://opencode.ai/inference/go/v1` answers `GET /models` (OpenAI-shaped
 * `data[].id`) and `GET /usage` (the rolling/weekly/monthly windows). It is the
 * `inference/go` family pi-ai 1.5 sends model calls to; the older `zen/go/v1`
 * still answers both, so a deployment pinned to it can override this field.
 */
export const DEFAULT_MONITOR_ENDPOINT = 'https://opencode.ai/inference/go/v1'

/** Credential reference the reporting calls resolve when the profile names none. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_CUSTOM_API_KEY'

/** Minutes a fetched status stays authoritative before a read refreshes it. */
export const DEFAULT_REFRESH_MINUTES = 15

/** One resolved monitoring profile; every field is materialized. */
export interface MonitorProfile {
    /** Host route to report on. */
    route: string
    /** Endpoint root that serves `/models` and `/usage`. */
    baseURL: string
    /** Credential-reference name resolved through the harness credential seam. */
    apiKeyEnv: string
    /** Cache lifetime of a fetched status, in minutes. */
    refreshMinutes: number
}

/** The schema the settings form is generated from. */
export const Config: Schema = z.object({
    // Every field is volatile: DSH 0.2 hands `apply` stable references whose
    // `.get()` answers the current layer, so a form write applies to the next
    // read without re-installing the plugin.
    route: z.string().default(DEFAULT_ROUTE).volatile(),
    baseURL: z.string().default(DEFAULT_MONITOR_ENDPOINT).volatile(),
    apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).volatile(),
    refreshMinutes: z.number().default(DEFAULT_REFRESH_MINUTES).volatile(),
})

/** The configuration references `apply` receives from the loader. */
export interface MonitorConfigRefs {
    route: Volatile<string>
    baseURL: Volatile<string>
    apiKeyEnv: Volatile<string>
    refreshMinutes: Volatile<number>
}

/** Trim to a defined non-empty string, or undefined. */
function trimmed(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Clamp a positive, finite number, falling back when the value is unusable. */
function positive(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return n
}

/**
 * Normalize one stored profile over the shipped defaults.
 * @param input - the stored (or merged) section, of unknown shape.
 * @returns a fully materialized profile.
 */
export function resolveProfile(input: unknown): MonitorProfile {
    const raw = (input ?? {}) as Partial<Record<keyof MonitorProfile, unknown>>
    return {
        route: trimmed(raw.route) ?? DEFAULT_ROUTE,
        baseURL: trimmed(raw.baseURL) ?? DEFAULT_MONITOR_ENDPOINT,
        apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
        refreshMinutes: positive(raw.refreshMinutes, DEFAULT_REFRESH_MINUTES),
    }
}

/**
 * Read one stable snapshot of the profile.
 * @param config - the loader-supplied references.
 * @returns the resolved profile.
 */
export function readMonitorProfile(config: MonitorConfigRefs | undefined): MonitorProfile {
    if (config === undefined) return resolveProfile(undefined)
    return resolveProfile({
        route: config.route.get(),
        baseURL: config.baseURL.get(),
        apiKeyEnv: config.apiKeyEnv.get(),
        refreshMinutes: config.refreshMinutes.get(),
    })
}
