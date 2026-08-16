import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { LspManager, type LspSymbol } from '../src/manager.ts'
import { resolveConfig, mergeConfig } from '../src/config.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lsp-mgr-'))
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n')
  await writeFile(join(dir, 'package.json'), '{}')
  return dir
}

const tempDirs: string[] = []
const managers: LspManager[] = []
afterEach(async () => {
  for (const m of managers) await m.shutdown()
  managers.length = 0
  for (const d of tempDirs) {
    try {
      const { rm } = await import('node:fs/promises')
      await rm(d, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
  tempDirs.length = 0
})

function managerFor(dir: string): LspManager {
  const merged = mergeConfig({
    servers: {
      fake: {
        command: [process.execPath, FIXTURE, '--stdio'],
        extensions: ['.ts'],
        rootMarkers: ['package.json'],
      },
    },
  })
  // Drop every default catalog server so only the fake server serves files.
  for (const id of Object.keys(merged.servers)) {
    if (id !== 'fake') delete merged.servers[id]
  }
  const config = resolveConfig(merged)
  const manager = new LspManager({ config, cwd: dir })
  managers.push(manager)
  return manager
}

describe('LspManager (integration vs fake server)', () => {
  it('discovers, opens, and queries a document', async () => {
    const dir = await fixture()
    tempDirs.push(dir)
    const manager = managerFor(dir)
    const file = join(dir, 'a.ts')
    const clients = await manager.getClients(file)
    expect(clients.length).toBe(1)
    expect(clients[0]!.serverID).toBe('fake')

    await manager.touchFile(file, 'document')
    const def = await manager.definition({ file, line: 1, character: 2 })
    expect(def.length).toBe(1)
    const hover = await manager.hover({ file, line: 1, character: 2 })
    expect(hover).toBeTruthy()
    const symbols = await manager.documentSymbol(`file://${file}`)
    expect(symbols.some((s) => (s as { name?: string }).name === 'cannedFn')).toBe(true)
    const refs = await manager.references({ file, line: 1, character: 2 })
    expect(refs.length).toBe(2)
    const impls = await manager.implementation({ file, line: 1, character: 2 })
    expect(impls.length).toBe(1)
  })

  it('status reports connected sessions', async () => {
    const dir = await fixture()
    tempDirs.push(dir)
    const manager = managerFor(dir)
    await manager.getClients(join(dir, 'a.ts'))
    const status = manager.status()
    expect(status.some((s) => s.id === 'fake' && s.status === 'connected')).toBe(true)
  })

  it('workspaceSymbol filters by kind and caps at 10', async () => {
    const dir = await fixture()
    tempDirs.push(dir)
    const manager = managerFor(dir)
    await manager.getClients(join(dir, 'a.ts'))
    const symbols: LspSymbol[] = await manager.workspaceSymbol('x')
    const names = symbols.map((s) => s.name)
    expect(names).toContain('keepMe')
    expect(names).not.toContain('dropMe') // kind 99 filtered out
    expect(symbols.length).toBeLessThanOrEqual(10)
  })

  it('reports no clients for an unmatched extension', async () => {
    const dir = await fixture()
    tempDirs.push(dir)
    const manager = managerFor(dir)
    await writeFile(join(dir, 'b.py'), 'x = 1\n')
    const clients = await manager.getClients(join(dir, 'b.py'))
    expect(clients.length).toBe(0)
  })
})
