/** Capability-aware gating core — decides whether describe_image is visible to an agent.
 *  Pure predicates (unit-testable); the per-agent live state lives in exposure.ts. */
import type { ModelModality } from '@deepseek-ai/dsh-llm'

/** Stable tool name. */
export const TOOL_NAME = 'describe_image'

/** Whether the given input-modality set can process images natively.
 *  Absent (unknown) and explicit omission are treated as text-only (safe default). */
export function isImageCapable(inputModalities: readonly ModelModality[] | undefined): boolean {
  return inputModalities !== undefined && inputModalities.includes('image')
}
