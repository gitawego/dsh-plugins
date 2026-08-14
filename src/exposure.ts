/** Mechanism A: per-agent tool visibility gate. describe_image is registered
 *  globally once; this class applies an agent-scoped deny mask only while the
 *  agent's primary model is multimodal (or the tool is disabled), so a wasted
 *  delegation call is structurally impossible. The mask flips only on real
 *  changes (model switch / enable toggle) — idempotent, never per-step, to
 *  keep the request prefix stable (KV-cache requirement, SPEC §18).
 *
 *  MID-SESSION MODEL-SWITCH DETECTION: a step's lifecycle is
 *  system-prompt/assemble → agent/pre-step → agent/request. The harness's
 *  model-selection machinery (installModelSelection) writes the selected
 *  provider/model into the assembled variables BEFORE pre-step, so the gate
 *  syncs from system-prompt/assemble — the earliest point in the step — and
 *  the paste hook / tool-execute checks read the switched model's modality on
 *  the FIRST step, not one step late. agent/request remains as a fallback
 *  sync for agents without installModelSelection. Both updates are idempotent
 *  (no-op on unchanged provider/model → zero hot-path mask churn). */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
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
      // EARLIEST switch detection: the model-selection machinery writes the
      // selected provider/model into the assembled variables during this
      // waterfall, and pre-step (paste routing) runs AFTER assembly in the
      // same step — so awaiting the modality resolve here makes the paste
      // hook and the tool-execute check see the switched model immediately.
      // Awaited only on an actual provider/model change (idempotent no-op
      // otherwise → no hot-path blocking, no mask churn).
      this.ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context: AssembleContext, next) => {
        const resolved = await next()
        const agent = context?.agent
        if (agent !== undefined) {
          const provider = resolved.variables?.provider
          const model = resolved.variables?.model
          if (provider !== undefined && model !== undefined) {
            await this.update(agent, provider, model)
          }
        }
        return resolved
      }),
      // Fallback sync: read the authoritative per-request model from the
      // proposed config (covers agents without installModelSelection, whose
      // assemblies carry no provider/model variables).
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
