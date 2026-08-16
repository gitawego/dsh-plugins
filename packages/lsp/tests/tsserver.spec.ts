import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTsserverPath, tsserverUnder, findProjectTsserver } from '../src/tsserver.ts'

let dirs: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lsp-ts-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) {
    try {
      const { rmSync } = require('node:fs')
      rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
  dirs = []
})

describe('tsserver resolution', () => {
  it('honors an explicit, existing tsserver.path', async () => {
    const root = fixture()
    const real = join(root, 'custom', 'tsserver.js')
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(real, '// tsserver')
    const out = await resolveTsserverPath({ binDir: join(root, 'bin'), cwd: root, explicit: real })
    expect(out.path).toBe(real)
    expect(out.action).toBeUndefined()
  })

  it('finds a project-local typescript via upward walk', async () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true })
    const file = join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js')
    writeFileSync(file, '// ts')
    const out = await resolveTsserverPath({ binDir: join(root, 'bin'), cwd: root })
    expect(out.path).toBe(await findProjectTsserver(root))
  })

  it('reuses an already-managed typescript in binDir (global)', async () => {
    const root = fixture()
    const bin = join(root, 'managed-bin')
    mkdirSync(join(bin, 'node_modules', 'typescript', 'lib'), { recursive: true })
    writeFileSync(join(bin, 'node_modules', 'typescript', 'lib', 'tsserver.js'), '// ts')
    const out = await resolveTsserverPath({ binDir: bin, cwd: root })
    expect(out.path).toBe(tsserverUnder(bin))
    expect(out.action).toBe('global')
  })

  it('does not install when install:false and nothing exists', async () => {
    const root = fixture()
    const bin = join(root, 'empty-bin')
    mkdirSync(bin, { recursive: true })
    const out = await resolveTsserverPath({ binDir: bin, cwd: root, install: false })
    expect(out.path).toBeUndefined()
    expect(out.action).toContain('could not obtain')
  })

  it('ignores an explicit path that does not exist (transparency note)', async () => {
    const root = fixture()
    const out = await resolveTsserverPath({ binDir: join(root, 'bin'), cwd: root, explicit: join(root, 'missing', 'tsserver.js') })
    expect(out.path).toBeUndefined()
    expect(out.action).toContain('not found')
  })
})
