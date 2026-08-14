/** Subagent-based delegation tests (DESIGN RULE): describe_image delegates to
 *  a DSH subagent with the vision model; the image is delivered by FILEPATH in
 *  the subagent message. No attachment store, no llm.stream-with-ImageBlock.
 *  Config-driven; edge cases covered. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mergeConfig, resolveConfig } from '../src/config.ts'
import { delegateToVisionModel, type DelegateDeps, type SubagentHandle } from '../src/delegate.ts'

// A real 1x1 PNG so the pipeline reaches the transport (loadImage gates on
// file existence + sniffed magic bytes before any subagent is spawned).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'dsh-vision-delegate-'))
const IMG = join(FIXTURE_DIR, 'img.png')
writeFileSync(IMG, PNG_1x1)
afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }))

function config(overrides: Record<string, unknown> = {}) {
  return resolveConfig(mergeConfig({ provider: 'p', model: 'm', ...overrides }))
}

function makeDeps(overrides: Partial<DelegateDeps> = {}): DelegateDeps & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const deps: DelegateDeps = {
    config: config(),
    home: FIXTURE_DIR,
    workspace: FIXTURE_DIR,
    resolveCredential: async () => ({ value: 'key' }),
    canDeliverImage: async () => true, // native ImageBlock delivery available by default
    createSubagent: async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>)
      const messages: UserMessage[] = []
      return {
        send: (message) => { messages.push(message) },
        whenIdle: async () => {},
        replyText: () => 'a cat on a mat',
        dispose: async () => {},
      } as SubagentHandle
    },
    signal: undefined,
    cache: undefined,
    ...overrides,
  }
  return Object.assign(deps, { calls })
}

describe('subagent delegation (DESIGN RULE)', () => {
  it('creates a subagent with the configured vision model and returns its content', async () => {
    const deps = makeDeps()
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'what is this?', compress: true, reasoning: 'off' })
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0]).toMatchObject({ provider: 'p', model: 'm', cwd: FIXTURE_DIR })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('a cat on a mat')
      expect(result.details.model).toBe('p/m')
      expect(result.details.transport).toBe('subagent')
    }
  })

  it('sends the image FILEPATH (not base64, not an ImageBlock) in the subagent message', async () => {
    let sent: UserMessage | undefined
    const deps = makeDeps({
      createSubagent: async () => ({
        send: (message) => { sent = message },
        whenIdle: async () => {},
        replyText: () => 'ok',
        dispose: async () => {},
      } as SubagentHandle),
    })
    await delegateToVisionModel(deps, { image_path: IMG, prompt: 'describe', compress: true, reasoning: 'off' })
    const text = sent?.content.find((b) => b.type === 'text')?.text ?? ''
    expect(text).toContain(IMG)
    expect(text).toContain('describe')
    expect(sent?.content.some((b) => b.type === 'image')).toBe(false)
    expect(text.includes('base64')).toBe(false)
  })

  it('returns not_configured when no vision model is configured (config-driven)', async () => {
    const deps = makeDeps({ config: config({ provider: undefined, model: undefined }) })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not_configured')
    expect(deps.calls).toHaveLength(0)
  })

  it('surfaces subagent creation failures as vision_call_error', async () => {
    const deps = makeDeps({
      createSubagent: async () => { throw new Error('no factory') },
    })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('vision_call_error')
  })

  it('fails when the subagent returns no content', async () => {
    const deps = makeDeps({
      createSubagent: async () => ({
        send: () => {}, whenIdle: async () => {}, replyText: () => undefined, dispose: async () => {},
      } as SubagentHandle),
    })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/no content/i)
  })

  it('always disposes the subagent, even on failure', async () => {
    const disposed = vi.fn()
    const deps = makeDeps({
      createSubagent: async () => ({
        send: () => {}, whenIdle: async () => {}, replyText: () => undefined, dispose: disposed,
      } as SubagentHandle),
    })
    await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('short-circuits on cache hits and local-only without spawning a subagent', async () => {
    let created = false
    const deps = makeDeps({
      createSubagent: async () => { created = true; throw new Error('should not run') },
    })
    const cached = { get: async () => ({ text: 'cached desc', details: {}, storedAt: 1 }) }
    const result = await delegateToVisionModel({ ...deps, cache: cached as never }, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe('cached desc')
    expect(created).toBe(false)
    const localOnly = makeDeps({ config: config({ localOnly: true }) })
    const refused = await delegateToVisionModel(localOnly, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('local_only')
  })

  it('honors the abort signal before creating the subagent', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = makeDeps({ signal: controller.signal })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('aborted')
    expect(deps.calls).toHaveLength(0)
  })

  // ── native-first delivery: subagent (ImageBlock) preferred; base64 http only
  // when the harness cannot deliver the image natively (Android/Termux EACCES).
  it('auto: falls back to the http endpoint when the subagent cannot receive images natively', async () => {
    let created = false
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'a cat via http' } }] }), text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const deps = makeDeps({
        canDeliverImage: async () => false,
        config: config({
          delegation: 'auto',
          http: { baseUrl: 'https://opencode.ai/zen/go/v1', credential: 'KEY', model: 'minimax-m3', protocol: 'openai' },
        }),
        createSubagent: async () => { created = true; throw new Error('should not run') },
      })
      const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
      expect(created).toBe(false)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.text).toBe('a cat via http')
        expect(result.details.transport).toBe('http')
      }
      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('auto: not_configured with http guidance when the native path is unavailable and http is unset', async () => {
    const deps = makeDeps({ canDeliverImage: async () => false })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_configured')
      expect(result.error.message).toMatch(/http/i)
    }
    expect(deps.calls).toHaveLength(0)
  })

  it('native: image_delivery_unavailable instead of a silent subagent run when the native path cannot deliver', async () => {
    const deps = makeDeps({ canDeliverImage: async () => false, config: config({ delegation: 'native' }) })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'x', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('image_delivery_unavailable')
      expect(result.error.message).toMatch(/attachment store/i)
    }
    expect(deps.calls).toHaveLength(0)
  })

  it('auto: uses the subagent (native) whenever the harness can deliver the image', async () => {
    const deps = makeDeps({ canDeliverImage: async () => true })
    const result = await delegateToVisionModel(deps, { image_path: IMG, prompt: 'native', compress: true, reasoning: 'off' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.details.transport).toBe('subagent')
    expect(deps.calls).toHaveLength(1)
  })
})

