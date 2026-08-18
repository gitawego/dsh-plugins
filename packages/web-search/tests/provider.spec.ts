import { describe, it, expect, vi } from 'vitest'
import { createResolvedConfig } from '../src/config.ts'
import type { WebSearchConfig } from '../src/config.ts'
import { createSearchProvider, type ProviderRuntime } from '../src/provider.ts'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'

type FetchThunk = ((url: string, init: RequestInit) => Response | Promise<Response>) | (() => Response | Promise<Response>)
function fakeFetch(queue: FetchThunk[]) {
  return vi.fn(async (url: any, init: any) => {
    const fn = queue.shift()
    if (!fn) throw new Error('no more fake responses queued for ' + url)
    return fn(url, init)
  }) as unknown as typeof fetch
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

const cfg = () => createResolvedConfig({
  llm: { enabled: true, protocol: 'anthropic' as const, baseUrl: 'https://opencode.ai/zen/go/v1', credential: 'OPENCODE_GO_API_KEY', model: 'deepseek-v4-flash', timeoutMs: 2000 },
  free: { parallelUrl: 'https://search.parallel.ai/mcp', exaUrl: 'https://mcp.exa.ai/mcp', timeoutMs: 1500, snippetMaxChars: 300, maxResults: 5 },
})

const parallelOk = () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ search_id: 's', results: [{ url: 'https://p.com', title: 'P', publish_date: null, excerpts: ['pp'] }] }) }] } })
const exaOk = () => textResponse('event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: E\\nURL: https://e.com\\nPublished: 2025-01-01\\nHighlights: hi"}]}}')
const goOk = () => jsonResponse({ type: 'message', content: [ { type: 'server_tool_use', name: 'web_search', input: { query: 'q' } }, { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'G', url: 'https://g.com', encrypted_content: 'x' }] } ] })

function makeProvider(runtime: Partial<ProviderRuntime>, fetchImpl: typeof fetch): WebSearchProvider {
  return createSearchProvider(() => cfg(), {
    fetchImpl,
    resolveGoApiKey: async () => undefined,
    resolveOpenCodeGoApiKey: async () => undefined,
    ...runtime,
} as any)
}

describe('provider (chained fallback)', () => {
  it('prefers Go when its credential resolves, and returns go sources', async () => {
    const fetchImpl = fakeFetch([goOk])
    const p = makeProvider({ resolveGoApiKey: async () => 'sk-x' }, fetchImpl)
    expect(p.available()).toBe(true)
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://g.com')
    expect(result.sources[0]!.title).toBe('G')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('skips Go when no credential, and uses Parallel (free) directly', async () => {
    const fetchImpl = fakeFetch([parallelOk])
    const p = makeProvider({ resolveGoApiKey: async () => undefined }, fetchImpl)
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://p.com')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back Go to Parallel when Go errors', async () => {
    const failingGo = () => { throw new Error('network') }
    const fetchImpl = fakeFetch([failingGo, parallelOk])
    const p = makeProvider({ resolveGoApiKey: async () => 'sk-x' }, fetchImpl)
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://p.com')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('falls back to Exa when Go and Parallel both fail', async () => {
    const fail = () => { throw new Error('down') }
    const fetchImpl = fakeFetch([fail, fail, exaOk])
    const p = makeProvider({ resolveGoApiKey: async () => 'sk-x' }, fetchImpl)
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://e.com')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('honors maxResults bound (capped + truncated)', async () => {
    const inner = JSON.stringify({ search_id: 's', results: [1,2,3,4,5,6,7,8,9,10].map((i) => ({ url: 'https://u'+i+'.com', title: 'T'+i, publish_date: null, excerpts: [] })) })
    const fetchImpl = fakeFetch([() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: inner }] } })])
    const p = makeProvider({ resolveGoApiKey: async () => undefined }, fetchImpl)
    const result = await p.search({ query: 'q' })
    expect(result.sources.length).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('throws WebError when all backends fail', async () => {
    const fail = () => { throw new Error('all down') }
    const fetchImpl = fakeFetch([fail, fail, fail])
    const p = makeProvider({ resolveGoApiKey: async () => undefined }, fetchImpl)
    await expect(p.search({ query: 'q' })).rejects.toThrow()
  })

  it('available() is false when no free url and no go credential', async () => {
    const p = createSearchProvider(() => createResolvedConfig({ llm: { baseUrl: undefined, credential: undefined }, free: { parallelUrl: '', exaUrl: '', timeoutMs: 0, snippetMaxChars: 0, maxResults: 0 } } as Partial<WebSearchConfig>), {} as any)
    expect(p.available()).toBe(false)
  })

  it('falls through to opencode-go default when custom LLM fails', async () => {
    // Custom LLM has a key, but its endpoint fails. The chain falls through
    // to the opencode-go default (credential 'sk-go'), which then succeeds
    // against its own Anthropic-format endpoint.
    const failingCustom = () => { throw new Error('custom backend down') }
    const fetchImpl = fakeFetch([failingCustom, goOk, exaOk])
    const p = makeProvider({
      resolveGoApiKey: async () => 'sk-custom',
      resolveOpenCodeGoApiKey: async () => 'sk-go',
    }, fetchImpl)
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://g.com')
    expect(result.sources[0]!.title).toBe('G')
  })

  it('skips opencode-go default silently when its credential is missing', async () => {
    // Custom LLM is unset, opencode-go has no key; the chain must continue
    // to the free backends without throwing the "no credential" error.
    const customDisabled = createResolvedConfig({ llm: { enabled: false }, free: { parallelUrl: 'https://search.parallel.ai/mcp', exaUrl: 'https://mcp.exa.ai/mcp' } } as Partial<WebSearchConfig>)
    const fetchImpl = fakeFetch([parallelOk]) // opencode-go never called
    const p = createSearchProvider(() => customDisabled, {
      fetchImpl,
      resolveGoApiKey: async () => undefined,
      resolveOpenCodeGoApiKey: async () => undefined,
    })
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://p.com')
  })

  it('prefers custom LLM when it works over opencode-go default', async () => {
    // Both credentials resolve; the custom LLM should win (fewer fetches).
    const fetchImpl = fakeFetch([goOk, exaOk]) // custom, exa never reached
    const p = makeProvider({
      resolveGoApiKey: async () => 'sk-custom',
      resolveOpenCodeGoApiKey: async () => 'sk-go',
    }, fetchImpl)
    const result = await p.search({ query: 'q' })
    expect(result.sources[0]!.url).toBe('https://g.com')
    expect(fetchImpl).toHaveBeenCalledTimes(1) // custom LLM only, default skipped
  })
})