import { describe, expect, it, vi } from 'vitest'
import {
    createProviderCard,
    type DiscoveredModel,
    type ProviderSections,
    type SettingsPathOp,
    type SettingsScopeLike,
} from '../src/client/controller.ts'

/** A settings scope with just enough behaviour to drive the card. */
function fakeScope(
    initial: ProviderSections = {},
    over: { writable?: boolean; status?: 'loading' | 'ready' | 'unavailable'; unstableSnapshot?: boolean } = {},
) {
    let value = initial
    let revision = 7
    const listeners = new Set<() => void>()
    const ops: SettingsPathOp[][] = []
    let reject: string | undefined
    // The real seam returns one reference until something changes; a double that
    // rebuilt it every call would hide a broken dependency on that stability,
    // which is what `unstableSnapshot` exercises on purpose.
    let snapshot = { status: over.status ?? 'ready', value, writable: over.writable ?? true, revision }
    const republish = () => {
        revision += 1
        snapshot = { status: over.status ?? 'ready', value, writable: over.writable ?? true, revision }
        for (const listener of listeners) listener()
    }
    return {
        ops,
        failWith: (message: string | undefined) => {
            reject = message
        },
        setValue: (next: ProviderSections) => {
            value = next
            republish()
        },
        scope: {
            getSnapshot: () => (over.unstableSnapshot === true
                ? { status: over.status ?? 'ready', value, writable: over.writable ?? true, revision }
                : snapshot),
            subscribe: (listener: () => void) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
            mutate: async (mutateOps: readonly SettingsPathOp[]) => {
                ops.push([...mutateOps])
                if (reject !== undefined) throw new Error(reject)
                opApply(mutateOps)
                republish()
            },
        } as SettingsScopeLike<ProviderSections>,
    }
    function opApply(mutateOps: readonly SettingsPathOp[]): void {
        for (const op of mutateOps) {
            const [route, field] = op.path
            const section = { ...(value[route!] ?? {}) }
            if (op.op === 'set') (section as Record<string, unknown>)[field!] = op.value
            else delete (section as Record<string, unknown>)[field!]
            value = { ...value, [route!]: section }
        }
    }
}

const models = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 384_000 },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 131_072 },
]

function card(
    over: {
        sections?: ProviderSections
        discover?: () => Promise<DiscoveredModel[]>
        writable?: boolean
        configured?: boolean
        describeThrows?: boolean
        writeFails?: string
    } = {},
) {
    const fake = fakeScope(over.sections ?? { 'opencode-go': { apiKeyEnv: 'KEY', sessionRouting: true } }, { writable: over.writable })
    const discover = vi.fn(over.discover ?? (async () => models))
    const describeCredential = vi.fn(async () => {
        if (over.describeThrows === true) throw new Error('store unreachable')
        return over.configured ?? false
    })
    const writeCredential = vi.fn(async () => {
        if (over.writeFails !== undefined) throw new Error(over.writeFails)
    })
    const controller = createProviderCard({
        scope: fake.scope,
        discover,
        describeCredential,
        writeCredential,
        route: 'opencode-go',
        now: () => 5_000,
    })
    return { controller, fake, discover, describeCredential, writeCredential }
}

/**
 * `useSyncExternalStore` compares snapshots by identity. A `getSnapshot()` that
 * returns a fresh object on every call therefore reads as "the store changed" on
 * every render, and React loops until it throws #185 (maximum update depth).
 * That is exactly how this card shipped broken: the slot renderer caught the
 * crash and drew nothing, so the card was simply absent from Settings → Plugins.
 */
describe('snapshot identity', () => {
    it('returns the same reference while nothing changed', async () => {
        const { controller } = card()
        await controller.refresh()
        const first = controller.getSnapshot()
        expect(controller.getSnapshot()).toBe(first)
        expect(controller.getSnapshot()).toBe(first)
    })

    it('returns a new reference after a change, exactly once', () => {
        const { controller } = card()
        const first = controller.getSnapshot()
        controller.edit('apiKeyEnv', 'NEXT')
        const second = controller.getSnapshot()
        expect(second).not.toBe(first)
        expect(controller.getSnapshot()).toBe(second)
    })

    it('does not depend on the scope returning a stable reference', async () => {
        const fake = fakeScope({}, { unstableSnapshot: true })
        const controller = createProviderCard({
            scope: fake.scope,
            discover: async () => models,
            describeCredential: async () => false,
            writeCredential: async () => {},
            route: 'opencode-go',
        })
        const first = controller.getSnapshot()
        expect(controller.getSnapshot()).toBe(first)
        controller.edit('apiKeyEnv', 'NEXT')
        expect(controller.getSnapshot()).not.toBe(first)
        expect(controller.getSnapshot()).toBe(controller.getSnapshot())
    })

    it('notices a settings change that the scope reports as a new snapshot', async () => {
        const { controller, fake } = card()
        const first = controller.getSnapshot()
        fake.setValue({ 'opencode-go': { apiKeyEnv: 'CHANGED' } })
        const second = controller.getSnapshot()
        expect(second).not.toBe(first)
        expect(second.credential).toBe('CHANGED')
    })

    it('keeps the reference stable across every read of one publish', async () => {
        const { controller } = card()
        await controller.refresh()
        const seen = new Set<unknown>()
        controller.subscribe(() => { seen.add(controller.getSnapshot()) })
        controller.edit('baseURL', 'https://x/v1')
        expect(seen.size).toBe(1)
    })

    it('reuses the reference when a mutation changes nothing observable', async () => {
        const { controller } = card()
        await controller.refresh()
        controller.discard()
        expect(controller.getSnapshot()).toBe(controller.getSnapshot())
    })
})

describe('card identity', () => {
    it('shows the route, its endpoint, and its credential reference', () => {
        const { controller } = card({ sections: { 'opencode-go': { apiKeyEnv: 'MY_KEY', baseURL: 'https://proxy.example/v1' } } })
        expect(controller.getSnapshot()).toMatchObject({
            route: 'opencode-go',
            endpoint: 'https://proxy.example/v1',
            credential: 'MY_KEY',
            status: 'ready',
        })
    })

    it('treats an absent section as the shipped defaults', () => {
        const { controller } = card({ sections: {} })
        expect(controller.getSnapshot()).toMatchObject({ endpoint: '', credential: '', sessionRouting: true, advertisesAll: true })
    })

    it('stays writable while the scope is still loading, because a false flag means unread', () => {
        const fake = fakeScope({}, { status: 'loading', writable: false })
        const controller = createProviderCard({
            scope: fake.scope,
            discover: async () => models,
            describeCredential: async () => false,
            writeCredential: async () => {},
            route: 'opencode-go',
        })
        expect(controller.getSnapshot().writable).toBe(true)
    })

    it('disables writes when a ready document is read-only', () => {
        const { controller } = card({ writable: false })
        expect(controller.getSnapshot().writable).toBe(false)
    })
})

describe('catalog read', () => {
    it('starts idle and reports what it read', async () => {
        const { controller, discover } = card()
        expect(controller.getSnapshot().catalog).toEqual({ state: 'idle' })
        await controller.refresh()
        expect(discover).toHaveBeenCalledWith('opencode-go')
        expect(controller.getSnapshot().catalog).toEqual({ state: 'ready', at: 5_000, count: 2 })
        expect(controller.getSnapshot().models.map((model) => model.id)).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash'])
    })

    it('keeps rows sorted by id, so a pinned model never jumps around', async () => {
        const { controller } = card({ discover: async () => [{ id: 'zz' }, { id: 'aa' }] })
        await controller.refresh()
        expect(controller.getSnapshot().models.map((model) => model.id)).toEqual(['aa', 'zz'])
    })

    it('reports a failed read and keeps the previous list rather than claiming an empty catalog', async () => {
        let fail = false
        const { controller } = card({
            discover: async () => {
                if (fail) throw new Error('endpoint answered 500')
                return models
            },
        })
        await controller.refresh()
        fail = true
        await controller.refresh()
        expect(controller.getSnapshot().catalog).toEqual({ state: 'failed', reason: 'endpoint answered 500' })
        expect(controller.getSnapshot().models).toHaveLength(2)
    })

    it('names a model after its id when the provider gives no display name', async () => {
        const { controller } = card({ discover: async () => [{ id: 'mystery' }] })
        await controller.refresh()
        expect(controller.getSnapshot().models[0]?.name).toBe('mystery')
    })

    it('notifies subscribers once the read settles', async () => {
        const { controller } = card()
        const listener = vi.fn()
        controller.subscribe(listener)
        await controller.refresh()
        expect(listener).toHaveBeenCalled()
    })
})

describe('advertising models', () => {
    it('advertises every served model while the allowlist is empty', async () => {
        const { controller } = card({ sections: { 'opencode-go': {} } })
        await controller.refresh()
        const snapshot = controller.getSnapshot()
        expect(snapshot.advertisesAll).toBe(true)
        expect(snapshot.advertisedCount).toBe(2)
        expect(snapshot.models.every((model) => model.advertised && !model.pinned)).toBe(true)
    })

    it('pins one model by writing the allowlist for this route only', async () => {
        const { controller, fake } = card({ sections: { 'opencode-go': { apiKeyEnv: 'KEY' } } })
        await controller.refresh()
        await controller.togglePin('glm-5.3-flash')
        expect(fake.ops[0]).toEqual([{ op: 'set', path: ['opencode-go', 'models'], value: ['glm-5.3-flash'] }])
        const snapshot = controller.getSnapshot()
        expect(snapshot.advertisesAll).toBe(false)
        expect(snapshot.models.find((model) => model.id === 'glm-5.3-flash')).toMatchObject({ pinned: true, advertised: true })
        expect(snapshot.models.find((model) => model.id === 'deepseek-v4.1-flash')).toMatchObject({ pinned: false, advertised: false })
    })

    it('unpins a model that was pinned, and clears the allowlist when the last one goes', async () => {
        const { controller, fake } = card({ sections: { 'opencode-go': { models: ['glm-5.3-flash'] } } })
        await controller.refresh()
        expect(controller.getSnapshot().advertisesAll).toBe(false)
        await controller.togglePin('glm-5.3-flash')
        expect(fake.ops[0]).toEqual([{ op: 'set', path: ['opencode-go', 'models'], value: [] }])
    })

    it('returns to serving everything through `unset`, which re-inherits the default', async () => {
        const { controller, fake } = card({ sections: { 'opencode-go': { models: ['glm-5.3-flash'] } } })
        await controller.refresh()
        await controller.useAll()
        expect(fake.ops[0]).toEqual([{ op: 'unset', path: ['opencode-go', 'models'] }])
        expect(controller.getSnapshot().advertisesAll).toBe(true)
    })

    it('reflects a pin immediately, because a toggle that appears inert reads as broken', async () => {
        const { controller } = card()
        await controller.refresh()
        await controller.togglePin('glm-5.3-flash')
        expect(controller.getSnapshot().models.find((model) => model.id === 'glm-5.3-flash')?.pinned).toBe(true)
    })

    it('keeps a pinned model visible, flagged, when the provider stops serving it', async () => {
        // The allowlist is stored, not derived: a pinned id the catalog no
        // longer lists must not silently vanish from the decision, or the user
        // is left with an unresolvable pin they cannot see or remove.
        const { controller } = card({ sections: { 'opencode-go': { models: ['retired-model'] } } })
        await controller.refresh()
        const snapshot = controller.getSnapshot()
        expect(snapshot.advertisedCount).toBe(1)
        expect(snapshot.models.find((model) => model.id === 'retired-model')).toMatchObject({ pinned: true, served: false })
        expect(snapshot.models.find((model) => model.id === 'glm-5.3-flash')).toMatchObject({ advertised: false, served: true })
    })

    it('removes a retired pin when the user unpins it', async () => {
        const { controller, fake } = card({ sections: { 'opencode-go': { models: ['retired-model'] } } })
        await controller.refresh()
        await controller.togglePin('retired-model')
        expect(fake.ops[0]).toEqual([{ op: 'set', path: ['opencode-go', 'models'], value: [] }])
        expect(controller.getSnapshot().models.some((model) => model.id === 'retired-model')).toBe(false)
    })
})

describe('storing the API key', () => {
    it('asks the credential store about the profile reference and reports it', async () => {
        const { controller, describeCredential } = card({ configured: true })
        await controller.refreshApiKey()
        expect(describeCredential).toHaveBeenCalledWith('KEY')
        expect(controller.getSnapshot().apiKey).toMatchObject({ reference: 'KEY', configured: true, draft: '' })
    })

    it('stages a key without storing it, and never puts it in the settings document', () => {
        const { controller, fake, writeCredential } = card()
        controller.editApiKey('sk-secret')
        expect(fake.ops).toHaveLength(0)
        expect(writeCredential).not.toHaveBeenCalled()
        expect(controller.getSnapshot().apiKey).toMatchObject({ draft: 'sk-secret', saved: false })
    })

    it('stores the key under the profile reference through the credential domain', async () => {
        const { controller, writeCredential, describeCredential } = card()
        // Construction probes the reference once; what matters is that storing
        // a key needs no probe, because the write is the answer.
        describeCredential.mockClear()
        controller.editApiKey('  sk-secret  ')
        await controller.saveApiKey()
        expect(writeCredential).toHaveBeenCalledWith('KEY', 'sk-secret')
        expect(describeCredential).not.toHaveBeenCalled()
        expect(controller.getSnapshot().apiKey).toMatchObject({ configured: true, saved: true, draft: '', error: undefined })
    })

    it('writes nothing for a blank draft, because blank means "leave it alone"', async () => {
        const { controller, writeCredential } = card()
        await controller.saveApiKey()
        expect(writeCredential).not.toHaveBeenCalled()
    })

    it('refuses to store a key with no reference to store it under', async () => {
        const { controller, writeCredential } = card({ sections: { 'opencode-go': {} } })
        controller.editApiKey('sk-secret')
        await controller.saveApiKey()
        expect(writeCredential).not.toHaveBeenCalled()
        expect(controller.getSnapshot().apiKey.error).toMatch(/Name a credential reference/)
    })

    it('reports a refused write and keeps the draft so it can be retried', async () => {
        const { controller } = card({ writeFails: 'credentials-rejected' })
        controller.editApiKey('sk-secret')
        await controller.saveApiKey()
        expect(controller.getSnapshot().apiKey).toMatchObject({ error: 'credentials-rejected', draft: 'sk-secret', saved: false })
    })

    it('stays quiet when the credential store cannot be reached', async () => {
        const { controller } = card({ describeThrows: true })
        await controller.refreshApiKey()
        expect(controller.getSnapshot().apiKey.configured).toBeUndefined()
        expect(controller.getSnapshot().apiKey.error).toBeUndefined()
    })

    it('re-reads the store when the reference name is edited', async () => {
        const { controller, describeCredential } = card()
        controller.edit('apiKeyEnv', 'ANOTHER_KEY')
        await controller.refreshApiKey()
        expect(describeCredential).toHaveBeenCalledWith('ANOTHER_KEY')
    })

    it('clears a previous success as soon as new text is typed', async () => {
        const { controller } = card()
        controller.editApiKey('one')
        await controller.saveApiKey()
        controller.editApiKey('two')
        expect(controller.getSnapshot().apiKey).toMatchObject({ saved: false, draft: 'two' })
    })
})

describe('configuration edits', () => {
    it('stages text without writing it', () => {
        const { controller, fake } = card()
        controller.edit('apiKeyEnv', 'NEW_KEY')
        expect(fake.ops).toHaveLength(0)
        expect(controller.getSnapshot()).toMatchObject({ dirty: true, drafts: { apiKeyEnv: 'NEW_KEY' } })
    })

    it('writes every staged field in one path-addressed mutation', async () => {
        const { controller, fake } = card()
        controller.edit('apiKeyEnv', 'NEW_KEY')
        controller.edit('maxRequestImageBytes', '1048576')
        await controller.save()
        expect(fake.ops[0]).toEqual([
            { op: 'set', path: ['opencode-go', 'apiKeyEnv'], value: 'NEW_KEY' },
            { op: 'set', path: ['opencode-go', 'maxRequestImageBytes'], value: 1_048_576 },
        ])
        expect(controller.getSnapshot().dirty).toBe(false)
    })

    it('unsets an emptied number rather than writing zero', async () => {
        const { controller, fake } = card()
        controller.edit('maxRequestImageBytes', '  ')
        await controller.save()
        expect(fake.ops[0]).toEqual([{ op: 'unset', path: ['opencode-go', 'maxRequestImageBytes'] }])
    })

    it('writes a boolean toggle as a boolean', async () => {
        const { controller, fake } = card()
        controller.edit('sessionRouting', 'false')
        await controller.save()
        expect(fake.ops[0]).toEqual([{ op: 'set', path: ['opencode-go', 'sessionRouting'], value: false }])
    })

    it('flags an unparseable number and an unknown reasoning level as invalid', () => {
        const { controller } = card()
        controller.edit('maxRequestImageBytes', 'many')
        controller.edit('reasoning', 'ultra')
        expect(controller.getSnapshot().invalid).toMatchObject({ maxRequestImageBytes: true, reasoning: true })
    })

    it('keeps drafts after a rejected write so they can be fixed', async () => {
        const { controller, fake } = card()
        fake.failWith('settings-rejected')
        controller.edit('apiKeyEnv', 'NOPE')
        await controller.save()
        expect(controller.getSnapshot()).toMatchObject({ dirty: true, saveFailed: true })
    })

    it('drops drafts on discard', () => {
        const { controller } = card()
        controller.edit('apiKeyEnv', 'X')
        controller.discard()
        expect(controller.getSnapshot()).toMatchObject({ dirty: false, drafts: {} })
    })

    it('writes nothing when there is nothing staged', async () => {
        const { controller, fake } = card()
        await controller.save()
        expect(fake.ops).toHaveLength(0)
    })
})
