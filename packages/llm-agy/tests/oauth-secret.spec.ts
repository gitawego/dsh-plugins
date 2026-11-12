import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OAUTH_SECRET_ENV, defaultOAuthSecretFile, resolveOAuthClientSecret } from '../src/oauth-secret.ts'

const dirs: string[] = []

afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-oauth-secret-'))
    dirs.push(dir)
    return dir
}

describe('resolveOAuthClientSecret', () => {
    it('prefers the environment override', async () => {
        expect(await resolveOAuthClientSecret({ [OAUTH_SECRET_ENV]: ' env-secret ' }, '/tmp/nope')).toBe('env-secret')
    })

    it('reads the private local file', async () => {
        const home = await tempDir()
        const dshHome = join(home, 'dsh')
        const file = defaultOAuthSecretFile({ DSH_HOME: dshHome }, home)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify({ clientSecret: 'file-secret' }))
        expect(await resolveOAuthClientSecret({ DSH_HOME: dshHome }, home)).toBe('file-secret')
    })

    it('returns undefined when no source is configured', async () => {
        const home = await tempDir()
        expect(await resolveOAuthClientSecret({}, home)).toBeUndefined()
        expect(defaultOAuthSecretFile({}, home)).toBe(join(home, '.dsh', 'llm-agy', 'oauth-client.json'))
    })
})
