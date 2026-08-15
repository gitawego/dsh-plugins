import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, createResolvedConfig, WEB_SEARCH_SETTINGS_NAMESPACE } from '../src/config.ts'
import type { WebSearchConfig } from '../src/config.ts'

describe('config', () => {
  it('exposes a settings namespace', () => {
    expect(WEB_SEARCH_SETTINGS_NAMESPACE).toMatch(/web-search-enhanced/)
  })

  it('has sensible defaults (free backends enabled, llm off by default)', () => {
    expect(DEFAULT_CONFIG.llm.baseUrl).toBeUndefined()
    expect(DEFAULT_CONFIG.free.parallelUrl).toContain('search.parallel.ai/mcp')
    expect(DEFAULT_CONFIG.free.exaUrl).toContain('mcp.exa.ai/mcp')
    expect(DEFAULT_CONFIG.free.maxResults).toBe(8)
    expect(DEFAULT_CONFIG.free.snippetMaxChars).toBe(300)
  })

  it('merges partial config over defaults', () => {
    const r = createResolvedConfig({ llm: { baseUrl: 'https://x/v1', model: 'm' } } as Partial<WebSearchConfig>)
    expect(r.llm.baseUrl).toBe('https://x/v1')
    expect(r.llm.model).toBe('m')
    expect(r.free.maxResults).toBe(8) // untouched default
  })

  it('coerces empty string to undefined for optional llm fields', () => {
    const r = createResolvedConfig({ llm: { baseUrl: '', credential: '' } } as Partial<import('../src/config.ts').WebSearchConfig>)
    expect(r.llm.baseUrl).toBeUndefined()
    expect(r.llm.credential).toBeUndefined()
  })
})