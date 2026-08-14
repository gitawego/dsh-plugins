/** Real subagent-seam tests (DESIGN RULE): createVisionSubagent drives
 *  ctx.agents.create with the vision model, sends the provided message via
 *  followup (the image FILEPATH rides the normal message), reads the last
 *  assistant text from the derived session history, and disposes the handle.
 *  Only DSH public APIs — fakes mimic the published shapes. */
import { describe, expect, it } from 'vitest'
import type { Message, TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createVisionSubagent, lastAssistantText, type AgentsLike } from '../src/subagent.ts'

function textBlock(text: string): TextBlock { return { type: 'text', text } }

function assistantMessage(texts: string[]): Message {
  return {
    role: 'assistant', id: 'a', content: texts.map(textBlock),
    source: { kind: 'model', provider: 'p', model: 'm' },
  } as Message
}

function fakeAgents(overrides: Partial<AgentsLike> = {}): AgentsLike & { created: Array<Record<string, unknown>>; sent: UserMessage[]; disposed: { count: number } } {
  const created: Array<Record<string, unknown>> = []
  const sent: UserMessage[] = []
  const disposed = { count: 0 }
  const base: AgentsLike = {
    create: async (options) => {
      created.push(options as unknown as Record<string, unknown>)
      return {
        agent: {
          followup: (m: UserMessage) => { sent.push(m) },
          whenIdle: async () => {},
          session: {
            header: { cwd: '/tmp/ws' },
            deriveMessages: () => [assistantMessage(['a cat on a mat'])],
          },
        },
        dispose: async () => { disposed.count++ },
      } as never
    },
  }
  const merged = { ...base, ...overrides }
  return Object.assign(merged, { created, sent, disposed })
}

describe('createVisionSubagent (DSH public API seam)', () => {
  it('creates the subagent with the vision model and the caller cwd', async () => {
    const agents = fakeAgents()
    const handle = await createVisionSubagent(agents, { provider: 'p', model: 'm', cwd: '/tmp/ws' })
    expect(agents.created).toHaveLength(1)
    const opts = agents.created[0]!
    expect(opts.agentOptions).toEqual({ provider: 'p', model: 'm' })
    expect(opts.meta).toMatchObject({ cwd: '/tmp/ws', origin: 'subagent' })
    expect(typeof opts.sessionId).toBe('string')
    expect(String(opts.sessionId)).toMatch(/^vision-/)
    await handle.dispose()
  })

  it('sends the image path in a normal followup message (no base64, no ImageBlock)', async () => {
    const agents = fakeAgents()
    const handle = await createVisionSubagent(agents, { provider: 'p', model: 'm', cwd: '/tmp/ws' })
    const msg = createUserMessage({
      content: [{ type: 'text', text: 'Image path: /tmp/img.png\nRequest: describe' }],
      source: { kind: 'user' },
    })
    handle.send(msg)
    expect(agents.sent).toHaveLength(1)
    expect(agents.sent[0]).toBe(msg)
    expect(agents.sent[0]!.content.some((b) => b.type === 'image')).toBe(false)
    await handle.dispose()
  })

  it('reads the last assistant text after quiescence', async () => {
    const agents = fakeAgents()
    const handle = await createVisionSubagent(agents, { provider: 'p', model: 'm', cwd: '/tmp/ws' })
    await handle.whenIdle()
    expect(handle.replyText()).toBe('a cat on a mat')
    await handle.dispose()
  })

  it('disposes the underlying handle (forwards every call)', async () => {
    const agents = fakeAgents()
    const handle = await createVisionSubagent(agents, { provider: 'p', model: 'm', cwd: '/tmp/ws' })
    await handle.dispose()
    await handle.dispose()
    expect(agents.disposed.count).toBe(2) // seam forwards; the delegate calls it once per run
  })

  it('propagates creation failures', async () => {
    const agents = fakeAgents({ create: async () => { throw new Error('no factory') } })
    await expect(createVisionSubagent(agents, { provider: 'p', model: 'm', cwd: '/tmp/ws' }))
      .rejects.toThrow('no factory')
  })
})

describe('lastAssistantText', () => {
  it('returns the last assistant text block content', () => {
    const messages: Message[] = [
      assistantMessage(['first']),
      assistantMessage(['second', ' part']),
      { role: 'user', id: 'u', content: [textBlock('user text')], source: { kind: 'user' } } as Message,
    ]
    expect(lastAssistantText(messages)).toBe('second part')
  })

  it('skips assistant messages that carry only reasoning/no text', () => {
    const messages: Message[] = [
      { role: 'assistant', id: 'a1', content: [{ type: 'reasoning', text: 'thinking…' }], source: { kind: 'model', provider: 'p', model: 'm' } } as Message,
      assistantMessage(['the visible answer']),
    ]
    expect(lastAssistantText(messages)).toBe('the visible answer')
  })

  it('returns undefined when no assistant text exists', () => {
    const messages: Message[] = [
      { role: 'user', id: 'u', content: [textBlock('hi')], source: { kind: 'user' } } as Message,
    ]
    expect(lastAssistantText(messages)).toBeUndefined()
  })
})

