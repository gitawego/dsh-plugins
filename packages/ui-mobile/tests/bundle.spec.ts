import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const bundle = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('dsh-ui-mobile client bundle', () => {
  it('registers itself through the module loader with the package id', () => {
    expect(bundle).toContain('window.__ModuleLoader__.load({')
    expect(bundle).toContain("id: '@gitawego/dsh-ui-mobile'")
  })

  it('exports the plugin body and consumes the shell layout service', () => {
    expect(bundle).toContain('exports.apply = apply')
    expect(bundle).toContain('exports.inject = inject')
    expect(manifest.dsh.client.inject).toContain('layout')
    expect(bundle).toContain('ctx.layout')
  })

  it('defaults to a single chat column on phones and hides the rails', () => {
    expect(bundle).toContain('0 minmax(0, 1fr) 0')
    expect(bundle).toContain('!important')
    expect(bundle).toContain('overflow-x: hidden')
  })

  it('opens sidebar/details as full-screen drawers (preserves all default functionality)', () => {
    expect(bundle).toContain("'min(300px, 88vw) 0 0'")
    expect(bundle).toContain("'0 0 min(300px, 88vw)'")
    expect(bundle).toContain('ctx.layout.toggleSidebar')
    expect(bundle).toContain('ctx.layout.openDetails')
    expect(bundle).toContain('ctx.layout.closeDetails')
  })

  it('restyles the stock conversation surface for phones (header/composer/todo/actions)', () => {
    // conversation header: compact + tabs spaced
    expect(bundle).toContain('.wSkVaW_header')
    expect(bundle).toContain('.wSkVaW_tabs')
    // composer toolbar: wrap + 44px tap targets so +/model/send don't overlap
    expect(bundle).toContain('.uV2eYG_row')
    expect(bundle).toContain('min-width: 44px; min-height: 44px')
    // model select readable
    expect(bundle).toContain('._7KE1Ra_trigger')
    // todo titles wrap instead of truncating
    expect(bundle).toContain('.lXshSW_title')
    expect(bundle).toContain('white-space: normal')
    // message actions get a real gap
    expect(bundle).toContain('.p-xYUq_actions')
  })

  it('provides a top-left action bar and scrim and cleans up on dispose', () => {
    expect(bundle).toContain('bar.id = BAR_ID')
    expect(bundle).toContain('scrim.id = SCRIM_ID')
    expect(bundle).toContain('gap: 16px')
    expect(bundle).toMatch(/return function dispose\(\)/)
    expect(bundle).toContain('.remove()')
  })
})
