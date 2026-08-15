/**
 * Exa MCP web search backend (free, no API key). Calls the public JSON-RPC
 * endpoint at mcp.exa.ai/mcp using the `web_search_exa` tool, mirroring
 * opencode's mcp-websearch implementation.
 */
import { parseExaText, type RawSource } from '../normalize.ts'

export interface ExaBackendOptions {
  url: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export function buildExaRequest(query: string, numResults: number): string {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search_exa',
      arguments: {
        query,
        type: 'auto',
        numResults,
        livecrawl: 'fallback',
      },
    },
  }
  return JSON.stringify(body)
}

/** Parse an SSE body (`data: {...}` lines) into the JSON-RPC result text. */
export function extractExaText(bodyText: string): string | undefined {
  // Favor the inner text of the result content, handling both JSON and SSE.
  for (const lineRaw of bodyText.split('\n')) {
    const line = lineRaw.trim()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    const items = Array.isArray(parsed?.result?.content) ? parsed.result.content : []
    for (const item of items) {
      if (typeof item?.text === 'string' && item.text.length > 0) return item.text
    }
  }
  // Fallback: try direct JSON.
  try {
    const parsed = JSON.parse(bodyText)
    const items = Array.isArray(parsed?.result?.content) ? parsed.result.content : []
    for (const item of items) {
      if (typeof item?.text === 'string' && item.text.length > 0) return item.text
    }
  } catch {
    /* ignore */
  }
  return undefined
}

export async function exaSearch(query: string, opts: ExaBackendOptions, signal?: AbortSignal): Promise<RawSource[]> {
  const runFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const cleanupTimer = () => clearTimeout(timer)
  if (signal) {
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    try {
      const res = await runFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: buildExaRequest(query, 8),
        signal: controller.signal,
      })
      cleanup()
      cleanupTimer()
      if (!res.ok) throw new Error('exa HTTP ' + res.status)
      const text = await res.text()
      const payload = extractExaText(text)
      if (!payload) return []
      return parseExaText(payload)
    } catch (e) {
      cleanup()
      cleanupTimer()
      throw e
    }
  } else {
    try {
      const res = await runFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: buildExaRequest(query, 8),
        signal: controller.signal,
      })
      cleanupTimer()
      if (!res.ok) throw new Error('exa HTTP ' + res.status)
      const text = await res.text()
      const payload = extractExaText(text)
      if (!payload) return []
      return parseExaText(payload)
    } catch (e) {
      cleanupTimer()
      throw e
    }
  }
}
