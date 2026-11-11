/**
 * Minimal ACP v1 client: newline-delimited JSON-RPC over a child process.
 *
 * Only what the provider needs is implemented: typed requests with timeouts
 * and cancellation, notifications, and agent→client requests. The child's
 * stdout is reserved for JSON-RPC; stderr is captured for diagnostics.
 *
 * @module @gitawego/dsh-llm-agy/acp-client
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { AcpMessage } from './protocol.ts'

/** A request exceeded its configured bound. */
export class AcpTimeoutError extends Error {
    constructor(method: string, timeoutMs: number) {
        super(`ACP ${method} timed out after ${timeoutMs} ms`)
        this.name = 'AcpTimeoutError'
    }
}

/** A request was withdrawn by the harness. */
export class AcpAbortError extends Error {
    constructor(method: string) {
        super(`ACP ${method} was aborted`)
        this.name = 'AcpAbortError'
    }
}

/** The agent process exited or could not be spawned. */
export class AcpProcessError extends Error {
    constructor(
        message: string,
        readonly exitCode: number | null,
        readonly signal: NodeJS.Signals | null,
        readonly stderr: string,
    ) {
        super(message)
        this.name = 'AcpProcessError'
    }
}

/** A JSON-RPC error returned by the agent. */
export class AcpRemoteError extends Error {
    constructor(
        message: string,
        readonly code: number,
        readonly data: unknown,
    ) {
        super(message)
        this.name = 'AcpRemoteError'
    }
}

/** Agent→client request handler. */
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown

/** Notification handler. */
export type AcpNotificationHandler = (method: string, params: unknown) => void

export interface AcpClientOptions {
    command: string[]
    cwd: string
    env?: Record<string, string>
    onNotification?: AcpNotificationHandler
    onRequest?: AcpRequestHandler
    onStderr?: (text: string) => void
    onProtocolError?: (line: string, error: unknown) => void
}

interface Pending {
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
    timer: NodeJS.Timeout
    cleanup: () => void
}

const STDERR_LIMIT = 8_192

/** One live ACP connection. */
export class AcpClient {
    private readonly child: ChildProcessWithoutNullStreams
    private readonly pending = new Map<string, Pending>()
    private stderr = ''
    private closed = false
    private nextId = 1
    private readonly readers: readline.Interface

    private constructor(
        child: ChildProcessWithoutNullStreams,
        private readonly options: AcpClientOptions,
    ) {
        this.child = child
        this.readers = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
        this.readers.on('line', (line) => this.onLine(line))
        child.stderr.on('data', (chunk: Buffer) => {
            this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-STDERR_LIMIT)
            this.options.onStderr?.(chunk.toString('utf8'))
        })
        child.on('error', (error) => {
            this.fail(new AcpProcessError(`could not run ACP command "${options.command.join(' ')}": ${error.message}`, null, null, this.stderr))
        })
        child.on('exit', (code, signal) => {
            this.fail(new AcpProcessError(`ACP agent exited (code ${String(code)}, signal ${String(signal)})`, code, signal, this.stderr))
        })
    }

    /** Spawn one ACP stdio server. */
    static spawn(options: AcpClientOptions): AcpClient {
        const [command, ...args] = options.command
        if (command === undefined) throw new Error('ACP command is empty')
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        // A persistent ACP session must not keep a one-shot harness process
        // alive after its turn. Pending requests still hold the event loop via
        // their timers; an idle child and its pipes do not.
        child.unref()
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
            ;(stream as unknown as { unref?: () => void }).unref?.()
        }
        return new AcpClient(child, options)
    }

    /** The child process id, useful for diagnostics. */
    get pid(): number | undefined {
        return this.child.pid
    }

    /** Captured stderr tail. */
    get stderrText(): string {
        return this.stderr
    }

    /** Whether the connection is usable. */
    get alive(): boolean {
        return !this.closed && this.child.exitCode === null && this.child.signalCode === null
    }

    /** Send one request and await its result. */
    request<T>(method: string, params: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
        if (!this.alive) {
            return Promise.reject(new AcpProcessError(`ACP agent is not running (${method})`, this.child.exitCode, this.child.signalCode, this.stderr))
        }
        if (signal?.aborted === true) return Promise.reject(new AcpAbortError(method))

        const id = this.nextId++
        const key = String(id)
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.settle(key)
                reject(new AcpTimeoutError(method, timeoutMs))
            }, timeoutMs)
            const onAbort = () => {
                this.settle(key)
                reject(new AcpAbortError(method))
            }
            signal?.addEventListener('abort', onAbort, { once: true })
            const cleanup = () => signal?.removeEventListener('abort', onAbort)
            this.pending.set(key, {
                resolve: (value) => resolve(value as T),
                reject,
                timer,
                cleanup,
            })
            try {
                this.send({ jsonrpc: '2.0', id, method, params })
            } catch (error) {
                this.settle(key)
                reject(error)
            }
        })
    }

    /** Send one notification (no response expected). */
    notify(method: string, params: unknown): void {
        if (!this.alive) return
        this.send({ jsonrpc: '2.0', method, params })
    }

    /** Close stdin and wait briefly for a clean exit. */
    async close(): Promise<void> {
        if (this.closed) return
        this.fail(new AcpProcessError('ACP client closed', this.child.exitCode, this.child.signalCode, this.stderr))
        this.closed = true
        try {
            this.readers.close()
        } catch {
            /* already closed */
        }
        try {
            this.child.stdin.end()
        } catch {
            /* already closed */
        }
        await new Promise<void>((resolve) => {
            if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve()
            const timer = setTimeout(() => {
                try {
                    this.child.kill('SIGKILL')
                } catch {
                    /* gone */
                }
                resolve()
            }, 1_000)
            this.child.once('exit', () => {
                clearTimeout(timer)
                resolve()
            })
        })
    }

    /** Reject every pending request and mark the connection closed. */
    private fail(error: Error): void {
        if (this.closed) return
        this.closed = true
        for (const [key, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.cleanup()
            pending.reject(error)
            this.pending.delete(key)
        }
    }

    /** Remove one pending entry. */
    private settle(key: string): void {
        const pending = this.pending.get(key)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        pending.cleanup()
        this.pending.delete(key)
    }

    /** Write one JSON-RPC frame. */
    private send(message: AcpMessage): void {
        if (this.closed) throw new Error('ACP client is closed')
        this.child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    /** Route one stdout line. */
    private onLine(line: string): void {
        const text = line.trim()
        if (text.length === 0) return
        let message: AcpMessage
        try {
            message = JSON.parse(text) as AcpMessage
        } catch (error) {
            this.options.onProtocolError?.(text, error)
            return
        }
        if (typeof message.method === 'string') {
            if (message.id !== undefined && message.id !== null) {
                void this.onAgentRequest(message)
            } else {
                this.options.onNotification?.(message.method, message.params)
            }
            return
        }
        if (message.id === undefined || message.id === null) return
        const pending = this.pending.get(String(message.id))
        if (pending === undefined) return
        this.settle(String(message.id))
        if (message.error !== undefined) {
            const code = typeof message.error.code === 'number' ? message.error.code : -32_000
            pending.reject(new AcpRemoteError(message.error.message ?? `ACP error ${code}`, code, message.error.data))
            return
        }
        pending.resolve(message.result)
    }

    /** Answer an agent→client request. */
    private async onAgentRequest(message: AcpMessage): Promise<void> {
        if (!this.alive) return
        const method = message.method!
        try {
            const result = await this.options.onRequest?.(method, message.params)
            if (result === undefined) {
                this.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32_601, message: `client method not supported: ${method}` },
                })
                return
            }
            this.send({ jsonrpc: '2.0', id: message.id, result })
        } catch (error) {
            if (!this.alive) return
            try {
                this.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
                })
            } catch {
                /* the process disappeared while answering */
            }
        }
    }
}
