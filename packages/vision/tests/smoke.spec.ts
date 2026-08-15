import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, MARKER_STYLES, PASTE_MODES, REASONING_LEVELS, mergeConfig, resolveConfig } from '../src/config.ts'
import { isImageCapable } from '../src/capability.ts'
import { MarkerRegistry, asImageMarker, buildBatchToolResult, buildHintLine, renderMarker, renderMarkers, resolveMarkerPaths } from '../src/marker.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mapWithConcurrency } from '../src/batch.ts'
import { VisionCache, cacheKey } from '../src/cache.ts'
import { appendAuditEntry, countAuditLog, resolveAuditPath, tailAuditLog, truncateImagePathForLog } from '../src/audit.ts'

describe('config', () => {
  it('applies defaults and clamps invalid values', () => {
    const c = mergeConfig({ maxDimension: 99999, jpegQuality: -5, batchConcurrency: 100 })
    expect(c.maxDimension).toBe(8000)
    expect(c.jpegQuality).toBe(1)
    expect(c.batchConcurrency).toBe(20)
    expect(c.enabled).toBe(DEFAULT_CONFIG.enabled)
    expect(c.textOnlyPasteMode).toBe('hint')
  })

  it('validates a bad credential ref fails loud', () => {
    expect(() => resolveConfig(mergeConfig({ http: { credential: 'NOT VALID!' } }))).toThrow()
    const ok = resolveConfig(mergeConfig({ http: { credential: 'VISION_API_KEY', baseUrl: 'https://api.example.com/v1', model: 'm' } }))
    expect(ok.http.baseUrl).toBe('https://api.example.com/v1')
    expect(String(ok.http.credential)).toBe('VISION_API_KEY')
  })

  it('rejects a non-http baseUrl', () => {
    expect(() => resolveConfig(mergeConfig({ http: { baseUrl: 'ftp://x' } }))).toThrow()
  })

  it('enum surfaces are stable', () => {
    expect(REASONING_LEVELS).toContain('xhigh')
    expect(MARKER_STYLES).toEqual(['code', 'bold', 'plain'])
    expect(PASTE_MODES).toEqual(['hint', 'auto', 'off'])
  })
})

describe('capability', () => {
  it('treats image-capable, absent, and explicit-empty correctly', () => {
    expect(isImageCapable(['text', 'image'])).toBe(true)
    expect(isImageCapable(['text'])).toBe(false)
    expect(isImageCapable(undefined)).toBe(false)
    expect(isImageCapable([])).toBe(false)
  })
})

describe('marker', () => {
  it('renders marker styles', () => {
    expect(renderMarker(1, 'code')).toBe('[' + String.fromCharCode(96) + 'Image-#1' + String.fromCharCode(96) + ']')
    expect(renderMarker(2, 'bold')).toBe('[**Image-#2**]')
    expect(renderMarker(3, 'plain')).toBe('[Image-#3]')
  })

  it('replaces paths with sequential markers', () => {
    const bt = String.fromCharCode(96)
    const out = renderMarkers('look at /tmp/a.png and /tmp/b.png', ['/tmp/a.png', '/tmp/b.png'], 'code')
    expect(out).toBe('look at [' + bt + 'Image-#1' + bt + '] and [' + bt + 'Image-#2' + bt + ']')
  })

  it('builds the hint line naming paths + batch affordance', () => {
    const hint = buildHintLine(['/tmp/a.png', '/tmp/b.png'], 'code')
    expect(hint).toContain('image_paths')
    expect(hint).toContain('/tmp/a.png')
  })

  it('builds the batch result block with cached/error annotations', () => {
    const block = buildBatchToolResult(['/a.png', '/b.png'], [
      { ok: true, text: 'desc a', cached: true, fallback: false },
      { ok: false, errorCode: 'not_found', message: 'image not found at /b.png' },
    ])
    expect(block).toContain('[Batch: 2 image(s)]')
    expect(block).toContain('[Image 1] /a.png')
    expect(block).toContain('(cached)')
    expect(block).toContain('[Image 2] /b.png')
    expect(block).toContain('[error: not_found — image not found at /b.png]')
  })
})

describe('marker resolution (model passes [Image-#N] instead of the real path)', () => {
  const agent = { id: 's1' } as unknown as Agent

  it('asImageMarker normalizes decorated marker spellings', () => {
    expect(asImageMarker('Image-#1')).toBe('Image-#1')
    expect(asImageMarker('[Image-#2]')).toBe('Image-#2')
    expect(asImageMarker('[**Image-#3**]')).toBe('Image-#3')
    expect(asImageMarker(`[${String.fromCharCode(96)}Image-#4${String.fromCharCode(96)}]`)).toBe('Image-#4')
    expect(asImageMarker('/tmp/Image-#1.png')).toBeUndefined() // real paths untouched
    expect(asImageMarker('screenshot.png')).toBeUndefined()
    expect(asImageMarker('')).toBeUndefined()
  })

  it('MarkerRegistry records and resolves per agent; detach clears', () => {
    const reg = new MarkerRegistry()
    const other = { id: 's2' } as unknown as Agent
    reg.record(agent, 'Image-#1', '/tmp/a.png')
    reg.record(agent, 'Image-#2', '/tmp/b.png')
    reg.record(other, 'Image-#1', '/tmp/other.png')
    expect(reg.resolve(agent, 'Image-#1')).toBe('/tmp/a.png')
    expect(reg.resolve(agent, 'Image-#2')).toBe('/tmp/b.png')
    expect(reg.resolve(other, 'Image-#1')).toBe('/tmp/other.png')
    expect(reg.resolve(agent, 'Image-#9')).toBeUndefined()
    reg.detach(agent)
    expect(reg.resolve(agent, 'Image-#1')).toBeUndefined()
  })

  it('resolveMarkerPaths substitutes recorded paths; unknown markers pass through', () => {
    const reg = new MarkerRegistry()
    reg.record(agent, 'Image-#1', '/tmp/a.png')
    expect(resolveMarkerPaths(['Image-#1', '/tmp/b.png'], reg, agent)).toEqual(['/tmp/a.png', '/tmp/b.png'])
    expect(resolveMarkerPaths(['[Image-#1]', 'Image-#7'], reg, agent)).toEqual(['/tmp/a.png', 'Image-#7'])
    expect(resolveMarkerPaths(['Image-#2'], reg, agent)).toEqual(['Image-#2'])
  })
})

describe('batch', () => {
  it('respects the concurrency bound', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return n
    })
    expect(peak).toBe(2)
  })

  it('aborts early when the signal fires', async () => {
    const controller = new AbortController()
    const seen: number[] = []
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      if (n >= 3) controller.abort()
      seen.push(n)
      await new Promise((r) => setTimeout(r, 2))
      return n
    }, controller.signal)
    expect(result.length).toBe(5)
    expect(seen.length).toBeLessThan(5)
  })
})

describe('cache', () => {
  it('memory LRU evicts oldest beyond maxEntries', async () => {
    const cache = new VisionCache({ maxEntries: 2 })
    await cache.set('a', { text: 'A', details: {}, storedAt: 1 })
    await cache.set('b', { text: 'B', details: {}, storedAt: 2 })
    expect((await cache.get('a'))?.text).toBe('A')
    await cache.set('c', { text: 'C', details: {}, storedAt: 3 })
    expect(await cache.get('b')).toBeUndefined()
    expect((await cache.get('a'))?.text).toBe('A')
    expect((await cache.get('c'))?.text).toBe('C')
  })

  it('persists to disk and clears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-cache-'))
    try {
      const cache = new VisionCache({ dir, maxEntries: 10 })
      await cache.set('k1', { text: 'T1', details: {}, storedAt: 1 })
      const cache2 = new VisionCache({ dir, maxEntries: 10 })
      expect((await cache2.get('k1'))?.text).toBe('T1')
      const stats = await cache2.stats()
      expect(stats.diskEntries).toBe(1)
      expect(stats.persisted).toBe(true)
      await cache2.clear()
      const cache3 = new VisionCache({ dir, maxEntries: 10 })
      expect(await cache3.get('k1')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keys are content-addressed and stable', () => {
    const a = cacheKey('hash', true, 1568, 85, 'prompt', 'p/m', 'off', undefined, 'http')
    const b = cacheKey('hash', true, 1568, 85, 'prompt', 'p/m', 'off', undefined, 'http')
    const c = cacheKey('hash', true, 1568, 85, 'different', 'p/m', 'off', undefined, 'http')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('audit', () => {
  it('appends, tails, counts, and truncates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-audit-'))
    const path = join(dir, 'vision-audit.log')
    try {
      const entry = {
        ts: '2026-01-01T00:00:00.000Z', provider: 'p', model: 'p/m', image_path: '/tmp/x.png',
        source_hash: 'abc', cached: false, fallback: false, fallback_model: undefined,
        ok: true, error_code: undefined, latency_ms: 10, local_only: false,
      }
      await appendAuditEntry(path, entry)
      await appendAuditEntry(path, { ...entry, ts: '2026-01-01T00:00:01.000Z', cached: true })
      expect(await countAuditLog(path)).toBe(2)
      const tail = await tailAuditLog(path, 1)
      expect(tail).toHaveLength(1)
      expect(tail[0]?.cached).toBe(true)
      await appendAuditEntry(path, entry)
      expect(await countAuditLog(path)).toBe(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('truncates data: URLs for the log', () => {
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(200)
    const truncated = truncateImagePathForLog(dataUrl)
    expect(truncated.startsWith('data:image/png;base64,AAA')).toBe(true)
    expect(truncated).toContain('chars')
    expect(truncateImagePathForLog('/tmp/screenshot.png')).toBe('/tmp/screenshot.png')
  })

  it('resolves the default path under a home dir', () => {
    expect(resolveAuditPath(undefined, '/home/u/.dsh')).toBe('/home/u/.dsh/vision-audit.log')
    expect(resolveAuditPath('/tmp/my.log', '/home/u/.dsh')).toBe('/tmp/my.log')
  })
})

import { createVisionCommand } from '../src/commands.ts'

describe('commands', () => {
  it('declares the input hint the Web client needs to intercept subcommand lines', () => {
    const cmd = createVisionCommand({
      settings: { get: () => ({}) as never, update: async () => {}, mutate: async () => {}, replace: async () => {} },
      config: () => ({} as never),
      gate: { resyncAll: () => {} } as never,
      cache: () => undefined,
      home: '/tmp',
      detect: async () => undefined,
    })
    expect(cmd.name).toBe('vision')
    expect(cmd.input?.hint?.length ?? 0).toBeGreaterThan(0)
  })

  it('session-status reports the tracked model switch state for the calling agent', async () => {
    const tracked = { provider: 'p', model: 'glm-5.2', multimodal: false }
    const cmd = createVisionCommand({
      settings: { get: () => ({}) as never, update: async () => {}, mutate: async () => {}, replace: async () => {} },
      config: () => ({
        enabled: true,
        textOnlyPasteMode: 'auto',
        delegation: 'auto',
        provider: 'vision', model: 'vl-1',
        http: { baseUrl: undefined, credential: undefined, model: undefined, protocol: 'openai' },
      }) as never,
      gate: { resyncAll: () => {}, current: () => tracked } as never,
      cache: () => undefined,
      home: '/tmp',
      detect: async () => undefined,
    })
    const invocation = {
      commandId: 'c1' as never,
      agent: {
        session: {
          requestHeader: () => ({ config: { provider: 'p', model: 'luna' } }),
        },
      } as never,
      rawInput: 'session-status',
      signal: new AbortController().signal,
    } as never
    const result = await cmd.handler?.(invocation)
    expect(result?.kind).toBe('success')
    const text = (result as { text: string }).text
    expect(text).toContain('p/glm-5.2')
    expect(text).toContain('text-only → images convert to text')
    expect(text).toContain('p/luna')
    expect(text).toContain('switch pending detection')
    expect(text).toContain('describe_image:   visible')
    expect(text).toContain('vision/vl-1')
  })
})

