/**
 * Configuration for the enhanced web search provider. Persisted in the DSH
 * Settings document under the `web-search-enhanced` namespace via ctx.settings.
 * `go.credential` is a DSH credential-ref NAME (never a literal secret).
 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('web-search-enhanced')

export const LLM_PROTOCOLS = ['anthropic', 'openai'] as const
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number]

export interface GoBackendConfig {
  enabled: boolean
  protocol: LlmProtocol
  baseUrl: string | undefined
  credential: string | undefined
  model: string | undefined
  timeoutMs: number
}

export interface FreeBackendConfig {
  parallelUrl: string
  exaUrl: string
  timeoutMs: number
  snippetMaxChars: number
  maxResults: number
}

export interface WebSearchConfig {
  go: GoBackendConfig
  free: FreeBackendConfig
}

export const DEFAULT_CONFIG: WebSearchConfig = {
  go: { enabled: false, protocol: 'anthropic', baseUrl: undefined, credential: undefined, model: 'deepseek-v4-flash', timeoutMs: 20_000 },
  free: {
    parallelUrl: 'https://search.parallel.ai/mcp',
    exaUrl: 'https://mcp.exa.ai/mcp',
    timeoutMs: 15_000,
    snippetMaxChars: 300,
    maxResults: 8,
  },
}

export const Config = z.object({
  go: z.object({
    enabled: z.boolean().default(false),
    protocol: z.union([...LLM_PROTOCOLS] as const).default('anthropic'),
    baseUrl: z.string().default(''),
    credential: z.string().default(''),
    model: z.string().default(DEFAULT_CONFIG.go.model!),
    timeoutMs: z.number().default(DEFAULT_CONFIG.go.timeoutMs),
  }),
  free: z.object({
    parallelUrl: z.string().default(DEFAULT_CONFIG.free.parallelUrl),
    exaUrl: z.string().default(DEFAULT_CONFIG.free.exaUrl),
    timeoutMs: z.number().default(DEFAULT_CONFIG.free.timeoutMs),
    snippetMaxChars: z.number().default(DEFAULT_CONFIG.free.snippetMaxChars),
    maxResults: z.number().default(DEFAULT_CONFIG.free.maxResults),
  }),
})

/** "" -> undefined for the optional go fields, so empty strings disable the backend. */
function normOpt(v: string | undefined): string | undefined {
  return v === undefined || v.trim().length === 0 ? undefined : v
}

export function createResolvedConfig(input: Partial<WebSearchConfig> = {}): WebSearchConfig {
  const go = { ...DEFAULT_CONFIG.go, ...(input.go ?? {}) }
  const free = { ...DEFAULT_CONFIG.free, ...(input.free ?? {}) }
  return {
    go: {
      ...go,
      baseUrl: normOpt(go.baseUrl),
      credential: normOpt(go.credential),
      model: normOpt(go.model) ?? DEFAULT_CONFIG.go.model!,
    },
    free: {
      ...free,
      parallelUrl: free.parallelUrl?.trim() || '',
      exaUrl: free.exaUrl?.trim() || '',
      timeoutMs: free.timeoutMs || DEFAULT_CONFIG.free.timeoutMs,
      snippetMaxChars: free.snippetMaxChars || DEFAULT_CONFIG.free.snippetMaxChars,
      maxResults: free.maxResults || DEFAULT_CONFIG.free.maxResults,
    },
  }
}