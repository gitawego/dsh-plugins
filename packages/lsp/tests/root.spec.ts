import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nearestRoot, strictNearestRoot } from '../src/root.ts'

let dirs: string[] = []
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-lsp-root-'))
  dirs.push(root)
  const pkg = path.join(root, 'pkg', 'src')
  await mkdir(pkg, { recursive: true })
  await writeFile(path.join(root, 'go.work'), '')
  await writeFile(path.join(root, 'pkg', 'go.mod'), '')
  return root
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

describe('nearestRoot', () => {
  it('finds the nearest marker up from the file', async () => {
    const root = await fixture()
    const fn = nearestRoot(['go.work', 'go.mod'])
    const file = path.join(root, 'pkg', 'src', 'a.go')
    const found = await fn(file, { directory: root })
    // The nearest marker walking up from pkg/src first hits pkg/go.mod.
    expect(found).toBe(path.join(root, 'pkg'))
  })

  it('falls back to the boundary directory when no marker is found', async () => {
    const root = await fixture()
    const fn = nearestRoot(['NOPE'])
    const found = await fn(path.join(root, 'pkg', 'src', 'a.go'), { directory: root })
    expect(found).toBe(root)
  })
})

describe('strictNearestRoot', () => {
  it('returns undefined when no marker matches', async () => {
    const root = await fixture()
    const fn = strictNearestRoot(['NOPE'])
    const found = await fn(path.join(root, 'pkg', 'src', 'a.go'), { directory: root })
    expect(found).toBeUndefined()
  })

  it('returns the nearest marker dir', async () => {
    const root = await fixture()
    const fn = strictNearestRoot(['go.work', 'go.mod'])
    const found = await fn(path.join(root, 'pkg', 'src', 'a.go'), { directory: root })
    expect(found).toBe(path.join(root, 'pkg'))
  })
})
