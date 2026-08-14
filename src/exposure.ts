/** Mechanism A: per-agent tool visibility gate. describe_image is registered
 *  globally once; this class applies an agent-scoped deny mask only while the
 *  agent's primary model is multimodal (or the tool is disabled), so a wasted
 *  delegation call is structurally impossible. The mask flips only on real
 *  changes (model switch / enable toggle) — idempotent, never per-step, to
 *  keep the request prefix stable (KV-cache requirement, SPEC §18). */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { TOOL_NAME, isImageCapable } from './capability.ts'

export interface PrimaryModelInfo {
  provider: string | undefined
  model: string | undefined
  multimodal: boolean
}

interface AgentGate {
  deny?: () => void
  info: PrimaryModelInfo
}

/** Resolve the current primary model's modality for one agent. */
export type ModalityResolver = (
  provider: string | undefined,
  model: string | undefined,
  agent: Agent,
) => Promise<boolean>

export class VisionGate {
  private readonly states = new Map<Agent, AgentGate>()
  private installed = false

  constructor(
    private readonly ctx: Context,
    private readonly resolveModalities: ModalityResolver,
    private readonly enabled: () => boolean,
  ) {}

  /** Current tracked primary-model info (undefined until first request/seed). */
  current(agent: Agent): PrimaryModelInfo | undefined {
    return this.states.get(agent)?.info
  }

  install(): () => void {
    if (this.installed) throw new Error('dsh-vision: gate already installed')
    this.installed = true
    const listeners = [
      this.ctx.on('agent/created', ({ agent }) => { void this.seed(agent) }),
      this.ctx.on('agent/disposed', ({ agent }) => { this.detach(agent) }),
      // Read the authoritative per-request model from the proposed config and
      // re-sync the mask when it changed (mid-session model switches).
      this.ctx.on('agent/request', async (payload, next) => {
        const config = await next()
        const state = this.states.get(payload.agent)
        if (state !== undefined && (config.provider !== state.info.provider || config.model !== state.info.model)) {
          void this.update(payload.agent, config.provider, config.model)
        }
        return config
      }),
    ]
    for (const agent of this.ctx.agents.list()) void this.seed(agent)
    return () => {
      if (!this.installed) return
      this.installed = false
      for (const dispose of listeners.reverse()) dispose()
      for (const state of this.states.values()) state.deny?.()
      this.states.clear()
    }
  }

  private async seed(agent: Agent): Promise<void> {
    if (this.states.has(agent)) return
    const options = agent.options
    this.states.set(agent, {
      info: { provider: options?.provider, model: options?.model, multimodal: false },
    })
    await this.update(agent, options?.provider, options?.model)
  }

  private async update(agent: Agent, provider: string | undefined, model: string | undefined): Promise<void> {
    const state = this.states.get(agent)
    if (state === undefined) return
    let multimodal = false
    if (provider !== undefined && model !== undefined) {
      try {
        multimodal = await this.resolveModalities(provider, model, agent)
      } catch {
        multimodal = false // unknown → text-only (safe default)
      }
    }
    const next: PrimaryModelInfo = { provider, model, multimodal }
    if (state.info.provider === next.provider && state.info.model === next.model && state.info.multimodal === next.multimodal) {
      return // idempotent: no change → no mask churn
    }
    state.info = next
    this.resync(agent, state)
  }

  /** Apply/remove the deny mask for one agent based on current state. */
  private resync(agent: Agent, state: AgentGate): void {
    const shouldDeny = !this.enabled() || state.info.multimodal
    if (shouldDeny && state.deny === undefined) {
      state.deny = agent.ctx.tools.restrict({ deny: [TOOL_NAME] })
    } else if (!shouldDeny && state.deny !== undefined) {
      state.deny()
      state.deny = undefined
    }
  }

  /** Re-sync after an enable/disable toggle. */
  resyncAll(): void {
    for (const [agent, state] of this.states) this.resync(agent, state)
  }

  private detach(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    state.deny?.()
    this.states.delete(agent)
  }
}

/** Convenience: modality check against inputModalities (used by delegate/auto-detect). */
export function isMultimodalByModalities(modalities: readonly ModelModality[] | undefined): boolean {
  return isImageCapable(modalities)
}
