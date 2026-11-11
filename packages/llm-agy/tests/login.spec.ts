import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizationCodeOf, startAgyLogin, type AgyLoginHandle } from '../src/login.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-agy-login.mjs', import.meta.url))
const handles: AgyLoginHandle[] = []

afterEach(() => {
    for (const handle of handles.splice(0)) handle.cancel()
    delete process.env['FAKE_AGY_LOGIN_NO_URL']
})

async function start(env: NodeJS.ProcessEnv = {}): Promise<AgyLoginHandle> {
    const handle = await startAgyLogin({
        command: [process.execPath, FIXTURE],
        cwd: process.cwd(),
        env,
        startTimeoutMs: 5_000,
        submitTimeoutMs: 5_000,
    })
    handles.push(handle)
    return handle
}

describe('authorizationCodeOf', () => {
    it('accepts a raw code and extracts one from a callback URL', () => {
        expect(authorizationCodeOf(' 4/abc  ')).toBe('4/abc')
        expect(authorizationCodeOf('https://antigravity.google/oauth-callback?state=x&code=4%2Fabc')).toBe('4/abc')
        expect(authorizationCodeOf('https://example.com/no-code')).toBe('')
    })
})

describe('startAgyLogin', () => {
    it('returns the Google URL without consuming the authorization code', async () => {
        const handle = await start()
        expect(handle.url).toContain('https://accounts.google.com/o/oauth2/auth?')
        expect(handle.done).toBe(false)
        await handle.submit('good')
        expect(handle.done).toBe(true)
    })

    it('accepts the final callback URL as the code', async () => {
        const handle = await start()
        await handle.submit('https://antigravity.google/oauth-callback?state=x&code=good')
        expect(handle.done).toBe(true)
    })

    it('surfaces a rejected authorization', async () => {
        const handle = await start()
        await expect(handle.submit('bad-code')).rejects.toThrow(/authorization rejected/)
    })

    it('rejects when the CLI exits before printing a URL', async () => {
        await expect(start({ FAKE_AGY_LOGIN_NO_URL: '1' })).rejects.toThrow(/no login available/)
    })
})
