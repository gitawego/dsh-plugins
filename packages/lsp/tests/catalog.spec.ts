import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVERS } from '../src/catalog.ts'
import { downloadPlanFor } from '../src/download.ts'

describe('default catalog', () => {
  it('defines the official servers with official servers (never a linter)', () => {
    for (const id of ['typescript', 'kotlin', 'gopls', 'rust-analyzer', 'clangd', 'pyright', 'ruby-lsp', 'elixir-ls', 'zls']) {
      expect(DEFAULT_SERVERS[id], `${id} present`).toBeDefined()
    }
  })

  it('maps download plans for opt-in servers', () => {
    expect(downloadPlanFor({ id: 'typescript', download: 'npm' })?.kind).toBe('npm')
    expect(downloadPlanFor({ id: 'kotlin', download: 'github-release' })?.kind).toBe('github-release')
    expect(downloadPlanFor({ id: 'gopls', download: 'go-install' })?.kind).toBe('go-install')
    expect(downloadPlanFor({ id: 'clangd' })).toBeUndefined()
  })
})
