/**
 * LLM-backed native web search. Supports two protocols:
 *  - anthropic: POST `/v1/messages` with the `web_search_20250305` server tool
 *    (opencode Go, DeepSeek Anthropic endpoint, and other Anthropic-compatible
 *    servers). Returns `web_search_tool_result` blocks.
 *  - openai: POST `/chat/completions` with an OpenAI-style web-search tool
 *    (best-effort; only servers that implement it return structured results).
 * Requires a credential (api key). Provider-agnostic — baseUrl/model/protocol
 * are configured by the user.
 */
import { parseGoResponse, parseOpenAiResponse, type RawSource } from '../normalize.ts'
import type { LlmProtocol } from '../config.ts'

export interface GoBackendOptions {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
  protocol: LlmProtocol
  fetchImpl?: typeof fetch
}

/** Build an Anthropic /v1/messages body with the native web search server tool. */
function buildAnthropicBody(query: string, model: string): string {
  return JSON.stringify({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: ' + query }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  })
}

/** Build an OpenAI /chat/completions body with a web-search tool (best-effort). */
function buildOpenAiBody(query: string, model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Perform a web search for the query: ' + query }],
    tools: [{ type: 'web_search', name: 'web_search' }],
  })
}

export async function goSearch(query: string, opts: GoBackendOptions, signal?: AbortSignal): Promise<RawSource[]> {
  const runFetch = opts.fetchImpl ?? fetch
  const isAnthropic = opts.protocol === 'anthropic'
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  const url = isAnthropic
    ? (base.endsWith('/messages') ? base : base + '/messages')
    : (base.endsWith('/chat/completions') ? base : base + '/chat/completions')
  const body = isAnthropic ? buildAnthropicBody(query, opts.model) : buildOpenAiBody(query, opts.model)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + opts.apiKey,
    accept: 'application/json',
  }
  if (isAnthropic) {
    headers['x-api-key'] = opts.apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const cleanupTimer = () => clearTimeout(timer)
  const doFetch = async (): Promise<Response> => {
    const res = await runFetch(url, { method: 'POST', headers, body, signal: controller.signal })
    if (!res.ok) throw new Error('llm web search HTTP ' + res.status)
    return res
  }
  if (signal) {
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    try {
      const res = await doFetch()
      cleanup()
      cleanupTimer()
      const parsed = await res.json()
      return isAnthropic ? parseGoResponse(parsed) : parseOpenAiResponse(parsed)
    } catch (e) {
      cleanup()
      cleanupTimer()
      throw e
    }
  } else {
    try {
      const res = await doFetch()
      cleanupTimer()
      const parsed = await res.json()
      return isAnthropic ? parseGoResponse(parsed) : parseOpenAiResponse(parsed)
    } catch (e) {
      cleanupTimer()
      throw e
    }
  }
}
