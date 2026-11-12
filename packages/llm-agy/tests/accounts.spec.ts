import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    accountFromCredential,
    accountFromSecret,
    accountId,
    defaultAccountsFile,
    defaultCliTokenFile,
    emptyStore,
    findAccount,
    parseAccountStore,
    readAccountStore,
    summarizeAccounts,
    upsertAccount,
    writeAccountStore,
} from '../src/accounts.ts'
import type { OAuthCredential } from '../src/token-storage.ts'

const dirs: string[] = []

afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-accounts-'))
    dirs.push(dir)
    return dir
}

function credential(email: string, access = 'access'): OAuthCredential {
    return {
        accessToken: access,
        refreshToken: 'refresh',
        expiresAt: 1_800_000_000,
        tokenType: 'Bearer',
        email,
    }
}

describe('default paths', () => {
    it('puts the registry under the DSH home and the CLI token under ~/.gemini', () => {
        expect(defaultAccountsFile({ DSH_HOME: '/tmp/dsh-home' }, '/home/user')).toBe('/tmp/dsh-home/llm-agy/accounts.json')
        expect(defaultAccountsFile({}, '/home/user')).toBe('/home/user/.dsh/llm-agy/accounts.json')
        expect(defaultCliTokenFile('/home/user')).toBe('/home/user/.gemini/antigravity-cli/antigravity-oauth-token')
    })
})

describe('account records', () => {
    it('builds a record from a credential and identifies it by lowercased email', () => {
        const account = accountFromCredential(credential('User@Example.com'), 'keyring', { now: 42 })
        expect(account).toMatchObject({
            id: 'user@example.com',
            identity: 'User@Example.com',
            source: 'keyring',
            updatedAt: 42,
        })
        expect(accountId(' User@Example.com ')).toBe('user@example.com')
    })

    it('parses a keyring secret into a keyring account', () => {
        const account = accountFromSecret(JSON.stringify({
            token: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
            auth_method: 'consumer',
            id_token_email: 'user@example.com',
        }), 'keyring', 7)
        expect(account).toMatchObject({ identity: 'user@example.com', source: 'keyring', updatedAt: 7 })
    })
})

describe('store', () => {
    it('round-trips through JSON and drops malformed accounts', () => {
        const store = emptyStore()
        upsertAccount(store, accountFromCredential(credential('a@example.com'), 'keyring')!)
        upsertAccount(store, accountFromCredential(credential('b@example.com'), 'login')!)
        store.activeId = 'a@example.com'
        const parsed = parseAccountStore(JSON.stringify({ ...store, accounts: [...store.accounts, { nope: true }] }))
        expect(parsed.accounts).toHaveLength(2)
        expect(parsed.activeId).toBe('a@example.com')
    })

    it('treats a corrupt body as empty', () => {
        expect(parseAccountStore('nope')).toEqual(emptyStore())
        expect(parseAccountStore(undefined)).toEqual(emptyStore())
    })

    it('updates credentials in place and finds by email', () => {
        const store = emptyStore()
        const first = accountFromCredential(credential('user@example.com', 'old'), 'keyring')!
        upsertAccount(store, first)
        const changed = accountFromCredential(credential('USER@example.com', 'new'), 'keyring')!
        expect(upsertAccount(store, changed)).toBe(true)
        expect(store.accounts).toHaveLength(1)
        expect(findAccount(store, 'user@example.com')?.credential.accessToken).toBe('new')
    })

    it('keeps a stable email order when the active account changes', () => {
        const store = emptyStore()
        upsertAccount(store, accountFromCredential(credential('z@example.com'), 'keyring')!)
        upsertAccount(store, accountFromCredential(credential('a@example.com'), 'keyring')!)
        upsertAccount(store, accountFromCredential(credential('m@example.com'), 'login')!)
        const expected = ['a@example.com', 'm@example.com', 'z@example.com']
        expect(summarizeAccounts(store, 'm@example.com').map((account) => account.identity)).toEqual(expected)
        expect(summarizeAccounts(store, 'z@example.com').map((account) => account.identity)).toEqual(expected)
        expect(summarizeAccounts(store, 'z@example.com').find((account) => account.active)?.identity).toBe('z@example.com')
    })

    it('writes a private registry file and reads it back', async () => {
        const dir = await tempDir()
        const path = join(dir, 'accounts.json')
        const store = emptyStore()
        upsertAccount(store, accountFromCredential(credential('user@example.com'), 'keyring')!)
        store.activeId = 'user@example.com'
        await writeAccountStore(path, store)
        expect((await readAccountStore(path)).accounts).toHaveLength(1)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, activeId: 'user@example.com' })
    })
})
