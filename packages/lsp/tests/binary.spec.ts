import { describe, expect, it } from 'vitest'
import { resolveBinary, resolveCommand } from '../src/binary.ts'

describe('binary resolution', () => {
  it('resolves an absolute path', async () => {
    const found = await resolveBinary('/bin/sh', process.cwd())
    expect(found).toBe('/bin/sh')
  })

  it('resolves via PATH', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: process.cwd() } as NodeJS.ProcessEnv
    const found = await resolveBinary('sh', process.cwd(), { env })
    expect(found).toBeTruthy()
  })

  it('returns undefined for a missing binary', async () => {
    const env = { PATH: '/nonexistent-dir', HOME: process.cwd() } as NodeJS.ProcessEnv
    const found = await resolveBinary('definitely-not-a-real-binary-xyz', process.cwd(), { env })
    expect(found).toBeUndefined()
  })

  it('resolveCommand splits args', async () => {
    const res = await resolveCommand({ command: ['/bin/sh', '-c', 'echo hi'] }, process.cwd())
    expect(res?.command).toBe('/bin/sh')
    expect(res?.args).toEqual(['-c', 'echo hi'])
  })
})
