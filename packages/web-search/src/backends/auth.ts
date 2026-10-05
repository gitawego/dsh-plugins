/**
 * Authentication for the two hosted MCP search endpoints.
 *
 * Both are free anonymously and both accept an API key as a Bearer token for
 * higher rate limits, which is why the token is optional everywhere here:
 *
 * - `search.parallel.ai/mcp` — "free to use anonymously at lower rate limits.
 *   Pass a Parallel API key as a Bearer token to unlock higher limits";
 * - `mcp.exa.ai/mcp` — the same shape, and the same header, per Exa's own docs.
 *
 * Nothing is sent when no key is configured, so the anonymous path is the
 * default rather than a degraded one.
 *
 * @module @gitawego/dsh-web-search/backends/auth
 */

/**
 * Headers for one MCP call.
 * @param apiKey - resolved token, when one is configured.
 * @returns the auth header, or an empty object for the anonymous path.
 */
export function bearerAuth(apiKey: string | undefined): Record<string, string> {
  if (apiKey === undefined) return {}
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) return {}
  return { authorization: `Bearer ${trimmed}` }
}
