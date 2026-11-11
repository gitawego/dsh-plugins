/**
 * Multi-account orchestration for the Antigravity route.
 *
 * The CLI keeps one active token in the keyring. This manager keeps the other
 * accounts' refresh tokens in a plugin-owned store, refreshes a target token
 * before switching to it, writes the chosen token to the keyring, and bumps an
 * epoch the ACP adapter watches. The epoch is what makes an already-running
 * ACP server restart for the next prompt instead of continuing with the
 * previous account's authenticated connection.
 *
 * @module @gitawego/dsh-llm-agy/account-manager
 */
import { readAccountStore, writeAccountStore, accountFromCredential, findAccount, summarizeAccounts, upsertAccount, type AccountList, type AccountRecord, type AccountStore } from './accounts.ts'
import { startAgyLogin, type AgyLoginHandle } from './login.ts'
import { fetchAgyUserInfo, refreshAgyToken } from './oauth.ts'
import {
    credentialFromTokenPayload,
    credentialNeedsRefresh,
    credentialSecret,
    withRefreshedToken,
    type OAuthCredential,
} from './token-storage.ts'

/** The token store operations the manager needs. */
export interface ManagerTokenStorage {
    read(): Promise<string | undefined>
    write(secret: string): Promise<void>
}

/** Options for {@link AgyAccountManager}. */
export interface AgyAccountManagerOptions {
    /** Current store path; resolved per call so a config change is honored. */
    storePath: () => string
    storage: ManagerTokenStorage
    /** Current login command and working directory. */
    loginCommand: () => readonly string[]
    loginCwd: () => string
    /** Test seams. */
    login?: typeof startAgyLogin
    refresh?: typeof refreshAgyToken
    userInfo?: typeof fetchAgyUserInfo
    now?: () => number
}

/** A login waiting for its authorization code. */
export interface PendingLogin {
    loginId: string
    url: string
}

/** Abandon a sign-in the browser never completed. */
const LOGIN_TTL_MS = 10 * 60_000

/** The manager's public surface. */
export class AgyAccountManager {
    private readonly options: AgyAccountManagerOptions
    private pending?: { id: string; handle: AgyLoginHandle; timer: NodeJS.Timeout; beforeSecret: string | undefined }
    private accountEpoch = 0

    constructor(options: AgyAccountManagerOptions) {
        this.options = options
    }

    /** Epoch incremented after every successful switch or sign-in. */
    epoch(): number {
        return this.accountEpoch
    }

    /** List accounts, importing the keyring's current login on first use. */
    async list(): Promise<AccountList> {
        const store = await this.load()
        const changed = await this.capture(store)
        if (changed) await this.save(store)
        return this.view(store)
    }

    /** Save the keyring's current token into the store, refreshing rotated tokens. */
    async captureActive(): Promise<void> {
        const store = await this.load()
        if (await this.capture(store)) await this.save(store)
    }

    /**
     * Make one account active.
     *
     * The target token is refreshed first when it is missing, expired, or close
     * to expiry. The keyring is only written after that refresh succeeds, so a
     * dead refresh token cannot leave the CLI signed out.
     */
    async switchTo(idOrEmail: string): Promise<AccountList> {
        const store = await this.load()
        if (await this.capture(store)) await this.save(store)
        const account = findAccount(store, idOrEmail)
        if (account === undefined) throw new Error(`unknown Antigravity account "${idOrEmail}"`)
        if (this.pending !== undefined) throw new Error('a sign-in is still waiting for its authorization code')

        await this.ensureFresh(account)
        const backup = await this.options.storage.read()
        try {
            await this.options.storage.write(credentialSecret(account.credential))
        } catch (error) {
            if (backup !== undefined) await this.options.storage.write(backup).catch(() => {})
            throw new Error(`could not write the Antigravity keyring: ${error instanceof Error ? error.message : String(error)}`)
        }
        store.activeId = account.id
        account.updatedAt = this.now()
        upsertAccount(store, account)
        await this.save(store)
        this.accountEpoch += 1
        return this.view(store)
    }

    /** Start `agy acp --login` and return its Google URL. */
    async startLogin(): Promise<PendingLogin> {
        if (this.pending !== undefined) {
            if (!this.pending.handle.done) {
                // A previous dialog/tab left this sign-in waiting. Reuse it so the
                // card can still show the URL and accept the code.
                return { loginId: this.pending.id, url: this.pending.handle.url }
            }
            clearTimeout(this.pending.timer)
            this.pending = undefined
        }
        // Save the current keyring login before the CLI replaces it, so adding a
        // second account does not lose the first one.
        const store = await this.load()
        if (await this.capture(store)) await this.save(store)
        const beforeSecret = await this.options.storage.read()
        const handle = await (this.options.login ?? startAgyLogin)({
            command: this.options.loginCommand(),
            cwd: this.options.loginCwd(),
        })
        const timer = setTimeout(() => {
            if (this.pending?.id !== handle.id) return
            handle.cancel()
            this.pending = undefined
        }, LOGIN_TTL_MS)
        timer.unref?.()
        this.pending = { id: handle.id, handle, timer, beforeSecret }
        return { loginId: handle.id, url: handle.url }
    }

    /** Finish a pending sign-in and make the resulting account active. */
    async submitLogin(loginId: string, code: string): Promise<AccountList> {
        const pending = this.pending
        if (pending === undefined || pending.id !== loginId) throw new Error('no sign-in is waiting for that id')
        clearTimeout(pending.timer)
        this.pending = undefined
        await pending.handle.submit(code)
        const afterSecret = await this.options.storage.read()
        if (afterSecret === undefined || afterSecret === pending.beforeSecret) {
            throw new Error('agy finished signing in but the keyring token did not change')
        }
        const store = await this.load()
        const changed = await this.capture(store)
        if (changed) await this.save(store)
        if (store.activeId === undefined) throw new Error('agy finished signing in but no token was stored')
        const current = store.accounts.find((account) => account.id === store.activeId)
        if (current !== undefined) {
            current.source = 'login'
            current.updatedAt = this.now()
            await this.save(store)
        }
        this.accountEpoch += 1
        return this.view(store)
    }

    /** Stop a pending sign-in. */
    cancelLogin(loginId: string): void {
        if (this.pending?.id !== loginId) return
        clearTimeout(this.pending.timer)
        this.pending.handle.cancel()
        this.pending = undefined
    }

    /** Stop any pending sign-in (plugin disposal). */
    dispose(): void {
        if (this.pending === undefined) return
        clearTimeout(this.pending.timer)
        this.pending.handle.cancel()
        this.pending = undefined
    }

    /** Refresh an account when it cannot be used as-is. */
    private async ensureFresh(account: AccountRecord): Promise<void> {
        if (!credentialNeedsRefresh(account.credential, this.now())) return
        if (account.credential.refreshToken.length === 0) {
            throw new Error(`account ${account.identity} has no refresh token; sign in to it again`)
        }
        let refreshed
        try {
            refreshed = await (this.options.refresh ?? refreshAgyToken)(account.credential.refreshToken, {
                signal: AbortSignal.timeout(20_000),
            })
        } catch (error) {
            throw new Error(`could not refresh the token for ${account.identity}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (refreshed.email !== undefined && refreshed.email.toLowerCase() !== account.identity.toLowerCase()) {
            throw new Error(`refresh token for ${account.identity} belongs to ${refreshed.email}`)
        }
        account.credential = withRefreshedToken(account.credential, refreshed)
        account.updatedAt = this.now()
    }

    /** Merge the active keyring token into the store. */
    private async capture(store: AccountStore): Promise<boolean> {
        let raw: string | undefined
        try {
            raw = await this.options.storage.read()
        } catch {
            return false
        }
        if (raw === undefined) return false
        const credential = credentialFromTokenPayload(raw)
        if (credential === undefined) return false
        let account = accountFromCredential(credential, 'keyring', { now: this.now() })
        if (account === undefined && credential.accessToken.length > 0) {
            const info = await (this.options.userInfo ?? fetchAgyUserInfo)(credential.accessToken, {
                signal: AbortSignal.timeout(10_000),
            }).catch(() => undefined)
            if (info !== undefined) {
                account = accountFromCredential({ ...credential, email: info.email }, 'keyring', {
                    ...(info.name !== undefined ? { label: info.name } : {}),
                    now: this.now(),
                })
            }
        }
        if (account === undefined) return false
        const existing = store.accounts.find((entry) => entry.id === account.id)
        if (existing !== undefined) {
            account.label = existing.label
            account.source = existing.source
        }
        let changed = upsertAccount(store, account)
        if (store.activeId !== account.id) {
            store.activeId = account.id
            changed = true
        }
        return changed
    }

    /** Read the current store. */
    private load(): Promise<AccountStore> {
        return readAccountStore(this.options.storePath())
    }

    /** Persist the current store. */
    private save(store: AccountStore): Promise<void> {
        return writeAccountStore(this.options.storePath(), store)
    }

    /** Project the store into the browser-safe list. */
    private view(store: AccountStore): AccountList {
        return {
            accounts: summarizeAccounts(store, store.activeId),
            ...(store.activeId !== undefined
                ? { activeEmail: store.accounts.find((account) => account.id === store.activeId)?.identity }
                : {}),
        }
    }

    /** Current local clock. */
    private now(): number {
        return (this.options.now ?? Date.now)()
    }
}

export type { AccountList, AccountRecord, OAuthCredential }
