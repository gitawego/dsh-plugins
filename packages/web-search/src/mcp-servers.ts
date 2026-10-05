/**
 * MCP search servers, as data both halves can import.
 *
 * Kept out of `config.ts` because the browser half reads this table and
 * `config.ts` imports schemastery: a value import of the config module would
 * pull a validation library into the bundle to render three strings.
 *
 * @module @gitawego/dsh-web-search/mcp-servers
 */

/** One MCP search server the user added. */
export interface McpServerEntry {
  /** Stable id, minted by the card; used as the React key and the removal handle. */
  id: string
  /** Display label; defaults to the host. */
  label: string
  /** Endpoint of the server's MCP route. */
  url: string
  /** Credential-reference name for its token; '' = no token. */
  credential: string
  /** MCP tool to call; '' = the `web_search` default. */
  tool: string
}

/** One shipped MCP server. Its endpoint is fixed: it is the address we tested. */
export interface BuiltinMcpServer {
  id: string
  label: string
  /** Read-only in every surface — a built-in endpoint is not a user choice. */
  url: string
  /** Field on the free-backend config holding its credential reference. */
  credentialField: 'parallelCredential' | 'exaCredential'
  /** Which shipped parser reads its reply. */
  shape: 'parallel' | 'exa'
}

/**
 * The shipped MCP search servers.
 *
 * Both are free anonymously and both accept a key as a Bearer token for higher
 * rate limits, which is why only the token is configurable: the endpoint is the
 * address this plugin was tested against, and letting it be edited turns a
 * working free backend into a typo that silently falls through the chain.
 */
export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  { id: 'parallel', label: 'Parallel', url: 'https://search.parallel.ai/mcp', credentialField: 'parallelCredential', shape: 'parallel' },
  { id: 'exa', label: 'Exa', url: 'https://mcp.exa.ai/mcp', credentialField: 'exaCredential', shape: 'exa' },
]
