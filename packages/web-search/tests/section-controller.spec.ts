/**
 * The section's draft, and the two sub-sections it writes.
 *
 * The shape matters: the old card staged one flat field per control, which
 * cannot carry a list of servers and produced a layout where an endpoint and its
 * token were separated by unrelated fields.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWebSearchSection, draftOf, type SettingsScopeLike } from '../src/client/controller.ts'

/** A settings scope holding one section and recording writes. */
function fakeScope(initial: unknown = {}, over: { writable?: boolean } = {}) {
    let value = initial
    const listeners = new Set<() => void>()
    const writes: { field: string; value: unknown }[] = []
    let reject: string | undefined
    let snapshot = { status: 'ready' as const, value, user: undefined as unknown, writable: over.writable ?? true, revision: 1 }
    return {
        writes,
        failWith: (message: string | undefined) => {
            reject = message
        },
        scope: {
            getSnapshot: () => snapshot,
            subscribe: (listener: () => void) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
            set: async (field: string, next: unknown) => {
                if (reject !== undefined) throw new Error(reject)
                writes.push({ field, value: next })
                value = { ...(value as Record<string, unknown>), [field]: next }
                snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
                for (const listener of listeners) listener()
            },
        } as SettingsScopeLike<unknown>,
    }
}

function section(initial: unknown = {}) {
    const fake = fakeScope(initial)
    const controller = createWebSearchSection({ scope: fake.scope, mintId: () => 'minted-id' })
    return { controller, fake }
}

describe('draftOf', () => {
    it('materializes the shipped defaults for an empty section', () => {
        const draft = draftOf({})
        expect(draft.llm).toMatchObject({ enabled: false, protocol: 'anthropic', model: 'deepseek-v4.1-flash', timeoutMs: '20000' })
        expect(draft.free).toMatchObject({ parallelCredential: '', exaCredential: '', servers: [], maxResults: '8' })
    })

    it('reads stored values over the defaults', () => {
        const draft = draftOf({ llm: { enabled: true, protocol: 'openai', model: 'm', timeoutMs: 1234 }, free: { maxResults: 3 } })
        expect(draft.llm).toMatchObject({ enabled: true, protocol: 'openai', model: 'm', timeoutMs: '1234' })
        expect(draft.free.maxResults).toBe('3')
    })

    it('never invents a protocol the schema does not accept', () => {
        expect(draftOf({ llm: { protocol: 'nonsense' } }).llm.protocol).toBe('anthropic')
    })

    it('defaults a server tool to web_search and keeps its id', () => {
        const draft = draftOf({ free: { servers: [{ id: 's1', url: 'https://mcp.example/mcp' }] } })
        expect(draft.free.servers).toEqual([{ id: 's1', label: '', url: 'https://mcp.example/mcp', credential: '', tool: 'web_search' }])
    })
})

describe('editing', () => {
    it('edits one path without touching the others', () => {
        const { controller } = section({ llm: { model: 'keep' } })
        controller.editFree('parallelCredential', 'PARALLEL_KEY')
        expect(controller.getSnapshot().draft.llm.model).toBe('keep')
        expect(controller.getSnapshot().draft.free.parallelCredential).toBe('PARALLEL_KEY')
    })

    it('coerces the protocol and the enabled toggle to their schema types', () => {
        const { controller } = section()
        controller.editLlm('protocol', 'openai')
        controller.editLlm('enabled', 'true')
        expect(controller.getSnapshot().draft.llm).toMatchObject({ protocol: 'openai', enabled: true })
    })

    it('flags a numeric field that is not a number, so save can be blocked', () => {
        const { controller } = section()
        controller.editFree('maxResults', 'many')
        expect(controller.getSnapshot().invalid).toContain('free.maxResults')
    })

    it('flags a server with no endpoint', () => {
        const { controller } = section()
        controller.addServer()
        expect(controller.getSnapshot().invalid).toContain('free.servers.0.url')
    })
})

describe('the server list', () => {
    it('adds a server and edits its fields independently', () => {
        const { controller } = section()
        const id = controller.addServer()
        expect(id).toBe('minted-id')
        controller.editServer(id, 'url', 'https://mcp.example/mcp')
        controller.editServer(id, 'label', 'Mine')
        expect(controller.getSnapshot().draft.free.servers).toEqual([
            { id: 'minted-id', label: 'Mine', url: 'https://mcp.example/mcp', credential: '', tool: 'web_search' },
        ])
    })

    it('removes a server by id, leaving the others', () => {
        const { controller } = section({ free: { servers: [{ id: 'a', url: 'https://a/mcp' }, { id: 'b', url: 'https://b/mcp' }] } })
        controller.removeServer('a')
        expect(controller.getSnapshot().draft.free.servers.map((server) => server.id)).toEqual(['b'])
    })

    it('keeps an edited server out of the stored section until save', () => {
        const { controller, fake } = section()
        controller.addServer()
        controller.editServer('minted-id', 'url', 'https://mcp.example/mcp')
        expect(fake.writes).toHaveLength(0)
    })
})

describe('save', () => {
    it('writes both sub-sections, normalized', async () => {
        const { controller, fake } = section()
        controller.editLlm('baseUrl', '  https://llm.example/v1  ')
        controller.editLlm('model', '  ')
        controller.addServer()
        controller.editServer('minted-id', 'url', ' https://mcp.example/mcp ')
        controller.editServer('minted-id', 'tool', '')
        await controller.save()
        expect(fake.writes.map((write) => write.field)).toEqual(['llm', 'free'])
        expect(fake.writes[0]?.value).toMatchObject({ baseUrl: 'https://llm.example/v1', model: 'deepseek-v4.1-flash' })
        expect(fake.writes[1]?.value).toMatchObject({
            servers: [{ id: 'minted-id', label: 'https://mcp.example/mcp', url: 'https://mcp.example/mcp', credential: '', tool: 'web_search' }],
        })
    })

    it('sends numbers as numbers, and the default for a blank field', async () => {
        const { controller, fake } = section()
        controller.editFree('maxResults', ' 12 ')
        controller.editFree('snippetMaxChars', '')
        await controller.save()
        expect(fake.writes[1]?.value).toMatchObject({ maxResults: 12, snippetMaxChars: 300 })
    })

    it('reports a refused write and keeps the draft', async () => {
        const { controller, fake } = section()
        fake.failWith('settings-rejected')
        controller.editFree('parallelCredential', 'NOPE')
        await controller.save()
        expect(controller.getSnapshot()).toMatchObject({ failed: true, saving: false })
        expect(controller.getSnapshot().draft.free.parallelCredential).toBe('NOPE')
    })

    it('drops staged edits on discard', () => {
        const { controller } = section({ free: { maxResults: 4 } })
        controller.editFree('maxResults', '9')
        controller.discard()
        expect(controller.getSnapshot().draft.free.maxResults).toBe('4')
    })
})

describe('snapshot identity', () => {
    it('is stable between reads, and replaced once after a change', () => {
        const { controller } = section()
        const first = controller.getSnapshot()
        expect(controller.getSnapshot()).toBe(first)
        controller.editFree('exaCredential', 'EXA_KEY')
        const second = controller.getSnapshot()
        expect(second).not.toBe(first)
        expect(controller.getSnapshot()).toBe(second)
    })

    it('notifies subscribers once per change', () => {
        const { controller } = section()
        const listener = vi.fn()
        controller.subscribe(listener)
        controller.editFree('exaCredential', 'EXA_KEY')
        expect(listener).toHaveBeenCalledTimes(1)
    })
})

describe('storing a token', () => {
    /** A section whose credential domain is faked, so no secret is involved. */
    function withCredentials(over: { describe?: boolean; describeThrows?: boolean; writeFails?: string } = {}) {
        const fake = fakeScope({})
        const written: { reference: string; value: string }[] = []
        const controller = createWebSearchSection({
            scope: fake.scope,
            mintId: () => 'minted-id',
            describeCredential: async () => {
                if (over.describeThrows === true) throw new Error('store unreachable')
                return over.describe ?? false
            },
            writeCredential: async (reference, value) => {
                if (over.writeFails !== undefined) throw new Error(over.writeFails)
                written.push({ reference, value })
            },
        })
        return { controller, fake, written }
    }

    it('stores the literal under the named reference, and never in the settings document', async () => {
        const { controller, fake, written } = withCredentials()
        controller.editFree('parallelCredential', 'PARALLEL_API_KEY')
        controller.editToken('PARALLEL_API_KEY', '  secret-token  ')
        await controller.saveToken('PARALLEL_API_KEY')
        expect(written).toEqual([{ reference: 'PARALLEL_API_KEY', value: 'secret-token' }])
        expect(fake.writes).toHaveLength(0)
        expect(controller.getSnapshot().tokens['PARALLEL_API_KEY']).toMatchObject({ configured: true, saved: true, draft: '' })
    })

    it('writes nothing for a blank draft, because blank means keep the stored token', async () => {
        const { controller, written } = withCredentials()
        await controller.saveToken('PARALLEL_API_KEY')
        expect(written).toHaveLength(0)
    })

    it('refuses to store a token with no reference to store it under', async () => {
        const { controller, written } = withCredentials()
        controller.editToken('', 'secret-token')
        await controller.saveToken('')
        expect(written).toHaveLength(0)
        expect(controller.getSnapshot().tokens['']?.error).toMatch(/Name a credential reference/)
    })

    it('reports a refused write and keeps the draft so it can be retried', async () => {
        const { controller } = withCredentials({ writeFails: 'credentials-rejected' })
        controller.editToken('PARALLEL_API_KEY', 'secret-token')
        await controller.saveToken('PARALLEL_API_KEY')
        expect(controller.getSnapshot().tokens['PARALLEL_API_KEY']).toMatchObject({ error: 'credentials-rejected', draft: 'secret-token' })
    })

    it('reports whether each named reference holds a token, and stays quiet when unreachable', async () => {
        const { controller } = withCredentials({ describe: true })
        controller.editFree('parallelCredential', 'PARALLEL_API_KEY')
        controller.editFree('exaCredential', 'EXA_KEY')
        await controller.refreshTokens()
        expect(controller.getSnapshot().tokens['PARALLEL_API_KEY']?.configured).toBe(true)
        expect(controller.getSnapshot().tokens['EXA_KEY']?.configured).toBe(true)

        const unreachable = withCredentials({ describeThrows: true })
        unreachable.controller.editFree('parallelCredential', 'PARALLEL_API_KEY')
        await unreachable.controller.refreshTokens()
        expect(unreachable.controller.getSnapshot().tokens['PARALLEL_API_KEY']).toMatchObject({ configured: undefined, error: undefined })
    })

    it('does not ask the store about a reference nobody named', async () => {
        const fake = fakeScope({})
        const describeCredential = vi.fn(async () => false)
        const controller = createWebSearchSection({ scope: fake.scope, describeCredential })
        await controller.refreshTokens()
        expect(describeCredential).not.toHaveBeenCalled()
    })
})
