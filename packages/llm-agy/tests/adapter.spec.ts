import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
    ReasoningEffortId,
    createAssistantMessage,
    createSystemMessage,
    createUserMessage,
    type GenerateOptions,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { AgyAdapter, type AgyHost } from '../src/adapter.ts'
import { silentLogger } from '../src/acp-session.ts'
import { resolveConfig, type ResolvedAgyConfig } from '../src/config.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
const ENV_KEYS = [
    'FAKE_AGY_ECHO',
    'FAKE_AGY_NO_TEXT',
    'FAKE_AGY_PERMISSION',
    'FAKE_AGY_PROMPT_ERROR',
    'FAKE_AGY_AUTH_ERROR',
    'FAKE_AGY_COUNT_FILE',
    'FAKE_AGY_SLOW_MS',
    'FAKE_AGY_CANCEL',
    'FAKE_AGY_NO_USAGE',
] as const

const adapters: AgyAdapter[] = []
const dirs: string[] = []

afterEach(async () => {
    for (const adapter of adapters.splice(0)) await adapter.dispose()
    for (const key of ENV_KEYS) delete process.env[key]
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-'))
    dirs.push(dir)
    return dir
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const [key, value] of Object.entries(values)) process.env[key] = value
}

function config(overrides: Partial<ResolvedAgyConfig> = {}): ResolvedAgyConfig {
    return resolveConfig({
        command: [process.execPath, FIXTURE],
        startupTimeoutMs: 5_000,
        promptTimeoutMs: 5_000,
        idleSessionMinutes: 1,
        ...overrides,
    })
}

interface ApprovalCall {
    toolName: string
    callId?: string
    reason?: string
    sessionId?: string
}

function host(cwd: string, outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once') {
    const calls: ApprovalCall[] = []
    const value: AgyHost = {
        logger: silentLogger,
        resolveCwd: () => cwd,
        readImage: async () => ({ data: '', mimeType: 'image/png' }),
        requestApproval: async (input) => {
            calls.push({ toolName: input.toolName, callId: input.callId, reason: input.reason, sessionId: input.sessionId })
            return outcome
        },
    }
    return { host: value, calls }
}

function makeAdapter(cwd: string, overrides: Partial<ResolvedAgyConfig> = {}, approval = host(cwd)) {
    const adapter = new AgyAdapter({ host: approval.host, config: () => config(overrides) })
    adapters.push(adapter)
    return { adapter, approval }
}

function user(text: string) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(text: string) {
    return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'agy', model: 'gemini-4-argon' } })
}

function options(
    messages: GenerateOptions['messages'],
    overrides: Partial<GenerateOptions> = {},
): GenerateOptions {
    return {
        provider: 'agy',
        model: 'gemini-4-argon',
        messages,
        sessionId: SessionId('sess-test'),
        ...overrides,
    }
}

async function collect(adapter: AgyAdapter, input: GenerateOptions): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(input)) chunks.push(chunk)
    return chunks
}

async function counts(path: string): Promise<{
    newCount: number
    promptCount: number
    lastPrompt: string
    lastNew: Record<string, unknown>
    model: string
    thought: string
    mode: string
}> {
    return JSON.parse(await readFile(path, 'utf8')) as never
}

describe('AgyAdapter streaming (integration vs fake ACP agent)', () => {
    it('maps reasoning, text, usage, and finish, and sends cwd + system via session/new', async () => {
        const dir = await tempDir()
        const countFile = join(dir, 'counts.json')
        setEnv({ FAKE_AGY_COUNT_FILE: countFile })
        const { adapter } = makeAdapter(dir)
        const chunks = await collect(
            adapter,
            options([createSystemMessage('You are a test.'), user('hello')]),
        )

        expect(chunks.map((chunk) => chunk.type)).toEqual([
            'block-start',
            'reasoning-delta',
            'block-end',
            'block-start',
            'text-delta',
            'block-end',
            'usage',
            'finish',
        ])
        expect(chunks.find((chunk) => chunk.type === 'text-delta')).toEqual({ type: 'text-delta', index: 1, text: 'PONG' })
        expect(chunks.find((chunk) => chunk.type === 'usage')).toEqual({
            type: 'usage',
            usage: { inputTokens: 27, outputTokens: 12, totalTokens: 42, cacheReadTokens: 3, reasoningTokens: 4 },
        })
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

        const recorded = await counts(countFile)
        expect(recorded.newCount).toBe(1)
        expect(recorded.promptCount).toBe(1)
        expect(recorded.lastPrompt).toBe('User: hello')
        expect(recorded.lastNew.cwd).toBe(dir)
        expect(recorded.lastNew._meta).toEqual({ antigravity: { systemPrompt: { append: 'You are a test.' } } })
    })

    it('sends only the new turn through one persistent ACP session', async () => {
        const dir = await tempDir()
        const countFile = join(dir, 'counts.json')
        setEnv({ FAKE_AGY_COUNT_FILE: countFile, FAKE_AGY_ECHO: '1' })
        const { adapter } = makeAdapter(dir)

        const first = user('one')
        await collect(adapter, options([first]))
        const second = user('two')
        const chunks = await collect(adapter, options([first, assistant('first answer'), second]))
        const text = chunks.find((chunk) => chunk.type === 'text-delta')
        expect(text).toEqual({ type: 'text-delta', index: 1, text: 'User: two' })

        const recorded = await counts(countFile)
        expect(recorded.newCount).toBe(1)
        expect(recorded.promptCount).toBe(2)
        expect(recorded.lastPrompt).toBe('User: two')
    })

    it('replays the transcript into a new ACP server after the account epoch changes', async () => {
        const dir = await tempDir()
        const firstCount = join(dir, 'first.json')
        const secondCount = join(dir, 'second.json')
        const epoch = { value: 0 }
        const approval = host(dir)
        const adapter = new AgyAdapter({
            host: approval.host,
            config: () => config(),
            accountEpoch: () => epoch.value,
        })
        adapters.push(adapter)
        setEnv({ FAKE_AGY_COUNT_FILE: firstCount, FAKE_AGY_ECHO: '1' })

        const first = user('one')
        await collect(adapter, options([first]))
        epoch.value = 1
        setEnv({ FAKE_AGY_COUNT_FILE: secondCount })
        await collect(adapter, options([first, assistant('first answer'), user('two')]))

        expect((await counts(firstCount)).newCount).toBe(1)
        expect((await counts(secondCount)).newCount).toBe(1)
    })

    it('opens a separate ACP session for a different DSH session', async () => {
        const dir = await tempDir()
        const firstCount = join(dir, 'first.json')
        const secondCount = join(dir, 'second.json')
        const { adapter } = makeAdapter(dir)
        setEnv({ FAKE_AGY_COUNT_FILE: firstCount })
        await collect(adapter, options([user('one')], { sessionId: SessionId('sess-a') }))
        setEnv({ FAKE_AGY_COUNT_FILE: secondCount })
        await collect(adapter, options([user('two')], { sessionId: SessionId('sess-b') }))
        expect((await counts(firstCount)).newCount).toBe(1)
        expect((await counts(secondCount)).newCount).toBe(1)
    })

    it('prepends a system update when the prompt changes mid-session', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_ECHO: '1' })
        const { adapter } = makeAdapter(dir)
        await collect(adapter, options([createSystemMessage('first rules'), user('one')]))
        const chunks = await collect(adapter, options([createSystemMessage('second rules'), user('two')]))
        const text = chunks.find((chunk) => chunk.type === 'text-delta')
        expect(text).toMatchObject({ type: 'text-delta' })
        if (text?.type !== 'text-delta') throw new Error('missing text')
        expect(text.text.startsWith('[Updated system instructions]\nsecond rules')).toBe(true)
    })

    it('does not emit a usage chunk when the agent omits usage', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_NO_USAGE: '1' })
        const { adapter } = makeAdapter(dir)
        const chunks = await collect(adapter, options([user('hello')]))
        expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(false)
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    })

    it('reconfigures a live session when the selected model changes', async () => {
        const dir = await tempDir()
        const countFile = join(dir, 'counts.json')
        setEnv({ FAKE_AGY_COUNT_FILE: countFile })
        const { adapter } = makeAdapter(dir)
        await collect(adapter, options([user('one')]))
        await collect(adapter, options([user('two')], { model: 'gemini-3.8-flash' }))
        const recorded = await counts(countFile)
        expect(recorded.newCount).toBe(1)
        expect(recorded.promptCount).toBe(2)
        expect(recorded.model).toBe('gemini-3.8-flash')
        expect(recorded.lastPrompt).toBe('User: two')
    })

    it('recreates the ACP session when the working directory changes', async () => {
        const firstDir = await tempDir()
        const secondDir = await tempDir()
        const firstCount = join(firstDir, 'first.json')
        const secondCount = join(secondDir, 'second.json')
        let cwd = firstDir
        const calls: ApprovalCall[] = []
        const customHost: AgyHost = {
            logger: silentLogger,
            resolveCwd: () => cwd,
            readImage: async () => ({ data: '', mimeType: 'image/png' }),
            requestApproval: async (input) => {
                calls.push({ toolName: input.toolName })
                return 'allowed-once'
            },
        }
        const { adapter } = makeAdapter(firstDir, {}, { host: customHost, calls })
        setEnv({ FAKE_AGY_COUNT_FILE: firstCount })
        const first = user('one')
        await collect(adapter, options([first]))
        cwd = secondDir
        setEnv({ FAKE_AGY_COUNT_FILE: secondCount })
        await collect(adapter, options([first, assistant('answer'), user('two')]))
        expect((await counts(firstCount)).newCount).toBe(1)
        expect((await counts(secondCount)).newCount).toBe(1)
        expect((await counts(secondCount)).lastPrompt).toContain('User: one')
        expect((await counts(secondCount)).lastPrompt).toContain('User: two')
    })

    it('selects the requested model and thought level', async () => {
        const dir = await tempDir()
        const countFile = join(dir, 'counts.json')
        setEnv({ FAKE_AGY_COUNT_FILE: countFile })
        const { adapter } = makeAdapter(dir)
        await collect(
            adapter,
            options([user('hello')], {
                model: 'gemini-3.8-flash',
                reasoningEffort: ReasoningEffortId('high'),
            }),
        )
        const recorded = await counts(countFile)
        expect(recorded.model).toBe('gemini-3.8-flash')
        expect(recorded.thought).toBe('high')
    })
})

describe('AgyAdapter permissions', () => {
    it('bridges an allow_once request to the harness approval service', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_PERMISSION: '1' })
        const { adapter, approval } = makeAdapter(dir)
        const chunks = await collect(adapter, options([user('write it')]))
        expect(chunks.find((chunk) => chunk.type === 'text-delta')).toMatchObject({ type: 'text-delta', text: 'PERMISSION allow-once' })
        expect(approval.calls).toHaveLength(1)
        expect(approval.calls[0]).toMatchObject({
            toolName: 'Write a file',
            callId: 'tc_1',
            reason: 'Write a file (edit)',
        })
    })

    it('returns the reject option when the user rejects', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_PERMISSION: '1' })
        const { adapter } = makeAdapter(dir, {}, host(dir, 'rejected'))
        const chunks = await collect(adapter, options([user('write it')]))
        expect(chunks.find((chunk) => chunk.type === 'text-delta')).toMatchObject({ type: 'text-delta', text: 'PERMISSION reject-once' })
    })

    it('cancels without consulting approval when permissionMode is deny', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_PERMISSION: '1' })
        const { adapter, approval } = makeAdapter(dir, { permissionMode: 'deny' })
        const chunks = await collect(adapter, options([user('write it')]))
        expect(chunks.find((chunk) => chunk.type === 'text-delta')).toMatchObject({ type: 'text-delta', text: 'PERMISSION cancelled' })
        expect(approval.calls).toHaveLength(0)
    })

    it('fails closed when approval is unavailable', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_PERMISSION: '1' })
        const { adapter } = makeAdapter(dir, {}, host(dir, 'unavailable'))
        const chunks = await collect(adapter, options([user('write it')]))
        expect(chunks.find((chunk) => chunk.type === 'text-delta')).toMatchObject({ type: 'text-delta', text: 'PERMISSION cancelled' })
    })
})

describe('AgyAdapter failures', () => {
    it('classifies a login failure as AUTH with remediation', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_AUTH_ERROR: '1' })
        const { adapter } = makeAdapter(dir)
        await expect(collect(adapter, options([user('hello')]))).rejects.toMatchObject({ code: 'AUTH' })
    })

    it('classifies an empty completion as EMPTY_RESPONSE', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_NO_TEXT: '1' })
        const { adapter } = makeAdapter(dir)
        await expect(collect(adapter, options([user('hello')]))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    })

    it('classifies a JSON-RPC prompt failure as ACP_ERROR', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_PROMPT_ERROR: '1' })
        const { adapter } = makeAdapter(dir)
        await expect(collect(adapter, options([user('hello')]))).rejects.toMatchObject({ code: 'ACP_ERROR' })
    })

    it('cancels an aborted turn and drops the session', async () => {
        const dir = await tempDir()
        setEnv({ FAKE_AGY_SLOW_MS: '5000', FAKE_AGY_CANCEL: '1' })
        const { adapter } = makeAdapter(dir)
        const controller = new AbortController()
        const promise = collect(adapter, options([user('slow')], { signal: controller.signal }))
        setTimeout(() => controller.abort(), 50)
        await expect(promise).rejects.toMatchObject({ code: 'ABORTED' })
    })

    it('rejects an unknown model without prompting', async () => {
        const dir = await tempDir()
        const { adapter } = makeAdapter(dir)
        await expect(collect(adapter, options([user('hello')], { model: 'nope' }))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    })

    it('closes a transient purpose session after the turn', async () => {
        const dir = await tempDir()
        const titleCount = join(dir, 'title.json')
        const chatCount = join(dir, 'chat.json')
        const { adapter } = makeAdapter(dir)
        setEnv({ FAKE_AGY_COUNT_FILE: titleCount })
        await collect(adapter, options([user('title this')], { purpose: 'title' as never }))
        setEnv({ FAKE_AGY_COUNT_FILE: chatCount })
        await collect(adapter, options([user('chat')]))
        expect((await counts(titleCount)).newCount).toBe(1)
        expect((await counts(chatCount)).newCount).toBe(1)
    })
})

describe('AgyAdapter catalog', () => {
    it('discovers the route models from ACP session/new', async () => {
        const dir = await tempDir()
        const { adapter } = makeAdapter(dir)
        const models = await adapter.listModels('agy')
        expect(models).toHaveLength(5)
        expect(models[0]).toMatchObject({
            provider: 'agy',
            id: 'gemini-4-argon',
            name: 'Gemini 4 Argon',
            inputModalities: ['text', 'image'],
        })
        expect(models.map((model) => model.id)).toEqual([
            'gemini-4-argon',
            'gemini-3.8-flash',
            'claude-opus-5-5',
            'claude-sonnet-5-5',
            'gpt-oss-120b-medium',
        ])
        expect(await adapter.listModels('other')).toEqual([])
    })

    it('resolves only metadata ACP actually advertises', async () => {
        const dir = await tempDir()
        const { adapter } = makeAdapter(dir)
        const resolved = await adapter.resolveModel('agy', 'gemini-4-argon')
        expect(resolved.context).toBeUndefined()
        expect(resolved.defaultMaxTokens).toBeUndefined()
        expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high'])
        expect(resolved.reasoning?.defaultEffort).toBe('medium')
        await expect(adapter.resolveModel('agy', 'nope')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
        await expect(adapter.resolveModel('other', 'gemini-4-argon')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    })

    it('uses the explicit config catalog without spawning ACP', async () => {
        const dir = await tempDir()
        const countFile = join(dir, 'counts.json')
        setEnv({ FAKE_AGY_COUNT_FILE: countFile })
        const { adapter } = makeAdapter(dir, {
            models: [
                {
                    id: 'declared-model',
                    name: 'Declared Model',
                    description: 'from config',
                    contextWindow: 321,
                    maxTokens: 123,
                    efforts: ['earnest', 'deep'],
                    defaultEffort: 'deep',
                },
            ],
        })
        const models = await adapter.listModels('agy')
        expect(models).toEqual([
            {
                provider: 'agy',
                id: 'declared-model',
                name: 'Declared Model',
                description: 'from config',
                inputModalities: ['text', 'image'],
            },
        ])
        const resolved = await adapter.resolveModel('agy', 'declared-model')
        expect(resolved.context).toEqual({ contextWindow: 321 })
        expect(resolved.defaultMaxTokens).toBe(123)
        expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['earnest', 'deep'])
        expect(resolved.reasoning?.defaultEffort).toBe('deep')
        await expect(readFile(countFile, 'utf8')).rejects.toThrow()
    })
})
