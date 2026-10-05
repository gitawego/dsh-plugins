/**
 * The harness `LlmAdapter` for this plugin's routes.
 *
 * Structure follows the seam's contract: one adapter instance owns a fixed set
 * of routes, resolution reads a snapshot (the transport, built from one settings
 * profile per route), and `stream()` is a thin translation between the harness
 * request vocabulary and pi-ai. All wire knowledge lives in the transport; all
 * request/reply vocabulary conversion lives in `context.ts` / `stream.ts`. What
 * is left here is policy: credential lookup, model/reasoning resolution, and
 * failure classification.
 *
 * @module @gitawego/dsh-llm-provider/adapter
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
    contentHasImage,
    LlmAdapter,
    LlmError,
    type GenerateOptions,
    type LlmModelInfo,
    type LlmProviderInfo,
    type LlmResolvedModelInfo,
    type PreparedAdapterCall,
    type ReasoningEffortId,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
    getSupportedThinkingLevels,
    type Api,
    type Model,
    type ModelThinkingLevel,
    type ThinkingLevel,
} from '@earendil-works/pi-ai'
import type { GatewayProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'
import { LlmUnavailableError, type GatewayTransport } from './transport.ts'

/** Everything the adapter needs from the plugin's composition. */
export interface GatewayAdapterOptions {
    /** Built transport for the plugin's routes. */
    transport: GatewayTransport
    /** Display name for one route. */
    displayName: (route: string) => string
    /** The current resolved profile for one route. */
    profileOf: (route: string) => GatewayProfile
    /**
     * Resolve the route's credential through the harness credential seam.
     * `undefined` leaves authentication to pi-ai's own ambient provider auth
     * (the gateway's `OPENCODE_API_KEY` environment variable).
     */
    resolveApiKey: (route: string) => Promise<string | undefined>
    /** The mounted attachment store, when the composition has one. */
    resolveAttachments?: () => AttachmentStore | undefined
}

/** Translate one pi-ai model into the harness's advisory catalog entry. */
function modelInfo(route: string, model: Model<Api>): LlmModelInfo {
    return {
        provider: route,
        id: model.id,
        name: model.name,
        ...(model.input.length > 0 ? { inputModalities: [...model.input] } : {}),
    }
}

/**
 * The reasoning metadata for one exact model.
 *
 * A model pi-ai does not mark reasoning-capable is reported with no reasoning
 * information at all rather than with `off`: `off` means "omit the reasoning
 * option", which for such a model is byte-for-byte the request it already
 * sends, so offering it would present a control that cannot change anything.
 * @param model - the resolved pi-ai model.
 * @param configured - the profile's default level, already validated.
 * @returns the harness reasoning info, or an empty object when none applies.
 */
function reasoningInfo(model: Model<Api>, configured: ModelThinkingLevel | undefined): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
    if (!model.reasoning) return {}
    const levels = getSupportedThinkingLevels(model)
    return {
        reasoning: {
            efforts: levels.map((level) => ({
                id: level as unknown as ReasoningEffortId,
                name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
            })),
            ...(configured !== undefined && levels.includes(configured) ? { defaultEffort: configured as unknown as ReasoningEffortId } : {}),
        },
    }
}

/**
 * The adapter serving this plugin's routes.
 *
 * Registered once, disposed with the plugin's fiber; its routes never change,
 * because a route is a gateway definition rather than a settings fact.
 */
export class GatewayAdapter extends LlmAdapter {
    private readonly options: GatewayAdapterOptions

    /**
     * @param options - transport, profile lookup, and credential resolution.
     */
    constructor(options: GatewayAdapterOptions) {
        super()
        this.options = options
    }

    /** @inheritdoc */
    override providerInfo(provider: string): LlmProviderInfo {
        return { id: provider, name: this.options.displayName(provider) }
    }

    /** @inheritdoc */
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        return Promise.resolve(this.options.transport.listModels(provider).map((model) => modelInfo(provider, model)))
    }

    /** @inheritdoc */
    override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
        // Declared async so a failure is a rejected promise, not a synchronous
        // throw through a promise-returning seam.
        return this.describe(provider, model)
    }

    /** @inheritdoc */
    override async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
        return {
            model: await this.describe(provider, model),
            stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => this.stream(options),
        }
    }

    /** @inheritdoc */
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const profile = this.options.profileOf(options.provider)
        if (options.stop !== undefined && options.stop.length > 0) {
            // pi-ai's common streaming surface cannot guarantee stop sequences
            // across providers, so honoring this silently would be a lie.
            throw new LlmError('llm-provider does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
        }
        const model = this.requireModel(options.provider, options.model)
        const reasoning = this.resolveReasoning(model, options.reasoningEffort, profile)
        const apiKey = await this.options.resolveApiKey(options.provider)

        const hasImage = options.messages.some((message) => contentHasImage(message.content))
        const attachments = hasImage ? this.options.resolveAttachments?.() : undefined
        if (hasImage && attachments === undefined) {
            throw new LlmError('llm-provider image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
        }
        if (hasImage && !model.input.includes('image')) {
            throw new LlmError(`model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
        }

        const context = await toPiContext(
            options,
            hasImage,
            attachments === undefined ? undefined : { attachments, profile, ...(options.signal ? { signal: options.signal } : {}) },
        )

        let events: AsyncIterable<Parameters<typeof toStreamChunks>[0] extends AsyncIterable<infer E> ? E : never>
        try {
            events = this.options.transport.stream(options.provider, options.model, context, {
                ...(apiKey !== undefined ? { apiKey } : {}),
                ...(reasoning !== undefined ? { reasoning } : {}),
                ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                ...(options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {}),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                // The adapter owns retry policy through dsh-llm-retry, so pi-ai's
                // own retry loop must not multiply attempts behind its back.
                maxRetries: 0,
            })
        } catch (error) {
            throw this.normalize(error, options.provider, options.model)
        }

        yield* toStreamChunks(events, model.contextWindow, options.signal)
    }

    /** Resolve one exact model or fail with the seam's stable code. */
    private requireModel(provider: string, modelId: string): Model<Api> {
        const model = this.options.transport.getModel(provider, modelId)
        if (model === undefined) {
            throw new LlmError(`llm-provider route "${provider}" does not serve model "${modelId}"`, 'UNKNOWN_MODEL')
        }
        return model
    }

    /** Build the harness model descriptor for one exact route/model pair. */
    private async describe(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
        const model = this.requireModel(provider, modelId)
        const profile = this.options.profileOf(provider)
        const configured = this.profileReasoningLevel(model, profile)
        return {
            ...modelInfo(provider, model),
            context: { contextWindow: model.contextWindow },
            ...(model.maxTokens > 0 ? { defaultMaxTokens: model.maxTokens } : {}),
            ...reasoningInfo(model, configured),
        }
    }

    /** The profile's reasoning default, when this model can actually take it. */
    private profileReasoningLevel(model: Model<Api>, profile: GatewayProfile): ModelThinkingLevel | undefined {
        if (profile.reasoning === '' || profile.reasoning === 'off') return undefined
        return getSupportedThinkingLevels(model).includes(profile.reasoning) ? profile.reasoning : undefined
    }

    /**
     * Resolve the request's reasoning effort.
     * @param model - exact model.
     * @param requested - caller's explicit effort, when any.
     * @param profile - the route profile supplying the configured default.
     * @returns the pi-ai level, or undefined to leave the provider default.
     */
    private resolveReasoning(model: Model<Api>, requested: ReasoningEffortId | undefined, profile: GatewayProfile): ThinkingLevel | undefined {
        const level = requested !== undefined ? String(requested) : profile.reasoning
        if (level === '' || level === 'off') return undefined
        if (!getSupportedThinkingLevels(model).includes(level as ModelThinkingLevel)) {
            throw new LlmError(
                `model "${model.id}" does not support reasoning effort "${level}"`,
                'UNSUPPORTED_REASONING_EFFORT',
            )
        }
        return level as ThinkingLevel
    }

    /** Turn a transport failure into a harness-typed failure. */
    private normalize(error: unknown, provider: string, model: string): LlmError {
        if (error instanceof LlmError) return error
        if (error instanceof LlmUnavailableError) {
            return new LlmError(error.message, 'UNKNOWN_MODEL', { cause: error })
        }
        const message = error instanceof Error ? error.message : String(error)
        return new LlmError(`llm-provider request for "${provider}/${model}" failed: ${message}`, 'TRANSPORT', { cause: error })
    }
}

