/** Tests for the browser-side data stores (mocked fetch, no DOM): the live
 *  model-catalog controller and the settings controller that backs the Vision
 *  settings form over the plugin's own /_dsh/vision/settings route. */
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogController, SettingsController } from '../src/client/index.tsx'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof fetch
}

describe('CatalogController (/_dsh/vision/models)', () => {
  it('publishes the live catalog snapshot', async () => {
    stubFetch(async () => jsonResponse({
      ok: true,
      value: {
        providers: [{ id: 'p', name: 'P' }],
        visionModels: [{ provider: 'p', model: 'm', name: 'M' }],
        configured: { provider: 'p', model: 'm' },
        detected: { provider: 'p', model: 'm', name: 'M', default: true },
        available: true,
      },
    }))
    const controller = new CatalogController()
    expect(controller.getSnapshot().status).toBe('idle')
    const settled = controller.load()
    expect(controller.getSnapshot().status).toBe('loading')
    await settled
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().snapshot?.detected?.model).toBe('m')
  })

  it('surfaces fetch failures without throwing', async () => {
    stubFetch(async () => jsonResponse({ ok: false, error: { code: 'catalog-unavailable', message: 'down' } }, false, 503))
    const controller = new CatalogController()
    await controller.load()
    expect(controller.getSnapshot().status).toBe('error')
    expect(controller.getSnapshot().error).toContain('down')
  })
})

describe('SettingsController (/_dsh/vision/settings)', () => {
  it('loads the current snapshot', async () => {
    stubFetch(async () => jsonResponse({
      ok: true,
      value: { writable: true, value: { provider: 'p', model: 'm' } },
    }))
    const controller = new SettingsController()
    await controller.load()
    const snapshot = controller.getSnapshot().snapshot
    expect(snapshot?.writable).toBe(true)
    expect(snapshot?.value.provider).toBe('p')
  })

  it('POSTs a form submission and publishes the fresh snapshot', async () => {
    let postedBody: unknown
    let postedInit: RequestInit | undefined
    stubFetch(async (input, init) => {
      postedBody = JSON.parse(String(init?.body))
      postedInit = init
      return jsonResponse({
        ok: true,
        value: { writable: true, value: { provider: 'p', model: 'm', enabled: true } },
      })
    })
    const controller = new SettingsController()
    await controller.save({ provider: 'p', model: 'm', enabled: true })
    expect(postedInit?.method).toBe('POST')
    expect(postedBody).toEqual({ provider: 'p', model: 'm', enabled: true })
    expect(controller.getSnapshot().snapshot?.value.enabled).toBe(true)
  })

  it('rethrows server rejection and records the error state', async () => {
    stubFetch(async () => jsonResponse({ ok: false, error: { code: 'settings-rejected', message: 'invalid baseUrl' } }, false, 400))
    const controller = new SettingsController()
    await expect(controller.save({})).rejects.toThrow(/invalid baseUrl/)
    expect(controller.getSnapshot().status).toBe('error')
  })
})


import { providerOptions, modelOptions } from '../src/client/index.tsx'

describe('settings dropdown option building (data-driven)', () => {
  const catalog = {
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'opencode-go', name: 'opencode-go' }],
    visionModels: [
      { provider: 'opencode-go', model: 'minimax-m3', name: 'MiniMax-M3' },
      { provider: 'opencode-go', model: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { provider: 'deepseek-official', model: 'vl-model', name: 'VL' },
    ],
    configured: { provider: 'opencode-go', model: 'minimax-m3' },
    detected: { provider: 'opencode-go', model: 'minimax-m3', name: 'MiniMax-M3', default: true },
    available: true,
  } as never

  it('lists all registered providers (auto-populated from dsh config)', () => {
    const options = providerOptions(catalog, '', 'opencode-go')
    expect(options).toContain('deepseek-official')
    expect(options).toContain('opencode-go')
  })

  it('keeps a configured provider that left the catalog', () => {
    const options = providerOptions(catalog, 'legacy-provider', 'opencode-go')
    expect(options).toContain('legacy-provider')
  })

  it('lists only the selected provider\'s vision models and marks the detected default', () => {
    const options = modelOptions(catalog, 'opencode-go', 'minimax-m3', 'minimax-m3')
    expect(options.map((o) => o.value)).toEqual(expect.arrayContaining(['minimax-m3', 'qwen3.7-plus']))
    expect(options.map((o) => o.value)).not.toContain('vl-model')
    const detected = options.find((o) => o.value === 'minimax-m3')
    expect(detected?.detected).toBe(true)
  })

  it('keeps a configured model that is not in the catalog', () => {
    const options = modelOptions(catalog, 'opencode-go', 'retired-model', undefined)
    expect(options.some((o) => o.value === 'retired-model' && o.retained)).toBe(true)
  })

  it('returns no models when the provider is unset', () => {
    expect(modelOptions(catalog, '', '', undefined).length).toBe(0)
  })
})

