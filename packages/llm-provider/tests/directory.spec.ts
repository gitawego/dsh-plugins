/**
 * Regression guard for a boot failure that shipped:
 *
 * ```text
 * Error: dsh: plugin tree failed to load: failed to apply loader entry
 *   llm-provider (@gitawego/dsh-llm-provider):
 *   configurable provider "opencode-go" is already declared
 * ```
 *
 * `dsh-llm-pi-ai` declares a directory entry for every provider in pi-ai's
 * installed catalog, so a route claiming a catalog provider id collides with a
 * plugin the harness mounts first. The tests below pin both halves of the
 * answer: our route key is not one pi-ai owns, and a collision we cannot avoid
 * degrades to a skipped row instead of a dead boot.
 *
 * The `LlmRuntime` cases run the real service, not a stub, so they fail if the
 * seam's all-or-nothing contract is ever relaxed or tightened.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, type LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { declareRoutes, describeSkips, type DirectoryHost } from '../src/directory.ts'
import { GATEWAYS, OPENCODE_GO, gatewayById } from '../src/gateways.ts'
import { fetchModelsDevCatalog } from '../src/models-dev.ts'
import { CATALOG_PROVIDERS } from '../src/catalog.ts'
import { protocolFor } from '../src/gateways.ts'

const NS = 'llm-provider'

/** A directory host that already owns the given routes. */
function host(taken: LlmConfigurableProvider[] = []) {
    const registered: LlmConfigurableProvider[] = []
    return {
        registered,
        host: {
            listConfigurableProviders: () => taken,
            registerConfigurableProviders: (entries: readonly LlmConfigurableProvider[]) => {
                const clash = entries.find((entry) => taken.some((other) => other.provider === entry.provider))
                if (clash !== undefined) throw new Error(`configurable provider "${clash.provider}" is already declared`)
                registered.push(...entries)
                return (() => undefined) as never
            },
        } as unknown as DirectoryHost,
    }
}

const piAiEntry = (provider: string): LlmConfigurableProvider => ({
    provider,
    displayName: provider,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', provider],
    declared: false,
})

describe('route ownership', () => {
    it('does not claim a provider id pi-ai ships in its catalog', () => {
        // This is the actual defect: `opencode-go` is a pi-ai catalog provider
        // id, and dsh-llm-pi-ai declares every one of those.
        expect(CATALOG_PROVIDERS['opencode-go']).toBeTypeOf('function')
        expect(OPENCODE_GO.catalogProvider).toBe('opencode-go')
        expect(OPENCODE_GO.id).not.toBe(OPENCODE_GO.catalogProvider)
        expect(CATALOG_PROVIDERS[OPENCODE_GO.id]).toBeUndefined()
    })

    it('keeps every served route out of pi-ai territory', () => {
        for (const gateway of GATEWAYS) {
            expect(CATALOG_PROVIDERS[gateway.id], `route ${gateway.id} collides with the pi-ai catalog`).toBeUndefined()
        }
    })

    it('still serves the pi-ai catalog under its own route key', () => {
        const model = 'deepseek-v4.1-flash'
        expect(protocolFor(OPENCODE_GO, model)).toBe('openai-completions')
        expect(gatewayById(OPENCODE_GO.id)).toBe(OPENCODE_GO)
        // The catalog provider id is what resolves the catalog; the route key is
        // what requests name. Both must exist, and they are not the same string.
        expect(OPENCODE_GO.catalogProvider).toBe('opencode-go')
    })
})

describe('declareRoutes', () => {
    it('declares the routes when the keys are free', () => {
        const { host: llm, registered } = host()
        const outcome = declareRoutes(llm, GATEWAYS, NS)
        expect(outcome.declared).toEqual([OPENCODE_GO.id])
        expect(outcome.skipped).toEqual([])
        expect(registered[0]).toMatchObject({
            provider: OPENCODE_GO.id,
            settingsNs: NS,
            settingsPath: [OPENCODE_GO.id],
            declared: false,
        })
    })

    it('skips a key another plugin declared, naming the owner', () => {
        const { host: llm, registered } = host([piAiEntry(OPENCODE_GO.id)])
        const outcome = declareRoutes(llm, GATEWAYS, NS)
        expect(outcome.declared).toEqual([])
        expect(outcome.skipped).toEqual([{ provider: OPENCODE_GO.id, owner: 'llm-pi-ai' }])
        expect(registered).toEqual([])
    })

    it('never throws when every key is taken, because a taken row is not an outage', () => {
        const { host: llm } = host([piAiEntry(OPENCODE_GO.id)])
        expect(() => declareRoutes(llm, GATEWAYS, NS)).not.toThrow()
    })

    it('declares what it can when only some keys are taken', () => {
        const second = { ...OPENCODE_GO, id: 'second-route', displayName: 'Second' }
        const { host: llm, registered } = host([piAiEntry('second-route')])
        const outcome = declareRoutes(llm, [OPENCODE_GO, second], NS)
        expect(outcome.declared).toEqual([OPENCODE_GO.id])
        expect(outcome.skipped).toEqual([{ provider: 'second-route', owner: 'llm-pi-ai' }])
        expect(registered.map((entry) => entry.provider)).toEqual([OPENCODE_GO.id])
    })

    it('reports a skip in words a log reader can act on', () => {
        const { host: llm } = host([piAiEntry(OPENCODE_GO.id)])
        const lines = describeSkips(declareRoutes(llm, GATEWAYS, NS))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/already declared by settings namespace "llm-pi-ai"/)
        expect(lines[0]).toMatch(/route still serves requests/)
    })

    it('says nothing when nothing was skipped', () => {
        const { host: llm } = host()
        expect(describeSkips(declareRoutes(llm, GATEWAYS, NS))).toEqual([])
    })
})

describe('against the real LLM runtime', () => {
    /** A real runtime, plus the pi-ai adapter's own directory declaration. */
    function realRuntime(): { llm: LlmRuntime; seed: () => void } {
        const ctx = new Context()
        const llm = new LlmRuntime(ctx)
        return {
            llm,
            // `dsh-llm-pi-ai` declares every catalog provider it could serve
            // before this plugin's apply runs.
            seed: () => {
                llm.registerConfigurableProviders([piAiEntry('opencode-go')])
            },
        }
    }

    it('refuses a duplicate registration outright, which is why we pre-check', () => {
        const { llm, seed } = realRuntime()
        seed()
        expect(() => llm.registerConfigurableProviders([{
            provider: 'opencode-go',
            displayName: 'OpenCode Go',
            settingsNs: NS,
            settingsPath: ['opencode-go'],
            declared: false,
        }])).toThrowError(/already declared/)
    })

    it('boots: our declaration lands beside the pi-ai catalog entry without throwing', () => {
        const { llm, seed } = realRuntime()
        seed()
        // The shipped route id, which is NOT the pi-ai catalog id.
        const outcome = declareRoutes(llm, GATEWAYS, NS)
        expect(outcome.skipped).toEqual([])
        expect(outcome.declared).toEqual([OPENCODE_GO.id])
        const providers = llm.listConfigurableProviders().map((entry) => `${entry.provider}@${entry.settingsNs}`)
        expect(providers).toContain('opencode-go@llm-pi-ai')
        expect(providers).toContain(`${OPENCODE_GO.id}@${NS}`)
    })

    it('degrades instead of failing when the same key really is gone', () => {
        const { llm, seed } = realRuntime()
        seed()
        // Simulate the historical mistake: a route key that pi-ai owns.
        const colliding = [{ ...OPENCODE_GO, id: 'opencode-go' }]
        expect(() => declareRoutes(llm, colliding, NS)).not.toThrow()
        expect(declareRoutes(llm, colliding, NS).skipped).toEqual([{ provider: 'opencode-go', owner: 'llm-pi-ai' }])
    })
})

describe('the conflict this plugin exists to avoid', () => {
    it('routes metadata lookups through the catalog provider id, not the route key', async () => {
        // Guards a subtle failure mode: if metadata were keyed by the route id,
        // every model would lose its capacities and compat switches — silently,
        // because the merge falls back to defaults.
        const fetchImpl = vi.fn(async () => new Response('{"opencode-go":{"models":{"deepseek-v4.1-flash":{"id":"deepseek-v4.1-flash","limit":{"context":1000000,"output":384000}}}}}', { status: 200 }))
        const metadata = await fetchModelsDevCatalog({ fetch: fetchImpl as unknown as typeof fetch })
        expect(metadata.get('deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
    })
})
