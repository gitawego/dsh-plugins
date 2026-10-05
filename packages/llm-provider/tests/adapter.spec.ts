import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent, Model, Api } from '@earendil-works/pi-ai'
import { createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { GatewayAdapter } from '../src/adapter.ts'
import { defaultProfile, type ProviderSettings } from '../src/config.ts'
import { GATEWAYS, OPENCODE_GO } from '../src/gateways.ts'
import type { GatewayTransport, PiRequestOptions } from '../src/transport.ts'

const model: Model<Api> = {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    provider: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    reasoning: true,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
} as Model<Api>

const usage = { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function assistant(over: Partial<AssistantMessage> = {}): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: 'openai-completions',
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        usage,
        stopReason: 'stop',
        timestamp: 0,
        ...over,
    }
}

/** A transport that records the pi-ai options one request produced. */
function fakeTransport(
    models: readonly Model<Api>[] = [model],
    events: AssistantMessageEvent[] = [
        { type: 'text_start', contentIndex: 0, partial: assistant() },
        { type: 'text_end', contentIndex: 0, content: 'ok', partial: assistant() },
        { type: 'done', reason: 'stop', message: assistant() },
    ],
) {
    const seen: { route: string; modelId: string; options: PiRequestOptions | undefined; context: unknown }[] = []
    const transport: GatewayTransport = {
        listModels: () => models,
        getModel: (route, id) => models.find((entry) => entry.id === id),
        stream: (route, modelId, context, options) => {
            seen.push({ route, modelId, options, context })
            async function* source(): AsyncIterable<AssistantMessageEvent> {
                for (const event of events) yield event
            }
            // The adapter only needs an async iterable; the real transport
            // returns pi-ai's event stream, which is one.
            return source() as never
        },
    }
    return { transport, seen }
}

function build(over: {
    transport?: GatewayTransport
    profile?: Partial<ProviderSettings[string]>
    apiKey?: string | undefined
    attachments?: unknown
} = {}) {
    const profile = { ...defaultProfile(OPENCODE_GO), ...(over.profile ?? {}) }
    return new GatewayAdapter({
        transport: over.transport ?? fakeTransport().transport,
        displayName: () => 'OpenCode Go',
        profileOf: () => profile,
        resolveApiKey: async () => over.apiKey,
        ...(over.attachments !== undefined ? { resolveAttachments: () => over.attachments as never } : {}),
    })
}

function request(over: Partial<GenerateOptions> = {}): GenerateOptions {
    return { provider: 'opencode-go', model: 'deepseek-v4.1-flash', messages: [], ...over }
}

async function collect(adapter: GatewayAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return chunks
}

describe('GatewayAdapter metadata', () => {
    it('reports the route display name', () => {
        expect(build().providerInfo('opencode-go')).toEqual({ id: 'opencode-go', name: 'OpenCode Go' })
    })

    it('advertises the catalog with its input modalities', async () => {
        await expect(build().listModels('opencode-go')).resolves.toEqual([
            {
                provider: 'opencode-go',
                id: 'deepseek-v4.1-flash',
                name: 'DeepSeek V4.1 Flash',
                inputModalities: ['text', 'image'],
            },
        ])
    })

    it('resolves capacity and the selectable reasoning levels', async () => {
        const info = (await build().resolveModel('opencode-go', 'deepseek-v4.1-flash')) as LlmResolvedModelInfo
        expect(info.context).toEqual({ contextWindow: 1_000_000 })
        expect(info.defaultMaxTokens).toBe(384_000)
        expect(info.reasoning?.efforts.map((effort) => String(effort.id))).toContain('high')
    })

    it('reports no reasoning capability for a model pi-ai marks non-reasoning', async () => {
        const transport = fakeTransport([{ ...model, reasoning: false } as Model<Api>]).transport
        const info = await build({ transport }).resolveModel('opencode-go', 'deepseek-v4.1-flash')
        expect(info.reasoning).toBeUndefined()
    })

    it('fails an unknown model with the seam code selectors route on', async () => {
        await expect(build().resolveModel('opencode-go', 'nope')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    })

    it('prepareCall captures model metadata and dispatches through the adapter', async () => {
        const prepared = await build().prepareCall('opencode-go', 'deepseek-v4.1-flash')
        expect(prepared.model.id).toBe('deepseek-v4.1-flash')
        expect(typeof prepared.stream).toBe('function')
    })
})

describe('GatewayAdapter stream', () => {
    it('forwards the session id to the transport, which is what puts the header on the wire', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport }), request({ sessionId: 'sess-8' as never }))
        expect(seen[0]?.options?.sessionId).toBe('sess-8')
    })

    it('forwards the credential the profile names', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport, apiKey: 'resolved-key' }), request())
        expect(seen[0]?.options?.apiKey).toBe('resolved-key')
    })

    it('leaves auth to pi-ai when the reference resolves to nothing', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport, apiKey: undefined }), request())
        expect(seen[0]?.options?.apiKey).toBeUndefined()
    })

    it('disables pi-ai retries so the harness owns retry policy', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport }), request())
        expect(seen[0]?.options?.maxRetries).toBe(0)
    })

    it('passes temperature, maxTokens and the abort signal through', async () => {
        const controller = new AbortController()
        const { transport, seen } = fakeTransport()
        await collect(build({ transport }), request({ temperature: 0.2, maxTokens: 32, signal: controller.signal }))
        expect(seen[0]?.options).toMatchObject({ temperature: 0.2, maxTokens: 32, signal: controller.signal })
    })

    it('converts the request and yields the translated chunks', async () => {
        const { transport, seen } = fakeTransport([model], [
            { type: 'text_start', contentIndex: 0, partial: assistant() },
            { type: 'text_delta', contentIndex: 0, delta: 'ok', partial: assistant() },
            { type: 'text_end', contentIndex: 0, content: 'ok', partial: assistant() },
            { type: 'done', reason: 'stop', message: assistant() },
        ])
        const chunks = await collect(build({ transport }), request())
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
        const context = seen[0]?.context as { messages: { role: string }[] }
        expect(context.messages).toEqual([])
    })

    it('refuses an unknown model before any dispatch', async () => {
        const { transport, seen } = fakeTransport()
        await expect(collect(build({ transport }), request({ model: 'nope' }))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
        expect(seen).toHaveLength(0)
    })

    it('refuses stop sequences it cannot guarantee', async () => {
        await expect(collect(build(), request({ stop: ['\n\n'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    })

    it('refuses an unsupported explicit reasoning effort', async () => {
        await expect(collect(build(), request({ reasoningEffort: 'ultra' as never }))).rejects.toMatchObject({
            code: 'UNSUPPORTED_REASONING_EFFORT',
        })
    })

    it('accepts an effort the exact model advertises', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport }), request({ reasoningEffort: 'high' as never }))
        expect(seen[0]?.options?.reasoning).toBe('high')
    })

    it('applies the profile reasoning default when the request names none', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport, profile: { reasoning: 'low' } }), request())
        expect(seen[0]?.options?.reasoning).toBe('low')
    })

    it('sends no reasoning option for the "off" profile default', async () => {
        const { transport, seen } = fakeTransport()
        await collect(build({ transport, profile: { reasoning: 'off' } }), request())
        expect(seen[0]?.options?.reasoning).toBeUndefined()
    })

    it('refuses images when no attachment store is mounted', async () => {
        const messages = [
            createUserMessage({
                content: [
                    {
                        type: 'image',
                        attachment: {
                            attachmentId: 'sha256-x' as never,
                            mediaType: 'image/png',
                            bytes: 10,
                            width: 1,
                            height: 1,
                        },
                    },
                ],
                source: { kind: 'user' },
            }),
        ]
        await expect(collect(build(), request({ messages }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    })

    it('refuses images for a model that cannot take them', async () => {
        const textOnly = { ...model, input: ['text'] } as Model<Api>
        const { transport } = fakeTransport([textOnly])
        const messages = [
            createUserMessage({
                content: [
                    {
                        type: 'image',
                        attachment: { attachmentId: 'sha256-x' as never, mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
                    },
                ],
                source: { kind: 'user' },
            }),
        ]
        await expect(
            collect(build({ transport, attachments: { readImageRequest: async () => ({}) } }), request({ messages })),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    })
})
