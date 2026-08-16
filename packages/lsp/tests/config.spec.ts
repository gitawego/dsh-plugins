import { describe, expect, it } from 'vitest'
import { mergeConfig, resolveConfig } from '../src/config.ts'
import { DEFAULT_SERVERS } from '../src/catalog.ts'

describe('mergeConfig / resolveConfig', () => {
  it('starts from the official default catalog', () => {
    const resolved = resolveConfig(mergeConfig({}))
    const ids = Object.keys(resolved.servers).sort()
    expect(ids).toEqual(Object.keys(DEFAULT_SERVERS).sort())
    expect(resolved.servers.typescript!.command).toEqual(['typescript-language-server', '--stdio'])
    expect(resolved.timeout).toBe(30000)
    expect(resolved.progressive.enabled).toBe(true)
    expect(resolved.progressive.inject).toBe('status')
    expect(resolved.progressive.maxDiagnostics).toBe(20)
  })

  it('applies per-server overrides', () => {
    const resolved = resolveConfig(mergeConfig({
      servers: {
        typescript: { command: ['custom-ts-lsp'], extensions: ['.ts'] },
      },
    }))
    expect(resolved.servers.typescript!.command).toEqual(['custom-ts-lsp'])
    expect(resolved.servers.typescript!.extensions).toEqual(['.ts'])
  })

  it('drops a default server when disabled', () => {
    const merged = mergeConfig({ servers: { kotlin: { disabled: true } } })
    expect(merged.servers.kotlin).toBeUndefined()
    expect(resolveConfig(merged).servers.kotlin).toBeUndefined()
  })

  it('adds a custom server', () => {
    const resolved = resolveConfig(mergeConfig({
      servers: { 'my-lang': { command: ['my-lsp', '--stdio'], extensions: ['.mylang'] } },
    }))
    expect(resolved.servers['my-lang']!.command).toEqual(['my-lsp', '--stdio'])
    expect(resolved.servers['my-lang']!.extensions).toEqual(['.mylang'])
  })

  it('clamps invalid timeout / clamps progressive fields', () => {
    const resolved = resolveConfig(mergeConfig({
      timeout: -5,
      progressive: { inject: 'widget', maxDiagnostics: 999999, quietMs: -1 },
    }))
    expect(resolved.timeout).toBe(30000)
    expect(['status', 'conversation', 'none']).toContain(resolved.progressive.inject)
    expect(resolved.progressive.maxDiagnostics).toBe(1000)
    expect(resolved.progressive.quietMs).toBe(2000) // below-min quietMs -> default
  })

  it('carries autoDownload flags from the catalog', () => {
    const resolved = resolveConfig(mergeConfig({}))
    expect(resolved.servers.typescript!.autoDownload).toBe(true)
    expect(resolved.servers.typescript!.download).toBe('npm')
    expect(resolved.servers.gopls!.download).toBe('go-install')
    expect(resolved.servers.clangd!.autoDownload).toBeUndefined()
  })

  it('defaults the typescript payload version to 6 and allows override', () => {
    expect(resolveConfig(mergeConfig({})).servers.typescript!.payloadVersion).toBe('6')
    const over = resolveConfig(mergeConfig({
      servers: { typescript: { payloadVersion: '5' } },
    }))
    expect(over.servers.typescript!.payloadVersion).toBe('5')
  })
})
