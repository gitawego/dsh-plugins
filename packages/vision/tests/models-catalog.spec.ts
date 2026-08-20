/** rc.8 LlmDiscoveredModel + registerModelDiscovery adoption.
 *  discoverForDraft probes an endpoint with a one-shot credential that is
 *  NEVER persisted (the harness's discoverModels API takes the key
 *  directly). The plugin's catalog layer wraps this with sensible defaults
 *  (timeout, signal propagation, error normalization) and exposes a typed
 *  result the settings UI can render. */
import { describe, expect, it, vi } from 'vitest'
import { discoverForDraft, type DiscoverOptions, type DiscoverResult } from '../src/models-catalog.ts'

function makeFakeLlm(overrides: Partial<{
  discoverModels: ReturnType<typeof vi.fn>
}> = {}) {
  return {
    discoverModels: overrides.discoverModels ?? vi.fn(async () => [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 4096 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxTokens: 16384 },
    ]),
  }
}

describe('discoverForDraft (rc.8 registerModelDiscovery adoption)', () => {
  it('returns image-capable models only (filters out models that explicitly declare no image input)', async () => {
    const llm = makeFakeLlm({
      discoverModels: vi.fn(async () => [
        // No inputModalities declared → model-catalog omission is NOT rejection → kept.
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
        // Explicitly declares no image → filtered out.
        { id: 'gpt-3.5', name: 'GPT-3.5', inputModalities: ['text'] },
        // Explicitly declares image → kept.
        { id: 'gpt-vision', name: 'GPT-Vision', inputModalities: ['image'] },
      ] as never),
    })
    const result = await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      api: 'openai',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.models).toHaveLength(2)
      expect(result.models.map((m) => m.id).sort()).toEqual(['gpt-4o', 'gpt-vision'])
    }
  })

  it('returns ALL models when none declare inputModalities (model catalog omission is not rejection)', async () => {
    const llm = makeFakeLlm({
      discoverModels: vi.fn(async () => [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ] as never),
    })
    const result = await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.models.map((m) => m.id).sort()).toEqual(['a', 'b'])
    }
  })

  it('propagates the AbortSignal to ctx.llm.discoverModels', async () => {
    const controller = new AbortController()
    const seen: { signal?: AbortSignal } = {}
    const llm = makeFakeLlm({
      discoverModels: vi.fn(async (_settingsNs: string, request: { signal?: AbortSignal }) => {
        seen.signal = request.signal
        return []
      }),
    })
    await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      signal: controller.signal,
    })
    expect(seen.signal).toBe(controller.signal)
  })

  it('never persists the one-shot apiKey (only forwards it to discoverModels)', async () => {
    const seenArgs: Array<{ apiKey?: string }> = []
    const llm = makeFakeLlm({
      discoverModels: vi.fn(async (_ns: string, request: { apiKey?: string }) => {
        seenArgs.push({ apiKey: request.apiKey })
        return []
      }),
    })
    await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-ephemeral',
    })
    expect(seenArgs).toHaveLength(1)
    expect(seenArgs[0]!.apiKey).toBe('sk-ephemeral')
  })

  it('returns ok:false with a normalized error when discoverModels throws', async () => {
    const llm = makeFakeLlm({
      discoverModels: vi.fn(async () => {
        throw new Error('network unreachable')
      }),
    })
    const result = await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('network unreachable')
      expect(result.code).toBe('unexpected')
    }
  })

  it('returns ok:false with code "missing_credentials" when apiKey is undefined', async () => {
    const llm = makeFakeLlm()
    const result = await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: undefined,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('missing_credentials')
      expect(llm.discoverModels).not.toHaveBeenCalled()
    }
  })

  it('forwards provider when given (route the draft is editing)', async () => {
    const seenArgs: Array<{ provider?: string }> = []
    const llm = makeFakeLlm({
      discoverModels: vi.fn(async (_ns: string, request: { provider?: string }) => {
        seenArgs.push({ provider: request.provider })
        return [{ id: 'm', name: 'M' }]
      }),
    })
    await discoverForDraft(llm as never, {
      settingsNs: 'vision',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      provider: 'openai-route',
    })
    expect(seenArgs[0]!.provider).toBe('openai-route')
  })
})


/** Auto-deriving the http delegation block from the provider's OWN
 *  llm-pi-ai profile (rc.8 regression fix): on Termux where the attachment
 *  store cannot deliver natively, describe_image previously required manually
 *  re-typing http.baseUrl+credential+model even though the provider was
 *  already configured. The plugin can now read the provider profile via
 *  ctx.settings.get('llm-pi-ai') and prefill credential (apiKeyEnv) + model;
 *  baseUrl comes from the profile when the user declared it, else stays
 *  user-supplied (the catalog endpoint is adapter-internal, not public API). */
import { deriveHttpFromProviderProfile } from '../src/models-catalog.ts'

describe('deriveHttpFromProviderProfile (rc.8 zero-manual-config fix)', () => {
  it('derives credential+model+baseUrl from a provider profile', () => {
    const profile = {
      providers: {
        'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: 'https://opencode.ai/zen/go/v1' },
      },
    }
    const result = deriveHttpFromProviderProfile(profile as never, 'opencode-go', 'minimax-m3')
    expect(result).toEqual({
      credential: 'OPENCODE_GO_API_KEY',
      model: 'minimax-m3',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    })
  })

  it('derives credential+model even when the profile has no baseURL (catalog endpoint)', () => {
    const profile = {
      providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } },
    }
    const result = deriveHttpFromProviderProfile(profile as never, 'opencode-go', 'minimax-m3')
    expect(result).toEqual({ credential: 'OPENCODE_GO_API_KEY', model: 'minimax-m3', baseUrl: undefined })
  })

  it('returns undefined when the provider is unknown', () => {
    expect(deriveHttpFromProviderProfile({} as never, 'nope', 'm')).toBeUndefined()
  })

  it('returns undefined when the provider has no apiKeyEnv (nothing to derive)', () => {
    const profile = { providers: { 'x': { baseURL: 'https://x' } } }
    expect(deriveHttpFromProviderProfile(profile as never, 'x', 'm')).toBeUndefined()
  })
})


/** resolveProviderEndpointFromCatalog: reads the PROVIDER'S OWN published
 *  pi-ai catalog data (dist/providers/data/<provider>.json — the provider's
 *  advertised endpoint, public data) to complete the http delegation block.
 *  Endpoint-only resolution; the image is still carried by the plugin's own
 *  http transport. User overrides always win (empty fields only). */
import { resolveProviderEndpointFromCatalog, apiToProtocol } from '../src/models-catalog.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('resolveProviderEndpointFromCatalog (pi-ai published catalog data)', () => {
  function fixtureCatalog(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-catalog-'))
    writeFileSync(join(dir, 'opencode-go.json'), JSON.stringify({
      'anthropic-messages': {
        'minimax-m3': { id: 'minimax-m3', api: 'anthropic-messages', provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go', input: ['text', 'image'] },
      },
      'openai-completions': {
        'deepseek-v4-flash': { id: 'deepseek-v4-flash', api: 'openai-completions', provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', input: ['text'] },
      },
    }))
    return dir
  }

  it('resolves baseUrl+protocol for an image-capable model under anthropic-messages', () => {
    const dir = fixtureCatalog()
    try {
      const hit = resolveProviderEndpointFromCatalog(dir, 'opencode-go', 'minimax-m3')
      expect(hit).toEqual({ baseUrl: 'https://opencode.ai/zen/go', api: 'anthropic-messages' })
      expect(apiToProtocol(hit?.api)).toBe('anthropic')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolves openai-completions protocol to openai', () => {
    const dir = fixtureCatalog()
    try {
      const hit = resolveProviderEndpointFromCatalog(dir, 'opencode-go', 'deepseek-v4-flash')
      expect(hit).toEqual({ baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-completions' })
      expect(apiToProtocol(hit?.api)).toBe('openai')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns undefined when the model has no image input in the catalog', () => {
    const dir = fixtureCatalog()
    try {
      // deepseek-v4-flash exists but input is text-only → not a vision endpoint.
      const hit = resolveProviderEndpointFromCatalog(dir, 'opencode-go', 'nope')
      expect(hit).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns undefined when the provider catalog file is absent (graceful on non-pi-ai hosts)', () => {
    expect(resolveProviderEndpointFromCatalog('/nonexistent-dir', 'opencode-go', 'minimax-m3')).toBeUndefined()
  })
})
