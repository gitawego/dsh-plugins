import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyAccountManager, type ManagerTokenStorage } from '../src/account-manager.ts'
import { readAccountStore, writeAccountStore, emptyStore, accountFromCredential } from '../src/accounts.ts'
import type { AgyLoginHandle } from '../src/login.ts'
import type { RefreshedToken } from '../src/oauth.ts'
import { credentialFromTokenPayload, type OAuthCredential } from '../src/token-storage.ts'

const dirs: string[] = []

afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

class MemoryStorage implements ManagerTokenStorage {
    value: string | undefined
    writes: string[] = []

    constructor(value?: string) {
        this.value = value
    }

    async read(): Promise<string | undefined> {
        return this.value
    }

    async write(secret: string): Promise<void> {
        this.value = secret
        this.writes.push(secret)
    }
}

function secret(email: string, access = 'access-1', expiresAt = 1_800_000_000): string {
    return JSON.stringify({
        token: {
            access_token: access,
            refresh_token: 'refresh-' + email,
            token_type: 'Bearer',
            expiry: new Date(expiresAt * 1000).toISOString(),
        },
        auth_method: 'consumer',
        id_token_email: email,
    })
}

function credential(email: string, access = 'access-1', expiresAt = 1_800_000_000): OAuthCredential {
    return {
        accessToken: access,
        refreshToken: 'refresh-' + email,
        tokenType: 'Bearer',
        expiresAt,
        email,
    }
}

async function tempStore(): Promise<{ dir: string; storePath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-manager-'))
    dirs.push(dir)
    return { dir, storePath: join(dir, 'accounts.json') }
}

function fakeLogin(storage: MemoryStorage, email: string): {
    start: () => Promise<AgyLoginHandle>
} {
    return {
        start: async () => ({
            id: 'login-1',
            url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
            done: false,
            async submit() {
                storage.value = secret(email)
            },
            cancel() {},
        }),
    }
}

describe('AgyAccountManager', () => {
    it('imports the active keyring login and marks it active', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
        })
        const list = await manager.list()
        expect(list.activeEmail).toBe('active@example.com')
        expect(list.accounts).toEqual([{
            id: 'active@example.com',
            identity: 'active@example.com',
            source: 'keyring',
            active: true,
        }])
        expect((await readAccountStore(storePath)).accounts).toHaveLength(1)
    })

    it('resolves the identity through userinfo when the token has no email', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(JSON.stringify({
            token: { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer' },
            auth_method: 'consumer',
        }))
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
            userInfo: async () => ({ email: 'resolved@example.com', name: 'Resolved Name' }),
        })
        const list = await manager.list()
        expect(list.activeEmail).toBe('resolved@example.com')
        expect(list.accounts[0]).toMatchObject({ identity: 'resolved@example.com', label: 'Resolved Name' })
    })

    it('refreshes an expired target before replacing the keyring', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const store = emptyStore()
        const target = accountFromCredential(credential('target@example.com', 'expired', 1), 'login')!
        store.accounts.push(target)
        await writeAccountStore(storePath, store)
        const refresh = vi.fn(async (): Promise<RefreshedToken> => ({
            accessToken: 'fresh',
            expiresAt: 1_900_000_000,
            tokenType: 'Bearer',
            email: 'target@example.com',
        }))
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
            refresh,
        })
        const list = await manager.switchTo('target@example.com')
        expect(refresh).toHaveBeenCalledWith('refresh-target@example.com', expect.anything())
        expect(list.activeEmail).toBe('target@example.com')
        expect(credentialFromTokenPayload(storage.value!)?.accessToken).toBe('fresh')
        expect(manager.epoch()).toBe(1)
    })

    it('does not touch the keyring when the refresh fails', async () => {
        const { storePath } = await tempStore()
        const original = secret('active@example.com')
        const storage = new MemoryStorage(original)
        const store = emptyStore()
        store.accounts.push(accountFromCredential(credential('target@example.com', 'expired', 1), 'login')!)
        await writeAccountStore(storePath, store)
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
            refresh: async () => {
                throw new Error('invalid_grant')
            },
        })
        await expect(manager.switchTo('target@example.com')).rejects.toThrow(/could not refresh the token/)
        expect(storage.value).toBe(original)
        expect(storage.writes).toHaveLength(0)
        expect(manager.epoch()).toBe(0)
    })

    it('refuses a refresh token that resolves to a different email', async () => {
        const { storePath } = await tempStore()
        const original = secret('active@example.com')
        const storage = new MemoryStorage(original)
        const store = emptyStore()
        store.accounts.push(accountFromCredential(credential('target@example.com', 'expired', 1), 'login')!)
        await writeAccountStore(storePath, store)
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
            refresh: async () => ({
                accessToken: 'fresh',
                expiresAt: 1_900_000_000,
                tokenType: 'Bearer',
                email: 'other@example.com',
            }),
        })
        await expect(manager.switchTo('target@example.com')).rejects.toThrow(/belongs to other@example.com/)
        expect(storage.value).toBe(original)
    })

    it('restores the previous keyring when the target write fails', async () => {
        const { storePath } = await tempStore()
        const original = secret('active@example.com')
        let current = original
        let calls = 0
        const storage: ManagerTokenStorage = {
            read: async () => current,
            write: async (secret) => {
                calls += 1
                if (calls === 1) throw new Error('keyring locked')
                current = secret
            },
        }
        const store = emptyStore()
        store.accounts.push(accountFromCredential(credential('target@example.com', 'fresh', 1_900_000_000), 'login')!)
        await writeAccountStore(storePath, store)
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
        })
        await expect(manager.switchTo('target@example.com')).rejects.toThrow(/could not write the Antigravity keyring/)
        expect(calls).toBe(2)
        expect(current).toBe(original)
        expect(manager.epoch()).toBe(0)
    })

    it('adds an account through the login flow and makes it active', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => ['agy', 'acp', '--login'],
            loginCwd: () => process.cwd(),
            login: fakeLogin(storage, 'new@example.com').start,
        })
        const started = await manager.startLogin()
        expect(started.url).toContain('accounts.google.com')
        const list = await manager.submitLogin(started.loginId, 'code')
        expect(list.activeEmail).toBe('new@example.com')
        expect(list.accounts.map((account) => account.identity)).toEqual(['new@example.com', 'active@example.com'])
        expect(manager.epoch()).toBe(1)
    })

    it('rejects a sign-in that exits without changing the keyring', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
            login: async () => ({
                id: 'login-1',
                url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
                done: false,
                submit: async () => {},
                cancel() {},
            }),
        })
        const started = await manager.startLogin()
        await expect(manager.submitLogin(started.loginId, 'code')).rejects.toThrow(/keyring token did not change/)
        expect(manager.epoch()).toBe(0)
    })

    it('reuses a pending sign-in instead of starting another process', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        let starts = 0
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            loginCommand: () => [],
            loginCwd: () => process.cwd(),
            login: async () => {
                starts += 1
                return {
                    id: 'login-1',
                    url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
                    done: false,
                    submit: async () => {},
                    cancel() {},
                }
            },
        })
        const first = await manager.startLogin()
        const second = await manager.startLogin()
        expect(second).toEqual(first)
        expect(starts).toBe(1)
        manager.dispose()
    })
})
