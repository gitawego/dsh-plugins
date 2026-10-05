/**
 * Settings namespace for the provider routes this plugin serves.
 *
 * The namespace carries one section per gateway (see `gateways.ts`), each
 * section a *tuning* profile: credential reference, optional endpoint override,
 * optional model allowlist, image budget, and the routing-header switch. Model
 * metadata itself is never configuration here — it comes from the installed
 * pi-ai catalog, so a catalog update is the only thing that changes a model's
 * context window or compat switches.
 *
 * Resolution is failure-tolerant by construction: every field has a schema
 * default derived from the gateway definition, and `resolveProfiles()` re-clamps
 * what a hand-edited `settings.yaml` can contain, so a malformed profile
 * degrades to the shipped default instead of taking the route offline.
 *
 * @module @gitawego/dsh-llm-provider/config
 */
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { GATEWAYS, type GatewayDefinition } from './gateways.ts'

/**
 * Settings namespace key. A plain literal: the seam's `SettingsNamespace`
 * brand is applied by `ctx.settings.register`'s generic, and the rc.7
 * `settingsNamespace()` helper does not exist in the 0.1.5 build.
 */
export const LLM_PROVIDER_SETTINGS_NAMESPACE = 'llm-provider'

/** Reasoning levels a profile may pin as the route default. `''` leaves it to pi-ai. */
export const REASONING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/** Aggregate base64 image-payload bound for one request; oldest images offload first. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Total-pixel budget for each deterministic request image. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Encoded-byte target for each request image before base64 expansion. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
/** Capacity fallback for a declared model the profile does not size. */
export const DEFAULT_CONTEXT_WINDOW = 262_144
/** Output-cap fallback for a declared model the profile does not size. */
export const DEFAULT_MAX_TOKENS = 32_768
/** Wire protocol assumed for a declared model when the profile names none. */
export const DEFAULT_API = 'openai-completions' as const

/** One model a profile adds to (or corrects in) the route's catalog. */
export interface ModelDeclaration {
    /** Model id a request names. */
    id: string
    /** Display name; defaults to the id. */
    name?: string
    /** Wire protocol; only needed for a model the catalog does not describe. */
    api?: string
    /** Endpoint override for this model only. */
    baseURL?: string
    contextWindow?: number
    maxTokens?: number
    reasoning?: boolean
    input?: ('text' | 'image')[]
}

/** One gateway's resolved profile; every field is materialized. */
export interface GatewayProfile {
    /** Credential-reference name resolved through the harness credential seam. */
    apiKeyEnv: string
    /** Endpoint override; the empty string means "use the catalog's per-model endpoint". */
    baseURL: string
    /** Model allowlist; empty means "every model the installed catalog describes". */
    models: string[]
    /**
     * Models this profile declares beyond (or instead of) the installed catalog.
     *
     * A gateway is not a snapshot: `opencode.ai/zen/go` serves model ids that
     * pi-ai 0.85.1's catalog has never heard of (`deepseek-v4.1-flash` among
     * them), and a route that could only serve catalog ids would reject exactly
     * the models a user is actually running. An id already in the catalog is
     * corrected field by field; a new id is described by the defaults below.
     */
    extraModels: ModelDeclaration[]
    /** Whether to stamp the gateway's routing header from the session id. */
    sessionRouting: boolean
    /** Route-default reasoning level, or `''` for the model/catalog default. */
    reasoning: ReasoningLevel
    maxRequestImageBytes: number
    requestImagePixelBudget: number
    requestImageMaxBytes: number
}

/** The namespace's resolved section: one profile per served route. */
export type ProviderSettings = Record<string, GatewayProfile>

/** The shipped profile for one gateway — also the schema default. */
export function defaultProfile(gateway: GatewayDefinition): GatewayProfile {
    return {
        apiKeyEnv: gateway.apiKeyEnv,
        baseURL: gateway.baseURL,
        models: [],
        extraModels: [],
        sessionRouting: gateway.sessionRouting,
        reasoning: '',
        maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
        requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
        requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    }
}

/** The schema for one gateway's section. */
function profileSchema(gateway: GatewayDefinition): Schema<GatewayProfile> {
    const defaults = defaultProfile(gateway)
    return z.object({
        apiKeyEnv: z.string().default(defaults.apiKeyEnv),
        baseURL: z.string().default(defaults.baseURL),
        models: z.array(z.string()).default(defaults.models),
        extraModels: z
            .array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                    api: z.string(),
                    baseURL: z.string(),
                    contextWindow: z.number(),
                    maxTokens: z.number(),
                    reasoning: z.boolean(),
                    input: z.array(z.union(['text', 'image'] as const)),
                }),
            )
            .default(defaults.extraModels),
        sessionRouting: z.boolean().default(defaults.sessionRouting),
        reasoning: z.union([...REASONING_LEVELS] as const).default(defaults.reasoning),
        maxRequestImageBytes: z.number().default(defaults.maxRequestImageBytes),
        requestImagePixelBudget: z.number().default(defaults.requestImagePixelBudget),
        requestImageMaxBytes: z.number().default(defaults.requestImageMaxBytes),
    }) as Schema<GatewayProfile>
}

/**
 * The namespace schema: one known route section per served gateway. Built from
 * {@link GATEWAYS} so adding a gateway cannot forget its settings section.
 */
export const Config: Schema<ProviderSettings> = z.object(
    Object.fromEntries(GATEWAYS.map((gateway) => [gateway.id, profileSchema(gateway)])),
) as Schema<ProviderSettings>

/** Clamp one positive byte/pixel budget, falling back when the value is unusable. */
function positiveInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return Math.floor(n)
}

/** Trim to a defined non-empty string, or undefined. */
function trimmed(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Normalize one declared model, dropping the fields it does not set so the merge
 * over the catalog stays field-by-field (an unset `contextWindow` must not
 * overwrite a catalog value with a default).
 * @param value - the stored entry, of unknown shape.
 * @returns the normalized declaration, or undefined when it names no id.
 */
function resolveDeclaration(value: unknown): ModelDeclaration | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const raw = value as Record<string, unknown>
    const id = trimmed(raw.id)
    if (id === undefined) return undefined
    const input = Array.isArray(raw.input)
        ? raw.input.filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
        : undefined
    return {
        id,
        ...(trimmed(raw.name) !== undefined ? { name: trimmed(raw.name)! } : {}),
        ...(trimmed(raw.api) !== undefined ? { api: trimmed(raw.api)! } : {}),
        ...(trimmed(raw.baseURL) !== undefined ? { baseURL: trimmed(raw.baseURL)! } : {}),
        ...(positiveInt(raw.contextWindow, 0) > 0 ? { contextWindow: positiveInt(raw.contextWindow, 0) } : {}),
        ...(positiveInt(raw.maxTokens, 0) > 0 ? { maxTokens: positiveInt(raw.maxTokens, 0) } : {}),
        ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
        ...(input !== undefined && input.length > 0 ? { input } : {}),
    }
}

/** Whether a normalized entry survived declaration normalization. */
function isDeclaration(value: ModelDeclaration | undefined): value is ModelDeclaration {
    return value !== undefined
}

/**
 * Merge one stored section over its gateway defaults, validating every field.
 * Never throws: a malformed value falls back to the shipped default, because a
 * hand-edited `settings.yaml` must not be able to disable a whole route.
 * @param gateway - the gateway the section belongs to.
 * @param input - the stored (or merged) section, of unknown shape.
 * @returns a fully materialized profile.
 */
export function resolveProfile(gateway: GatewayDefinition, input: unknown): GatewayProfile {
    const defaults = defaultProfile(gateway)
    const raw = (input ?? {}) as Partial<Record<keyof GatewayProfile, unknown>>
    const reasoning = REASONING_LEVELS.includes(raw.reasoning as ReasoningLevel)
        ? (raw.reasoning as ReasoningLevel)
        : defaults.reasoning
    return {
        apiKeyEnv: trimmed(raw.apiKeyEnv) ?? defaults.apiKeyEnv,
        // An explicitly cleared endpoint is meaningful: models carry their own
        // endpoint in the catalog, so '' defers to them instead of to a
        // hardcoded route default.
        baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim() : defaults.baseURL,
        models: Array.isArray(raw.models)
            ? [...new Set(raw.models.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
            : defaults.models,
        extraModels: Array.isArray(raw.extraModels) ? raw.extraModels.map(resolveDeclaration).filter(isDeclaration) : defaults.extraModels,
        sessionRouting: typeof raw.sessionRouting === 'boolean' ? raw.sessionRouting : defaults.sessionRouting,
        reasoning,
        maxRequestImageBytes: positiveInt(raw.maxRequestImageBytes, defaults.maxRequestImageBytes),
        requestImagePixelBudget: positiveInt(raw.requestImagePixelBudget, defaults.requestImagePixelBudget),
        requestImageMaxBytes: positiveInt(raw.requestImageMaxBytes, defaults.requestImageMaxBytes),
    }
}

/**
 * Resolve the whole namespace section: one profile per served route.
 * @param section - the resolved namespace value (schema defaults already applied).
 * @returns profiles keyed by route, in {@link GATEWAYS} order.
 */
export function resolveProfiles(section: unknown): ProviderSettings {
    const raw = (section ?? {}) as Record<string, unknown>
    const profiles: ProviderSettings = {}
    for (const gateway of GATEWAYS) profiles[gateway.id] = resolveProfile(gateway, raw[gateway.id])
    return profiles
}
