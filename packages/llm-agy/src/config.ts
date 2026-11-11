/**
 * Plugin configuration for the `agy` ACP route.
 *
 * Every user-editable field is volatile: DSH 0.2 hands `apply` stable
 * references whose `.get()` answers the current layer, so a form write applies
 * to the next session without re-installing the plugin.
 *
 * There is deliberately no credential field. The provider's authentication is
 * the Antigravity CLI's own Google login. Multi-account support keeps account
 * refresh tokens in a plugin-owned 0600 store, never in this configuration.
 *
 * `models` is empty by default. An empty list means "discover the catalog from
 * `agy acp`"; a non-empty list is an explicit configuration override. No model
 * id, name, context window, output cap, or effort is shipped in code.
 *
 * @module @gitawego/dsh-llm-agy/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { defaultAccountsFile } from './accounts.ts'
import type { ConfiguredModel } from './catalog.ts'

/** Settings namespace shared with the loader entry id. */
export const AGY_SETTINGS_NAMESPACE = 'llm-agy'

/** Route key registered into `ctx.llm`. */
export const AGY_PROVIDER = 'agy'

/** Default ACP command. `agy acp` speaks ACP over stdio. */
export const DEFAULT_COMMAND = ['agy', 'acp'] as const

/** Default quota command; `/usage` prints the grouped plan buckets as JSON. */
export const DEFAULT_QUOTA_COMMAND = ['agy', '--print', '/usage', '--output-format', 'json'] as const

/** Default terminal-auth command used by the Add account flow. */
export const DEFAULT_LOGIN_COMMAND = ['agy', 'acp', '--login'] as const

/** Label used when the profile does not override it. */
export const DEFAULT_DISPLAY_NAME = 'Antigravity (agy ACP)'

/**
 * Model id used only when a caller omits one *and* the profile names none.
 * Empty means "use ACP's current model"; it is not a baked-in model.
 */
export const DEFAULT_MODEL = ''

/**
 * ACP mode the agent starts in. Free-form configuration: `agy` is the
 * authority on its mode vocabulary, and `AcpSession` validates the value
 * against the modes advertised by `session/new`.
 */
export type AgyMode = string

/** How an ACP permission request is answered. */
export type AgyPermissionMode = 'ask' | 'deny'

/** Fully materialized configuration used by one adapter operation. */
export interface ResolvedAgyConfig {
    /** Executable and arguments that start the ACP stdio server. */
    command: string[]
    /** Executable and arguments that print the plan quota as JSON. */
    quotaCommand: string[]
    /** Minutes a quota read stays authoritative in the settings card. */
    quotaRefreshMinutes: number
    /** Plugin-owned multi-account registry; empty resolves under the DSH home. */
    accountsFile: string
    /** Executable and arguments that start the interactive Google sign-in. */
    loginCommand: string[]
    /** Optional working-directory override; empty means the session's own cwd. */
    cwd: string
    /** Bound on spawn + initialize + session/new. */
    startupTimeoutMs: number
    /** Bound on one `session/prompt` turn. */
    promptTimeoutMs: number
    /** Idle lifetime of a persistent ACP session. */
    idleSessionMinutes: number
    /** Minutes a discovered model catalog stays authoritative. */
    discoveryMinutes: number
    /** Provider label for selectors and diagnostics. */
    displayName: string
    /** Model used when a caller omits one; empty means ACP's current model. */
    defaultModel: string
    /** Explicit model catalog override; empty means discover from ACP. */
    models: ConfiguredModel[]
    /** Declare image input and forward attachments as ACP image blocks. */
    imageInput: boolean
    /** ACP mode applied after `session/new`. */
    agentMode: AgyMode
    /** Approval policy for ACP tool permission requests. */
    permissionMode: AgyPermissionMode
    /** Text appended to the DSH system prompt before it is sent to ACP. */
    systemPromptSuffix: string
}

/** Configuration references the loader supplies to `apply`. */
export interface AgyConfigRefs {
    command: Volatile<string[]>
    quotaCommand: Volatile<string[]>
    quotaRefreshMinutes: Volatile<number>
    accountsFile: Volatile<string>
    loginCommand: Volatile<string[]>
    cwd: Volatile<string>
    startupTimeoutMs: Volatile<number>
    promptTimeoutMs: Volatile<number>
    idleSessionMinutes: Volatile<number>
    discoveryMinutes: Volatile<number>
    displayName: Volatile<string>
    defaultModel: Volatile<string>
    models: Volatile<ConfiguredModel[]>
    imageInput: Volatile<boolean>
    agentMode: Volatile<AgyMode>
    permissionMode: Volatile<AgyPermissionMode>
    systemPromptSuffix: Volatile<string>
}

/** The schema the settings form is generated from. */
export const Config: Schema = z.object({
    command: z.array(z.string()).default([...DEFAULT_COMMAND]).volatile(),
    quotaCommand: z.array(z.string()).default([...DEFAULT_QUOTA_COMMAND]).volatile(),
    quotaRefreshMinutes: z.number().default(5).volatile(),
    accountsFile: z.string().default('').volatile(),
    loginCommand: z.array(z.string()).default([...DEFAULT_LOGIN_COMMAND]).volatile(),
    cwd: z.string().default('').volatile(),
    startupTimeoutMs: z.number().default(15_000).volatile(),
    promptTimeoutMs: z.number().default(30 * 60_000).volatile(),
    idleSessionMinutes: z.number().default(30).volatile(),
    discoveryMinutes: z.number().default(10).volatile(),
    displayName: z.string().default(DEFAULT_DISPLAY_NAME).volatile(),
    defaultModel: z.string().default(DEFAULT_MODEL).volatile(),
    models: z
        .array(
            z.object({
                id: z.string(),
                name: z.string().default(''),
                description: z.string().default(''),
                contextWindow: z.number().default(0),
                maxTokens: z.number().default(0),
                efforts: z.array(z.string()).default([]),
                defaultEffort: z.string().default(''),
            }),
        )
        .default([])
        .volatile(),
    imageInput: z.boolean().default(true).volatile(),
    agentMode: z.string().default('default').volatile(),
    permissionMode: z.union(['ask', 'deny']).default('ask').volatile(),
    systemPromptSuffix: z.string().default('').volatile(),
})

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

/** Keep a positive, finite number, or drop it. */
function optionalPositive(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Accept only the closed permission vocabulary. */
function permissionMode(value: unknown, fallback: AgyPermissionMode): AgyPermissionMode {
    return value === 'ask' || value === 'deny' ? value : fallback
}

/** Normalize one configured model, dropping unusable entries. */
function configuredModel(value: unknown): ConfiguredModel | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const id = trimmed(raw.id)
    if (id === undefined) return undefined
    const name = trimmed(raw.name)
    const description = trimmed(raw.description)
    const contextWindow = optionalPositive(raw.contextWindow)
    const maxTokens = optionalPositive(raw.maxTokens)
    const efforts = Array.isArray(raw.efforts)
        ? raw.efforts.map(trimmed).filter((effort): effort is string => effort !== undefined)
        : []
    const defaultEffort = trimmed(raw.defaultEffort)
    return {
        id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    }
}

/**
 * Normalize one stored configuration over shipped defaults.
 * @param input - the stored section, of unknown shape.
 * @returns a fully materialized configuration.
 */
export function resolveConfig(input: unknown): ResolvedAgyConfig {
    const raw = (input ?? {}) as Partial<Record<keyof ResolvedAgyConfig, unknown>>
    const command = Array.isArray(raw.command)
        ? raw.command
              .filter((part): part is string => typeof part === 'string')
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
        : []
    const quotaCommand = Array.isArray(raw.quotaCommand)
        ? raw.quotaCommand
              .filter((part): part is string => typeof part === 'string')
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
        : []
    const loginCommand = Array.isArray(raw.loginCommand)
        ? raw.loginCommand
              .filter((part): part is string => typeof part === 'string')
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
        : []
    const models = Array.isArray(raw.models)
        ? raw.models.map(configuredModel).filter((model): model is ConfiguredModel => model !== undefined)
        : []
    return {
        command: command.length > 0 ? command : [...DEFAULT_COMMAND],
        quotaCommand: quotaCommand.length > 0 ? quotaCommand : [...DEFAULT_QUOTA_COMMAND],
        quotaRefreshMinutes: positive(raw.quotaRefreshMinutes, 5),
        accountsFile: trimmed(raw.accountsFile) ?? defaultAccountsFile(),
        loginCommand: loginCommand.length > 0 ? loginCommand : [...DEFAULT_LOGIN_COMMAND],
        cwd: trimmed(raw.cwd) ?? '',
        startupTimeoutMs: positive(raw.startupTimeoutMs, 15_000),
        promptTimeoutMs: positive(raw.promptTimeoutMs, 30 * 60_000),
        idleSessionMinutes: positive(raw.idleSessionMinutes, 30),
        discoveryMinutes: positive(raw.discoveryMinutes, 10),
        displayName: trimmed(raw.displayName) ?? DEFAULT_DISPLAY_NAME,
        defaultModel: trimmed(raw.defaultModel) ?? DEFAULT_MODEL,
        models,
        imageInput: raw.imageInput !== false,
        agentMode: trimmed(raw.agentMode) ?? 'default',
        permissionMode: permissionMode(raw.permissionMode, 'ask'),
        systemPromptSuffix: typeof raw.systemPromptSuffix === 'string' ? raw.systemPromptSuffix : '',
    }
}

/**
 * Read one stable configuration snapshot from the loader references.
 * @param config - the references, or undefined for a direct unit-test call.
 * @returns the resolved configuration.
 */
export function readConfig(config: AgyConfigRefs | undefined): ResolvedAgyConfig {
    if (config === undefined) return resolveConfig(undefined)
    return resolveConfig({
        command: config.command.get(),
        quotaCommand: config.quotaCommand.get(),
        quotaRefreshMinutes: config.quotaRefreshMinutes.get(),
        accountsFile: config.accountsFile.get(),
        loginCommand: config.loginCommand.get(),
        cwd: config.cwd.get(),
        startupTimeoutMs: config.startupTimeoutMs.get(),
        promptTimeoutMs: config.promptTimeoutMs.get(),
        idleSessionMinutes: config.idleSessionMinutes.get(),
        discoveryMinutes: config.discoveryMinutes.get(),
        displayName: config.displayName.get(),
        defaultModel: config.defaultModel.get(),
        models: config.models.get(),
        imageInput: config.imageInput.get(),
        agentMode: config.agentMode.get(),
        permissionMode: config.permissionMode.get(),
        systemPromptSuffix: config.systemPromptSuffix.get(),
    })
}
