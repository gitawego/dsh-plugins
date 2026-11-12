import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyAccountManager, type ManagerTokenStorage } from '../src/account-manager.ts'
import { readAccountStore, writeAccountStore, emptyStore, accountFromCredential } from '../src/accounts.ts'
import type { GoogleLoginHandle, GoogleLoginResult } from '../src/oauth-login.ts'
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

function deferredLogin(email: string, name?: string): {
    handle: GoogleLoginHandle
    succeed: () => void
    fail: (error: Error) => void
} {
    let resolve!: (result: GoogleLoginResult) => void
    let reject!: (error: Error) => void
    const result = new Promise<GoogleLoginResult>((res, rej) => {
        resolve = res
        reject = rej
    })
    return {
        handle: {
            id: 'login-1',
            url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
            result,
            cancel: () => reject(new Error('Google sign-in cancelled')),
        },
        succeed: () => resolve({
            email,
            ...(name !== undefined ? { name } : {}),
            credential: {
                accessToken: 'access-new',
                refreshToken: 'refresh-' + email,
                tokenType: 'Bearer',
                expiresAt: 1_900_000_000,
                email,
            },
        }),
        fail: reject,
    }
}

describe('AgyAccountManager', () => {
    it('imports the active keyring login and marks it active', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
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
        })
        await expect(manager.switchTo('target@example.com')).rejects.toThrow(/could not write the Antigravity keyring/)
        expect(calls).toBe(2)
        expect(current).toBe(original)
        expect(manager.epoch()).toBe(0)
    })

    it('resolves an account token without changing the active keyring', async () => {
        const { storePath } = await tempStore()
        const original = secret('active@example.com')
        const storage = new MemoryStorage(original)
        const store = emptyStore()
        store.accounts.push(accountFromCredential(credential('target@example.com', 'expired', 1), 'login')!)
        await writeAccountStore(storePath, store)
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            refresh: async () => ({
                accessToken: 'fresh-target',
                expiresAt: 1_900_000_000,
                tokenType: 'Bearer',
                email: 'target@example.com',
            }),
        })
        const resolved = await manager.accessToken('target@example.com')
        expect(resolved).toEqual({ identity: 'target@example.com', accessToken: 'fresh-target' })
        expect(storage.value).toBe(original)
        expect(storage.writes).toHaveLength(0)
        expect((await readAccountStore(storePath)).accounts.find((account) => account.identity === 'target@example.com')?.credential.accessToken)
            .toBe('fresh-target')
    })

    it('adds an OAuth account and makes it active', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const fake = deferredLogin('new@example.com', 'New User')
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            login: async () => fake.handle,
        })
        const started = await manager.startLogin()
        expect(started.url).toContain('accounts.google.com')
        expect(manager.loginStatus(started.loginId)).toEqual({ status: 'pending' })
        fake.succeed()
        await vi.waitFor(() => expect(manager.loginStatus(started.loginId).status).toBe('success'))
        const status = manager.loginStatus(started.loginId)
        if (status.status !== 'success') throw new Error('expected success')
        expect(status.accounts.activeEmail).toBe('new@example.com')
        expect(status.accounts.accounts.map((account) => account.identity)).toEqual(['active@example.com', 'new@example.com'])
        expect(manager.epoch()).toBe(1)
        expect(credentialFromTokenPayload(storage.value!)?.email).toBe('new@example.com')
    })

    it('passes the account email as a login hint for re-authentication', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const fake = deferredLogin('active@example.com')
        let seen: { loginHint?: string } | undefined
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            login: async (options) => {
                seen = options
                return fake.handle
            },
        })
        await manager.startLogin('active@example.com')
        expect(seen?.loginHint).toBe('active@example.com')
        manager.cancelLogin('login-1')
    })

    it('reports a failed OAuth exchange and keeps the previous keyring', async () => {
        const { storePath } = await tempStore()
        const original = secret('active@example.com')
        const storage = new MemoryStorage(original)
        const fake = deferredLogin('new@example.com')
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            login: async () => fake.handle,
        })
        const started = await manager.startLogin()
        fake.fail(new Error('access_denied'))
        await vi.waitFor(() => expect(manager.loginStatus(started.loginId).status).toBe('error'))
        const status = manager.loginStatus(started.loginId)
        if (status.status !== 'error') throw new Error('expected error')
        expect(status.error).toContain('access_denied')
        expect(storage.value).toBe(original)
        expect(manager.epoch()).toBe(0)
    })

    it('cancels a pending OAuth sign-in', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        const fake = deferredLogin('new@example.com')
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            login: async () => fake.handle,
        })
        const started = await manager.startLogin()
        manager.cancelLogin(started.loginId)
        expect(manager.loginStatus(started.loginId)).toEqual({ status: 'error', error: 'no sign-in is waiting for that id' })
        expect(manager.epoch()).toBe(0)
    })

    it('reuses a pending sign-in instead of starting another listener', async () => {
        const { storePath } = await tempStore()
        const storage = new MemoryStorage(secret('active@example.com'))
        let starts = 0
        const fake = deferredLogin('new@example.com')
        const manager = new AgyAccountManager({
            storePath: () => storePath,
            storage,
            login: async () => {
                starts += 1
                return fake.handle
            },
        })
        const first = await manager.startLogin()
        const second = await manager.startLogin()
        expect(second).toEqual(first)
        expect(starts).toBe(1)
        manager.dispose()
    })
})
