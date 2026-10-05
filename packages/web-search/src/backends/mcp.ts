/**
 * A user-added MCP search server.
 *
 * The shipped servers each have their own reply shape, and a server someone adds
 * is almost always a re-host of one of those families (or a gateway in front of
 * them), so this calls the generic JSON-RPC route with a configurable tool name
 * and reads the reply with both shipped parsers: Parallel's JSON envelope first,
 * then Exa's `Title:/URL:/Highlights:` text block. Whichever yields sources
 * wins, and an unreadable reply yields none rather than throwing — the chain's
 * next candidate is a better answer than a parse error.
 *
 * @module @gitawego/dsh-web-search/backends/mcp
 */
import { bearerAuth } from './auth.ts'
import { extractParallelText } from './parallel.ts'
import { extractExaText } from './exa.ts'
import { parseParallelText, parseExaText, type RawSource } from '../normalize.ts'

export interface McpBackendOptions {
  url: string
  timeoutMs: number
  /** MCP tool to call; the `web_search` default matches Parallel's route. */
  tool?: string
  /** Resolved token; absent keeps the anonymous request. */
  apiKey?: string
  fetchImpl?: typeof fetch
}

/**
 * Build the JSON-RPC `tools/call` body for one added server.
 * @param query - the search query.
 * @param tool - MCP tool name.
 * @returns the request body.
 */
export function buildMcpRequest(query: string, tool: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: { objective: query, search_queries: [query], query } },
  })
}

/**
 * Read sources out of either shipped reply shape.
 * @param body - the response body, JSON or SSE.
 * @returns the parsed sources; empty when neither shape yields any.
 */
export function parseMcpBody(body: string): RawSource[] {
  // A JSON body may still arrive as SSE (`data: {...}` lines), which is what the
  // Exa-shaped servers do.
  let document: unknown
  try {
    document = JSON.parse(body)
  } catch {
    const data = extractExaText(body)
    return data === undefined ? [] : parseExaText(data)
  }
  const text = extractParallelText(document)
  if (text === undefined) return []
  const asParallel = parseParallelText(text)
  return asParallel.length > 0 ? asParallel : parseExaText(text)
}

/**
 * Run one search against an added MCP server.
 * @param query - the search query.
 * @param opts - endpoint, tool, token, and cancellation.
 * @param signal - caller cancellation.
 * @returns the raw sources; throws on a network or HTTP failure so the chain moves on.
 */
export async function mcpSearch(query: string, opts: McpBackendOptions, signal?: AbortSignal): Promise<RawSource[]> {
  const runFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const cleanup = () => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  try {
    const res = await runFetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...bearerAuth(opts.apiKey),
      },
      body: buildMcpRequest(query, opts.tool !== undefined && opts.tool.length > 0 ? opts.tool : 'web_search'),
      signal: controller.signal,
    })
    cleanup()
    if (!res.ok) throw new Error('mcp HTTP ' + res.status)
    return parseMcpBody(await res.text())
  } catch (error) {
    cleanup()
    throw error
  }
}
