/** describe_image tool definition. The schema is a compile-time constant —
 *  registered once, never rebuilt on config changes (KV-cache, SPEC §18). */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { VisionGate } from './exposure.ts'
import type { ResolvedVisionConfig, ReasoningLevel } from './config.ts'
import { MAX_BATCH_IMAGES, REASONING_LEVELS } from './config.ts'
import { delegateToVisionModel, type CreateSubagent, type DelegateDeps } from './delegate.ts'
import { mapWithConcurrency } from './batch.ts'
import { buildBatchToolResult, type BatchImageOutcome } from './marker.ts'
import type { VisionCache } from './cache.ts'

/** Tool dependencies wired by index.ts (live config + harness services). */
export interface DescribeImageDeps {
  config: () => ResolvedVisionConfig
  gate: VisionGate
  cache: () => VisionCache | undefined
  home: string
  resolveCredential: (ref: CredentialRef) => Promise<{ value: string } | undefined>
  /** DESIGN RULE: spawn the vision-model DSH subagent (public API). */
  createSubagent: CreateSubagent
  lifecycleSignal?: AbortSignal
}

/** Schema-tolerant path normalization (pi-vision port): accepts string or
 *  string[] for both image_path and image_paths; merges image_paths first. */
export function normalizeImagePaths(params: {
  image_path?: string | string[]
  image_paths?: string | string[]
}): string[] {
  const coerce = (v: string | string[] | undefined): string[] => {
    if (v === undefined) return []
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
    if (typeof v !== 'string') return []
    const s = v.trim()
    if (s === '') return []
    // Some models send arrays as a JSON string — coerce that.
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s) as unknown
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        /* not JSON — treat as a single path */
      }
    }
    return [s]
  }
  const merged = [...coerce(params.image_paths), ...coerce(params.image_path)]
  return [...new Set(merged.filter((p) => p.length > 0))]
}

/** The one visible tool. */
export function createDescribeImageTool(deps: DescribeImageDeps) {
  return defineTool({
    name: 'describe_image',
    description: 'Analyze one or more image files and return text descriptions or answer questions about them. '
      + 'Delegates to a configured vision model when the active primary model cannot process images natively. '
      + 'Accepts file paths, data: URLs, or raw base64. For multiple images (comparison, cross-reference), pass image_paths (up to 50). '
      + 'All paths are resolved against the session workspace.',
    parameters: {
      image_path: { type: 'string', description: 'Path to a single image file, a data: URL, or raw base64. Use this for one image.' },
      image_paths: { type: 'array', items: { type: 'string' }, description: 'Multiple image paths/data URLs/base64 strings to analyze together. Up to 50.' },
      prompt: { type: 'string', required: true, description: 'What to analyze, extract, or answer about the image(s).' },
      compress: { type: 'boolean', description: 'Optimize (resize + re-encode) the image(s) before delegation. Default true.' },
      reasoning: { type: 'string', enum: [...REASONING_LEVELS], description: 'Reasoning effort for the delegation call(s).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', required: true },
          details: {
            type: 'object',
            additionalProperties: true,
            properties: {
              mode: { type: 'string' },
              transport: { type: 'string' },
              model: { type: 'string' },
              cached: { type: 'boolean' },
              fallback: { type: 'boolean' },
              error: { type: 'string' },
              batch: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => {
      const paths = (Array.isArray(args.image_paths) ? args.image_paths : [])
        .concat(args.image_path !== undefined ? [args.image_path] : [])
        .filter((p): p is string => typeof p === 'string')
      return {
        card: 'generic',
        title: paths.length > 1 ? `Analyze ${paths.length} images` : `Inspect ${paths[0] ?? 'image'}`,
        kind: 'read',
        locations: paths.map((path) => ({ path })),
      }
    },
    async execute(args: DescribeImageArgs, exec): Promise<DescribeImageValue> {
      const config = deps.config()
      if (exec.agent === undefined) throw new Error('describe_image requires an agent session')
      const signal = deps.lifecycleSignal === undefined ? exec.signal : AbortSignal.any([exec.signal, deps.lifecycleSignal])

      // Mechanism-A defense in depth: a multimodal primary never needs this tool.
      const primary = deps.gate.current(exec.agent)
      if (primary?.multimodal) {
        const id = primary.provider && primary.model ? `${primary.provider}/${primary.model}` : 'unknown'
        return {
          text: `The active primary model (${id}) can process images natively. Reference the image path in your message and respond directly — no delegation needed.`,
          details: { mode: 'passthrough_redirect', model: id } as Record<string, JsonValue>,
        }
      }

      const paths = normalizeImagePaths(args)
      if (paths.length === 0) {
        throw new Error('describe_image requires image_path or image_paths (got neither).')
      }
      if (paths.length > MAX_BATCH_IMAGES) {
        throw new Error(`describe_image received ${paths.length} images; the batch cap is ${MAX_BATCH_IMAGES}. Split across multiple calls.`)
      }

      const reasoning = (args.reasoning ?? config.defaultReasoningEffort) as ReasoningLevel
      const compress = args.compress ?? true
      const workspace = exec.agent?.session.header.cwd ?? process.cwd()

      const delegateDeps: DelegateDeps = {
        config,
        home: deps.home,
        workspace,
        resolveCredential: deps.resolveCredential,
        createSubagent: deps.createSubagent,
        signal,
        cache: deps.cache(),
      }

      // Single-image back-compat path.
      if (paths.length === 1) {
        const result = await delegateToVisionModel(delegateDeps, { image_path: paths[0]!, prompt: args.prompt, compress, reasoning })
        if (result.ok) {
          return { text: result.text, details: { mode: 'delegate', ...result.details } as Record<string, JsonValue> }
        }
        throw new Error(result.error.message)
      }

      // Batch path: parallel, bounded by batchConcurrency, per-image resilience.
      const batchResults = await mapWithConcurrency(paths, config.batchConcurrency, async (p): Promise<BatchImageOutcome> => {
        try {
          const r = await delegateToVisionModel(delegateDeps, { image_path: p, prompt: args.prompt, compress, reasoning })
          if (r.ok) {
            const outcome: BatchImageOutcome = { ok: true, text: r.text, cached: r.details.cached, fallback: r.details.fallback }
            return outcome
          }
          return { ok: false, errorCode: r.error.code, message: r.error.message }
        } catch (err) {
          return { ok: false, errorCode: 'unexpected', message: err instanceof Error ? err.message : String(err) }
        }
      }, signal)

      const text = buildBatchToolResult(paths, batchResults)
      const allFailed = batchResults.every((r) => !r.ok)
      if (allFailed) {
        throw new Error(text)
      }
      return {
        text,
        details: {
          mode: 'delegate-batch',
          batch: batchResults.map((r, i) => ({
            index: i,
            path: paths[i]!,
            ok: r.ok,
            cached: r.ok ? r.cached : false,
            fallback: r.ok ? r.fallback : false,
            ...(r.ok ? {} : { errorCode: r.errorCode }),
          })) as JsonValue[],
        },
      }
    },
  })
}

/** Canonical describe_image output value (matches the declared output schema). */
export type DescribeImageValue = {
  text: string
  details: Record<string, JsonValue>
}

export interface DescribeImageArgs {
  image_path?: string
  image_paths?: string[]
  prompt: string
  compress?: boolean
  reasoning?: string
}

export type { ToolRunContext }
