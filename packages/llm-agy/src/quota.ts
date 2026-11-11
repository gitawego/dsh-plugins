/**
 * Antigravity plan quota from `agy --print /usage --output-format json`.
 *
 * The CLI exposes the same `retrieveUserQuotaSummary` payload the Antigravity
 * UI renders: groups (Gemini, Claude/GPT, Argon) with weekly and five-hour
 * buckets carrying a remaining fraction and reset time. The command does not
 * send a model prompt and returns no account identity.
 *
 * @module @gitawego/dsh-llm-agy/quota
 */
import { spawn } from 'node:child_process'

/** One quota bucket. */
export interface AgyQuotaWindow {
    id: string
    group: string
    label: string
    window: string
    percentRemaining: number
    percentUsed: number
    resetsAt?: string
    description?: string
    status: 'ok' | 'exhausted'
}

/** One quota read. */
export interface AgyQuota {
    windows: AgyQuotaWindow[]
    fetchedAt: number
    error?: string
}

/** One entry in the CLI's usage report. */
interface UsageReport {
    status?: unknown
    command?: {
        data?: {
            groups?: UsageGroup[]
        }
    }
}

interface UsageGroup {
    name?: unknown
    buckets?: UsageBucket[]
}

interface UsageBucket {
    id?: unknown
    name?: unknown
    window?: unknown
    remaining_fraction?: unknown
    reset_time?: unknown
    description?: unknown
}

/** Finite number, or undefined. */
function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Non-empty string, or undefined. */
function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** A stable key for one bucket. */
function windowId(group: string, bucket: UsageBucket, index: number): string {
    const id = str(bucket.id) ?? str(bucket.name) ?? String(index)
    return `${group}:${id}`
}

/**
 * Parse one `agy --print /usage` payload.
 * @param stdout - the CLI's JSON output.
 * @param fetchedAt - epoch milliseconds for the read.
 * @returns the quota, or an error-shaped quota when the payload is unusable.
 */
export function parseAgyUsage(stdout: string, fetchedAt: number = Date.now()): AgyQuota {
    let report: UsageReport
    try {
        report = JSON.parse(stdout) as UsageReport
    } catch (error) {
        return { windows: [], fetchedAt, error: `agy /usage returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (report.status !== undefined && report.status !== 'SUCCESS') {
        return { windows: [], fetchedAt, error: `agy /usage reported ${String(report.status)}` }
    }
    const groups = report.command?.data?.groups
    if (!Array.isArray(groups) || groups.length === 0) {
        return { windows: [], fetchedAt, error: 'agy /usage returned no quota groups' }
    }
    const windows: AgyQuotaWindow[] = []
    for (const rawGroup of groups) {
        const group = str(rawGroup.name) ?? 'Quota'
        const buckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : []
        for (const [index, bucket] of buckets.entries()) {
            const remaining = num(bucket.remaining_fraction)
            if (remaining === undefined) continue
            const clamped = Math.max(0, Math.min(1, remaining))
            const percentRemaining = Math.round(clamped * 10_000) / 100
            const reset = str(bucket.reset_time)
            windows.push({
                id: windowId(group, bucket, index),
                group,
                label: str(bucket.name) ?? str(bucket.window) ?? 'Limit',
                window: str(bucket.window) ?? 'window',
                percentRemaining,
                percentUsed: Math.round((100 - percentRemaining) * 100) / 100,
                ...(reset !== undefined ? { resetsAt: reset } : {}),
                ...(str(bucket.description) !== undefined ? { description: str(bucket.description) } : {}),
                status: clamped <= 0 ? 'exhausted' : 'ok',
            })
        }
    }
    return windows.length > 0
        ? { windows, fetchedAt }
        : { windows: [], fetchedAt, error: 'agy /usage returned no measured quota buckets' }
}

const MAX_OUTPUT = 2 * 1024 * 1024

/** Spawn a command, collect bounded stdout, and resolve on a clean exit. */
function run(command: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (command.length === 0) {
            reject(new Error('quota command is empty'))
            return
        }
        const [bin, ...args] = command
        const child = spawn(bin!, args, {
            cwd,
            env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (error?: Error): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            if (error === undefined) resolve(stdout)
            else reject(error)
        }
        const onAbort = (): void => {
            child.kill('SIGKILL')
            finish(new Error('quota read aborted'))
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            finish(new Error(`quota read timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8')
            if (stdout.length > MAX_OUTPUT) {
                child.kill('SIGKILL')
                finish(new Error('quota output exceeded 2 MiB'))
            }
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_096)
        })
        child.on('error', (error) => finish(error))
        child.on('exit', (code, exitSignal) => {
            if (code === 0) finish()
            else finish(new Error(`agy /usage exited (code ${String(code)}, signal ${String(exitSignal)})${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ''}`))
        })
    })
}

/** One quota read's options. */
export interface ReadAgyQuotaOptions {
    command: readonly string[]
    cwd: string
    timeoutMs: number
    signal?: AbortSignal
}

/**
 * Read the current Antigravity plan quota.
 * @param options - command, working directory, timeout, and cancellation.
 * @returns the parsed quota; transport failures are returned as `error`.
 */
export async function readAgyQuota(options: ReadAgyQuotaOptions): Promise<AgyQuota> {
    try {
        return parseAgyUsage(await run(options.command, options.cwd, options.timeoutMs, options.signal))
    } catch (error) {
        return { windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
    }
}
