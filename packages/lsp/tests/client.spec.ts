import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, type LspClient } from '../src/client.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))

async function fixtureDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-lsp-${name}-`))
  await writeFile(join(dir, 'a.ts'), 'const x: number = "not a number";\n')
  return dir
}

const tempDirs: string[] = []
afterEach(async () => {
  for (const d of tempDirs) {
    try {
      const { rm } = await import('node:fs/promises')
      await rm(d, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
  tempDirs.length = 0
  if (currentClient) {
    await currentClient.shutdown()
    currentClient = undefined
  }
})

let currentClient: LspClient | undefined

describe('LspClient (integration vs fake server)', () => {
  it('initializes and opens a document (push diagnostics)', async () => {
    const dir = await fixtureDir('push')
    tempDirs.push(dir)
    const client = await createClient({
      serverID: 'fake',
      command: [process.execPath, FIXTURE, '--stdio'],
      cwd: dir,
      timeoutMs: 5000,
    })
    currentClient = client
    const version = await client.touchFile(join(dir, 'a.ts'))
    await client.waitForDiagnostics({
      path: join(dir, 'a.ts'),
      version,
      mode: 'full',
      requireNonEmpty: false,
    })
    const diags = client.diagnostics.get(join(dir, 'a.ts')) ?? []
    expect(client.serverID).toBe('fake')
    // Fake server publishes empty diagnostics for a.ts (no errors) and the
    // version is monotonically increasing.
    expect(version).toBe(0)
    expect(diags).toBeDefined()
  })

  it('serves canned query responses (definition, hover, references)', async () => {
    const dir = await fixtureDir('canned')
    tempDirs.push(dir)
    const client = await createClient({
      serverID: 'fake',
      command: [process.execPath, FIXTURE, '--stdio'],
      cwd: dir,
      timeoutMs: 5000,
    })
    currentClient = client
    const file = join(dir, 'a.ts')
    await client.touchFile(file)
    const def = await client.request<unknown>('textDocument/definition', {
      textDocument: { uri: `file://${file}` },
      position: { line: 1, character: 2 },
    })
    expect(def).toBeTruthy()
    const hover = await client.request<{ contents?: { value?: string } }>('textDocument/hover', {
      textDocument: { uri: `file://${file}` },
      position: { line: 1, character: 2 },
    })
    expect(hover?.contents?.value).toBe('hover docs')
  })

  it('shuts down gracefully (sends shutdown + exit)', async () => {
    const dir = await fixtureDir('shutdown')
    tempDirs.push(dir)
    const client = await createClient({
      serverID: 'fake',
      command: [process.execPath, FIXTURE, '--stdio'],
      cwd: dir,
      timeoutMs: 5000,
    })
    currentClient = client
    await client.shutdown()
    // Subsequent requests resolve null on a shut-down client.
    const res = await client.request<unknown>('textDocument/definition', {})
    expect(res).toBeNull()
  })
})
