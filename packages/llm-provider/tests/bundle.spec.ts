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

    it('registers the settings card under the namespace it edits', () => {
        const source = readFileSync(bundle, 'utf8')
        expect(source).toContain('llm-provider')
        expect(source).toContain('settings.plugin.item')
    })

    it('declares every scoped Remote namespace it reads', () => {
        // cordis resolves `ctx.remote.llm` through a service key of its own and
        // throws "cannot get property "remote.llm" without inject" when the
        // namespace is undeclared. The card's model list and key field both read
        // those namespaces, so a missing declaration is a runtime failure with
        // no compile-time signal.
        const module = materialize(bundle)
        expect(module.inject).toContain('remote')
        for (const scoped of ['remote.llm', 'remote.credentials']) {
            expect(module.inject, `${scoped} is read but not declared`).toContain(scoped)
        }
    })

    it('reads the Remote carrier directly, because a lazy lookup is what broke it', () => {
        // `ctx.get('remote')?.llm` bypasses the inject declaration and throws at
        // read time; the direct property is the only form that works.
        const source = readFileSync(bundle, 'utf8')
        expect(source).not.toMatch(/get\(\s*["']remote["']\s*\)/)
    })
})
