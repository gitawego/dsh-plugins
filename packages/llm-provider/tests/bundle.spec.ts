/**
 * Build-output guard.
 *
 * The monorepo's AGENT.md records why this file exists: `packages/lsp` once
 * shipped a browser bundle over the server's `lib/client.js`, and the failure
 * surfaced only when the harness booted. Two claims here are the cheap,
 * build-time version of that lesson:
 *
 * 1. the client bundle is self-contained — the browser module system hands the
 *    wrapped factory a `require` that answers only the host's externals, so a
 *    surviving relative `require('./x.js')` is a boot-time crash;
 * 2. the server entry still exports what the loader mounts, and the two halves
 *    do not share a path.
 *
 * Runs against the built output, so it must run after `pnpm build`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

/**
 * Materialize the built client bundle the way the browser module loader does,
 * so its exports can be asserted instead of pattern-matched.
 * @param path - the built bundle.
 * @returns the module the bundle registers.
 */
function materialize(path: string): { inject?: string[]; apply?: unknown } {
    let factory: ((require: (specifier: string) => unknown) => { inject?: string[]; apply?: unknown }) | undefined
    const source = readFileSync(path, 'utf8')
    // The bundle only registers a factory at script execution.
    new Function('window', source)({
        __ModuleLoader__: {
            load: ({ factory: loaded }: { factory: typeof factory }) => {
                factory = loaded
            },
        },
    })
    if (factory === undefined) throw new Error('the client bundle registered no factory')
    return factory((specifier: string) => require(specifier.startsWith('react') ? specifier : specifier))
}

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, { default: string }>
    dsh?: { client?: unknown; bundle?: unknown }
}

describe('built package shape', () => {
    it('declares both halves and the bundle patch', () => {
        expect(pkg.dsh?.client).toBeDefined()
        expect(pkg.dsh?.bundle).toBeDefined()
        expect(pkg.exports['./client']?.default).toBe('./lib/client.js')
        expect(pkg.exports['.']?.default).toBe('./lib/index.js')
    })

    it('does not let the two halves collide on one path', () => {
        expect(pkg.exports['./client']?.default).not.toBe(pkg.exports['.']?.default)
    })
})

describe('server entry', () => {
    const entry = join(root, 'lib', 'index.js')

    it('exists and exports the plugin surface the loader mounts', () => {
        expect(existsSync(entry), 'lib/index.js is missing — run `pnpm build` first').toBe(true)
        const source = readFileSync(entry, 'utf8')
        for (const symbol of ['apply', 'inject', 'Config', 'createGatewayTransport', 'ROUTES']) {
            expect(source, `${symbol} is not exported by the server entry`).toMatch(new RegExp(`\\b${symbol}\\b`))
        }
    })

    it('is ESM, which is what the host loads', () => {
        const source = readFileSync(entry, 'utf8')
        expect(source).toMatch(/^export /mu)
    })
})

describe('client bundle', () => {
    const bundle = join(root, 'lib', 'client.js')

    it('exists', () => {
        expect(existsSync(bundle), 'lib/client.js is missing — run `pnpm build` first').toBe(true)
    })

    it('registers itself under the package name, which is how the loader keys it', () => {
        const source = readFileSync(bundle, 'utf8')
        expect(source).toContain(`window.__ModuleLoader__.load({ id: "${pkg.name}"`)
        expect(source).toContain('factory: (require) =>')
    })

    it('carries no relative require, which the browser loader cannot answer', () => {
        const source = readFileSync(bundle, 'utf8')
        const relative = source.match(/require\(\s*["']\.{1,2}\//gu) ?? []
        expect(relative, `relative requires survive bundling: ${relative.join(', ')}`).toEqual([])
    })

    it('requires only the host-provided externals', () => {
        const source = readFileSync(bundle, 'utf8')
        const specs = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1]!)
        for (const spec of specs) {
            expect(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'], `unexpected external: ${spec}`).toContain(spec)
        }
    })

    it('registers a settings SECTION, not a card in the plugin list', () => {
        // The surface grows with every gateway the plugin serves, and the plugin
        // list is the wrong home for that: `settings.section` is a list slot
        // (so it also carries an explicit `order`, and its position is stable).
        const source = readFileSync(bundle, 'utf8')
        expect(source).toContain('settings.section')
        expect(source).toContain('llm-providers')
        expect(source).not.toContain('settings.plugin.item')
    })

    it('gates registration only on boot-time services, so the card has a stable position', () => {
        // The Plugins tab renders cards in slot-registration order, and a keyed
        // slot carries no `order` field — so registering later than necessary is
        // the only ordering mistake a plugin can make here. Waiting on the Remote
        // carrier, which arrives with the socket handshake, made this card land
        // wherever that handshake happened to finish.
        const module = materialize(bundle)
        expect(module.inject).toEqual(['slots', 'locale', 'settingsScope'])
    })

    it('extends the Models page for its own provider row', () => {
        // The shipped Models section renders `settings.models.provider-card` for
        // every provider row, keyed by the settings namespace that owns it —
        // documented as the seat for plugins distributed outside the harness.
        // This route needs it: the section's own editor cannot configure us.
        const source = readFileSync(bundle, 'utf8')
        expect(source).toContain('settings.models.provider-card')
        // The copy names the location; the arrow survives bundling as an escape,
        // so assert the halves rather than the whole line.
        expect(source).toContain('Models, allowance, and endpoint are configured in')
        expect(source).toContain('LLM providers')
    })

    it('binds the scoped Remote namespaces in a fiber that declares them', () => {
        // cordis refuses to resolve `ctx.remote.llm` from a context that has not
        // declared it ("cannot get property ... without inject"). A child fiber
        // declaring them satisfies that rule without delaying registration, and
        // the lazy accessor form would bypass the declaration entirely.
        const source = readFileSync(bundle, 'utf8')
        for (const scoped of ['remote.llm', 'remote.credentials']) {
            expect(source, `${scoped} is read but never declared`).toContain(scoped)
        }
        expect(source).not.toMatch(/get\(\s*["']remote["']\s*\)/)
    })
})
