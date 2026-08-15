/** Real subagent seam (NON-NEGOTIABLE DESIGN RULE): delegation drives a DSH
 *  subagent with the vision model as its primary — ctx.agents.create with
 *  agentOptions {provider, model}. The image is delivered by FILEPATH inside a
 *  normal message (the subagent's own pre-step paste hook attaches it for its
 *  multimodal primary); the final assistant text is read from the derived
 *  session history; the owned handle is disposed by the caller. No attachment
 *  store, no llm.stream-with-ImageBlock, no another-agent-tool, no pi-ai
 *  internals. */
import { randomUUID } from 'node:crypto'
import type { Message, TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentHandle } from './delegate.ts'

/** Structural subset of ctx.agents.create (public DSH API) so tests inject a
 *  fake registry instead of a live loop. The real AgentRegistry satisfies it:
 *  AgentHandle.agent is an Agent (followup/whenIdle/session). */
export interface AgentsLike {
  create(options: {
    sessionId: unknown
    meta?: Record<string, unknown>
    agentOptions?: { provider?: string; model?: string }
  }): Promise<{ agent: SubagentAgentLike; dispose(): Promise<void> }>
}

/** The Agent surface this seam uses. */
export interface SubagentAgentLike {
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
  session: { deriveMessages(): Message[] }
}

/** Last assistant text in the derived history: scan from the newest message
 *  backwards, take the first assistant message that carries visible text
 *  blocks (reasoning-only / tool-only tails are skipped). */
export function lastAssistantText(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== 'assistant') continue
    const text = msg.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

/** Spawn the vision sub-agent and return the handle seam. */
export async function createVisionSubagent(
  agents: AgentsLike,
  opts: { provider: string; model: string; cwd: string },
): Promise<SubagentHandle> {
  const handle = await agents.create({
    sessionId: SessionId(`vision-${randomUUID()}`),
    meta: { cwd: opts.cwd, origin: 'subagent' },
    agentOptions: { provider: opts.provider, model: opts.model },
  })
  return {
    send: (message: UserMessage) => handle.agent.followup(message),
    whenIdle: () => handle.agent.whenIdle(),
    replyText: () => lastAssistantText(handle.agent.session.deriveMessages()),
    dispose: () => handle.dispose(),
  }
}

