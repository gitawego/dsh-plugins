/** M2 paste-hook tests: token extraction, marker rendering, hint/descriptions
 *  blocks, and the full pre-step transform with injected fakes (no DSH ctx). */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mergeConfig, resolveConfig } from '../src/config.ts'
import type { DelegateResult } from '../src/delegate.ts'
import { MarkerRegistry, buildDescriptionsBlock, buildPasteHintLine, renderMarkersResolved } from '../src/marker.ts'
import { createPasteHook, findImagePathTokens, type PasteDeps } from '../src/paste.ts'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const BT = String.fromCharCode(96) // `

function makeAgent(cwd: string): Agent {
  return { session: { header: { cwd } }, id: 's1' } as unknown as Agent
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function userMessageWithImage(text: string, ref: ImageAttachmentRef): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }, { type: 'image', attachment: ref }],
    source: { kind: 'user' },
  })
}

const IMG_REF = {
  attachmentId: 'att-img-1', mediaType: 'image/png', bytes: PNG_1x1.byteLength, width: 1, height: 1, name: 'pasted.png',
} as ImageAttachmentRef

function okResult(imagePath: string): DelegateResult {
  return {
    ok: true,
    text: 'a cat on a mat',
    details: {
      model: 'p/m', image_path: imagePath, prompt: 'prompt', compressed: true,
      reasoning: 'off', cached: false, fallback: false, transport: 'subagent',
    },
  }
}

function makeDeps(overrides: Partial<PasteDeps> = {}): PasteDeps & { saveCalls: string[]; delegateCalls: Array<{ image_path: string; prompt: string }> } {
  const saveCalls: string[] = []
  const delegateCalls: Array<{ image_path: string; prompt: string }> = []
  const deps: PasteDeps = {
    config: () => resolveConfig(mergeConfig({ markerStyle: 'plain' })),
    isMultimodal: () => false,
    saveAttachment: async (input) => {
      saveCalls.push(input.mediaType)
      return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 } as ImageAttachmentRef
    },
    readImage: async (ref) => ({ ref, data: new Uint8Array(PNG_1x1) }),
    tmpDir: '/tmp/dsh-vision-paste-test',
    markers: new MarkerRegistry(),
    canDeliverImage: async () => true,
    isImageCapable: () => false, // default: text-only model
    delegateFor: () => async (params) => {
      delegateCalls.push({ image_path: params.image_path, prompt: params.prompt })
      return okResult(params.image_path)
    },
    ...overrides,
  }
  return Object.assign(deps, { saveCalls, delegateCalls })
}

async function runHook(
  deps: PasteDeps,
  agent: Agent,
  messages: UserMessage[],
  nextDecision: PreStepDecision = { kind: 'enter', messages },
): Promise<PreStepDecision> {
  const hook = createPasteHook(deps)
  return hook(
    { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => nextDecision,
  )
}

function textOf(msg: UserMessage): string {
  const block = msg.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')
  return block?.text ?? ''
}

/** Join EVERY text block (the first one carries the collapsed message text;
 *  block markers/notes are separate text blocks). */
function allTextOf(msg: UserMessage): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

describe('findImagePathTokens', () => {
  it('extracts absolute, home, and relative path tokens', () => {
    expect(findImagePathTokens('look at /tmp/a.png now')).toEqual(['/tmp/a.png'])
    expect(findImagePathTokens('~/shots/x.png and ./rel/y.jpg')).toEqual(['~/shots/x.png', './rel/y.jpg'])
    expect(findImagePathTokens('../up/z.jpeg')).toEqual(['../up/z.jpeg'])
  })

  it('extracts windows drive paths and escaped spaces', () => {
    expect(findImagePathTokens('see C:\\pics\\a.png and D:/pics/b.png')).toEqual(['C:\\pics\\a.png', 'D:/pics/b.png'])
    expect(findImagePathTokens('open /my\\ shots/x.png')).toEqual(['/my\\ shots/x.png'])
  })

  it('ignores bare filenames and dedupes', () => {
    expect(findImagePathTokens('my screenshot name.png')).toEqual([])
    expect(findImagePathTokens('one /a.png two /a.png')).toEqual(['/a.png'])
  })

  it('matches Termux-style paths with spaces and parentheses', () => {
    const spaced = '/storage/emulated/0/Download/TokensMonitor/preview-atlas-minimax-cn-graph-346x187 (1).png'
    expect(findImagePathTokens(`read ${spaced} now`)).toEqual([spaced])
    expect(findImagePathTokens('open /my folder/img (2).jpeg')).toEqual(['/my folder/img (2).jpeg'])
  })

  it('does not swallow prose between two paths (non-greedy to first extension)', () => {
    expect(findImagePathTokens('compare /tmp/a.png and /tmp/b.png')).toEqual(['/tmp/a.png', '/tmp/b.png'])
    expect(findImagePathTokens('see "/tmp/a.png" here')).toEqual(['/tmp/a.png'])
  })
})

describe('renderMarkersResolved', () => {
  it('replaces resolved tokens right-to-left with 1-based markers', () => {
    const resolved = new Map([
      ['/tmp/a.png', { index: 0 }],
      ['/tmp/b.png', { index: 1 }],
    ])
    const out = renderMarkersResolved('see /tmp/a.png and /tmp/b.png', ['/tmp/a.png', '/tmp/b.png'], resolved, 'code')
    expect(out).toBe(`see [${BT}Image-#1${BT}] and [${BT}Image-#2${BT}]`)
    expect(renderMarkersResolved('x /tmp/a.png y', ['/tmp/a.png'], new Map([['/tmp/a.png', { index: 0 }]]), 'bold')).toBe('x [**Image-#1**] y')
  })

  it('leaves unresolvable tokens and unknown occurrences as-is', () => {
    expect(renderMarkersResolved('x /tmp/c.png y', ['/tmp/c.png'], new Map(), 'plain')).toBe('x /tmp/c.png y')
    // a token that appears but resolves to a different path stays untouched
    const resolved = new Map([['/tmp/a.png', { index: 0 }]])
    expect(renderMarkersResolved('x /tmp/a.png /tmp/b.png y', ['/tmp/a.png', '/tmp/b.png'], resolved, 'plain')).toBe('x [Image-#1] /tmp/b.png y')
  })
})

describe('paste hint + descriptions blocks', () => {
  it('builds the hint line naming paths + batch affordance', () => {
    const hint = buildPasteHintLine([{ token: '/tmp/a.png', index: 0 }])
    expect(hint).toContain('describe_image')
    expect(hint).toContain('/tmp/a.png')
    const multi = buildPasteHintLine([{ token: '/a.png', index: 0 }, { token: '/b.png', index: 1 }])
    expect(multi).toContain('image_paths')
    expect(multi).toContain('2 images')
  })

  it('builds the descriptions block with label + footer', () => {
    const block = buildDescriptionsBlock([{ token: '/tmp/a.png', index: 0, text: 'a cat', cached: false }], 'p/m')
    expect(block).toContain('/tmp/a.png')
    expect(block).toContain('a cat')
    expect(block).toContain('p/m')
    expect(block).toContain('textOnlyPasteMode')
    expect(buildDescriptionsBlock([], 'p/m')).toBe('')
  })

  it('builds the delivery-unavailable hint (Termux) naming the real reason', () => {
    const hint = buildPasteHintLine([{ token: '/tmp/a.png', index: 0 }], 'plain', { deliveryUnavailable: true })
    expect(hint).toContain('native image delivery is unavailable')
    expect(hint).toContain('describe_image')
    expect(hint).toContain('/tmp/a.png')
    expect(hint).not.toContain("can't process images")
    const normal = buildPasteHintLine([{ token: '/tmp/a.png', index: 0 }], 'plain')
    expect(normal).toContain("can't process images")
  })
})

describe('paste hook (pre-step transform)', () => {
  let dir: string
  let aPath: string
  let bPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-paste-'))
    aPath = join(dir, 'a.png')
    bPath = join(dir, 'b.png')
    await writeFile(aPath, PNG_1x1)
    await writeFile(bPath, PNG_1x1)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('leaves messages without image tokens untouched', async () => {
    const deps = makeDeps()
    const msg = userMessage('plain text')
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') expect(decision.messages[0]).toBe(msg)
  })

  it('attaches images with markers for multimodal primaries (identity preserved)', async () => {
    const deps = makeDeps({ isMultimodal: () => true })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.saveCalls).toEqual(['image/png'])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.id).toBe(msg.id)
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(1)
      expect(textOf(out)).toContain('[Image-#1]')
    }
  })

  it('hints (no attachment) for text-only primaries in hint mode', async () => {
    const deps = makeDeps()
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.saveCalls).toEqual([])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(0)
      const text = textOf(out)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain('describe_image')
      expect(text).toContain(aPath)
    }
  })

  it('renders markers only in off mode', async () => {
    const deps = makeDeps({ config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'off', markerStyle: 'plain' })) })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    if (decision.kind === 'enter') {
      const text = textOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]')
      expect(text).not.toContain('describe_image')
    }
  })

  it('auto-delegates each image and appends the descriptions block', async () => {
    const deps = makeDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const agent = makeAgent(dir)
    const msg = userMessage(`compare ${aPath} and ${bPath}`)
    const decision = await runHook(deps, agent, [msg])
    expect(deps.delegateCalls).toHaveLength(2)
    expect(deps.delegateCalls.map((c) => c.image_path).sort()).toEqual([aPath, bPath].sort())
    // marker → real-path bridge: the model can pass [Image-#N] to describe_image
    expect(deps.markers.resolve(agent as never, 'Image-#1')).toBe(aPath)
    expect(deps.markers.resolve(agent as never, 'Image-#2')).toBe(bPath)
    if (decision.kind === 'enter') {
      const text = textOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain('[Image-#2]')
      expect(text).toContain('a cat on a mat')
      expect(text).toContain('auto-described')
    }
  })

  it('falls back to the hint when every delegation fails', async () => {
    const deps = makeDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm' })),
      delegateFor: () => async () => ({ ok: false, error: { code: 'vision_call_error', message: 'boom' } }),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    if (decision.kind === 'enter') {
      const text = textOf(decision.messages[0]!)
      expect(text).toContain('describe_image')
      expect(text).not.toContain('auto-described')
    }
  })

  it('skips delegation entirely in local-only mode', async () => {
    const deps = makeDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm', localOnly: true })),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') expect(textOf(decision.messages[0]!)).toContain('describe_image')
  })

  it('treats a disabled vision feature as markers-only for text-only primaries', async () => {
    const deps = makeDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm', enabled: false })),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const text = textOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]')
      expect(text).not.toContain('describe_image')
    }
  })

  it('does not rewrite plugin-sourced messages', async () => {
    const deps = makeDeps({ isMultimodal: () => true })
    const injected = createUserMessage({
      content: [{ type: 'text', text: `ref ${aPath}` }],
      source: { kind: 'plugin', plugin: 'other' },
    })
    const decision = await runHook(deps, makeAgent(dir), [injected])
    expect(deps.saveCalls).toEqual([])
    if (decision.kind === 'enter') expect(decision.messages[0]).toBe(injected)
  })

  it('passes reject decisions through unchanged', async () => {
    const deps = makeDeps()
    const decision = await runHook(deps, makeAgent(dir), [userMessage('x')], { kind: 'reject' })
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('aborts auto-delegation on timeout and falls back to the hint', async () => {
    const deps = makeDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm', autoDelegateTimeoutMs: 1000 })),
      delegateFor: () => async (_params, signal) => new Promise<DelegateResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    if (decision.kind === 'enter') {
      const text = textOf(decision.messages[0]!)
      expect(text).toContain('describe_image')
      expect(text).not.toContain('auto-described')
    }
  })
})

describe('paste hook — image BLOCK conversion for text-only primaries', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-blocks-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function blockDeps(overrides: Partial<PasteDeps> = {}) {
    return makeDeps({
      tmpDir: dir,
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm' })),
      ...overrides,
    })
  }

  it('preserves image blocks untouched for multimodal primaries (passthrough)', async () => {
    const deps = blockDeps({ isMultimodal: () => true })
    const msg = userMessageWithImage('see this', IMG_REF)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.saveCalls).toEqual([]) // existing block is NOT re-saved
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      const images = out.content.filter((b) => b.type === 'image')
      expect(images).toHaveLength(1) // block kept
    }
  })

  it('auto mode: converts an image block to a temp-file description (image block removed)', async () => {
    const deps = blockDeps()
    const msg = userMessageWithImage('see this', IMG_REF)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(1)
    const delegatedPath = deps.delegateCalls[0]!.image_path
    expect(delegatedPath.startsWith(dir)).toBe(true)
    expect(delegatedPath.endsWith('.png')).toBe(true)
    // Materialized during delegation, then cleaned up (description embedded + cached).
    expect(existsSync(delegatedPath)).toBe(false)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(0) // raw block gone
      const text = textOf(out)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain('a cat on a mat') // delegated description
      expect(text).toContain('auto-described')
    }
  })

  it('hint mode: replaces the block with a marker and names the temp path (no delegate)', async () => {
    const deps = blockDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'hint', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const msg = userMessageWithImage('see this', IMG_REF)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(0)
      const text = allTextOf(out)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain('describe_image') // hint lets the model delegate on demand
      expect(text).toContain(dir) // temp path is nameable
    }
    // hint mode keeps the materialized temp file so describe_image can read it later
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toHaveLength(1)
  })

  it('off mode: replaces the block with a marker only', async () => {
    const deps = blockDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'off', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const msg = userMessageWithImage('see this', IMG_REF)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(0)
      const text = allTextOf(out)
      expect(text).toContain('[Image-#1]')
      expect(text).not.toContain('describe_image')
    }
  })

  it('never throws when reading a block fails; replaces it with a note', async () => {
    const deps = blockDeps({
      readImage: async () => { throw new Error('store unavailable') },
    })
    const msg = userMessageWithImage('see this', IMG_REF)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(0)
      expect(allTextOf(out)).toContain('unreadable')
    }
  })

  it('combines path tokens and image blocks with sequential markers (auto)', async () => {
    const deps = blockDeps()
    const aPath = join(dir, 'a.png')
    await writeFile(aPath, PNG_1x1)
    const msg = userMessageWithImage(`compare ${aPath} and this`, IMG_REF)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(2)
    if (decision.kind === 'enter') {
      const text = textOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]') // path token first
      expect(text).toContain('[Image-#2]') // block second
      expect(text).toContain('a cat on a mat')
    }
  })
})

describe('paste hook — multimodal primary WITHOUT native delivery (Termux)', () => {
  let dir: string
  let aPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-nodeliver-'))
    aPath = join(dir, 'a.png')
    await writeFile(aPath, PNG_1x1)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function nodeliverDeps(overrides: Partial<PasteDeps> = {}) {
    return makeDeps({
      isMultimodal: () => true,
      canDeliverImage: async () => false, // attachment store cannot write (EACCES)
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'hint', markerStyle: 'plain', provider: 'p', model: 'm' })),
      ...overrides,
    })
  }

  it('never drops the image: forces auto-delegation instead of a marker-only message', async () => {
    const deps = nodeliverDeps()
    const agent = makeAgent(dir)
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, agent, [msg])
    expect(deps.saveCalls).toEqual([]) // native attachment impossible
    expect(deps.delegateCalls).toHaveLength(1) // auto-delegated anyway
    expect(deps.delegateCalls[0]!.image_path).toBe(aPath)
    if (decision.kind === 'enter') {
      const out = decision.messages[0]!
      expect(out.content.filter((b) => b.type === 'image')).toHaveLength(0)
      const text = allTextOf(out)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain('a cat on a mat') // the description reached the multimodal primary
      expect(text).toContain('native image delivery is unavailable')
    }
  })

  it('forces auto even when paste mode is off (image must not vanish)', async () => {
    const deps = nodeliverDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'off', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(1)
    if (decision.kind === 'enter') expect(allTextOf(decision.messages[0]!)).toContain('a cat on a mat')
  })

  it('respects a disabled vision feature (off — no delegation)', async () => {
    const deps = nodeliverDeps({
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'hint', markerStyle: 'plain', provider: 'p', model: 'm', enabled: false })),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const text = allTextOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]')
      expect(text).not.toContain('a cat on a mat')
    }
  })
})

describe('paste hook — hint wording when native delivery is unavailable', () => {
  let dir: string
  let aPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-hintwording-'))
    aPath = join(dir, 'a.png')
    await writeFile(aPath, PNG_1x1)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('text-only primary on Termux: hint names model capability, not delivery', async () => {
    const deps = makeDeps({
      isMultimodal: () => false,
      isImageCapable: () => false, // truly text-only model
      canDeliverImage: async () => false,
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'hint', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const agent = makeAgent(dir)
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, agent, [msg])
    expect(deps.delegateCalls).toHaveLength(0) // on-demand — no automatic spend
    if (decision.kind === 'enter') {
      const text = allTextOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain("can't process images") // the MODEL is the reason
      expect(text).not.toContain('native image delivery')
      expect(text).toContain(aPath)
    }
  })

  it('vision-capable model on Termux: hint names native delivery', async () => {
    const deps = makeDeps({
      isMultimodal: () => false, // effective text-only (gate: host cannot deliver)
      isImageCapable: () => true, // the MODEL can process images natively
      canDeliverImage: async () => false,
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'hint', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const agent = makeAgent(dir)
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, agent, [msg])
    expect(deps.delegateCalls).toHaveLength(0)
    if (decision.kind === 'enter') {
      const text = allTextOf(decision.messages[0]!)
      expect(text).toContain('[Image-#1]')
      expect(text).toContain('native image delivery is unavailable')
      expect(text).not.toContain("can't process images")
    }
  })

  it('effective text-only + auto mode still auto-delegates (user chose auto)', async () => {
    const deps = makeDeps({
      isMultimodal: () => false,
      canDeliverImage: async () => false,
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'auto', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const msg = userMessage(`look at ${aPath}`)
    const decision = await runHook(deps, makeAgent(dir), [msg])
    expect(deps.delegateCalls).toHaveLength(1)
    if (decision.kind === 'enter') expect(allTextOf(decision.messages[0]!)).toContain('a cat on a mat')
  })
})

describe('paste hook — surfaces present the resolved absolute path (abs)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-abspath-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('hint + registry use the resolved absolute path even for a relative token', async () => {
    const aPath = join(dir, 'a.png')
    await writeFile(aPath, PNG_1x1)
    const deps = makeDeps({
      isMultimodal: () => false,
      config: () => resolveConfig(mergeConfig({ textOnlyPasteMode: 'hint', markerStyle: 'plain', provider: 'p', model: 'm' })),
    })
    const agent = makeAgent(dir)
    // Relative token: PATH_TOKEN_RE matches "./a.png" relative to the workspace.
    const msg = userMessage(`look at ./a.png`)
    const decision = await runHook(deps, agent, [msg])
    if (decision.kind === 'enter') {
      const text = allTextOf(decision.messages[0]!)
      expect(text).toContain(aPath) // absolute resolved path, not the raw "./a.png"
      expect(text).not.toContain('./a.png')
    }
    // Registry resolves Image-#1 to the absolute path (delegation input).
    expect(deps.markers.resolve(agent as never, 'Image-#1')).toBe(aPath)
  })
})
