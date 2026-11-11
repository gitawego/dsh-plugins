/**
 * Opt-in real-CLI smoke test.
 *
 * The default suite never touches the network or a user's Antigravity login.
 * Run this one explicitly when you need proof that the installed `agy` still
 * speaks the protocol this adapter implements:
 *
 *   DSH_AGY_E2E=1 pnpm --filter @gitawego/dsh-llm-agy test
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { AgyAdapter } from '../src/adapter.ts'
import { silentLogger } from '../src/acp-session.ts'
import { resolveConfig } from '../src/config.ts'

const enabled = process.env.DSH_AGY_E2E === '1'
const dirs: string[] = []
const adapters: AgyAdapter[] = []

afterEach(async () => {
    for (const adapter of adapters.splice(0)) await adapter.dispose()
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!enabled)('real agy acp', () => {
    it(
        'answers one prompt and returns usage',
        async () => {
            const dir = await mkdtemp(join(tmpdir(), 'dsh-agy-e2e-'))
            dirs.push(dir)
            const adapter = new AgyAdapter({
                host: {
                    logger: silentLogger,
                    resolveCwd: () => dir,
                    readImage: async () => ({ data: '', mimeType: 'image/png' }),
                    requestApproval: async () => 'rejected',
                },
                config: () =>
                    resolveConfig({
                        command: ['agy', 'acp'],
                        startupTimeoutMs: 30_000,
                        promptTimeoutMs: 180_000,
                        idleSessionMinutes: 1,
                        defaultModel: 'gemini-4-argon',
                        agentMode: 'default',
                        permissionMode: 'deny',
                    }),
            })
            adapters.push(adapter)
            const chunks = []
            for await (const chunk of adapter.stream({
                provider: 'agy',
                model: 'gemini-4-argon',
                messages: [
                    createUserMessage({
                        content: [{ type: 'text', text: 'Reply with exactly: REAL_OK' }],
                        source: { kind: 'user' },
                    }),
                ],
                sessionId: SessionId('e2e-real-check'),
            })) {
                chunks.push(chunk)
            }
            const text = chunks
                .filter((chunk) => chunk.type === 'text-delta')
                .map((chunk) => chunk.text)
                .join('')
            expect(text.trim()).toBe('REAL_OK')
            expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(true)
            expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
        },
        180_000,
    )
})
