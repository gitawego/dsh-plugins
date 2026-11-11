import { describe, expect, it } from 'vitest'
import { DEFAULT_COMMAND, DEFAULT_DISPLAY_NAME, DEFAULT_MODEL, Config, readConfig, resolveConfig } from '../src/config.ts'

function refs(values: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }])) as never
}

describe('resolveConfig', () => {
    it('materializes the shipped defaults without a baked-in model', () => {
        const config = resolveConfig(undefined)
        expect(config.command).toEqual([...DEFAULT_COMMAND])
        expect(config.cwd).toBe('')
        expect(config.startupTimeoutMs).toBe(15_000)
        expect(config.promptTimeoutMs).toBe(30 * 60_000)
        expect(config.idleSessionMinutes).toBe(30)
        expect(config.discoveryMinutes).toBe(10)
        expect(config.displayName).toBe(DEFAULT_DISPLAY_NAME)
        expect(config.defaultModel).toBe(DEFAULT_MODEL)
        expect(config.defaultModel).toBe('')
        expect(config.models).toEqual([])
        expect(config.agentMode).toBe('default')
        expect(config.permissionMode).toBe('ask')
        expect(config.systemPromptSuffix).toBe('')
    })

    it('accepts overrides and trims strings', () => {
        const config = resolveConfig({
            command: ['node', 'agent.mjs'],
            cwd: '  /tmp/project  ',
            startupTimeoutMs: 500,
            promptTimeoutMs: 2_000,
            idleSessionMinutes: 5,
            discoveryMinutes: 2,
            displayName: '  My Antigravity  ',
            defaultModel: ' gemini-3.8-flash ',
            agentMode: 'plan',
            permissionMode: 'deny',
            systemPromptSuffix: 'be terse',
        })
        expect(config).toMatchObject({
            command: ['node', 'agent.mjs'],
            cwd: '/tmp/project',
            startupTimeoutMs: 500,
            promptTimeoutMs: 2_000,
            idleSessionMinutes: 5,
            discoveryMinutes: 2,
            displayName: 'My Antigravity',
            defaultModel: 'gemini-3.8-flash',
            agentMode: 'plan',
            permissionMode: 'deny',
            systemPromptSuffix: 'be terse',
        })
    })

    it('normalizes only explicit model metadata and drops unusable entries', () => {
        const config = resolveConfig({
            models: [
                {
                    id: '  model-a  ',
                    name: 'Model A',
                    description: ' declared ',
                    contextWindow: 1234,
                    maxTokens: 56,
                    efforts: ['low', ' high ', ''],
                    defaultEffort: ' high ',
                },
                { id: '   ' },
                { name: 'no id' },
                { id: 'model-a', name: 'duplicate is kept in config order' },
                { id: 'model-b', contextWindow: 0, maxTokens: -1 },
            ],
        })
        expect(config.models).toEqual([
            {
                id: 'model-a',
                name: 'Model A',
                description: 'declared',
                contextWindow: 1234,
                maxTokens: 56,
                efforts: ['low', 'high'],
                defaultEffort: 'high',
            },
            { id: 'model-a', name: 'duplicate is kept in config order' },
            { id: 'model-b' },
        ])
    })

    it('filters empty command parts and falls back to agy acp', () => {
        expect(resolveConfig({ command: ['', '  '] }).command).toEqual([...DEFAULT_COMMAND])
        expect(resolveConfig({ command: ['agy', '', 'acp'] }).command).toEqual(['agy', 'acp'])
    })

    it('rejects non-positive timeouts and idle windows', () => {
        const config = resolveConfig({
            startupTimeoutMs: 0,
            promptTimeoutMs: -1,
            idleSessionMinutes: Number.NaN,
            discoveryMinutes: 0,
        })
        expect(config.startupTimeoutMs).toBe(15_000)
        expect(config.promptTimeoutMs).toBe(30 * 60_000)
        expect(config.idleSessionMinutes).toBe(30)
        expect(config.discoveryMinutes).toBe(10)
    })

    it('keeps the agent mode free-form and validates it against ACP at session setup', () => {
        expect(resolveConfig({ agentMode: '  future-mode  ' }).agentMode).toBe('future-mode')
        expect(resolveConfig({ agentMode: '   ' }).agentMode).toBe('default')
    })

    it('closes the permission vocabulary', () => {
        expect(resolveConfig({ permissionMode: 'allow' }).permissionMode).toBe('ask')
    })
})

describe('readConfig', () => {
    it('reads every volatile reference once', () => {
        const config = readConfig(
            refs({
                command: ['agy', 'acp', '--dangerously-skip-permissions'],
                cwd: '/work',
                startupTimeoutMs: 1_000,
                promptTimeoutMs: 2_000,
                idleSessionMinutes: 3,
                discoveryMinutes: 4,
                displayName: 'Configured name',
                defaultModel: '',
                models: [{ id: 'configured-model', contextWindow: 100 }],
                agentMode: 'accept-edits',
                permissionMode: 'deny',
                systemPromptSuffix: 'suffix',
            }),
        )
        expect(config.command).toEqual(['agy', 'acp', '--dangerously-skip-permissions'])
        expect(config.displayName).toBe('Configured name')
        expect(config.defaultModel).toBe('')
        expect(config.models).toEqual([{ id: 'configured-model', contextWindow: 100 }])
        expect(config.agentMode).toBe('accept-edits')
        expect(config.permissionMode).toBe('deny')
        expect(config.systemPromptSuffix).toBe('suffix')
    })

    it('exposes volatile references the settings form reads', () => {
        const parsed = Config({}) as Record<string, { get: () => unknown }>
        expect(parsed.defaultModel?.get()).toBe('')
        expect(parsed.models?.get()).toEqual([])
        expect(parsed.agentMode?.get()).toBe('default')
        expect(parsed.permissionMode?.get()).toBe('ask')
    })
})
