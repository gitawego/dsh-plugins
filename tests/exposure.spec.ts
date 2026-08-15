/** VisionGate tests: per-agent tool-visibility masking and — critically —
 *  MID-SESSION MODEL-SWITCH DETECTION. The gate must learn about a switch at
 *  `system-prompt/assemble` time (which fires BEFORE `agent/pre-step` in the
 *  same step), so the paste hook and tool-execute checks see the switched
 *  model's modality on the FIRST step — not one step late via `agent/request`.
 *
 *  The harness's model-selection machinery (`installModelSelection`) writes
 *  the selected provider/model into `PromptAssembly.variables` during the
 *  assemble waterfall; the gate's assemble listener reads those after next(). */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { VisionGate, type PrimaryModelInfo } from '../src/exposure.ts'
import { TOOL_NAME } from '../src/capability.ts'

interface FakeTools {
  restrictCalls: Array<{ deny: string[] }>
  disposeCount: number
  restrict(filter: { deny: string[] }): () => void
}

interface FakeAgent {
  id: string
  options: { provider?: string; model?: string }
  ctx: { tools: FakeTools }
  session: { header: { cwd: string } }
}

function makeAgent(id: string, options: { provider?: string; model?: string }): FakeAgent {
  const tools: FakeTools = {
    restrictCalls: [],
    disposeCount: 0,
    restrict(filter) {
      tools.restrictCalls.push(filter)
      let active = true
      return () => {
        if (!active) return
        active = false
        tools.disposeCount++
      }
    },
  }
  return {
    id,
    options,
    ctx: { tools },
    session: { header: { cwd: '/ws' } },
  }
}

type Listener = (...args: unknown[]) => unknown

class FakeCtx {
  listeners = new Map<string, Listener[]>()
  agentsList: FakeAgent[] = []
  agents = { list: () => this.agentsList }
  on(name: string, cb: Listener): () => void {
    const list = this.listeners.get(name) ?? []
    list.push(cb)
    this.listeners.set(name, list)
    let active = true
    return () => {
      if (!active) return
      active = false
      const i = list.indexOf(cb)
      if (i >= 0) list.splice(i, 1)
    }
  }
}

/** Let the gate's async seeding/update settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Run the assemble waterfall the way the harness does: the gate listener is
 *  invoked with a next() that resolves to the assembly the model-selection
 *  machinery produced (variables.provider/model already applied). */
async function runAssemble(
  ctx: FakeCtx,
  agent: FakeAgent,
  variables: Record<string, string | undefined>,
): Promise<void> {
  const listener = ctx.listeners.get('system-prompt/assemble')![0] as (
    assembly: unknown,
    context: unknown,
    next: () => Promise<{ variables: Record<string, string | undefined> }>,
  ) => Promise<unknown>
  const assembly = { sections: [], contexts: [], tools: [], variables }
  await listener(assembly, { agent }, async () => ({ ...assembly, variables }))
}

function makeGate(ctx: FakeCtx, modalities: Record<string, boolean>, enabled = true): VisionGate {
  const resolver = vi.fn(async (provider: string | undefined, model: string | undefined) => {
    if (provider === undefined || model === undefined) return { multimodal: false, imageCapable: false }
    const known = modalities[`${provider}/${model}`]
    if (known === undefined) throw new Error('unknown model')
    return { multimodal: known, imageCapable: known }
  })
  return new VisionGate(ctx as never, resolver, () => enabled)
}

function currentInfo(gate: VisionGate, agent: FakeAgent): PrimaryModelInfo | undefined {
  return gate.current(agent as unknown as Agent)
}

describe('VisionGate — seed', () => {
  it('seeds from agent options on install and masks multimodal primaries', async () => {
    const ctx = new FakeCtx()
    const luna = makeAgent('a1', { provider: 'p', model: 'luna' })
    ctx.agentsList = [luna]
    const gate = makeGate(ctx, { 'p/luna': true })
    const dispose = gate.install()
    await flush()
    try {
      expect(currentInfo(gate, luna)).toEqual({ provider: 'p', model: 'luna', multimodal: true, imageCapable: true })
      expect(luna.ctx.tools.restrictCalls).toEqual([{ deny: [TOOL_NAME] }])
    } finally {
      dispose()
    }
  })

  it('leaves text-only primaries unmasked', async () => {
    const ctx = new FakeCtx()
    const glm = makeAgent('a1', { provider: 'p', model: 'glm-5.2' })
    ctx.agentsList = [glm]
    const gate = makeGate(ctx, { 'p/glm-5.2': false })
    const dispose = gate.install()
    await flush()
    try {
      expect(currentInfo(gate, glm)?.multimodal).toBe(false)
      expect(glm.ctx.tools.restrictCalls).toEqual([])
    } finally {
      dispose()
    }
  })

  it('treats unknown models as text-only (safe default)', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'mystery' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, {})
    const dispose = gate.install()
    await flush()
    try {
      expect(currentInfo(gate, agent)?.multimodal).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe('VisionGate — mid-session model switch detection', () => {
  it('detects a switch at system-prompt/assemble time (before pre-step)', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'luna' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, { 'p/luna': true, 'p/glm-5.2': false })
    const dispose = gate.install()
    await flush()
    try {
      // Session starts on luna (multimodal): masked.
      expect(currentInfo(gate, agent)?.multimodal).toBe(true)
      expect(agent.ctx.tools.restrictCalls).toHaveLength(1)

      // User switches to glm-5.2 mid-session. The next step's assemble carries
      // the switched model in variables (written by the harness model selection).
      await runAssemble(ctx, agent, { provider: 'p', model: 'glm-5.2' })

      // The gate must already reflect the switch BEFORE pre-step runs:
      // paste hook sees text-only; the deny mask is lifted.
      expect(currentInfo(gate, agent)).toEqual({ provider: 'p', model: 'glm-5.2', multimodal: false, imageCapable: false })
      expect(agent.ctx.tools.disposeCount).toBe(1) // mask removed
    } finally {
      dispose()
    }
  })

  it('detects the reverse switch (text-only → multimodal) and re-masks', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'glm-5.2' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, { 'p/glm-5.2': false, 'p/luna': true })
    const dispose = gate.install()
    await flush()
    try {
      await runAssemble(ctx, agent, { provider: 'p', model: 'luna' })
      expect(currentInfo(gate, agent)).toEqual({ provider: 'p', model: 'luna', multimodal: true, imageCapable: true })
      expect(agent.ctx.tools.restrictCalls).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('is idempotent: same model on assemble → no mask churn', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'luna' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, { 'p/luna': true })
    const dispose = gate.install()
    await flush()
    try {
      await runAssemble(ctx, agent, { provider: 'p', model: 'luna' })
      expect(agent.ctx.tools.restrictCalls).toHaveLength(1)
      expect(agent.ctx.tools.disposeCount).toBe(0)
      expect(currentInfo(gate, agent)?.multimodal).toBe(true)
    } finally {
      dispose()
    }
  })

  it('ignores assemblies without an agent (diagnostics) and without variables', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'luna' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, { 'p/luna': true })
    const dispose = gate.install()
    await flush()
    try {
      const listener = ctx.listeners.get('system-prompt/assemble')![0] as (
        assembly: unknown, context: unknown, next: () => Promise<unknown>,
      ) => Promise<unknown>
      // No agent (diagnostic assembly): state untouched.
      await listener({ variables: { provider: 'p', model: 'glm-5.2' } }, {}, async () => ({ variables: { provider: 'p', model: 'glm-5.2' } }))
      expect(currentInfo(gate, agent)?.model).toBe('luna')
      // Agent present but no provider/model variables (agent without
      // installModelSelection): state untouched.
      await listener({ variables: {} }, { agent }, async () => ({ variables: {} }))
      expect(currentInfo(gate, agent)?.model).toBe('luna')
      expect(currentInfo(gate, agent)?.multimodal).toBe(true)
    } finally {
      dispose()
    }
  })

  it('keeps the agent/request fallback sync working after a switch', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'luna' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, { 'p/luna': true, 'p/glm-5.2': false })
    const dispose = gate.install()
    await flush()
    try {
      const requestListener = ctx.listeners.get('agent/request')![0] as (
        payload: unknown,
        next: () => Promise<{ provider: string; model: string }>,
      ) => Promise<unknown>
      const config = { provider: 'p', model: 'glm-5.2' }
      const returned = await requestListener({ agent }, async () => config)
      expect(returned).toEqual(config)
      expect(currentInfo(gate, agent)).toEqual({ provider: 'p', model: 'glm-5.2', multimodal: false, imageCapable: false })
      expect(agent.ctx.tools.disposeCount).toBe(1)
    } finally {
      dispose()
    }
  })

  it('flips the mask back when the tool is disabled via resyncAll', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'glm-5.2' })
    ctx.agentsList = [agent]
    let enabled = true
    const gate = new VisionGate(ctx as never, vi.fn(async () => ({ multimodal: false, imageCapable: false })), () => enabled)
    const dispose = gate.install()
    await flush()
    try {
      expect(agent.ctx.tools.restrictCalls).toHaveLength(0)
      enabled = false
      gate.resyncAll()
      expect(agent.ctx.tools.restrictCalls).toEqual([{ deny: [TOOL_NAME] }])
    } finally {
      dispose()
    }
  })

  it('detaches agents on dispose and tears down on install disposer', async () => {
    const ctx = new FakeCtx()
    const agent = makeAgent('a1', { provider: 'p', model: 'luna' })
    ctx.agentsList = [agent]
    const gate = makeGate(ctx, { 'p/luna': true })
    const dispose = gate.install()
    await flush()
    expect(agent.ctx.tools.restrictCalls).toHaveLength(1)
    const createdListener = ctx.listeners.get('agent/created')![0] as (payload: { agent: FakeAgent }) => void
    const disposedListener = ctx.listeners.get('agent/disposed')![0] as (payload: { agent: FakeAgent }) => void
    const second = makeAgent('a2', { provider: 'p', model: 'glm-5.2' })
    createdListener({ agent: second })
    expect(currentInfo(gate, second)).toBeDefined()
    disposedListener({ agent: second })
    expect(currentInfo(gate, second)).toBeUndefined()
    dispose()
    expect(agent.ctx.tools.disposeCount).toBe(1)
    expect(ctx.listeners.get('agent/request')?.length ?? 0).toBe(0)
  })
})
