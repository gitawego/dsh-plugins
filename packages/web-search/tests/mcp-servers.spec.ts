/**
 * The shipped MCP servers have fixed endpoints; servers someone adds are called
 * after them, in the order they listed them, with an optional token each.
 *
 * The distinction matters: a built-in endpoint is the address this plugin was
 * tested against, and letting it be edited turns a working free backend into a
 * typo that silently falls through the chain.
 */
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_MCP_SERVERS, DEFAULT_CONFIG, createResolvedConfig, type WebSearchConfig } from '../src/config.ts'
import { buildMcpRequest, mcpSearch, parseMcpBody } from '../src/backends/mcp.ts'
import { createSearchProvider, type ProviderRuntime } from '../src/provider.ts'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'

describe('the shipped servers', () => {
    it('declare a fixed endpoint each, and the field their token lives in', () => {
        expect(BUILTIN_MCP_SERVERS.map((server) => [server.id, server.url, server.credentialField, server.shape])).toEqual([
            ['parallel', 'https://search.parallel.ai/mcp', 'parallelCredential', 'parallel'],
            ['exa', 'https://mcp.exa.ai/mcp', 'exaCredential', 'exa'],
        ])
    })

    it('are not part of the configuration schema, so no surface can edit an endpoint', () => {
        const resolved = createResolvedConfig({})
        expect(Object.keys(resolved.free)).not.toContain('parallelUrl')
        expect(Object.keys(resolved.free)).not.toContain('exaUrl')
    })
})

describe('an added server', () => {
    it('normalizes its entry: trimmed, labelled, and defaulted to the web_search tool', () => {
        const resolved = createResolvedConfig({
            free: { ...DEFAULT_CONFIG.free, servers: [{ id: 's1', label: '  ', url: '  https://mcp.example/mcp  ', credential: ' KEY ', tool: '' }] },
        })
        expect(resolved.free.servers).toEqual([
            { id: 's1', label: 'https://mcp.example/mcp', url: 'https://mcp.example/mcp', credential: 'KEY', tool: 'web_search' },
        ])
    })

    it('drops an entry with no endpoint, rather than trying to call nothing', () => {
        const resolved = createResolvedConfig({ free: { ...DEFAULT_CONFIG.free, servers: [{ id: 's1', label: 'x', url: '   ', credential: '', tool: '' }] } })
        expect(resolved.free.servers).toEqual([])
    })

    it('carries the tool name in the request, defaulting to web_search', () => {
        expect(JSON.parse(buildMcpRequest('q', 'web_search')).params).toMatchObject({ name: 'web_search', arguments: { objective: 'q' } })
        expect(JSON.parse(buildMcpRequest('q', 'search_web')).params).toMatchObject({ name: 'search_web' })
    })

    it('reads a Parallel-shaped reply and an Exa-shaped one', () => {
        const parallel = JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://p.com', title: 'P', excerpts: ['x'] }] }) }] } })
        expect(parseMcpBody(parallel).map((source) => source.url)).toEqual(['https://p.com'])
        const exa = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: E\\nURL: https://e.com\\nHighlights: hi"}]}}'
        expect(parseMcpBody(exa).map((source) => source.url)).toEqual(['https://e.com'])
    })

    it('yields no sources for a reply it cannot read, so the chain moves on', () => {
        expect(parseMcpBody('not json at all')).toEqual([])
        expect(parseMcpBody(JSON.stringify({ result: { content: [] } }))).toEqual([])
    })

    it('sends its token as a Bearer header, and nothing when it has none', async () => {
        const seen: Record<string, string>[] = []
        const impl = (async (_url: string | URL, init?: RequestInit) => {
            const headers: Record<string, string> = {}
            new Headers(init?.headers ?? {}).forEach((value, name) => {
                headers[name.toLowerCase()] = value
            })
            seen.push(headers)
            return new Response('{}', { status: 200 })
        }) as unknown as typeof fetch
        await mcpSearch('q', { url: 'https://mcp.example/mcp', timeoutMs: 1000, apiKey: 'tok', fetchImpl: impl })
        await mcpSearch('q', { url: 'https://mcp.example/mcp', timeoutMs: 1000, fetchImpl: impl })
        expect(seen[0]?.['authorization']).toBe('Bearer tok')
        expect(seen[1]?.['authorization']).toBeUndefined()
    })
})

/** A provider whose config is fixed for the test. */
function providerWith(config: Partial<WebSearchConfig>, runtime: Partial<ProviderRuntime>, fetchImpl: typeof fetch): WebSearchProvider {
    return createSearchProvider(() => createResolvedConfig(config), {
        fetchImpl,
        resolveGoApiKey: async () => undefined,
        resolveOpenCodeGoApiKey: async () => undefined,
        ...runtime,
    } as ProviderRuntime)
}

const parallelOk = () => new Response(
    JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://builtin.com', title: 'B', excerpts: ['x'] }] }) }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
)

describe('the chain order', () => {
    it('tries the shipped servers before the added ones', async () => {
        const calls: string[] = []
        const impl = (async (url: string | URL) => {
            calls.push(String(url))
            // The added server answers; the shipped one is asked first and fails.
            if (String(url).includes('example')) {
                return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://added.com', title: 'A', excerpts: ['y'] }] }) }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
            }
            return new Response('nope', { status: 500 })
        }) as unknown as typeof fetch
        const provider = providerWith(
            { free: { ...DEFAULT_CONFIG.free, servers: [{ id: 's1', label: 'Mine', url: 'https://mcp.example/mcp', credential: '', tool: 'web_search' }] } },
            {},
            impl,
        )
        const result = await provider.search({ query: 'q' })
        expect(result.sources.map((source) => source.url)).toEqual(['https://added.com'])
        expect(calls).toEqual(['https://search.parallel.ai/mcp', 'https://mcp.exa.ai/mcp', 'https://mcp.example/mcp'])
    })

    it('resolves an added server token through the seam', async () => {
        const resolveServerApiKey = vi.fn(async () => 'server-token')
        const seen: { url: string; headers: Record<string, string> }[] = []
        const impl = (async (url: string | URL, init?: RequestInit) => {
            const headers: Record<string, string> = {}
            new Headers(init?.headers ?? {}).forEach((value, name) => {
                headers[name.toLowerCase()] = value
            })
            seen.push({ url: String(url), headers })
            // Only the added server answers, so the chain must reach it.
            return String(url).includes('example') ? parallelOk() : new Response('nope', { status: 500 })
        }) as unknown as typeof fetch
        const provider = providerWith(
            { free: { ...DEFAULT_CONFIG.free, servers: [{ id: 's1', label: 'Mine', url: 'https://mcp.example/mcp', credential: 'MY_KEY', tool: 'web_search' }] } },
            { resolveServerApiKey },
            impl,
        )
        await provider.search({ query: 'q' })
        expect(resolveServerApiKey).toHaveBeenCalledWith('MY_KEY')
        const added = seen.find((entry) => entry.url.includes('example'))
        expect(added?.headers['authorization']).toBe('Bearer server-token')
    })

    it('does not ask the seam for a server with no credential reference', async () => {
        const resolveServerApiKey = vi.fn(async () => 'unused')
        const seen: { url: string; headers: Record<string, string> }[] = []
        const impl = (async (url: string | URL, init?: RequestInit) => {
            const headers: Record<string, string> = {}
            new Headers(init?.headers ?? {}).forEach((value, name) => {
                headers[name.toLowerCase()] = value
            })
            seen.push({ url: String(url), headers })
            return String(url).includes('example') ? parallelOk() : new Response('nope', { status: 500 })
        }) as unknown as typeof fetch
        const provider = providerWith(
            { free: { ...DEFAULT_CONFIG.free, servers: [{ id: 's1', label: 'Mine', url: 'https://mcp.example/mcp', credential: '', tool: 'web_search' }] } },
            { resolveServerApiKey },
            impl,
        )
        await provider.search({ query: 'q' })
        expect(resolveServerApiKey).not.toHaveBeenCalled()
        expect(seen.find((entry) => entry.url.includes('example'))?.headers['authorization']).toBeUndefined()
    })
})
