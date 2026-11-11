/**
 * `LlmAdapter` for the `agy` route.
 *
 * The route is an agent-delegate: `agy` runs its own tools in the session's
 * working directory, while the harness sees text and reasoning only. DSH tool
 * schemas are intentionally ignored; ACP tool notifications describe work the
 * agent already performed and must not become DSH tool calls.
 *
 * Sessions are persistent per DSH session id, serialized by `AcpSession`, and
 * expired after an idle interval. A failed or aborted session is dropped so the
 * next turn starts a clean process.
 *
 * @module @gitawego/dsh-llm-agy/adapter
 */
import {
    LlmAdapter,
    LlmError,
    ReasoningEffortId,
    ToolCallId,
    type GenerateOptions,
    type ImageBlock,
    type LlmModelInfo,
    type LlmProviderInfo,
    type LlmResolvedModelInfo,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { AcpSession, type PermissionHandler, type SessionLogger } from './acp-session.ts'
import { configCatalog, type Catalog, type CatalogModel } from './catalog.ts'
import type { ResolvedAgyConfig } from './config.ts'
import { classifyAcpError } from './errors.ts'
import { buildPrompt, buildPromptContent, systemPromptOf, systemUpdateText, type PromptImage } from './messages.ts'
import { permissionReason, permissionResponse, permissionToolName } from './permissions.ts'
import type { AcpContentBlock, AcpRequestPermissionRequest } from './protocol.ts'
import { ChunkTranslator } from './stream.ts'

/** The harness seam the adapter needs; kept narrow for direct tests. */
export interface AgyHost {
    logger: SessionLogger
    resolveCwd(sessionId?: string): string
    /** Resolve one durable attachment to request bytes for an ACP image block. */
    readImage(ref: ImageBlock['attachment'], signal?: AbortSignal): Promise<PromptImage>
    requestApproval(input: {
        sessionId?: string
        toolName: string
        callId?: ReturnType<typeof ToolCallId>
        reason?: string
        signal?: AbortSignal
    }): Promise<ApprovalOutcome>
}

export interface AgyAdapterOptions {
    host: AgyHost
    config: () => ResolvedAgyConfig
    /** Epoch that changes when the active Antigravity account changes. */
    accountEpoch?: () => number
}

interface SessionEntry {
    session: AcpSession
    delivered: Set<string>
    systemPrompt?: string
    state: { signal?: AbortSignal }
    lastUsed: number
    idleTimer?: NodeJS.Timeout
    transient: boolean
    model: string
    effort?: string
    mode: string
    epoch: number
}

/** A single-consumer async queue used to bridge callback updates into a generator. */
class AsyncQueue<T> implements AsyncIterable<T> {
    private readonly values: T[] = []
    private readonly waiters: Array<{
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
    }> = []
    private done = false
    private failure: unknown

    push(value: T): void {
        const waiter = this.waiters.shift()
        if (waiter !== undefined) waiter.resolve({ value, done: false })
        else this.values.push(value)
    }

    end(): void {
        this.done = true
        for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true })
    }

    fail(error: unknown): void {
        this.failure = error
        for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                if (this.values.length > 0) return Promise.resolve({ value: this.values.shift()!, done: false })
                if (this.failure !== undefined) return Promise.reject(this.failure)
                if (this.done) return Promise.resolve({ value: undefined as T, done: true })
                return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }))
            },
        }
    }
}

/** Map one catalog entry to the list-model shape. */
function modelInfo(model: CatalogModel, imageInput: boolean): LlmModelInfo {
    return {
        provider: 'agy',
        id: model.id,
        name: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
        inputModalities: imageInput ? ['text', 'image'] : ['text'],
    }
}

/** Resolve one model with only the metadata the catalog actually carries. */
function resolvedModel(model: CatalogModel, imageInput: boolean): LlmResolvedModelInfo {
    return {
        ...modelInfo(model, imageInput),
        ...(model.contextWindow !== undefined ? { context: { contextWindow: model.contextWindow } } : {}),
        ...(model.maxTokens !== undefined ? { defaultMaxTokens: model.maxTokens } : {}),
        ...(model.efforts.length > 0
            ? {
                  reasoning: {
                      efforts: model.efforts.map((effort) => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
                      ...(model.defaultEffort !== undefined
                          ? { defaultEffort: ReasoningEffortId(model.defaultEffort) }
                          : {}),
                  },
              }
            : {}),
    }
}

/** The adapter registered for the `agy` route. */
export class AgyAdapter extends LlmAdapter {
    private readonly entries = new Map<string, Promise<SessionEntry>>()
    private readonly live = new Set<AcpSession>()
    private readonly host: AgyHost
    private readonly config: () => ResolvedAgyConfig
    private readonly accountEpoch: () => number
    private catalogCache?: { key: string; at: number; value: Catalog }
    private catalogPending?: { key: string; promise: Promise<Catalog> }
    private disposed = false

    constructor(options: AgyAdapterOptions) {
        super()
        this.host = options.host
        this.config = options.config
        this.accountEpoch = options.accountEpoch ?? (() => 0)
    }

    override providerInfo(provider: string): LlmProviderInfo {
        return { id: provider, name: this.config().displayName }
    }

    override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        if (provider !== 'agy') return []
        const catalog = await this.catalog()
        const imageInput = this.config().imageInput
        return catalog.models.map((model) => modelInfo(model, imageInput))
    }

    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        if (provider !== 'agy') {
            throw new LlmError(`unknown provider "${provider}"`, 'UNKNOWN_MODEL')
        }
        const catalog = await this.catalog()
        const found = catalog.models.find((entry) => entry.id === model)
        if (found === undefined) {
            throw new LlmError(
                `unknown Antigravity model "${model}". Available: ${catalog.models.map((entry) => entry.id).join(', ') || '(none discovered)'}`,
                'UNKNOWN_MODEL',
            )
        }
        return resolvedModel(found, this.config().imageInput)
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.provider !== 'agy') {
            throw new LlmError(`unknown provider "${options.provider}"`, 'UNKNOWN_MODEL')
        }
        const config = this.config()
        let modelId = options.model.trim().length > 0 ? options.model : config.defaultModel
        if (modelId.length === 0) {
            const catalog = await this.catalog()
            modelId = catalog.currentModel ?? catalog.models[0]?.id ?? ''
        }
        if (modelId.length === 0) {
            throw new LlmError('Antigravity ACP advertised no model and the profile names none', 'UNKNOWN_MODEL')
        }
        const effort = options.reasoningEffort
        const system = this.systemPrompt(options, config)
        const cwd = this.host.resolveCwd(options.sessionId)
        const transient = options.sessionId === undefined || options.purpose !== undefined
        const key = `${options.sessionId ?? 'anonymous'}#${options.purpose ?? 'chat'}`
        let entry: SessionEntry
        try {
            entry = transient
                ? await this.openEntry({ config, model: modelId, effort, system, cwd, transient: true, permissionSignal: undefined })
                : await this.acquire(key, { config, model: modelId, effort, system, cwd })
        } catch (error) {
            throw classifyAcpError(error)
        }

        const translator = new ChunkTranslator()
        const queue = new AsyncQueue<StreamChunk>()
        const controller = new AbortController()
        const linked = linkSignals(options.signal, controller.signal)
        const signal = linked.signal
        let settled = false
        let failed = false

        let content: AcpContentBlock[]
        let deliveredIds: string[]
        if (config.imageInput) {
            const built = await buildPromptContent(
                options,
                entry.delivered,
                (ref, readSignal) => this.host.readImage(ref, readSignal),
                signal,
            )
            content = built.content
            deliveredIds = built.deliveredIds
            if (entry.delivered.size > 0 && system !== undefined && entry.systemPrompt !== system) {
                content.unshift({ type: 'text', text: systemUpdateText(system) })
            }
        } else {
            const built = buildPrompt(options, entry.delivered)
            let promptText = built.text
            if (entry.delivered.size > 0 && system !== undefined && entry.systemPrompt !== system) {
                promptText = `${systemUpdateText(system)}\n\n${promptText}`
            }
            content = [{ type: 'text', text: promptText }]
            deliveredIds = built.deliveredIds
        }
        if (content.length === 0) content.push({ type: 'text', text: 'Continue.' })

        entry.state.signal = signal
        const prompt = entry.session.prompt(
            content,
            (update) => {
                try {
                    for (const chunk of translator.update(update)) queue.push(chunk)
                } catch (error) {
                    queue.fail(error)
                }
            },
            signal,
        )

        prompt.then(
            (response) => {
                try {
                    const finished = translator.finish(response)
                    const aborted = finished.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'aborted')
                    for (const chunk of finished) queue.push(chunk)
                    for (const id of deliveredIds) entry.delivered.add(id)
                    entry.systemPrompt = system
                    entry.lastUsed = Date.now()
                    if (aborted) failed = true
                    else if (!entry.transient) this.scheduleIdle(key, entry)
                    settled = true
                    queue.end()
                } catch (error) {
                    settled = true
                    failed = true
                    queue.fail(classifyAcpError(error))
                }
            },
            (error: unknown) => {
                settled = true
                failed = true
                queue.fail(classifyAcpError(error))
            },
        )

        try {
            for await (const chunk of queue) yield chunk
        } finally {
            linked.dispose()
            entry.state.signal = undefined
            if (!settled) {
                controller.abort()
                await this.drop(key, entry)
            } else if (failed || entry.transient || !entry.session.alive) {
                await this.drop(key, entry)
            }
        }
    }

    /**
     * Resolve the model catalog. Configuration wins when present; otherwise the
     * catalog is read from one short-lived `agy acp` session and cached for the
     * configured discovery window.
     */
    private async catalog(): Promise<Catalog> {
        const config = this.config()
        if (config.models.length > 0) return configCatalog(config.models, config.defaultModel)

        const key = JSON.stringify({
            command: config.command,
            cwd: config.cwd,
            discoveryMinutes: config.discoveryMinutes,
        })
        if (this.catalogCache?.key === key && Date.now() - this.catalogCache.at < config.discoveryMinutes * 60_000) {
            return this.catalogCache.value
        }
        if (this.catalogPending?.key === key) return this.catalogPending.promise

        const pending = this.discover(config)
        this.catalogPending = { key, promise: pending }
        try {
            const value = await pending
            this.catalogCache = { key, at: Date.now(), value }
            return value
        } finally {
            if (this.catalogPending?.promise === pending) this.catalogPending = undefined
        }
    }

    /** Open a throwaway ACP session and read its advertised catalog. */
    private async discover(config: ResolvedAgyConfig): Promise<Catalog> {
        let session: AcpSession | undefined
        try {
            session = await AcpSession.open({
                command: config.command,
                cwd: config.cwd || process.cwd(),
                configure: false,
                mode: config.agentMode,
                startupTimeoutMs: config.startupTimeoutMs,
                promptTimeoutMs: config.promptTimeoutMs,
                onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
                logger: this.host.logger,
            })
            return session.catalog()
        } catch (error) {
            throw classifyAcpError(error)
        } finally {
            await session?.close().catch(() => {})
        }
    }

    /** Close every pooled session. */
    async dispose(): Promise<void> {
        this.disposed = true
        this.catalogCache = undefined
        this.catalogPending = undefined
        const entries = [...this.entries.values()]
        this.entries.clear()
        await Promise.all(
            entries.map(async (entry) => {
                try {
                    const resolved = await entry
                    clearTimeout(resolved.idleTimer)
                    await resolved.session.close()
                } catch {
                    /* an entry that failed to open has nothing to close */
                }
            }),
        )
        const live = [...this.live]
        this.live.clear()
        await Promise.all(live.map((session) => session.close().catch(() => {})))
    }

    /** Compose the effective system prompt sent through ACP's `_meta` slot. */
    private systemPrompt(options: GenerateOptions, config: ResolvedAgyConfig): string | undefined {
        const base = systemPromptOf(options)
        const suffix = config.systemPromptSuffix.trim()
        if (base === undefined) return suffix.length > 0 ? suffix : undefined
        return suffix.length > 0 ? `${base}\n\n${suffix}` : base
    }

    /** Resolve one pooled session, replacing a dead one. */
    private async acquire(
        key: string,
        input: {
            config: ResolvedAgyConfig
            model: string
            effort: string | undefined
            system: string | undefined
            cwd: string
        },
    ): Promise<SessionEntry> {
        const existing = this.entries.get(key)
        if (existing !== undefined) {
            let entry: SessionEntry | undefined
            try {
                entry = await existing
                if (entry.session.alive && entry.epoch !== this.accountEpoch()) {
                    // The account changed under this ACP server; its authenticated
                    // transport still belongs to the previous login. Drop it and
                    // replay the transcript into a new process.
                    await this.drop(key, entry)
                } else if (entry.session.alive) {
                    if (entry.session.cwd !== input.cwd) {
                        // A DSH `cd` cannot move an already-spawned agent; start a
                        // fresh ACP session and replay the harness transcript.
                        await this.drop(key, entry)
                    } else {
                        if (entry.model !== input.model || entry.effort !== input.effort || entry.mode !== input.config.agentMode) {
                            await entry.session.configure(input.model, input.effort, input.config.agentMode)
                            entry.model = input.model
                            entry.effort = input.effort
                            entry.mode = input.config.agentMode
                        }
                        return entry
                    }
                }
            } catch {
                /* A dead or misconfigured session is replaced, never reused. */
                if (entry !== undefined) await this.drop(key, entry)
            }
            this.entries.delete(key)
        }
        const pending = this.openEntry({ ...input, transient: false, permissionSignal: undefined })
        this.entries.set(key, pending)
        try {
            return await pending
        } catch (error) {
            if (this.entries.get(key) === pending) this.entries.delete(key)
            throw error
        }
    }

    /** Open one ACP session and install its permission bridge. */
    private async openEntry(input: {
        config: ResolvedAgyConfig
        model: string
        effort: string | undefined
        system: string | undefined
        cwd: string
        transient: boolean
        permissionSignal: AbortSignal | undefined
    }): Promise<SessionEntry> {
        if (this.disposed) throw new LlmError('Antigravity provider is disposed', 'DISPOSED')
        const state: { signal?: AbortSignal } = { signal: input.permissionSignal }
        const onPermission: PermissionHandler = async (request: AcpRequestPermissionRequest) => {
            if (this.config().permissionMode === 'deny') return { outcome: { outcome: 'cancelled' } }
            const toolCall = request.toolCall
            const outcome = await this.host.requestApproval({
                toolName: permissionToolName(toolCall),
                ...(typeof toolCall.toolCallId === 'string' && toolCall.toolCallId.length > 0
                    ? { callId: ToolCallId(toolCall.toolCallId) }
                    : {}),
                ...(permissionReason(toolCall) !== undefined ? { reason: permissionReason(toolCall) } : {}),
                ...(state.signal !== undefined ? { signal: state.signal } : {}),
            })
            return permissionResponse(request, outcome)
        }

        const session = await AcpSession.open({
            command: input.config.command,
            cwd: input.cwd,
            ...(input.system !== undefined ? { systemPrompt: input.system } : {}),
            model: input.model,
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            mode: input.config.agentMode,
            startupTimeoutMs: input.config.startupTimeoutMs,
            promptTimeoutMs: input.config.promptTimeoutMs,
            onPermission,
            logger: this.host.logger,
        })
        this.live.add(session)
        return {
            session,
            delivered: new Set<string>(),
            ...(input.system !== undefined ? { systemPrompt: input.system } : {}),
            state,
            lastUsed: Date.now(),
            transient: input.transient,
            model: input.model,
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            mode: input.config.agentMode,
            epoch: this.accountEpoch(),
        }
    }

    /** Arm or re-arm one session's idle expiry. */
    private scheduleIdle(key: string, entry: SessionEntry): void {
        if (entry.transient) return
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
        const minutes = this.config().idleSessionMinutes
        entry.idleTimer = setTimeout(() => {
            if (key.length > 0) this.entries.delete(key)
            this.live.delete(entry.session)
            void entry.session.close()
        }, minutes * 60_000)
        entry.idleTimer.unref?.()
    }

    /** Close and forget one session. */
    private async drop(key: string, entry: SessionEntry): Promise<void> {
        if (key.length > 0) this.entries.delete(key)
        clearTimeout(entry.idleTimer)
        this.live.delete(entry.session)
        await entry.session.close().catch(() => {})
    }
}

/** Link two abort signals without requiring `AbortSignal.any` at compile time. */
function linkSignals(first: AbortSignal | undefined, second: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    if (first === undefined) return { signal: second, dispose() {} }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (first.aborted || second.aborted) {
        controller.abort()
        return { signal: controller.signal, dispose() {} }
    }
    first.addEventListener('abort', abort, { once: true })
    second.addEventListener('abort', abort, { once: true })
    return {
        signal: controller.signal,
        dispose() {
            first.removeEventListener('abort', abort)
            second.removeEventListener('abort', abort)
        },
    }
}
