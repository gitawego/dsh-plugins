/**
 * Parallel MCP web search backend (free, no API key). Calls the public
 * JSON-RPC endpoint at search.parallel.ai/mcp using the `web_search` tool,
 * mirroring opencode's mcp-websearch implementation.
 */
import { parseParallelText, type RawSource } from '../normalize.ts'

export interface ParallelBackendOptions {
  url: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

/** Build the JSON-RPC tools/call body for Parallel's `web_search` tool. */
export function buildParallelRequest(query: string): string {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search',
      arguments: {
        objective: query,
        search_queries: [query],
      },
    },
  }
  return JSON.stringify(body)
}

/** Extract the first `text` content entry from the JSON-RPC result. */
export function extractParallelText(parsed: any): string | undefined {
  const items = Array.isArray(parsed?.result?.content) ? parsed.result.content : []
  for (const item of items) {
    if (typeof item?.text === 'string' && item.text.length > 0) return item.text
  }
  return undefined
}

/**
 * Run one Parallel search. Resolves `RawSource[]`; throws on network error or
 * non-OK response (the caller's fallback chain handles it).
 */
export async function parallelSearch(query: string, opts: ParallelBackendOptions, signal?: AbortSignal): Promise<RawSource[]> {
  const runFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  if (signal) {
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    // drop the listener when this call finishes
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    try {
      const res = await runFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: buildParallelRequest(query),
        signal: controller.signal,
      })
      cleanup()
      clearTimeout(timer)
      if (!res.ok) throw new Error('parallel HTTP ' + res.status)
      const parsed = await res.json()
      const text = extractParallelText(parsed)
      if (!text) return []
      return parseParallelText(text)
    } catch (e) {
      cleanup()
      clearTimeout(timer)
      throw e
    }
  } else {
    try {
      const res = await runFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: buildParallelRequest(query),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error('parallel HTTP ' + res.status)
      const parsed = await res.json()
      const text = extractParallelText(parsed)
      if (!text) return []
      return parseParallelText(text)
    } catch (e) {
      clearTimeout(timer)
      throw e
    }
  }
}
