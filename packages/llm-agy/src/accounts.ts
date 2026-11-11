/**
 * The multi-account registry.
 *
 * `agy` itself stores exactly one active token, so keeping several accounts
 * means keeping their refresh tokens somewhere and writing the chosen one back
 * to the keyring. This file owns that store and seeds it only from sources the
 * plugin itself controls:
 *
 * - the keyring's current token (the account the CLI is using now);
 * - accounts added through this plugin's own `agy acp --login` flow.
 *
 * It deliberately does NOT read another desktop app's account directory: not
 * every user has one, and a DSH plugin must stand on its own. The store is
 * plain JSON with mode 0600. It never leaves the machine and is never sent to
 * the browser; the routes expose only identity, label, source, and the active
 * marker.
 *
 * @module @gitawego/dsh-llm-agy/accounts
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
    credentialFromTokenPayload,
    type OAuthCredential,
} from './token-storage.ts'

/** Where a credential came from. */
export type AccountSource = 'keyring' | 'login'

/** One saved account. */
export interface AccountRecord {
    /** Lowercased email used by the UI and routes. */
    id: string
    /** Email as shown by the source. */
    identity: string
    label?: string
    source: AccountSource
    credential: OAuthCredential
    /** Epoch milliseconds of the last local write. */
    updatedAt: number
}

/** The on-disk registry. */
export interface AccountStore {
    version: 1
    activeId?: string
    accounts: AccountRecord[]
}

/** Browser-safe account row. */
export interface AccountSummary {
    id: string
    identity: string
    label?: string
    source: AccountSource
    active: boolean
}

/** Store plus the active marker. */
export interface AccountList {
    accounts: AccountSummary[]
    activeEmail?: string
}

/** Default registry path under the DSH home. */
export function defaultAccountsFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const dshHome = env['DSH_HOME']?.trim()
    return join(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(home, '.dsh'), 'llm-agy', 'accounts.json')
}

/** Default CLI token file used by older installs. */
export function defaultCliTokenFile(home: string = homedir()): string {
    return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
}

/** Stable id for an email. */
export function accountId(identity: string): string {
    return identity.trim().toLowerCase()
}

/** A blank registry. */
export function emptyStore(): AccountStore {
    return { version: 1, accounts: [] }
}

/** Read a non-empty string field. */
function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Convert epoch seconds to a finite number. */
function epochSeconds(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/** Validate one stored record; malformed rows are dropped rather than trusted. */
function parseAccount(value: unknown): AccountRecord | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const identity = str(raw['identity'])
    if (identity === undefined) return undefined
    const credential = raw['credential']
    if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) return undefined
    const c = credential as Record<string, unknown>
    const accessToken = str(c['accessToken']) ?? ''
    const refreshToken = str(c['refreshToken']) ?? ''
    if (accessToken.length === 0 && refreshToken.length === 0) return undefined
    const source = raw['source']
    const idToken = str(c['idToken'])
    const scope = str(c['scope'])
    const email = str(c['email']) ?? identity
    const expiresAt = epochSeconds(c['expiresAt'])
    const tokenType = str(c['tokenType']) ?? 'Bearer'
    return {
        id: accountId(identity),
        identity,
        ...(str(raw['label']) !== undefined ? { label: str(raw['label'])! } : {}),
        source: source === 'login' || source === 'keyring' ? source : 'keyring',
        credential: {
            accessToken,
            refreshToken,
            tokenType,
            ...(idToken !== undefined ? { idToken } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            ...(scope !== undefined ? { scope } : {}),
            ...(email.length > 0 ? { email } : {}),
        },
        updatedAt: typeof raw['updatedAt'] === 'number' && Number.isFinite(raw['updatedAt']) ? raw['updatedAt'] : Date.now(),
    }
}

/** Parse a registry file, tolerating a missing or corrupt body. */
export function parseAccountStore(raw: string | undefined): AccountStore {
    if (raw === undefined || raw.trim().length === 0) return emptyStore()
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return emptyStore()
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyStore()
    const root = value as Record<string, unknown>
    const accounts = Array.isArray(root['accounts'])
        ? root['accounts'].map(parseAccount).filter((account): account is AccountRecord => account !== undefined)
        : []
    const activeId = str(root['activeId'])
    return {
        version: 1,
        ...(activeId !== undefined && accounts.some((account) => account.id === activeId) ? { activeId } : {}),
        accounts,
    }
}

/** Read the registry from disk. */
export async function readAccountStore(path: string): Promise<AccountStore> {
    try {
        return parseAccountStore(await readFile(path, 'utf8'))
    } catch {
        return emptyStore()
    }
}

/** Write the registry atomically with private permissions. */
export async function writeAccountStore(path: string, store: AccountStore): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const body = `${JSON.stringify(store, null, 2)}\n`
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600).catch(() => {})
}

/** Build a record from a normalized credential. */
export function accountFromCredential(
    credential: OAuthCredential,
    source: AccountSource,
    options: { label?: string; now?: number } = {},
): AccountRecord | undefined {
    const identity = credential.email?.trim()
    if (identity === undefined || identity.length === 0) return undefined
    return {
        id: accountId(identity),
        identity,
        ...(options.label !== undefined && options.label.trim().length > 0 ? { label: options.label.trim() } : {}),
        source,
        credential,
        updatedAt: options.now ?? Date.now(),
    }
}

/** Compare the fields whose change means a keyring write is worthwhile. */
export function sameCredential(left: OAuthCredential, right: OAuthCredential): boolean {
    return left.accessToken === right.accessToken
        && left.refreshToken === right.refreshToken
        && left.expiresAt === right.expiresAt
        && left.idToken === right.idToken
        && left.email === right.email
}

/**
 * Insert or update one account.
 * @returns true when the registry changed.
 */
export function upsertAccount(store: AccountStore, account: AccountRecord): boolean {
    const index = store.accounts.findIndex((entry) => entry.id === account.id)
    if (index === -1) {
        store.accounts.push(account)
        return true
    }
    const current = store.accounts[index]!
    const changed = !sameCredential(current.credential, account.credential)
        || current.label !== account.label
        || current.source !== account.source
        || current.identity !== account.identity
    if (!changed) return false
    store.accounts[index] = {
        ...current,
        ...account,
        label: account.label ?? current.label,
        source: current.source === 'keyring' ? current.source : account.source,
        updatedAt: account.updatedAt,
    }
    return true
}

/** Find an account by id or case-insensitive email. */
export function findAccount(store: AccountStore, idOrEmail: string): AccountRecord | undefined {
    const key = accountId(idOrEmail)
    return store.accounts.find((account) => account.id === key || accountId(account.identity) === key)
}

/** Browser-safe rows, active first, then alphabetical. */
export function summarizeAccounts(store: AccountStore, activeId: string | undefined): AccountSummary[] {
    return [...store.accounts]
        .sort((left, right) => {
            const leftActive = left.id === activeId ? 0 : 1
            const rightActive = right.id === activeId ? 0 : 1
            if (leftActive !== rightActive) return leftActive - rightActive
            return left.identity.localeCompare(right.identity)
        })
        .map((account) => ({
            id: account.id,
            identity: account.identity,
            ...(account.label !== undefined ? { label: account.label } : {}),
            source: account.source,
            active: account.id === activeId,
        }))
}

/** Parse one keyring secret into an account. */
export function accountFromSecret(raw: string, source: AccountSource, now: number = Date.now()): AccountRecord | undefined {
    const credential = credentialFromTokenPayload(raw)
    if (credential === undefined) return undefined
    return accountFromCredential(credential, source, { now })
}
