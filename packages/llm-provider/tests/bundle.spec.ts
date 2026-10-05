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
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
