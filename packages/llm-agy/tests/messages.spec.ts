import {
    createAssistantMessage,
    createSystemMessage,
    createToolResultMessage,
    createUserMessage,
    ToolCallId,
    type GenerateOptions,
    type RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { buildPrompt, contentText, messageIds, renderMessage, systemPromptOf, systemUpdateText } from '../src/messages.ts'

function user(text: string) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(text: string) {
    return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'agy', model: 'gemini-4-argon' } })
}

function options(messages: RequestMessage[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
    return { provider: 'agy', model: 'gemini-4-argon', messages, ...extra }
}

describe('contentText', () => {
    it('keeps visible text and skips reasoning', () => {
        expect(
            contentText([
                { type: 'text', text: 'hello' },
                { type: 'reasoning', text: 'private' },
                { type: 'text', text: 'world' },
            ]),
        ).toBe('hello\nworld')
    })

    it('renders file and image placeholders', () => {
        expect(
            contentText([
                { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'shot.png' } },
                { type: 'file', attachment: { attachmentId: 'b', name: 'notes.md', bytes: 2 } },
            ] as never),
        ).toBe('[image: shot.png]\n[file: notes.md]')
    })
})

describe('systemPromptOf', () => {
    it('prefers the explicit one-shot system field', () => {
        expect(systemPromptOf(options([user('hi')], { system: '  explicit  ' }))).toBe('explicit')
    })

    it('uses the latest system message in the request history', () => {
        expect(systemPromptOf(options([createSystemMessage('first'), user('hi'), createSystemMessage('second')]))).toBe('second')
    })

    it('returns undefined when no system prompt exists', () => {
        expect(systemPromptOf(options([user('hi')]))).toBeUndefined()
    })
})

describe('buildPrompt', () => {
    it('sends a single first user message without transcript framing', () => {
        const prompt = user('hello')
        expect(buildPrompt(options([prompt]), new Set())).toEqual({ text: 'User: hello', deliveredIds: [prompt.id] })
    })

    it('replays existing history on the first call', () => {
        const first = user('one')
        const answer = assistant('two')
        const last = user('three')
        const built = buildPrompt(options([first, answer, last]), new Set())
        expect(built.text).toContain('The following is the conversation so far')
        expect(built.text).toContain('User: one')
        expect(built.text).toContain('Assistant: two')
        expect(built.text).toContain('User: three')
        expect(built.deliveredIds).toEqual([first.id, answer.id, last.id])
    })

    it('sends only the new turn once the cursor is populated', () => {
        const first = user('one')
        const answer = assistant('two')
        const last = user('three')
        const built = buildPrompt(options([first, answer, last]), new Set([first.id, answer.id]))
        expect(built.text).toBe('User: three')
        expect(built.deliveredIds).toEqual([first.id, answer.id, last.id])
    })

    it('asks for continuation when nothing is new', () => {
        const first = user('one')
        expect(buildPrompt(options([first]), new Set([first.id])).text).toBe('Continue.')
    })

    it('labels multiple fresh messages', () => {
        const first = user('one')
        const answer = assistant('two')
        const built = buildPrompt(options([first, answer]), new Set())
        expect(built.text).toContain('Assistant: two')
    })

    it('includes tool results as transcript text', () => {
        const result = createToolResultMessage({
            callId: ToolCallId('call-1'),
            content: [{ type: 'text', text: 'exit 0' }],
            isError: false,
        })
        const built = buildPrompt(options([result]), new Set())
        expect(built.text).toBe('Tool result: exit 0')
    })

    it('handles an empty conversation', () => {
        expect(buildPrompt(options([]), new Set()).text).toBe('Continue.')
    })
})

describe('helpers', () => {
    it('renders role labels and error outcomes', () => {
        expect(renderMessage(user('hi'))).toBe('User: hi')
        expect(renderMessage(assistant('there'))).toBe('Assistant: there')
        const result = createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'boom' }], isError: true })
        expect(renderMessage(result)).toBe('Tool error: boom')
    })

    it('collects stable message ids', () => {
        const one = user('a')
        const two = assistant('b')
        expect(messageIds([one, two])).toEqual([one.id, two.id])
    })

    it('marks a system update explicitly', () => {
        expect(systemUpdateText('new rules')).toBe('[Updated system instructions]\nnew rules')
    })
})
