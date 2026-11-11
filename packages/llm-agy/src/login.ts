/**
 * `agy acp --login` as a browser-assisted sign-in flow.
 *
 * In terminal-auth mode the CLI prints a Google OAuth URL and waits on stdin
 * for either the authorization code or the final callback URL. This module
 * turns that exchange into a start/submit/cancel handle the settings card can
 * drive: the URL comes back to the browser, the user pastes the code, and the
 * handle writes it to the still-running CLI process.
 *
 * Nothing here stores a credential. The CLI writes its own login to the
 * keyring; the account manager reads it back after the process exits.
 *
 * @module @gitawego/dsh-llm-agy/login
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** One pending sign-in. */
export interface AgyLoginHandle {
    id: string
    url: string
    /** Write the authorization code and wait for the CLI to finish. */
    submit(code: string): Promise<void>
    /** Stop the CLI; a pending {@link submit} then rejects. */
    cancel(): void
    /** Whether the CLI process has exited. */
    readonly done: boolean
}

/** Options for a login launch. */
export interface AgyLoginOptions {
    command: readonly string[]
    cwd: string
    env?: NodeJS.ProcessEnv
    startTimeoutMs?: number
    submitTimeoutMs?: number
    /** Test hook; receives bounded diagnostic text, never the submitted code. */
    onLog?: (text: string) => void
}

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g
const GOOGLE_URL = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/u
const MAX_TEXT = 32_768

/** Strip terminal control sequences for messages and URL extraction. */
function clean(text: string): string {
    return text.replace(ANSI, '')
}

/** Remove trailing punctuation a terminal renderer may add. */
function cleanUrl(url: string): string {
    return url.replace(/[),.;]+$/u, '')
}

/** Extract a code from a pasted callback URL, or return the trimmed value. */
export function authorizationCodeOf(input: string): string {
    const value = input.trim()
    if (value.length === 0) return ''
    if (/^https?:\/\//iu.test(value)) {
        try {
            return new URL(value).searchParams.get('code')?.trim() ?? ''
        } catch {
            return ''
        }
    }
    return value
}

/** Reject a start with the CLI's diagnostics. */
function diagnostic(stdout: string, stderr: string): string {
    const text = clean(`${stderr}\n${stdout}`).trim()
    return text.length > 0 ? text.slice(-2_000) : 'the login process produced no diagnostics'
}

/**
 * Start `agy acp --login` and wait for its OAuth URL.
 * @param options - command, cwd, timeouts, and logging.
 * @returns a handle that is waiting for the authorization code.
 * @throws when the process cannot start, exits early, or never prints a URL.
 */
export async function startAgyLogin(options: AgyLoginOptions): Promise<AgyLoginHandle> {
    if (options.command.length === 0) throw new Error('login command is empty')
    const [bin, ...args] = options.command
    const startTimeoutMs = options.startTimeoutMs ?? 20_000
    const submitTimeoutMs = options.submitTimeoutMs ?? 120_000
    const child: ChildProcessWithoutNullStreams = spawn(bin!, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let exited = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let spawnError: Error | undefined
    let url: string | undefined
    let startSettled = false

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => {
            exited = true
            exitCode = code
            exitSignal = signal
            resolve({ code, signal })
        })
    })

    const waitExit = (timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
        if (exited) {
            if (exitCode === 0) resolve()
            else reject(new Error(`agy login exited (code ${String(exitCode)}, signal ${String(exitSignal)}): ${diagnostic(stdout, stderr)}`))
            return
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error(`agy login timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        timer.unref?.()
        void exitPromise.then(() => {
            clearTimeout(timer)
            if (exitCode === 0) resolve()
            else reject(new Error(`agy login exited (code ${String(exitCode)}, signal ${String(exitSignal)}): ${diagnostic(stdout, stderr)}`))
        })
    })

    const handle: AgyLoginHandle = {
        id: randomUUID(),
        get url() {
            return url ?? ''
        },
        get done() {
            return exited
        },
        async submit(input: string) {
            if (exited) throw new Error(`agy login already exited (code ${String(exitCode)})`)
            const code = authorizationCodeOf(input)
            if (code.length === 0) throw new Error('authorization code is empty')
            try {
                child.stdin.write(`${code}\n`)
            } catch {
                throw new Error('agy login is no longer accepting input')
            }
            await waitExit(submitTimeoutMs)
        },
        cancel() {
            if (!exited) child.kill('SIGTERM')
            setTimeout(() => {
                if (!exited) child.kill('SIGKILL')
            }, 2_000).unref?.()
        },
    }

    const startPromise = new Promise<AgyLoginHandle>((resolve, reject) => {
        const timer = setTimeout(() => {
            if (startSettled) return
            startSettled = true
            child.kill('SIGKILL')
            reject(new Error(`agy login did not print a Google URL within ${startTimeoutMs} ms: ${diagnostic(stdout, stderr)}`))
        }, startTimeoutMs)
        timer.unref?.()

        const finish = (error?: Error): void => {
            if (startSettled) return
            startSettled = true
            clearTimeout(timer)
            if (error !== undefined) reject(error)
            else resolve(handle)
        }

        child.on('error', (error) => {
            spawnError = error
            options.onLog?.(error.message)
            finish(new Error(`failed to start agy login: ${error.message}`))
        })
        child.stdout.on('data', (chunk: Buffer) => {
            stdout = `${stdout}${chunk.toString('utf8')}`.slice(-MAX_TEXT)
            options.onLog?.(clean(chunk.toString('utf8')))
            if (url !== undefined) return
            const match = clean(stdout).match(GOOGLE_URL)
            if (match !== null) {
                url = cleanUrl(match[0])
                finish()
            }
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_TEXT)
            options.onLog?.(clean(chunk.toString('utf8')))
        })
        void exitPromise.then(() => {
            if (url === undefined) {
                finish(new Error(`agy login exited before printing a URL${spawnError !== undefined ? '' : `: ${diagnostic(stdout, stderr)}`}`))
            }
        })
    })

    return startPromise
}
