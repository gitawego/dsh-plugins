import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    AgyTokenStorage,
    credentialFromTokenPayload,
    credentialNeedsRefresh,
    tokenPayloadOf,
    withRefreshedToken,
    type OAuthCredential,
    type SecretToolResult,
} from '../src/token-storage.ts'

const dirs: string[] = []

afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-token-'))
    dirs.push(dir)
    return dir
}

function result(overrides: Partial<SecretToolResult> = {}): SecretToolResult {
    return { code: 0, signal: null, stdout: '', stderr: '', missing: false, ...overrides }
}

const CREDENTIAL: OAuthCredential = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 1_700_003_600,
    tokenType: 'Bearer',
    idToken: 'header.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.signature',
    email: 'user@example.com',
}

describe('credentialFromTokenPayload', () => {
    it('reads the CLI keyring shape', () => {
        const credential = credentialFromTokenPayload(JSON.stringify({
            token: {
                access_token: 'access',
                token_type: 'Bearer',
                refresh_token: 'refresh',
                expiry: '2026-11-12T00:14:39.000Z',
            },
            auth_method: 'consumer',
            id_token_email: 'user@example.com',
        }))
        expect(credential).toEqual({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAt: 1_794_442_479,
            tokenType: 'Bearer',
            email: 'user@example.com',
        })
    })

    it('falls back to the id_token email and drops empty payloads', () => {
        expect(credentialFromTokenPayload(JSON.stringify({
            token: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', id_token: CREDENTIAL.idToken },
        }))?.email).toBe('user@example.com')
        expect(credentialFromTokenPayload('not json')).toBeUndefined()
        expect(credentialFromTokenPayload(JSON.stringify({ token: {} }))).toBeUndefined()
    })
})

describe('tokenPayloadOf', () => {
    it('round-trips through the CLI shape', () => {
        const parsed = credentialFromTokenPayload(JSON.stringify(tokenPayloadOf(CREDENTIAL)))
        expect(parsed).toMatchObject({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAt: 1_700_003_600,
            tokenType: 'Bearer',
            email: 'user@example.com',
        })
    })
})

describe('credentialNeedsRefresh', () => {
    it('refreshes missing, undated, and near-expiry tokens', () => {
        expect(credentialNeedsRefresh({ ...CREDENTIAL, accessToken: '' }, 0)).toBe(true)
        expect(credentialNeedsRefresh({ ...CREDENTIAL, expiresAt: undefined }, 0)).toBe(true)
        expect(credentialNeedsRefresh(CREDENTIAL, (CREDENTIAL.expiresAt! - 200) * 1000, 300)).toBe(true)
        expect(credentialNeedsRefresh(CREDENTIAL, 1_700_000_000_000, 300)).toBe(false)
    })
})

describe('withRefreshedToken', () => {
    it('updates the access material while preserving the refresh token', () => {
        expect(withRefreshedToken(CREDENTIAL, {
            accessToken: 'new-access',
            expiresAt: 1_800_000_000,
            tokenType: 'Bearer',
            email: 'user@example.com',
        })).toMatchObject({
            accessToken: 'new-access',
            refreshToken: 'refresh',
            expiresAt: 1_800_000_000,
            email: 'user@example.com',
        })
    })
})

describe('AgyTokenStorage', () => {
    it('reads the keyring first', async () => {
        const calls: string[][] = []
        const storage = new AgyTokenStorage({
            run: async (args) => {
                calls.push([...args])
                return result({ stdout: 'secret-from-keyring\n' })
            },
        })
        expect(await storage.read()).toBe('secret-from-keyring')
        expect(calls[0]).toEqual(['lookup', 'service', 'gemini', 'username', 'antigravity'])
    })

    it('falls back to the CLI token file', async () => {
        const dir = await tempDir()
        const file = join(dir, 'antigravity-oauth-token')
        await writeFile(file, 'file-secret')
        const storage = new AgyTokenStorage({
            cliTokenFile: file,
            run: async () => result({ code: 1 }),
        })
        expect(await storage.read()).toBe('file-secret')
    })

    it('writes the keyring and mirrors the CLI file', async () => {
        const dir = await tempDir()
        const file = join(dir, 'antigravity-oauth-token')
        const calls: Array<{ args: readonly string[]; stdin: string | undefined }> = []
        const storage = new AgyTokenStorage({
            cliTokenFile: file,
            run: async (args, stdin) => {
                calls.push({ args, stdin })
                return result()
            },
        })
        await storage.write('new-secret')
        expect(calls[0]?.args.slice(0, 2)).toEqual(['store', '--label=gemini'])
        expect(calls[0]?.stdin).toBe('new-secret')
        expect(await readFile(file, 'utf8')).toBe('new-secret')
    })

    it('falls back to the file when secret-tool is unavailable', async () => {
        const dir = await tempDir()
        const file = join(dir, 'antigravity-oauth-token')
        const storage = new AgyTokenStorage({
            cliTokenFile: file,
            run: async () => result({ code: null, missing: true, stderr: 'not found' }),
        })
        await storage.write('file-fallback')
        expect(await readFile(file, 'utf8')).toBe('file-fallback')
    })

    it('refuses to pretend a locked keyring write succeeded', async () => {
        const storage = new AgyTokenStorage({
            run: async () => result({ code: 1, stderr: 'The secret service is locked' }),
        })
        await expect(storage.write('new-secret')).rejects.toThrow(/secret-tool store failed: The secret service is locked/)
    })
})
