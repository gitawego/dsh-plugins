/**
 * Both hosted MCP endpoints are free anonymously and take an optional API key as
 * a Bearer token for higher rate limits. These tests pin that contract from our
 * side: the token rides when one is configured, and its absence leaves the
 * anonymous request byte-identical to what shipped before.
 */
import { describe, expect, it, vi } from 'vitest'
import { bearerAuth } from '../src/backends/auth.ts'
import { parallelSearch } from '../src/backends/parallel.ts'
import { exaSearch } from '../src/backends/exa.ts'
import { createResolvedConfig, DEFAULT_CONFIG } from '../src/config.ts'
import { createSearchProvider, type ProviderRuntime } from '../src/provider.ts'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'

describe('bearerAuth', () => {
    it('sends the key as a Bearer token', () => {
        expect(bearerAuth('abc')).toEqual({ authorization: 'Bearer abc' })
    })

    it('sends nothing for an absent or blank key, which is the anonymous path', () => {
        expect(bearerAuth(undefined)).toEqual({})
        expect(bearerAuth('')).toEqual({})
        expect(bearerAuth('   ')).toEqual({})
    })

    it('trims a key pasted with whitespace, which Fetch would otherwise carry into the header', () => {
        expect(bearerAuth('  abc\n')).toEqual({ authorization: 'Bearer abc' })
    })
})

/** Capture the request one backend issues. */
function recorder(body: string, contentType = 'application/json') {
    const seen: { headers: Record<string, string>; url: string }[] = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {}
        new Headers(init?.headers ?? {}).forEach((value, name) => {
            headers[name.toLowerCase()] = value
        })
        seen.push({ headers, url: String(url) })
        return new Response(body, { status: 200, headers: { 'content-type': contentType } })
    }) as unknown as typeof fetch
    return { seen, impl }
}

const parallelBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://p.com', title: 'P', excerpts: ['x'] }] }) }] } })
const exaBody = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Title: E\\nURL: https://e.com\\nHighlights: hi"}]}}'

describe('the free backends', () => {
    it('sends the Parallel token when one is configured', async () => {
        const { seen, impl } = recorder(parallelBody)
        await parallelSearch('q', { url: 'https://search.parallel.ai/mcp', timeoutMs: 1000, apiKey: 'parallel-key', fetchImpl: impl })
        expect(seen[0]?.headers['authorization']).toBe('Bearer parallel-key')
    })

    it('sends no authorization header when none is configured', async () => {
        const { seen, impl } = recorder(parallelBody)
        await parallelSearch('q', { url: 'https://search.parallel.ai/mcp', timeoutMs: 1000, fetchImpl: impl })
        expect(seen[0]?.headers['authorization']).toBeUndefined()
    })

    it('sends the Exa token when one is configured', async () => {
        const { seen, impl } = recorder(exaBody, 'text/event-stream')
        await exaSearch('q', { url: 'https://mcp.exa.ai/mcp', timeoutMs: 1000, apiKey: 'exa-key', fetchImpl: impl })
        expect(seen[0]?.headers['authorization']).toBe('Bearer exa-key')
    })

    it('sends no authorization header when none is configured', async () => {
        const { seen, impl } = recorder(exaBody, 'text/event-stream')
        await exaSearch('q', { url: 'https://mcp.exa.ai/mcp', timeoutMs: 1000, fetchImpl: impl })
        expect(seen[0]?.headers['authorization']).toBeUndefined()
    })
})

describe('the default model', () => {
    it('is the model the live configuration runs', () => {
        expect(DEFAULT_CONFIG.llm.model).toBe('deepseek-v4.1-flash')
        expect(createResolvedConfig({}).llm.model).toBe('deepseek-v4.1-flash')
    })

    it('is what the opencode Go fallback step requests', async () => {
        // The step is hardcoded; a stale id there would silently 404 against a
        // gateway that has moved on.
        const bodies: string[] = []
        const impl = (async (_url: string | URL, init?: RequestInit) => {
            bodies.push(String(init?.body ?? ''))
            // A result block, or the step reports "empty results" and the chain moves on.
            return new Response(JSON.stringify({
                type: 'message',
                content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'G', url: 'https://g.com', encrypted_content: 'x' }] }],
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch
        const provider: WebSearchProvider = createSearchProvider(
            () => createResolvedConfig({ llm: { enabled: false, baseUrl: undefined, credential: undefined, model: 'deepseek-v4.1-flash', protocol: 'anthropic', timeoutMs: 1000 } }),
            {
                fetchImpl: impl,
                resolveGoApiKey: async () => undefined,
                resolveOpenCodeGoApiKey: async () => 'go-key',
            } as ProviderRuntime,
        )
        await provider.search({ query: 'q' })
        expect(bodies[0]).toContain('deepseek-v4.1-flash')
    })
})

describe('the credential references', () => {
    it('default to absent, so the anonymous free path stays the default', () => {
        expect(createResolvedConfig({}).free.parallelCredential).toBeUndefined()
        expect(createResolvedConfig({}).free.exaCredential).toBeUndefined()
    })

    it('normalize a blank reference to absent rather than naming an empty key', () => {
        const resolved = createResolvedConfig({ free: { ...DEFAULT_CONFIG.free, parallelCredential: '  ', exaCredential: 'EXA_KEY' } })
        expect(resolved.free.parallelCredential).toBeUndefined()
        expect(resolved.free.exaCredential).toBe('EXA_KEY')
    })

    it('resolve through the credential seam and ride on the request', async () => {
        const seen: Record<string, string>[] = []
        const impl = (async (_url: string | URL, init?: RequestInit) => {
            const headers: Record<string, string> = {}
            new Headers(init?.headers ?? {}).forEach((value, name) => {
                headers[name.toLowerCase()] = value
            })
            seen.push(headers)
            return new Response(parallelBody, { status: 200, headers: { 'content-type': 'application/json' } })
        }) as unknown as typeof fetch
        const provider = createSearchProvider(
            () => createResolvedConfig({
                llm: { enabled: false, baseUrl: undefined, credential: undefined, model: 'deepseek-v4.1-flash', protocol: 'anthropic', timeoutMs: 1000 },
                free: { ...DEFAULT_CONFIG.free, parallelCredential: 'PARALLEL_KEY' },
            }),
            {
                fetchImpl: impl,
                resolveGoApiKey: async () => undefined,
                resolveOpenCodeGoApiKey: async () => undefined,
                resolveParallelApiKey: async () => 'from-store',
            } as ProviderRuntime,
        )
        await provider.search({ query: 'q' })
        expect(seen[0]?.['authorization']).toBe('Bearer from-store')
    })

    it('do not ask the seam when no reference is configured', async () => {
        const resolveParallelApiKey = vi.fn(async () => 'unused')
        const impl = (async () => new Response(parallelBody, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
        const provider = createSearchProvider(
            () => createResolvedConfig({ llm: { enabled: false, baseUrl: undefined, credential: undefined, model: 'deepseek-v4.1-flash', protocol: 'anthropic', timeoutMs: 1000 }, free: { ...DEFAULT_CONFIG.free } }),
            { fetchImpl: impl, resolveGoApiKey: async () => undefined, resolveOpenCodeGoApiKey: async () => undefined, resolveParallelApiKey } as ProviderRuntime,
        )
        await provider.search({ query: 'q' })
        expect(resolveParallelApiKey).not.toHaveBeenCalled()
    })
})
