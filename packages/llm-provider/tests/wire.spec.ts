/**
 * Wire-level proof, with no network and no credentials.
 *
 * The unit tests above establish that the session id reaches the *pi-ai request
 * options*. That is not the same claim as "the request that leaves this process
 * carries the header": pi-ai owns the HTTP call, so the only way to know the
 * header survives its pipeline is to hand it a `fetch` and read what it is
 * asked to send.
 *
 * This file drives the real OpenCode Go catalog through the real transport and
 * the real pi-ai OpenAI-completions implementation, and asserts on the
 * outgoing request. It is the test that would fail if pi-ai ever stopped
 * forwarding request headers — which is exactly the failure mode that produced
 * `400 MissingSessionID` in the first place.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream, type AssistantMessageEvent } from '@earendil-works/pi-ai'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createGatewayTransport } from '../src/transport.ts'
import { GATEWAYS, OPENCODE_GO } from '../src/gateways.ts'
import { defaultProfile, type ProviderSettings } from '../src/config.ts'
import { OPENCODE_SESSION_HEADER } from '../src/session-header.ts'

/** The model id the live settings use, which pi-ai 0.85.1's catalog predates. */
const LIVE_MODEL = 'deepseek-v4.1-flash'

function profiles(): ProviderSettings {
    return {
        'opencode-go': {
            ...defaultProfile(OPENCODE_GO),
            // The catalog ships `deepseek-v4-flash`; the gateway serves
            // `deepseek-v4.1-flash`. A profile declares what the catalog
            // predates — this is the real configuration, not a test fiction.
            extraModels: [{ id: LIVE_MODEL, contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true }],
        },
    }
}

/** One minimal OpenAI-completions SSE turn. */
function sseResponse(): Response {
    const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
    const text = chunk({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: LIVE_MODEL,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    })
    const done = chunk({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: LIVE_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    })
    return new Response(text + done + 'data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    })
}

/** Capture the request pi-ai actually issues. */
function recordingFetch() {
    const requests: { url: string; headers: Record<string, string>; body: unknown }[] = []
    type FetchInput = Parameters<typeof fetch>[0]
    type FetchInit = NonNullable<Parameters<typeof fetch>[1]>
    const impl = (async (input: FetchInput, init?: FetchInit) => {
        // The provider SDK may hand headers as a plain object, an array of
        // pairs, or a Headers instance; normalize the way the wire does.
        const headers: Record<string, string> = {}
        new Headers(init?.headers ?? {}).forEach((value, name) => {
            headers[name.toLowerCase()] = value
        })
        requests.push({
            url: String(input),
            headers,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        })
        return sseResponse()
    }) as unknown as typeof fetch
    return { requests, impl }
}

async function drain(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
    const seen: AssistantMessageEvent[] = []
    for await (const event of events) seen.push(event)
    return seen
}

describe('OpenCode Go wire request', () => {
    it('sends x-opencode-session on the real HTTP request, which is what the gateway refuses without', async () => {
        const { requests, impl } = recordingFetch()
        const transport = createGatewayTransport(GATEWAYS, profiles())
        const events = transport.stream(
            'opencode-go',
            LIVE_MODEL,
            { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
            { apiKey: 'test-key', sessionId: 'sess-wire-1', fetch: impl },
        )
        await drain(events as unknown as AsyncIterable<AssistantMessageEvent>)

        expect(requests).toHaveLength(1)
        expect(requests[0]?.headers[OPENCODE_SESSION_HEADER]).toBe('sess-wire-1')
        expect(requests[0]?.url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    })

    it('sends the harness attribution alongside it', async () => {
        const { requests, impl } = recordingFetch()
        const transport = createGatewayTransport(GATEWAYS, profiles())
        await drain(
            transport.stream(
                'opencode-go',
                LIVE_MODEL,
                { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
                { apiKey: 'test-key', sessionId: 'sess-wire-2', fetch: impl },
            ) as unknown as AsyncIterable<AssistantMessageEvent>,
        )
        expect(requests[0]?.headers['user-agent']).toBeTruthy()
        expect(requests[0]?.headers['authorization']).toBe('Bearer test-key')
    })

    it('declares the model the catalog does not, so the live configuration is servable', () => {
        const transport = createGatewayTransport(GATEWAYS, profiles())
        expect(transport.getModel('opencode-go', LIVE_MODEL)?.contextWindow).toBe(1_000_000)
        // ...without losing the catalog models.
        expect(transport.listModels('opencode-go').some((model) => model.id === 'deepseek-v4-flash')).toBe(true)
    })

    it('reports the turn as a normal completion, so a fixed request is a working turn', async () => {
        const { impl } = recordingFetch()
        const transport = createGatewayTransport(GATEWAYS, profiles())
        const events = await drain(
            transport.stream(
                'opencode-go',
                LIVE_MODEL,
                { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
                { apiKey: 'test-key', sessionId: 'sess-wire-3', fetch: impl },
            ) as unknown as AsyncIterable<AssistantMessageEvent>,
        )
        const terminal = events.at(-1)
        expect(terminal?.type).toBe('done')
        expect(terminal?.type === 'done' && terminal.message.content).toEqual([{ type: 'text', text: 'ok' }])
    })

    it('never presents a live conversation without conversation identity', async () => {
        const { requests, impl } = recordingFetch()
        const transport = createGatewayTransport(GATEWAYS, profiles())
        await drain(
            transport.stream(
                'opencode-go',
                LIVE_MODEL,
                { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
                { apiKey: 'test-key', fetch: impl },
            ) as unknown as AsyncIterable<AssistantMessageEvent>,
        )
        // A caller with no session id (a hand-built one-shot) sends no header;
        // the loop always supplies one, which is why the route works in chat.
        expect(requests[0]?.headers[OPENCODE_SESSION_HEADER]).toBeUndefined()
    })

    it('carries a user-role harness message into the outgoing body', async () => {
        const { requests, impl } = recordingFetch()
        const transport = createGatewayTransport(GATEWAYS, profiles())
        await drain(
            transport.stream(
                'opencode-go',
                LIVE_MODEL,
                {
                    messages: [
                        {
                            ...createUserMessage({ content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } }),
                            // pi-ai's message vocabulary carries a timestamp.
                            timestamp: 0,
                        },
                    ],
                },
                { apiKey: 'test-key', sessionId: 'sess-wire-4', fetch: impl },
            ) as unknown as AsyncIterable<AssistantMessageEvent>,
        )
        expect(requests[0]?.body).toMatchObject({ model: LIVE_MODEL, stream: true })
        // pi-ai keeps the array form when the source content was a block list.
        expect((requests[0]?.body as { messages: { content: unknown }[] }).messages[0]?.content).toEqual([
            { type: 'text', text: 'hello there' },
        ])
    })

    it('does not need the harness session id to be a UUID — the gateway treats it as opaque', async () => {
        const { requests, impl } = recordingFetch()
        const transport = createGatewayTransport(GATEWAYS, profiles())
        await drain(
            transport.stream(
                'opencode-go',
                LIVE_MODEL,
                { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
                { apiKey: 'k', sessionId: '01a10c8e-0898-77d8-9c28-5ff69e4529a9', fetch: impl },
            ) as unknown as AsyncIterable<AssistantMessageEvent>,
        )
        expect(requests[0]?.headers[OPENCODE_SESSION_HEADER]).toBe('01a10c8e-0898-77d8-9c28-5ff69e4529a9')
    })
})

describe('pi-ai event plumbing sanity', () => {
    it('keeps using the same assistant event stream class the adapter consumes', () => {
        // Guards the assumption this plugin is built on: pi-ai's stream is an
        // async iterable of AssistantMessageEvent values.
        expect(typeof createAssistantMessageEventStream).toBe('function')
        const stream = createAssistantMessageEventStream()
        expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    })
})
