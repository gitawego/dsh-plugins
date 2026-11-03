/**
 * The failure text for a route whose credential reference resolves to nothing.
 *
 * This is worth its own module because the failure it describes is the one that
 * actually happens: the harness credential seam is the route's *only* source of
 * a key, so an unresolved reference means the request leaves without an
 * `Authorization` header. pi-ai then reports
 *
 * ```text
 * No API key for provider: opencode-go-session
 * ```
 *
 * which names neither the reference nor the place to set it — and reading it as
 * "pi-ai will find the gateway's ambient `OPENCODE_API_KEY`" is wrong twice
 * over. pi-ai's ambient lookup is keyed by *its own* provider id, and this
 * route's id is deliberately not one of those (see `gateways.ts`: claiming
 * `opencode-go` collides with the installed catalog's directory entry), so
 * pi-ai's `getEnvApiKey('opencode-go-session')` can never answer. A reference
 * that resolves to nothing is therefore a hard failure, and both surfaces that
 * dispatch — the adapter and the quota read — say so in the same words.
 *
 * @module @gitawego/dsh-llm-provider/credential-message
 */

/**
 * Explain why a route has no credential, and where to fix it.
 * @param route - the route key the request named.
 * @param apiKeyEnv - the profile's credential reference, `''` when it names none.
 * @returns one sentence naming the route, the reference, and the fix.
 */
export function missingCredentialMessage(route: string, apiKeyEnv: string): string {
    const cause =
        apiKeyEnv.length > 0
            ? `the credential reference "${apiKeyEnv}" holds no value (llm-provider → ${route} → apiKeyEnv)`
            : `the route's profile names no credential reference (llm-provider → ${route} → apiKeyEnv is empty)`
    return (
        `no credential for route "${route}": ${cause}. ` +
        `Save the key against that reference (Settings → LLM provider, or ~/.dsh/.credentials.yaml), ` +
        `or point apiKeyEnv at the reference that already holds it.`
    )
}
