#!/usr/bin/env node
/**
 * Extract the Antigravity installed-app OAuth client secret from the local
 * `agy` binary and store it in the plugin's private config.
 *
 * The secret is not part of this repository. This script finds the
 * `GOCSPX-...` candidates in the CLI, tests them against the current keyring
 * refresh token, and writes the working one to
 * `$DSH_HOME/llm-agy/oauth-client.json` (mode 0600).
 *
 * Usage:
 *   node scripts/antigravity-oauth-secret.mjs
 *   node scripts/antigravity-oauth-secret.mjs --agy /path/to/agy
 *   node scripts/antigravity-oauth-secret.mjs --secret GOCSPX-...
 */
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

function arg(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
}

function agyPath() {
    const explicit = arg('--agy') ?? process.env.AGY_BIN
    if (explicit !== undefined) return explicit
    try {
        return execFileSync('which', ['agy'], { encoding: 'utf8' }).trim()
    } catch {
        return join(homedir(), '.local', 'bin', 'agy')
    }
}

function keyringRefreshToken() {
    try {
        const raw = execFileSync('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], { encoding: 'utf8' })
        const parsed = JSON.parse(raw)
        return typeof parsed?.token?.refresh_token === 'string' ? parsed.token.refresh_token : undefined
    } catch {
        return undefined
    }
}

function secretFile() {
    const dshHome = process.env.DSH_HOME?.trim()
    return join(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'), 'llm-agy', 'oauth-client.json')
}

async function writeSecret(secret) {
    if (!/^GOCSPX-[A-Za-z0-9_-]{28}$/u.test(secret)) {
        throw new Error('that does not look like a Google OAuth client secret (expected GOCSPX-...)')
    }
    const path = secretFile()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify({ clientSecret: secret }, null, 2)}\n`, { mode: 0o600 })
    await chmod(path, 0o600)
    console.log(`Wrote ${path}`)
    console.log('The plugin will read it on the next OAuth sign-in or token refresh.')
}

async function main() {
    const supplied = arg('--secret') ?? process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET
    if (supplied !== undefined && supplied.trim().length > 0) {
        await writeSecret(supplied.trim())
        return
    }

    const binary = agyPath()
    let text
    try {
        text = (await readFile(binary)).toString('latin1')
    } catch (error) {
        throw new Error(`cannot read ${binary}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const candidates = [...new Set(text.match(/GOCSPX-[A-Za-z0-9_-]{28}/gu) ?? [])]
    if (candidates.length === 0) throw new Error(`no GOCSPX candidates found in ${binary}`)
    const refreshToken = keyringRefreshToken()
    if (refreshToken === undefined) {
        throw new Error('no Antigravity refresh token in the keyring; sign in with agy first, or pass --secret')
    }

    for (const candidate of candidates) {
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: candidate,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        })
        const response = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body,
        }).catch(() => undefined)
        if (response?.ok) {
            const payload = await response.json().catch(() => undefined)
            if (typeof payload?.access_token === 'string' && payload.access_token.length > 0) {
                await writeSecret(candidate)
                return
            }
        }
    }
    throw new Error(`none of the ${candidates.length} candidate secret(s) worked; pass --secret explicitly`)
}

main().catch((error) => {
    console.error(`antigravity-oauth-secret: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
