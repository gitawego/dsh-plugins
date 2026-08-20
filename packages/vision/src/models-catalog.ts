/** Domain-level helpers for the vision model catalog — builds a snapshot
 *  of the live LLM registry (image-capable models, registered providers,
 *  default detection) for any consumer. Extracted from the rc.6 bespoke
 *  HTTP route so the same logic powers both the host-side /vision command
 *  and the rc.7 client-side catalog dropdown (via api.llm.models RPC).
 *  Not HTTP-coupled. */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import type { ResolvedVisionConfig } from './config.ts'
import { detectVisionModel, type VisionModelCandidate } from './defaults.ts'

export interface VisionProviderRow {
  id: string
  name: string
}

export interface VisionModelRow extends VisionModelCandidate {
  default?: boolean
}

export interface VisionModelsSnapshot {
  providers: VisionProviderRow[]
  visionModels: VisionModelRow[]
  configured: { provider: string | undefined; model: string | undefined }
  detected: VisionModelRow | undefined
  available: boolean
}

export async function buildModelsSnapshot(
  ctx: { llm: { listProviders: () => Array<{ id: string; name: string }>; listModels: (provider: string) => Promise<Array<{ id: string; name: string; inputModalities?: readonly string[] }>> } },
  resolved: ResolvedVisionConfig,
): Promise<VisionModelsSnapshot> {
  let providers: VisionProviderRow[] = []
  try {
    providers = ctx.llm.listProviders().map((p) => ({ id: p.id, name: p.name }))
  } catch {
    providers = []
  }
  const visionModels: VisionModelRow[] = []
  for (const { id } of providers) {
    let models
    try {
      models = await ctx.llm.listModels(id)
    } catch {
      continue
    }
    for (const m of models) {
      const inputModalities = m.inputModalities ?? []
      if (!inputModalities.includes('image')) continue
      visionModels.push({ provider: id, model: m.id, name: m.name })
    }
  }
  const detected = await detectVisionModel(ctx.llm as never, { primaryProvider: resolved.provider })
  const detectedRow: VisionModelRow | undefined = detected === undefined
    ? undefined
    : { provider: detected.provider, model: detected.model, name: detected.name, default: true }
  const configured = { provider: resolved.provider, model: resolved.model }
  const available = providers.length > 0
  return { providers, visionModels, configured, detected: detectedRow, available }
}

/** rc.8 registerModelDiscovery + discoverModels adoption.
 *  When the user is editing a profile (has NOT yet saved the credential),
 *  the live catalog is closed (the route isn't registered yet). The
 *  harness's discoverModels(settingsNs, {provider, baseURL, api, apiKey,
 *  signal}) lets the plugin probe an endpoint with a one-shot credential
 *  that is never persisted. This module wraps that surface with:
 *   - inputModalities filtering (only image-capable candidates)
 *   - signal propagation (caller-side cancellation)
 *   - normalized error reporting (missing_credentials / unexpected)
 *   - typed DiscoverResult (the wire shape the web client + /vision
 *     command both consume). */

/** A minimal structural subset of ctx.llm the helper depends on. Tests
 *  inject a fake; production callers pass ctx.llm (the full LlmRuntime
 *  satisfies the subset). */
export interface DiscoverLlm {
  discoverModels(
    settingsNs: string,
    request: {
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
      signal?: AbortSignal
    },
  ): Promise<ReadonlyArray<{
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    inputModalities?: readonly string[]
  }>>
}

export interface DiscoverOptions {
  /** Settings namespace the discovery advertises under (the plugin owns 'vision'). */
  settingsNs: string
  /** Endpoint to probe (no stored credential → caller must supply). */
  baseURL: string
  /** One-shot credential — never persisted; forwarded to discoverModels only. */
  apiKey: string | undefined
  /** Optional: the route the draft is editing (when known). */
  provider?: string
  /** Optional: wire protocol the endpoint speaks (openai / anthropic / ...). */
  api?: string
  /** Caller-side cancellation. */
  signal?: AbortSignal
}

export type DiscoverResult =
  | { ok: true; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number }> }
  | { ok: false; code: 'missing_credentials' | 'unexpected'; message: string }

/** Probe an endpoint with a one-shot credential. Filters out non-image-capable
 *  models when the endpoint reports inputModalities; passes through all
 *  models when the endpoint omits inputModalities (model-catalog omission
 *  is not rejection — see SPEC §13). */
export async function discoverForDraft(
  llm: DiscoverLlm,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  if (opts.apiKey === undefined || opts.apiKey.trim().length === 0) {
    return { ok: false, code: 'missing_credentials', message: 'discover requires an apiKey (one-shot, never persisted)' }
  }
  try {
    const raw = await llm.discoverModels(opts.settingsNs, {
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      api: opts.api,
      provider: opts.provider,
      signal: opts.signal,
    })
    // Keep only image-capable models when the endpoint declares inputModalities;
    // pass through all when none declare it (catalog omission is not rejection).
    const models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number }> = []
    for (const m of raw) {
      const modalities = m.inputModalities
      if (modalities !== undefined && !modalities.includes('image')) continue
      models.push({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens })
    }
    return { ok: true, models }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, code: 'unexpected', message: `discoverModels failed: ${message}` }
  }
}

/** rc.8 regression fix — auto-derive the http delegation block from the
 *  provider's OWN llm-pi-ai settings profile.
 *
 *  Why: on a host where the attachment store cannot deliver images natively
 *  (Android/Termux EACCES), delegation=auto falls back to the http transport,
 *  which needs http.baseUrl + http.credential + http.model. The provider and
 *  model are already auto-detected, and the provider's credential (apiKeyEnv)
 *  and endpoint (baseURL, when declared) live in the provider's OWN settings
 *  namespace — the user did NOT want to re-type them. This helper reads the
 *  cross-namespace settings document (ctx.settings.get('llm-pi-ai'), a public
 *  API that returns any registered namespace's resolved value) and synthesizes
 *  the http block.
 *
 *  baseUrl caveat: for a CATALOG route pi-ai ships, the endpoint is
 *  adapter-internal (not in the user document); the helper yields baseUrl
 *  only when the user declared `baseURL` under the provider profile. Callers
 *  persist the derived fields so the user only ever supplies baseUrl once
 *  (or uses a route that declares it). */
export interface DerivedHttpConfig {
  baseUrl: string | undefined
  credential: string | undefined
  model: string
}

/** Shape of the llm-pi-ai settings namespace (cross-namespace read target). */
export interface LlmPiAiSettingsDocument {
  providers?: Record<string, { apiKeyEnv?: string; baseURL?: string }>
}

export function deriveHttpFromProviderProfile(
  document: LlmPiAiSettingsDocument | undefined,
  provider: string | undefined,
  model: string | undefined,
): DerivedHttpConfig | undefined {
  if (provider === undefined || model === undefined) return undefined
  const profile = document?.providers?.[provider]
  if (profile === undefined) return undefined
  const credential = profile.apiKeyEnv !== undefined && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : undefined
  if (credential === undefined) return undefined
  return {
    baseUrl: profile.baseURL !== undefined && profile.baseURL.length > 0 ? profile.baseURL : undefined,
    credential,
    model,
  }
}

/** resolveProviderEndpointFromCatalog: read ONE provider's published pi-ai
 *  catalog data (dist/providers/data/<provider>.json) to find the model's
 *  advertised baseUrl + wire api. This is PUBLIC provider data (the endpoint
 *  the vendor publishes), NOT adapter runtime internals — the DESIGN RULE
 *  forbids using pi-ai machinery to carry the IMAGE; reading an endpoint
 *  string is endpoint resolution. Endpoint-only: the plugin's http transport
 *  still carries the image itself (base64), and user overrides always win.
 *  Graceful on hosts without pi-ai (returns undefined). */
export interface CatalogEndpointHit {
  baseUrl: string
  api: string
}

/** Map a pi-ai wire-api name to the plugin's HttpProtocol. Unknown → openai. */
export const OPENAI_COMPATIBLE_APIS = ['openai-completions', 'openai-responses']
export function apiToProtocol(api: string | undefined): 'openai' | 'anthropic' {
  return (api === 'anthropic-messages' && !OPENAI_COMPATIBLE_APIS.includes(api)) ? 'anthropic' : 'openai'
}

interface CatalogModelEntry { baseUrl?: string; input?: readonly string[] }
interface CatalogApiGroup { [model: string]: CatalogModelEntry }
interface ProviderCatalog { [api: string]: CatalogApiGroup }

/** Resolve the endpoint for (provider, model) from the published pi-ai
 *  catalog data directory. Prefers the model under an API whose entry is
 *  image-capable (input includes 'image'); falls back to the first API
 *  group containing the model (a text-only catalog omission is not a
 *  rejection — the endpoint still tells us where the vendor serves it).
 *  The caller decides image-capability separately. */
export function resolveProviderEndpointFromCatalog(
  catalogDataDir: string | undefined,
  provider: string,
  model: string,
): CatalogEndpointHit | undefined {
  if (catalogDataDir === undefined) return undefined
  const file = joinPath(catalogDataDir, `${provider}.json`)
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return undefined }
  let catalog: ProviderCatalog
  try { catalog = JSON.parse(raw) as ProviderCatalog } catch { return undefined }
  const apis = Object.keys(catalog)
  // Order the API groups: OpenAI-compatible first (empirically these gateways
  // only actually serve requests through /chat/completions with the provider
  // key — the anthropic label is often metadata only and /v1/messages 401s),
  // then anthropic-messages, then anything else.
  const byApiPriority = (api: string): number => OPENAI_COMPATIBLE_APIS.includes(api) ? 0 : (api === 'anthropic-messages' ? 1 : 2)
  const groups = apis
    .map((api) => ({ api, entry: catalog[api]?.[model] }))
    .filter((g): g is { api: string; entry: { baseUrl?: string; input?: readonly string[] } } =>
      g.entry !== undefined && g.entry.baseUrl !== undefined)
    .sort((a, b) => byApiPriority(a.api) - byApiPriority(b.api))
  // Prefer an image-capable entry across the priority-ordered groups.
  const imageHit = groups.find((g) => g.entry!.input?.includes('image'))
  if (imageHit !== undefined) return { baseUrl: imageHit.entry!.baseUrl as string, api: imageHit.api }
  // Otherwise the first group naming the model (endpoint still known).
  const first = groups[0]
  if (first !== undefined) return { baseUrl: first.entry.baseUrl as string, api: first.api }
  return undefined
}

/** Locate the pi-ai providers/data catalog directory — the vendor-published
 *  endpoint catalog (dist/providers/data/*.json). This is PUBLIC provider
 *  endpoint data, NOT adapter runtime machinery; the DESIGN RULE governs how
 *  the IMAGE is carried (http base64 / subagent), not where an endpoint string
 *  comes from. The harness loads the plugin from <dsh-global> and pi-ai is a
 *  peer in the same pnpm store, so createRequire anchored to the plugin's own
 *  module resolves dsh-llm-pi-ai the same way the harness does, and we walk up
 *  to the co-located @earendil-works/pi-ai package. Non-throwing. */
import { createRequire } from 'node:module'
export function resolvePiAiCatalogDataDir(unusedHome: string | undefined): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@deepseek-ai/dsh-llm-pi-ai') // .../dsh-llm-pi-ai/lib/index.js
    let dir = joinPath(entry, '..', '..') // .../dsh-llm-pi-ai
    // Layout A: pi-ai is a sibling in the same pnpm store realm.
    const sibling = joinPath(dir, '..', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
    if (existsSync(sibling)) return sibling
    // Layout B: pi-ai under this package's own node_modules.
    const nested = joinPath(dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
    if (existsSync(nested)) return nested
    // Layout C: pi-ai hoisted to a common ancestor — walk up a few levels.
    for (let i = 0; i < 4; i++) {
      const parent = joinPath(dir, '..')
      if (parent === dir) break
      const cand = joinPath(parent, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
      if (existsSync(cand)) return cand
      dir = parent
    }
  } catch {
    /* not under the harness install — graceful */
  }
  return undefined
}
