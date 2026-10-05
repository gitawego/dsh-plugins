import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
    createAssistantMessage,
    createSystemMessage,
    createToolResultMessage,
    createUserMessage,
    type GenerateOptions,
    type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import {
    assertSupportedImageRoles,
    flattenText,
    foreignAssistant,
    parseArguments,
    splitSystemPrompt,
    textOnlyContext,
    toolResultText,
} from '../src/context.ts'

const toolCallId = (value: string): ToolCallId => value as unknown as ToolCallId

const imageRef = (): ImageAttachmentRef => ({
    attachmentId: 'sha256-deadbeef' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 1024,
    width: 8,
    height: 8,
})

function request(over: Partial<GenerateOptions> = {}): GenerateOptions {
    return { provider: 'opencode-go', model: 'deepseek-v4.1-flash', messages: [], ...over }
}

describe('parseArguments', () => {
    it('parses a raw argument object', () => {
        expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
    })

    it('degrades a partial or non-object argument string to an empty object', () => {
        expect(parseArguments('{"a":')).toEqual({})
        expect(parseArguments('[1,2]')).toEqual({})
        expect(parseArguments('null')).toEqual({})
    })
})

describe('flattenText / toolResultText', () => {
    it('concatenates visible text only', () => {
        expect(flattenText([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }])).toBe('ab')
    })

    it('reaches text nested inside a tool result', () => {
        expect(
            toolResultText([
                { type: 'text', text: 'outer ' },
                { type: 'tool-result', toolCallId: toolCallId('c1'), content: [{ type: 'text', text: 'inner' }] },
            ]),
        ).toBe('outer inner')
    })
})

describe('splitSystemPrompt', () => {
    it('prefers an explicit one-shot system prompt and keeps every message', () => {
        const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
        const split = splitSystemPrompt(request({ system: 'be brief', messages }))
        expect(split.systemPrompt).toBe('be brief')
        expect(split.messages).toBe(messages)
    })

    it('folds a leading system message into the prompt and drops it from history', () => {
        const split = splitSystemPrompt(
            request({
                messages: [
                    createSystemMessage('you are terse', 'test'),
                    createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
                ],
            }),
        )
        expect(split.systemPrompt).toBe('you are terse')
        expect(split.messages).toHaveLength(1)
        expect(split.messages[0]?.role).toBe('user')
    })

    it('sends no prompt for an empty leading system message', () => {
        const split = splitSystemPrompt(request({ messages: [createSystemMessage('', 'test')] }))
        expect(split.systemPrompt).toBeUndefined()
        expect(split.messages).toHaveLength(0)
    })

    it('leaves a non-system history untouched', () => {
        const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
        expect(splitSystemPrompt(request({ messages })).systemPrompt).toBeUndefined()
    })
})

describe('foreignAssistant', () => {
    it('rebuilds text, reasoning and tool calls without replay metadata', () => {
        const message = createAssistantMessage({
            content: [
                { type: 'reasoning', text: 'thinking' },
                { type: 'text', text: 'answer' },
                { type: 'tool-call', id: toolCallId('call-9'), name: 'bash', arguments: '{"command":"ls"}' },
            ],
            source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        })
        const converted = foreignAssistant(message)
        expect(converted.content).toEqual([
            { type: 'thinking', thinking: 'thinking' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', id: 'call-9', name: 'bash', arguments: { command: 'ls' } },
        ])
        expect(converted.provider).toBe('opencode-go')
        expect(converted.model).toBe('deepseek-v4.1-flash')
        expect(converted.stopReason).toBe('toolUse')
        expect(converted.usage.totalTokens).toBe(0)
    })

    it('refuses an assistant image, which pi-ai history cannot represent', () => {
        const message = createAssistantMessage({
            content: [{ type: 'image', attachment: imageRef() }],
            source: { provider: 'opencode-go', model: 'm' },
        })
        expect(() => foreignAssistant(message)).toThrow(/cannot represent structured assistant image output/)
    })
})

describe('assertSupportedImageRoles', () => {
    it('accepts user-role images and refuses assistant-role ones', () => {
        expect(() =>
            assertSupportedImageRoles([
                createUserMessage({ content: [{ type: 'image', attachment: imageRef() }], source: { kind: 'user' } }),
            ]),
        ).not.toThrow()
        expect(() =>
            assertSupportedImageRoles([
                createAssistantMessage({ content: [{ type: 'image', attachment: imageRef() }], source: { provider: 'p', model: 'm' } }),
            ]),
        ).toThrow(/in-history assistant message/)
    })
})

describe('textOnlyContext', () => {
    it('names each tool result after the call it answers', () => {
        const context = textOnlyContext(
            request({
                messages: [
                    createAssistantMessage({
                        content: [{ type: 'tool-call', id: toolCallId('call-1'), name: 'bash', arguments: '{}' }],
                        source: { provider: 'p', model: 'm' },
                    }),
                    createToolResultMessage({
                        callId: toolCallId('call-1'),
                        content: [{ type: 'text', text: 'done' }],
                        isError: false,
                    }),
                ],
            }),
        )
        const result = context.messages.find((message) => message.role === 'toolResult')
        expect(result).toMatchObject({ toolCallId: 'call-1', toolName: 'bash', isError: false })
        expect(result?.role === 'toolResult' && result.content).toEqual([{ type: 'text', text: 'done' }])
    })

    it('keeps an empty tool result visible rather than sending an empty block', () => {
        const context = textOnlyContext(
            request({
                messages: [
                    createToolResultMessage({ callId: toolCallId('call-2'), content: [], isError: true }),
                ],
            }),
        )
        expect(context.messages[0]).toMatchObject({ role: 'toolResult', toolName: 'unknown', isError: true })
        expect(context.messages[0]?.role === 'toolResult' && context.messages[0].content).toEqual([
            { type: 'text', text: '(no output)' },
        ])
    })

    it('passes tool schemas through', () => {
        const context = textOnlyContext(
            request({ tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] }),
        )
        expect(context.tools).toEqual([{ name: 'bash', description: 'run', parameters: { type: 'object' } }])
    })

    it('omits an empty tool list entirely', () => {
        expect(textOnlyContext(request({ tools: [] })).tools).toBeUndefined()
    })

    it('refuses an image when the attachment service is not in play', () => {
        expect(() =>
            textOnlyContext(
                request({
                    messages: [
                        createUserMessage({ content: [{ type: 'image', attachment: imageRef() }], source: { kind: 'user' } }),
                    ],
                }),
            ),
        ).toThrow(/requires the durable attachment service/)
    })

    it('carries a mid-history system message forward as user text', () => {
        const context = textOnlyContext(
            request({
                messages: [
                    createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }),
                    createSystemMessage('later instruction', 'test'),
                ],
            }),
        )
        expect(context.messages).toEqual([
            { role: 'user', content: 'first', timestamp: 0 },
            { role: 'user', content: 'later instruction', timestamp: 0 },
        ])
    })
})
