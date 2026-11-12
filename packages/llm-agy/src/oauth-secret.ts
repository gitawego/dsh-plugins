/**
 * Resolve the Antigravity installed-app OAuth client secret.
 *
 * The secret is not part of this repository. Antigravity's own CLI ships it,
 * and a local install can extract it into a private config file with
 * `scripts/antigravity-oauth-secret.mjs`. Users who already know the value can
 * provide it through the environment instead:
 *
 * - `ANTIGRAVITY_OAUTH_CLIENT_SECRET`
 * - `$DSH_HOME/llm-agy/oauth-client.json` (`{"clientSecret":"..."}`, mode 0600)
 *
 * Keeping it local also keeps GitHub secret scanning meaningful: the client is
 * public, but a literal `GOCSPX-...` value in a commit is indistinguishable
 * from a real credential to automated scanners.
 *
 * @module @gitawego/dsh-llm-agy/oauth-secret
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Environment variable that overrides the local file. */
export const OAUTH_SECRET_ENV = 'ANTIGRAVITY_OAUTH_CLIENT_SECRET'

/** Default local secret file. */
export function defaultOAuthSecretFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const dshHome = env['DSH_HOME']?.trim()
    return join(dshHome !== undefined && dshHome.length > 0 ? dshHome : join(home, '.dsh'), 'llm-agy', 'oauth-client.json')
}

/**
 * Read the configured OAuth client secret.
 * @param env - environment variables.
 * @param home - home directory.
 * @returns the secret, or undefined when neither source is configured.
 */
export async function resolveOAuthClientSecret(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): Promise<string | undefined> {
    const fromEnv = env[OAUTH_SECRET_ENV]?.trim()
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    try {
        const raw = await readFile(defaultOAuthSecretFile(env, home), 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const secret = typeof parsed['clientSecret'] === 'string' ? parsed['clientSecret'].trim() : ''
        return secret.length > 0 ? secret : undefined
    } catch {
        return undefined
    }
}

/** Explain how to configure a missing secret. */
export const MISSING_OAUTH_SECRET_MESSAGE =
    'Antigravity OAuth client secret is not configured. Set ANTIGRAVITY_OAUTH_CLIENT_SECRET or run scripts/antigravity-oauth-secret.mjs to extract it from the installed agy CLI.'
