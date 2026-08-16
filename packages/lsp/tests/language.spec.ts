import { describe, expect, it } from 'vitest'
import { languageIdFor } from '../src/language.ts'

describe('languageIdFor', () => {
  it('maps common extensions', () => {
    expect(languageIdFor('/x/a.ts')).toBe('typescript')
    expect(languageIdFor('b.tsx')).toBe('typescriptreact')
    expect(languageIdFor('c.py')).toBe('python')
    expect(languageIdFor('d.go')).toBe('go')
    expect(languageIdFor('e.rs')).toBe('rust')
    expect(languageIdFor('f.kt')).toBe('kotlin')
  })

  it('falls back to plaintext for unknown/no extension', () => {
    expect(languageIdFor('/x/README')).toBe('plaintext')
    expect(languageIdFor('.gitignore')).toBe('plaintext')
    expect(languageIdFor('file.unknownxyz')).toBe('plaintext')
  })
})
