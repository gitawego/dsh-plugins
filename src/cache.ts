/** Content-addressed delegation cache: memory LRU always, optional disk LRU.
 *  Key = sha256(image hash + compression params + prompt + model + reasoning +
 *  system prompt), so a hit costs ZERO vision-model calls. Only successes are
 *  cached — fallback results never are (F10). */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CacheEntry {
  text: string
  details: Record<string, unknown>
  storedAt: number
}

export interface CacheStats {
  memoryEntries: number
  diskEntries: number
  maxEntries: number
  persisted: boolean
}

/** Deterministic content-addressed key. */
export function cacheKey(...parts: (string | number | boolean | undefined)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

interface DiskEntryMeta {
  key: string
  storedAt: number
}

export class VisionCache {
  private readonly memory = new Map<string, CacheEntry>()
  private diskIndex: DiskEntryMeta[] | undefined
  private readonly dir: string | undefined
  private readonly maxEntries: number

  constructor(options: { dir?: string; maxEntries: number }) {
    this.dir = options.dir
    this.maxEntries = options.maxEntries
  }

  get persisted(): boolean {
    return this.dir !== undefined
  }

  /** LRU-promote a memory entry (delete + re-insert to keep insertion order). */
  private touch(key: string): void {
    const entry = this.memory.get(key)
    if (entry !== undefined) {
      this.memory.delete(key)
      this.memory.set(key, entry)
    }
  }

  private async loadDiskIndex(): Promise<DiskEntryMeta[]> {
    if (this.dir === undefined) return []
    if (this.diskIndex !== undefined) return this.diskIndex
    let metas: DiskEntryMeta[] = []
    try {
      const names = await readdir(this.dir)
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const key = name.slice(0, -'.json'.length)
        try {
          const st = await stat(join(this.dir, name))
          metas.push({ key, storedAt: st.mtimeMs })
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* directory may not exist yet */
    }
    metas.sort((a, b) => a.storedAt - b.storedAt)
    this.diskIndex = metas
    return metas
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const mem = this.memory.get(key)
    if (mem !== undefined) {
      this.touch(key)
      return mem
    }
    if (this.dir === undefined) return undefined
    const file = join(this.dir, key + '.json')
    try {
      const raw = await readFile(file, 'utf8')
      const entry = JSON.parse(raw) as CacheEntry
      if (typeof entry.text !== 'string') return undefined
      // Refresh mtime → LRU position
      const index = await this.loadDiskIndex()
      const meta = index.find((m) => m.key === key)
      if (meta !== undefined) {
        meta.storedAt = Date.now()
        index.sort((a, b) => a.storedAt - b.storedAt)
      }
      return entry
    } catch {
      return undefined
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    // Memory LRU eviction
    this.memory.set(key, entry)
    if (this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value as string | undefined
      if (oldest !== undefined) this.memory.delete(oldest)
    }
    if (this.dir === undefined) return
    await mkdir(this.dir, { recursive: true })
    const file = join(this.dir, key + '.json')
    await writeFile(file, JSON.stringify(entry), 'utf8')
    // Disk LRU bookkeeping (best-effort)
    try {
      const index = await this.loadDiskIndex()
      const existing = index.find((m) => m.key === key)
      if (existing !== undefined) existing.storedAt = entry.storedAt
      else index.push({ key, storedAt: entry.storedAt })
      index.sort((a, b) => a.storedAt - b.storedAt)
      while (index.length > this.maxEntries) {
        const victim = index.shift()
        if (victim !== undefined) {
          await rm(join(this.dir, victim.key + '.json'), { force: true })
        }
      }
    } catch {
      /* disk LRU bookkeeping is best-effort */
    }
  }

  async stats(): Promise<CacheStats> {
    const diskEntries = this.dir === undefined ? 0 : (await this.loadDiskIndex()).length
    return {
      memoryEntries: this.memory.size,
      diskEntries,
      maxEntries: this.maxEntries,
      persisted: this.dir !== undefined,
    }
  }

  async clear(): Promise<void> {
    this.memory.clear()
    if (this.dir !== undefined) {
      await rm(this.dir, { recursive: true, force: true })
      this.diskIndex = undefined
    }
  }
}
