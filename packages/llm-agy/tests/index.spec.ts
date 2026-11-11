import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AGY_PROVIDER } from '../src/config.ts'
import { apply, createAgyHost } from '../src/index.ts'

interface FakeAgent {
    name: string
}

function fakeContext(overrides: Record<string, unknown> = {}) {
    const agent: FakeAgent = { name: 'agent' }
    const session = { id: 's1', header: { cwd: '/from-header' } }
    const services: Record<string, unknown> = {
        sessions: { get: (id: string) => (id === 's1' ? session : undefined) },
        workingDirectory: { get: () => '/from-working-directory' },
        agents: { currentInitiator: () => agent, get: () => agent },
        approval: { request: async () => 'allowed-once' },
        ...overrides,
    }
    const ctx = {
        logger: () => ({ debug() {}, warn() {} }),
        get: (name: string) => services[name],
        inject: () => {},
        llm: {
            registerAdapter: () => () => {},
        },
    }
    return { ctx: ctx as unknown as Context, agent, services }
}

describe('createAgyHost', () => {
    it('prefers the committed working directory for a live session', () => {
        const { ctx } = fakeContext()
        const host = createAgyHost(ctx, undefined)
        expect(host.resolveCwd('s1')).toBe('/from-working-directory')
    })

    it('falls back to the session header, then process.cwd()', () => {
        const { ctx } = fakeContext({ workingDirectory: undefined })
        const host = createAgyHost(ctx, undefined)
        expect(host.resolveCwd('s1')).toBe('/from-header')
        expect(host.resolveCwd('unknown')).toBe(process.cwd())
    })

    it('routes approval through the live agent', async () => {
        let captured: Record<string, unknown> | undefined
        const { ctx, agent } = fakeContext()
        const approval = ctx.get('approval')!
        ;(approval as unknown as { request: (req: Record<string, unknown>) => Promise<string> }).request = async (req) => {
            captured = req
            return 'allowed-once'
        }
        const host = createAgyHost(ctx, undefined)
        const outcome = await host.requestApproval({
            sessionId: 's1',
            toolName: 'write_file',
            callId: ToolCallId('call-1'),
            reason: 'because',
        })
        expect(outcome).toBe('allowed-once')
        expect(captured).toMatchObject({
            agent,
            toolName: 'write_file',
            callId: 'call-1',
            reason: 'because',
        })
    })

    it('resolves an image through the attachment service as base64 ACP data', async () => {
        const { ctx } = fakeContext({
            attachments: {
                readImageRequest: async (ref: unknown, target: unknown) => {
                    expect(ref).toMatchObject({ attachmentId: 'img-1' })
                    expect(target).toEqual({ width: 2048, height: 2048, maxBytes: 4 * 1024 * 1024 })
                    return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
                },
            },
        })
        const host = createAgyHost(ctx, undefined)
        await expect(host.readImage({ attachmentId: 'img-1' } as never)).resolves.toEqual({
            data: 'AQID',
            mimeType: 'image/png',
        })
    })

    it('fails image input with UNSUPPORTED_CONTENT when the attachment service is missing', async () => {
        const host = createAgyHost(fakeContext({ attachments: undefined }).ctx, undefined)
        await expect(host.readImage({ attachmentId: 'img-1' } as never)).rejects.toMatchObject({
            code: 'UNSUPPORTED_CONTENT',
        })
    })

    it('fails closed when the approval or agent service is missing', async () => {
        const withoutApproval = fakeContext({ approval: undefined }).ctx
        await expect(createAgyHost(withoutApproval, undefined).requestApproval({ toolName: 'x' })).resolves.toBe('unavailable')

        const withoutAgent = fakeContext({ agents: undefined }).ctx
        await expect(createAgyHost(withoutAgent, undefined).requestApproval({ toolName: 'x' })).resolves.toBe('unavailable')
    })
})

describe('apply', () => {
    it('mounts on a real Cordis context and registers the agy route', () => {
        const ctx = new Context()
        let registration: { routes: string[]; info: { id: string; name: string } } | undefined
        let disposed = false
        ctx.provide('llm', {
            registerAdapter(routes: string[], adapter: { providerInfo: (provider: string) => { id: string; name: string } }) {
                registration = { routes, info: adapter.providerInfo(AGY_PROVIDER) }
                return () => {
                    disposed = true
                }
            },
        } as never)
        const dispose = apply(ctx, undefined)
        expect(registration).toEqual({ routes: ['agy'], info: { id: 'agy', name: 'Antigravity (agy ACP)' } })
        dispose()
        expect(disposed).toBe(true)
    })

    it('registers the agy route and unregisters it on disposal', () => {
        const calls: Array<{ routes: string[]; adapter: unknown }> = []
        let disposed = false
        const { ctx } = fakeContext()
        ;(ctx.llm as unknown as { registerAdapter: (routes: string[], adapter: unknown) => () => void }).registerAdapter = (routes, adapter) => {
            calls.push({ routes, adapter })
            return () => {
                disposed = true
            }
        }
        const dispose = apply(ctx, undefined)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.routes).toEqual([AGY_PROVIDER])
        expect(calls[0]?.adapter).toBeDefined()
        dispose()
        expect(disposed).toBe(true)
    })
})
