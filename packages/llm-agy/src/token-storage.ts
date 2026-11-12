/**
 * Antigravity token storage: the system keyring first, a CLI token file second.
 *
 * `agy` stores its Google login with `github.com/zalando/go-keyring` under the
 * Secret Service item `service=gemini, username=antigravity`. On Linux that is
 * the same item `secret-tool` reads and writes, which is what makes account
 * switching possible without an API key. Older or headless installs may have a
 * token file under `~/.gemini/antigravity-cli/` instead; reads fall back to it
 * and writes keep it in sync when it exists.
 *
 * @module @gitawego/dsh-llm-agy/token-storage
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { decodeJwtEmail } from './oauth.ts'

/** Keyring service and user the Antigravity CLI uses. */
export const ANTIGRAVITY_KEYRING_SERVICE = 'gemini'
export const ANTIGRAVITY_KEYRING_USER = 'antigravity'

/** One normalized Google OAuth credential. */
export interface OAuthCredential {
    accessToken: string
    refreshToken: string
    idToken?: string
    /** Epoch seconds; absent when the source did not record it. */
    expiresAt?: number
    tokenType: string
    scope?: string
    email?: string
}

/** The JSON shape `agy` stores in the keyring. */
export interface KeyringTokenPayload {
    token: {
        access_token: string
        token_type: string
        refresh_token: string
        expiry?: string
        expires_in?: number
    }
    auth_method: 'consumer'
    id_token_email?: string
}

/** Result of one `secret-tool` invocation. */
export interface SecretToolResult {
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    missing: boolean
}

/** Runner injection point for tests. */
export type SecretToolRunner = (args: readonly string[], stdin: string | undefined, timeoutMs: number) => Promise<SecretToolResult>

/** Spawn `secret-tool`, collect bounded output, and never reject for a non-zero exit. */
export const runSecretTool: SecretToolRunner = (args, stdin, timeoutMs) => new Promise((resolve) => {
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let missing = false
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr, missing })
    }
    const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null, 'SIGKILL')
    }, timeoutMs)
    child.on('error', (error: NodeJS.ErrnoException) => {
        missing = error.code === 'ENOENT'
        stderr = `${stderr}${error.message}`.slice(-4_096)
        finish(null, null)
    })
    child.stdout.on('data', (chunk: Buffer) => {
        stdout = `${stdout}${chunk.toString('utf8')}`.slice(-16_384)
    })
    child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_096)
    })
    child.on('exit', (code, signal) => finish(code, signal))
    if (stdin !== undefined) {
        child.stdin.on('error', () => {})
        child.stdin.end(stdin)
    } else {
        child.stdin.end()
    }
})

/** Parse a keyring / token-file payload into a normalized credential. */
export function credentialFromTokenPayload(raw: string): OAuthCredential | undefined {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return undefined
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const root = value as Record<string, unknown>
    const token = (root['token'] ?? {}) as Record<string, unknown>
    const accessToken = typeof token['access_token'] === 'string' ? token['access_token'].trim() : ''
    const refreshToken = typeof token['refresh_token'] === 'string' ? token['refresh_token'].trim() : ''
    if (accessToken.length === 0 && refreshToken.length === 0) return undefined
    const expiry = typeof token['expiry'] === 'string' ? Date.parse(token['expiry']) : Number.NaN
    const expiresAt = Number.isFinite(expiry) ? Math.floor(expiry / 1000) : undefined
    const idToken = typeof token['id_token'] === 'string' ? token['id_token'] : undefined
    const email = typeof root['id_token_email'] === 'string'
        ? root['id_token_email'].trim()
        : idToken !== undefined
          ? decodeJwtEmail(idToken)
          : undefined
    return {
        accessToken,
        refreshToken,
        ...(idToken !== undefined ? { idToken } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        tokenType: typeof token['token_type'] === 'string' && token['token_type'].length > 0 ? token['token_type'] : 'Bearer',
        ...(typeof root['scope'] === 'string' ? { scope: root['scope'] } : {}),
        ...(email !== undefined && email.length > 0 ? { email } : {}),
    }
}

/** Serialize a credential in the shape `agy` reads from the keyring. */
export function tokenPayloadOf(credential: OAuthCredential): KeyringTokenPayload {
    const expiry = credential.expiresAt !== undefined ? new Date(credential.expiresAt * 1000).toISOString() : undefined
    return {
        token: {
            access_token: credential.accessToken,
            token_type: credential.tokenType,
            refresh_token: credential.refreshToken,
            ...(expiry !== undefined ? { expiry } : {}),
        },
        auth_method: 'consumer',
        ...(credential.email !== undefined ? { id_token_email: credential.email } : {}),
    }
}

/** Serialize a credential as the secret payload. */
export function credentialSecret(credential: OAuthCredential): string {
    return JSON.stringify(tokenPayloadOf(credential))
}

/** Whether the access token is missing or inside the refresh skew. */
export function credentialNeedsRefresh(credential: OAuthCredential, nowMs: number = Date.now(), skewSeconds = 300): boolean {
    if (credential.accessToken.length === 0) return true
    if (credential.expiresAt === undefined) return true
    return credential.expiresAt <= Math.floor(nowMs / 1000) + skewSeconds
}

/** Piggyback refreshed material onto an account credential. */
export function withRefreshedToken(
    credential: OAuthCredential,
    refreshed: { accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number; tokenType: string; scope?: string; email?: string },
): OAuthCredential {
    return {
        ...credential,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? credential.refreshToken,
        expiresAt: refreshed.expiresAt,
        tokenType: refreshed.tokenType,
        ...(refreshed.idToken !== undefined ? { idToken: refreshed.idToken } : {}),
        ...(refreshed.scope !== undefined ? { scope: refreshed.scope } : credential.scope !== undefined ? { scope: credential.scope } : {}),
        ...(refreshed.email !== undefined ? { email: refreshed.email } : credential.email !== undefined ? { email: credential.email } : {}),
    }
}

/** Options for {@link AgyTokenStorage}. */
export interface AgyTokenStorageOptions {
    service?: string
    user?: string
    /** Older CLI token file; read as a fallback and written alongside the keyring. */
    cliTokenFile?: string
    /** Additional read-only fallbacks, newest first. */
    fallbackFiles?: string[]
    run?: SecretToolRunner
    readTimeoutMs?: number
    writeTimeoutMs?: number
}

/**
 * The CLI's token store.
 *
 * Reads prefer the keyring, then the CLI token file. Writes go to the keyring
 * and mirror the token file when possible, matching the Antigravity desktop
 * app's own account switcher.
 */
export class AgyTokenStorage {
    private readonly service: string
    private readonly user: string
    private readonly cliTokenFile: string | undefined
    private readonly fallbackFiles: string[]
    private readonly run: SecretToolRunner
    private readonly readTimeoutMs: number
    private readonly writeTimeoutMs: number

    constructor(options: AgyTokenStorageOptions = {}) {
        this.service = options.service ?? ANTIGRAVITY_KEYRING_SERVICE
        this.user = options.user ?? ANTIGRAVITY_KEYRING_USER
        this.cliTokenFile = options.cliTokenFile
        this.fallbackFiles = options.fallbackFiles ?? []
        this.run = options.run ?? runSecretTool
        this.readTimeoutMs = options.readTimeoutMs ?? 5_000
        this.writeTimeoutMs = options.writeTimeoutMs ?? 10_000
    }

    /** Read the active secret, or undefined when no store has one. */
    async read(): Promise<string | undefined> {
        const keyring = await this.readKeyring()
        if (keyring !== undefined) return keyring
        for (const path of [this.cliTokenFile, ...this.fallbackFiles]) {
            if (path === undefined) continue
            try {
                const value = await readFile(path, 'utf8')
                if (value.trim().length > 0) return value.trim()
            } catch {
                /* absent is the normal case for a keyring-only install */
            }
        }
        return undefined
    }

    /** Read directly from the keyring, bypassing file fallbacks. */
    async readKeyring(): Promise<string | undefined> {
        const result = await this.run(
            ['lookup', 'service', this.service, 'username', this.user],
            undefined,
            this.readTimeoutMs,
        )
        if (result.code === 0) {
            const value = result.stdout.trim()
            return value.length > 0 ? value : undefined
        }
        return undefined
    }

    /** Write the active secret to the keyring, with the token file as a fallback. */
    async write(secret: string): Promise<void> {
        const result = await this.run(
            ['store', '--label=gemini', 'service', this.service, 'username', this.user],
            secret,
            this.writeTimeoutMs,
        )
        if (result.code !== 0) {
            // A missing secret-tool can fall back to the CLI file. A present but
            // failing keyring cannot: `agy` reads the keyring first, so writing
            // the file would report success while the CLI kept the old account.
            if (!result.missing || this.cliTokenFile === undefined) {
                throw new Error(`secret-tool store failed${result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : ''}`)
            }
            await this.writeFile(this.cliTokenFile, secret)
            return
        }
        if (this.cliTokenFile !== undefined) await this.writeFile(this.cliTokenFile, secret).catch(() => {})
    }

    /** Create a private directory and write a 0600 token file. */
    private async writeFile(path: string, secret: string): Promise<void> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
        try {
            await writeFile(temporary, secret, { encoding: 'utf8', mode: 0o600 })
            await rename(temporary, path)
            await chmod(path, 0o600).catch(() => {})
        } catch (error) {
            await unlink(temporary).catch(() => {})
            throw error
        }
    }
}
