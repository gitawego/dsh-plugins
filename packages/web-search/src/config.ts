/**
 * Configuration for the enhanced web search provider. Persisted in the DSH
 * Settings document under the `web-search-enhanced` namespace via ctx.settings.
 * `llm.credential` is a DSH credential-ref NAME (never a literal secret).
 */
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { BUILTIN_MCP_SERVERS, type McpServerEntry } from './mcp-servers.ts'

export { BUILTIN_MCP_SERVERS, type BuiltinMcpServer, type McpServerEntry } from './mcp-servers.ts'

/** Settings namespace key. Spelled as a plain literal: the seam's
 *  `SettingsNamespace` brand is applied by `ctx.settings.register`'s generic,
 *  and `settingsNamespace()` (the old rc.7 helper) no longer exists. */
export const WEB_SEARCH_SETTINGS_NAMESPACE = 'web-search-enhanced'

export const LLM_PROTOCOLS = ['anthropic', 'openai'] as const
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number]

export interface LlmBackendConfig {
  enabled: boolean
  protocol: LlmProtocol
  baseUrl: string | undefined
  credential: string | undefined
  model: string | undefined
  timeoutMs: number
}

export interface FreeBackendConfig {
  /** Credential-reference name for the Parallel token; undefined = anonymous. */
  parallelCredential: string | undefined
  /** Credential-reference name for the Exa token; undefined = anonymous. */
  exaCredential: string | undefined
  /** Servers the user added; tried after the shipped ones, in this order. */
  servers: McpServerEntry[]
  timeoutMs: number
  snippetMaxChars: number
  maxResults: number
}

export interface WebSearchConfig {
  llm: LlmBackendConfig
  free: FreeBackendConfig
}

export const DEFAULT_CONFIG: WebSearchConfig = {
  llm: { enabled: false, protocol: 'anthropic', baseUrl: undefined, credential: undefined, model: 'deepseek-v4.1-flash', timeoutMs: 20_000 },
  free: {
    // Both shipped endpoints are free anonymously; a token raises the limits.
    parallelCredential: undefined,
    exaCredential: undefined,
    servers: [],
    timeoutMs: 15_000,
    snippetMaxChars: 300,
    maxResults: 8,
  },
}

export const Config: Schema<WebSearchConfig> = z.object({
  llm: z.object({
    enabled: z.boolean().default(false),
    protocol: z.union([...LLM_PROTOCOLS] as const).default('anthropic'),
    baseUrl: z.string().default(''),
    credential: z.string().default(''),
    model: z.string().default(DEFAULT_CONFIG.llm.model!),
    timeoutMs: z.number().default(DEFAULT_CONFIG.llm.timeoutMs),
  }),
  free: z.object({
    parallelCredential: z.string().default(''),
    exaCredential: z.string().default(''),
    servers: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          url: z.string(),
          credential: z.string(),
          tool: z.string(),
        }),
      )
      .default([]),
    timeoutMs: z.number().default(DEFAULT_CONFIG.free.timeoutMs),
    snippetMaxChars: z.number().default(DEFAULT_CONFIG.free.snippetMaxChars),
    maxResults: z.number().default(DEFAULT_CONFIG.free.maxResults),
  }),
})

/** "" -> undefined for the optional llm fields, so empty strings disable the backend. */
function normOpt(v: string | undefined): string | undefined {
  return v === undefined || v.trim().length === 0 ? undefined : v
}

export function createResolvedConfig(input: Partial<WebSearchConfig> = {}): WebSearchConfig {
  const llm = { ...DEFAULT_CONFIG.llm, ...(input.llm ?? {}) }
  const free = { ...DEFAULT_CONFIG.free, ...(input.free ?? {}) }
  return {
    llm: {
      ...llm,
      baseUrl: normOpt(llm.baseUrl),
      credential: normOpt(llm.credential),
      model: normOpt(llm.model) ?? DEFAULT_CONFIG.llm.model!,
    },
    free: {
      ...free,
      parallelCredential: normOpt(free.parallelCredential),
      exaCredential: normOpt(free.exaCredential),
      servers: (free.servers ?? []).filter((entry) => entry.url.trim().length > 0).map((entry) => ({
        ...entry,
        label: entry.label.trim() || entry.url.trim(),
        url: entry.url.trim(),
        credential: entry.credential.trim(),
        tool: entry.tool.trim() || 'web_search',
      })),
      timeoutMs: free.timeoutMs || DEFAULT_CONFIG.free.timeoutMs,
      snippetMaxChars: free.snippetMaxChars || DEFAULT_CONFIG.free.snippetMaxChars,
      maxResults: free.maxResults || DEFAULT_CONFIG.free.maxResults,
    },
  }
}