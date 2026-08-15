/**
 * opencode Go backend: calls the Anthropic-compatible /v1/messages endpoint
 * with the native `web_search_20250305` server tool. Uses the model's native
 * web search (verified to return `web_search_tool_result` blocks on
 * deepseek-v4-flash). Requires a credential (api key).
 */
import { parseGoResponse, type RawSource } from '../normalize.ts'

export interface GoBackendOptions {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export function buildGoRequest(query: string, model: string): string {
  const body = {
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Perform a web search for the query: ' + query }],
      },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  }
  return JSON.stringify(body)
}

export async function goSearch(query: string, opts: GoBackendOptions, signal?: AbortSignal): Promise<RawSource[]> {
  const runFetch = opts.fetchImpl ?? fetch
  // The seam's Anthropic helper appends /messages to baseUrl; the caller
  // provides baseUrl already rooted at the v1 endpoint's parent of /messages.
  const endpoint = opts.baseUrl.endsWith('/') ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  const url = endpoint.endsWith('/messages') ? endpoint : endpoint + '/messages'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const cleanupTimer = () => clearTimeout(timer)
  const headers = {
    'content-type': 'application/json',
    'x-api-key': opts.apiKey,
    authorization: 'Bearer ' + opts.apiKey,
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  }
  if (signal) {
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    try {
      const res = await runFetch(url, { method: 'POST', headers, body: buildGoRequest(query, opts.model), signal: controller.signal })
      cleanup()
      cleanupTimer()
      if (!res.ok) throw new Error('go HTTP ' + res.status)
      const parsed = await res.json()
      return parseGoResponse(parsed)
    } catch (e) {
      cleanup()
      cleanupTimer()
      throw e
    }
  } else {
    try {
      const res = await runFetch(url, { method: 'POST', headers, body: buildGoRequest(query, opts.model), signal: controller.signal })
      cleanupTimer()
      if (!res.ok) throw new Error('go HTTP ' + res.status)
      const parsed = await res.json()
      return parseGoResponse(parsed)
    } catch (e) {
      cleanupTimer()
      throw e
    }
  }
}
