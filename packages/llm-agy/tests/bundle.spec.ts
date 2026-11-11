/**
 * Build-output guard. Runs after `pnpm build` (the package's `prepare` does it
 * on install), and catches the class of failure the monorepo AGENT.md records:
 * the loader expects the server entry to exist, be ESM, and export `apply`,
 * `inject`, and `Config`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, { default: string }>
    dsh?: { bundle?: { patch?: string } }
}

describe('package shape', () => {
    it('declares the bundle patch the loader applies', () => {
        expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
        expect(pkg.exports['.']?.default).toBe('./lib/index.js')
        expect(existsSync(join(root, 'cordis.patch.yml'))).toBe(true)
    })
})

describe('server entry', () => {
    const entry = join(root, 'lib', 'index.js')

    it('exists', () => {
        expect(existsSync(entry), 'lib/index.js is missing — run `pnpm build` first').toBe(true)
    })

    it('exports the plugin surface the loader mounts', () => {
        const source = readFileSync(entry, 'utf8')
        for (const symbol of ['apply', 'inject', 'Config', 'AGY_PROVIDER', 'AgyAdapter']) {
            expect(source, `${symbol} is not exported by the server entry`).toMatch(new RegExp(`\\b${symbol}\\b`))
        }
    })

    it('is ESM, which is what the host loads', () => {
        expect(readFileSync(entry, 'utf8')).toMatch(/^export /mu)
    })
})
