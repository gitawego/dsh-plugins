/**
 * Build-output guard for the section's bundle.
 *
 * The browser module system wraps ONE entry file in a `factory(require)` whose
 * `require` answers only the host's externals, so a surviving relative
 * `require('./x.js')` is a boot-time crash — and the section is written as
 * several modules. It must also stay free of the server's validation library:
 * the shared server table lives in `mcp-servers.ts` precisely so importing it
 * does not pull schemastery into the browser.
 *
 * Runs against the built output, so it must run after `pnpm build`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const bundle = join(root, 'lib', 'client.js')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, { default: string }>
    dsh?: { client?: unknown }
}

describe('the built section bundle', () => {
    it('exists, and is the client export', () => {
        expect(existsSync(bundle), 'lib/client.js is missing — run `pnpm build` first').toBe(true)
        expect(pkg.exports['./client']?.default).toBe('./lib/client.js')
    })

    it('registers itself under the package name, which is how the loader keys it', () => {
        const source = readFileSync(bundle, 'utf8')
        expect(source).toContain(`window.__ModuleLoader__.load({ id: "${pkg.name}"`)
    })

    it('carries no relative require, which the browser loader cannot answer', () => {
        const source = readFileSync(bundle, 'utf8')
        expect(source.match(/require\(\s*["']\.{1,2}\//gu) ?? []).toEqual([])
    })

    it('requires only the host-provided externals', () => {
        const source = readFileSync(bundle, 'utf8')
        const specs = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1]!)
        for (const spec of specs) {
            expect(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'], `unexpected external: ${spec}`).toContain(spec)
        }
    })

    it('does not drag the server schema library into the browser', () => {
        const source = readFileSync(bundle, 'utf8')
        expect(source).not.toContain('schemastery')
    })

    it('registers a settings SECTION, not a card in the plugin list', () => {
        const source = readFileSync(bundle, 'utf8')
        expect(source).toContain('settings.section')
        expect(source).not.toContain('settings.plugin.item')
    })
})
