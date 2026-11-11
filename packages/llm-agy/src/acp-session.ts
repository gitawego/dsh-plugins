/**
 * One live `agy acp` session.
 *
 * A session owns a child process, the ACP handshake, the model/effort/mode
 * configuration, and one serialized prompt at a time. The adapter pools these
 * per DSH session so `agy` retains its own conversation and tool history across
 * harness turns.
 *
 * @module @gitawego/dsh-plugins/../llm-agy/acp-session
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AcpClient, AcpAbortError } from './acp-client.ts'
import { sessionCatalog, type Catalog } from './catalog.ts'
import {
    asRecord,
    findConfigOption,
    selectOptions,
    type AcpContentBlock,
    type AcpInitializeResponse,
    type AcpNewSessionResponse,
    type AcpPromptResponse,
    type AcpRequestPermissionRequest,
    type AcpRequestPermissionResponse,
    type AcpSessionConfigOption,
    type AcpSessionUpdate,
} from './protocol.ts'

/** Narrow logging seam so the session can be tested without a Cordis logger. */
export interface SessionLogger {
    debug(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
}

/** No-op logger for direct adapter construction. */
export const silentLogger: SessionLogger = {
    debug() {},
    warn() {},
}

/** One agent→client permission request handler. */
export type PermissionHandler = (request: AcpRequestPermissionRequest) => Promise<AcpRequestPermissionResponse>

export interface OpenSessionOptions {
    command: string[]
    cwd: string
    systemPrompt?: string
    /** Required unless `configure` is false (catalog discovery). */
    model?: string
    effort?: string
    mode: string
    /** Set false for a read-only catalog probe. Defaults to true. */
    configure?: boolean
    startupTimeoutMs: number
    promptTimeoutMs: number
    onPermission: PermissionHandler
    logger?: SessionLogger
}

/** ACP's protocol version implemented here. */
const ACP_PROTOCOL_VERSION = 1

/** One configured ACP session. */
export class AcpSession {
    private tail: Promise<void> = Promise.resolve()
    private activeUpdate: ((update: AcpSessionUpdate) => void) | undefined
    private configOptions: AcpSessionConfigOption[]
    private closed = false
    private readonly client: AcpClient
    private readonly logger: SessionLogger

    private constructor(
        client: AcpClient,
        readonly sessionId: string,
        configOptions: AcpSessionConfigOption[],
        private readonly options: OpenSessionOptions,
    ) {
        this.client = client
        this.configOptions = configOptions
        this.logger = options.logger ?? silentLogger
    }

    /** Spawn, initialize, create a session, and apply the selected config. */
    static async open(options: OpenSessionOptions): Promise<AcpSession> {
        let sessionHolder: AcpSession | undefined
        const client = AcpClient.spawn({
            command: options.command,
            cwd: options.cwd,
            onNotification: (method, params) => {
                if (method === 'session/update') {
                    const record = asRecord(params)
                    const update = asRecord(record?.update)
                    if (update !== undefined) {
                        // The constructor is not available yet during the handshake,
                        // so route through a mutable holder installed below.
                        sessionHolder?.onUpdate(update as AcpSessionUpdate)
                    }
                }
            },
            onRequest: async (method, params) => {
                if (method === 'session/request_permission') {
                    const request = params as AcpRequestPermissionRequest
                    try {
                        return await options.onPermission(request)
                    } catch (error) {
                        options.logger?.warn('permission request failed: %s', String(error))
                        return { outcome: { outcome: 'cancelled' } } satisfies AcpRequestPermissionResponse
                    }
                }
                return undefined
            },
            onStderr: (text) => options.logger?.debug('agy acp stderr: %s', text.trim()),
            onProtocolError: (line, error) => options.logger?.warn('agy acp protocol error: %s (%s)', String(error), line.slice(0, 200)),
        })

        try {
            const init = await client.request<AcpInitializeResponse>(
                'initialize',
                {
                    protocolVersion: ACP_PROTOCOL_VERSION,
                    clientCapabilities: {
                        fs: { readTextFile: false, writeTextFile: false },
                        terminal: false,
                    },
                    clientInfo: { name: '@gitawego/dsh-llm-agy', version: '0.2.0' },
                },
                options.startupTimeoutMs,
            )
            if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
                throw new LlmError(
                    `Antigravity ACP speaks protocol ${init.protocolVersion}, but this adapter implements ${ACP_PROTOCOL_VERSION}`,
                    'INCOMPATIBLE_PROTOCOL',
                )
            }

            const params: Record<string, unknown> = { cwd: options.cwd, mcpServers: [] }
            if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
                params._meta = { antigravity: { systemPrompt: { append: options.systemPrompt } } }
            }
            const created = await client.request<AcpNewSessionResponse>('session/new', params, options.startupTimeoutMs)
            if (typeof created.sessionId !== 'string' || created.sessionId.length === 0) {
                throw new LlmError('Antigravity ACP returned no session id', 'MALFORMED_RESPONSE')
            }
            const session = new AcpSession(client, created.sessionId, created.configOptions ?? [], options)
            sessionHolder = session
            if (options.configure !== false) {
                if (options.model === undefined) {
                    throw new LlmError('Antigravity ACP requires a model for a configured session', 'UNKNOWN_MODEL')
                }
                await session.configure(options.model, options.effort, options.mode)
            }
            return session
        } catch (error) {
            await client.close()
            throw error
        }
    }

    /** The session id returned by ACP. */
    get id(): string {
        return this.sessionId
    }

    /** The command working directory. */
    get cwd(): string {
        return this.options.cwd
    }

    /** Whether the underlying process is still usable. */
    get alive(): boolean {
        return !this.closed && this.client.alive
    }

    /** Capture stderr for diagnostics. */
    get stderr(): string {
        return this.client.stderrText
    }

    /** The catalog this ACP session advertised. */
    catalog(): Catalog {
        return sessionCatalog(this.configOptions)
    }

    /** Route one `session/update`. */
    private onUpdate(update: AcpSessionUpdate): void {
        if (update.sessionUpdate === 'config_option_update') {
            const options = (update as { configOptions?: AcpSessionConfigOption[] }).configOptions
            if (Array.isArray(options)) this.configOptions = options
            return
        }
        this.activeUpdate?.(update)
    }

    /** Select the model, effort, and mode advertised by `session/new`. */
    async configure(model: string, effort: string | undefined, mode: string): Promise<void> {
        const modelOption = findConfigOption(this.configOptions, 'model', 'model')
        if (modelOption === undefined) {
            throw new LlmError('Antigravity ACP did not advertise a model selector', 'UNSUPPORTED_MODEL')
        }
        const values = selectOptions(modelOption).map((option) => option.value)
        if (values.length > 0 && !values.includes(model)) {
            throw new LlmError(
                `Antigravity ACP does not offer model "${model}". Available: ${values.join(', ')}`,
                'UNKNOWN_MODEL',
            )
        }
        await this.setOption(modelOption, model, true)

        if (effort !== undefined && effort.length > 0) {
            const effortOption = findConfigOption(this.configOptions, 'thought_level', 'thought_level')
            if (effortOption === undefined) {
                throw new LlmError(
                    `Antigravity ACP does not offer reasoning effort "${effort}"`,
                    'UNSUPPORTED_REASONING_EFFORT',
                )
            }
            const values = selectOptions(effortOption).map((option) => option.value)
            if (values.length > 0) {
                if (!values.includes(effort)) {
                    throw new LlmError(
                        `Antigravity ACP does not offer reasoning effort "${effort}". Available: ${values.join(', ')}`,
                        'UNSUPPORTED_REASONING_EFFORT',
                    )
                }
                await this.setOption(effortOption, effort, true)
            } else if (effortOption.currentValue !== effort) {
                throw new LlmError(
                    `Antigravity ACP advertises no selectable reasoning efforts (current: ${String(effortOption.currentValue)})`,
                    'UNSUPPORTED_REASONING_EFFORT',
                )
            }
        }

        const modeOption = findConfigOption(this.configOptions, 'mode', 'mode')
        if (modeOption !== undefined) {
            const values = selectOptions(modeOption).map((option) => option.value)
            if (values.length > 0) {
                if (!values.includes(mode)) {
                    throw new LlmError(
                        `Antigravity ACP does not offer mode "${mode}". Available: ${values.join(', ')}`,
                        'UNSUPPORTED_OPTION',
                    )
                }
                await this.setOption(modeOption, mode, true)
            } else if (modeOption.currentValue !== mode) {
                throw new LlmError(
                    `Antigravity ACP advertises no selectable modes (current: ${String(modeOption.currentValue)})`,
                    'UNSUPPORTED_OPTION',
                )
            }
        }
    }

    /** Apply one config value. */
    private async setOption(option: AcpSessionConfigOption, value: string, required: boolean): Promise<void> {
        if (option.currentValue === value) return
        try {
            const response = await this.client.request<{ configOptions?: AcpSessionConfigOption[] }>(
                'session/set_config_option',
                { sessionId: this.sessionId, configId: option.id, value },
                this.options.startupTimeoutMs,
            )
            if (Array.isArray(response?.configOptions)) this.configOptions = response.configOptions
            else option.currentValue = value
        } catch (error) {
            if (required) throw error
            this.logger.warn('agy acp could not set %s to %s: %s', option.id, value, String(error))
        }
    }

    /** Run one prompt turn, streaming updates through `onUpdate`. */
    async prompt(
        prompt: AcpContentBlock[],
        onUpdate: (update: AcpSessionUpdate) => void,
        signal?: AbortSignal,
    ): Promise<AcpPromptResponse> {
        const previous = this.tail
        let release: () => void = () => {}
        this.tail = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        if (!this.alive) {
            release()
            throw new AcpAbortError('session/prompt')
        }
        this.activeUpdate = onUpdate
        const onAbort = () => {
            this.client.notify('session/cancel', { sessionId: this.sessionId })
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
            const response = await this.client.request<AcpPromptResponse>(
                'session/prompt',
                { sessionId: this.sessionId, prompt },
                this.options.promptTimeoutMs,
                signal,
            )
            return response
        } finally {
            signal?.removeEventListener('abort', onAbort)
            this.activeUpdate = undefined
            release()
        }
    }

    /** Ask the agent to stop the active turn. */
    cancel(): void {
        if (!this.alive) return
        this.client.notify('session/cancel', { sessionId: this.sessionId })
    }

    /** Close the session and its process. */
    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        if (this.client.alive) {
            try {
                await this.client.request('session/close', { sessionId: this.sessionId }, 2_000)
            } catch {
                /* a dead or busy agent is closed by killing the process */
            }
        }
        await this.client.close()
    }
}
