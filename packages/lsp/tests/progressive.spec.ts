import { describe, expect, it } from 'vitest'
import { collectEditedFiles, buildInjection, toolResultLike } from '../src/progressive.ts'

describe('collectEditedFiles', () => {
  it('collects edit/write/lsp_fix paths', () => {
    const files = collectEditedFiles([
      toolResultLike('edit', { path: 'a.ts' }),
      toolResultLike('write', { path: 'b.ts' }),
      toolResultLike('lsp_fix', { path: 'c.ts' }),
      toolResultLike('hover', { path: 'no.ts' }),
    ])
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('collects bash redirect targets and de-duplicates', () => {
    const files = collectEditedFiles([
      toolResultLike('bash', { command: 'echo x >> "a.ts" && echo y > b.ts' }),
      toolResultLike('edit', { path: 'a.ts' }),
    ])
    expect(files).toContain('a.ts')
    expect(files).toContain('b.ts')
    expect(new Set(files).size).toBe(files.length)
  })
})

describe('buildInjection', () => {
  it('builds a compact summary and respects the max', () => {
    const diags = {
      '/a.ts': [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm1' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: 'm2' },
      ],
      '/b.ts': [
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, message: 'm3' },
      ],
    }
    const text = buildInjection(diags, 2)!
    expect(text).toContain('m1')
    expect(text).toContain('m2')
    expect(text).not.toContain('m3')
  })

  it('returns undefined when there is nothing', () => {
    expect(buildInjection({ '/a.ts': [] }, 5)).toBeUndefined()
    expect(buildInjection({}, 5)).toBeUndefined()
  })
})
