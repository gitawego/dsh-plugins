import { describe, expect, it } from 'vitest'
import { RootPool, type RootUser } from '../src/pool.ts'

interface FakeManager { root: string; released: boolean }

function makePool(): { pool: RootPool<FakeManager>; released: string[] } {
  const released: string[] = []
  const pool = new RootPool<FakeManager>(
    (root) => ({ root, released: false }),
    (root, manager) => { manager.released = true; released.push(root) },
  )
  return { pool, released }
}

const user = (id: string): RootUser => ({ id })

describe('RootPool', () => {
  it('shares one handle across users of the same root', () => {
    const { pool } = makePool()
    const a = pool.acquire('/repo', user('agent-1'))
    const b = pool.acquire('/repo', user('agent-2'))
    expect(a).toBe(b) // same handle object
    expect(pool.handles).toHaveLength(1)
  })

  it('creates a separate handle per distinct root', () => {
    const { pool } = makePool()
    const a = pool.acquire('/a', user('agent-1'))
    const b = pool.acquire('/b', user('agent-2'))
    expect(a).not.toBe(b)
    expect(pool.handles).toHaveLength(2)
  })

  it('releases only when the last user of a root leaves', () => {
    const { pool, released } = makePool()
    pool.acquire('/repo', user('a'))
    pool.acquire('/repo', user('b'))
    pool.release(user('a'))
    expect(released).toEqual([]) // still referenced by b
    expect(pool.handles).toHaveLength(1)
    pool.release(user('b'))
    expect(released).toEqual(['/repo'])
    expect(pool.handles).toHaveLength(0)
  })

  it('releasing an unknown user is a no-op', () => {
    const { pool, released } = makePool()
    pool.acquire('/repo', user('a'))
    pool.release(user('nobody'))
    expect(released).toEqual([])
    expect(pool.handles).toHaveLength(1)
  })

  it('releaseAll disposes every live handle and clears state', () => {
    const { pool, released } = makePool()
    pool.acquire('/a', user('a'))
    pool.acquire('/b', user('b'))
    pool.releaseAll()
    expect(released.sort()).toEqual(['/a', '/b'])
    expect(pool.handles).toHaveLength(0)
  })
})
