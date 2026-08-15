import { describe, it, expect } from 'vitest'
import { dedupeAndCap, parseParallelText, parseExaText, parseGoResponse, parseOpenAiResponse } from '../src/normalize.ts'

describe('normalize', () => {
  it('maps Parallel inner text to sources with url/title/snippet/publishedAt', () => {
    const inner = JSON.stringify({
      search_id: 'x',
      results: [
        { url: 'https://a.com', title: 'A', publish_date: '2025-01-02', excerpts: ['first excerpt', 'second'] },
        { url: 'https://b.com', title: 'B', publish_date: null, excerpts: [] },
      ],
    })
    const out = parseParallelText(inner)
    expect(out).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'first excerpt', publishedAt: '2025-01-02' },
      { url: 'https://b.com', title: 'B' },
    ])
  })

  it('parses Exa text blocks into sources', () => {
    const text = 'Title: Paper Y\nURL: https://arxiv.org/abs/2501.12948v1\nPublished: 2025-01-23\nAuthor: N/A\nHighlights:\nSome highlight here.\n'
    const out = parseExaText(text)
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0]!.url).toBe('https://arxiv.org/abs/2501.12948v1')
    expect(out[0]!.title).toBe('Paper Y')
  })

  it('parses Go anthropic web_search_tool_result blocks (ignores encrypted_content)', () => {
    const body = {
      type: 'message',
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'server_tool_use', name: 'web_search', input: { query: 'q' } },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', title: 'T1', url: 'https://x.com', encrypted_content: 'opaque' },
            { type: 'web_search_result', title: 'T2', url: 'https://y.com' },
          ],
        },
      ],
    }
    const out = parseGoResponse(body)
    expect(out).toEqual([
      { url: 'https://x.com', title: 'T1' },
      { url: 'https://y.com', title: 'T2' },
    ])
  })

  it('extracts plaintext content snippet from web_search_result (MiniMax)', () => {
    const body = { type: 'message', content: [{
      type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', title: 'T', url: 'https://x.com', content: 'plaintext snippet here', page_age: '2026-01-01' }],
    }] }
    expect(parseGoResponse(body)).toEqual([
      { url: 'https://x.com', title: 'T', snippet: 'plaintext snippet here', publishedAt: '2026-01-01' },
    ])
  })

  it('returns [] when Go returns no web_search_tool_result block', () => {
    expect(parseGoResponse({ type: 'message', content: [{ type: 'text', text: 'hi' }] })).toEqual([])
  })

  it('dedupes by URL and caps to maxResults, setting truncated only when capped', () => {
    const raw = [1, 2, 3, 4, 5].map((i) => ({ url: 'https://u' + i + '.com', snippet: 's'.repeat(50) }))
    const out = dedupeAndCap(raw, 3, 300)
    expect(out.sources.map((s) => s.url)).toEqual(['https://u1.com', 'https://u2.com', 'https://u3.com'])
    expect(out.truncated).toBe(true)
    // when under cap, not truncated
    const under = dedupeAndCap(raw, 10, 300)
    expect(under.truncated).toBe(false)
  })

  it('parses OpenAI web_search.results into sources', () => {
    const body = {
      choices: [{ message: { web_search: { results: [
        { url: 'https://a.com', title: 'A', snippet: 'sa' },
        { url: 'https://b.com', title: 'B' },
      ] } } }],
    }
    expect(parseOpenAiResponse(body)).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'sa' },
      { url: 'https://b.com', title: 'B' },
    ])
  })

  it('caps snippet length', () => {
    const raw = [{ url: 'https://a.com', snippet: 'x'.repeat(1000) }]
    const out = dedupeAndCap(raw, 5, 300)
    expect(out.sources[0]!.snippet!.length).toBe(300)
  })
})