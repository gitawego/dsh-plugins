import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** A `type: 'text'` content block for tool output.render. */
export function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/**
 * The canonical JSON-serializable `{ text, details }` tool output value.
 * Every member is a JsonValue so the object satisfies the open-root index
 * signature the shared output schema infers.
 */
export interface ToolOutputValue extends Record<string, JsonValue> {
  text: string
  details: Record<string, JsonValue>
}

/**
 * Build a canonical `{ text, details }` tool output. `details` is an arbitrary
 * JSON-serializable object exposed to the UI/replay; it is not model-facing
 * content.
 */
export function canonical(text: string, details: Record<string, unknown> = {}): ToolOutputValue {
  return { text, details } as unknown as ToolOutputValue
}
