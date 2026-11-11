import { describe, expect, it } from 'vitest'
import { configCatalog, sessionCatalog } from '../src/catalog.ts'
import type { AcpSessionConfigOption } from '../src/protocol.ts'

const configOptions: AcpSessionConfigOption[] = [
    {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'model-a',
        options: [
            { value: 'model-a', name: 'Model A' },
            { value: 'model-b', name: 'Model B' },
        ],
    },
    {
        id: 'thought_level',
        name: 'Thinking Level',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
        ],
    },
]

describe('sessionCatalog', () => {
    it('derives model ids, names, efforts, and the current selections from ACP', () => {
        const catalog = sessionCatalog(configOptions)
        expect(catalog.source).toBe('acp')
        expect(catalog.currentModel).toBe('model-a')
        expect(catalog.models).toEqual([
            {
                id: 'model-a',
                name: 'Model A',
                efforts: [
                    { id: 'low', name: 'Low' },
                    { id: 'medium', name: 'Medium' },
                    { id: 'high', name: 'High' },
                ],
                defaultEffort: 'medium',
            },
            {
                id: 'model-b',
                name: 'Model B',
                efforts: [
                    { id: 'low', name: 'Low' },
                    { id: 'medium', name: 'Medium' },
                    { id: 'high', name: 'High' },
                ],
                defaultEffort: 'medium',
            },
        ])
    })

    it('does not invent context windows, output caps, or descriptions', () => {
        const model = sessionCatalog(configOptions).models[0]!
        expect(model.contextWindow).toBeUndefined()
        expect(model.maxTokens).toBeUndefined()
        expect(model.description).toBeUndefined()
    })

    it('leaves efforts empty when ACP advertises no thought-level option', () => {
        const catalog = sessionCatalog(configOptions.slice(0, 1))
        expect(catalog.models[0]?.efforts).toEqual([])
        expect(catalog.models[0]?.defaultEffort).toBeUndefined()
    })

    it('returns an empty catalog when ACP advertises no model option', () => {
        expect(sessionCatalog([])).toEqual({ source: 'acp', models: [] })
    })

    it('uses a current-only effort value as the sole vocabulary entry', () => {
        const catalog = sessionCatalog([
            configOptions[0]!,
            { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'only' },
        ])
        expect(catalog.models[0]?.efforts).toEqual([{ id: 'only', name: 'only' }])
        expect(catalog.models[0]?.defaultEffort).toBe('only')
    })
})

describe('configCatalog', () => {
    it('uses only declared metadata and preserves the configured default model', () => {
        const catalog = configCatalog(
            [
                {
                    id: 'model-a',
                    name: 'Model A',
                    description: 'declared',
                    contextWindow: 1234,
                    maxTokens: 56,
                    efforts: ['low', 'high'],
                    defaultEffort: 'high',
                },
                { id: 'model-b' },
            ],
            'model-b',
        )
        expect(catalog).toEqual({
            source: 'config',
            currentModel: 'model-b',
            models: [
                {
                    id: 'model-a',
                    name: 'Model A',
                    description: 'declared',
                    contextWindow: 1234,
                    maxTokens: 56,
                    efforts: [
                        { id: 'low', name: 'low' },
                        { id: 'high', name: 'high' },
                    ],
                    defaultEffort: 'high',
                },
                {
                    id: 'model-b',
                    name: 'model-b',
                    efforts: [],
                },
            ],
        })
    })

    it('does not invent context or efforts for a bare configured model', () => {
        const model = configCatalog([{ id: 'bare' }]).models[0]!
        expect(model.name).toBe('bare')
        expect(model.contextWindow).toBeUndefined()
        expect(model.maxTokens).toBeUndefined()
        expect(model.efforts).toEqual([])
        expect(model.defaultEffort).toBeUndefined()
    })

    it('drops blank and duplicate ids and ignores non-positive capacities', () => {
        const catalog = configCatalog([
            { id: '   ' },
            { id: 'dup', name: 'first' },
            { id: 'dup', name: 'second' },
            { id: 'zero', contextWindow: 0, maxTokens: -1 },
        ])
        expect(catalog.models.map((model) => model.id)).toEqual(['dup', 'zero'])
        expect(catalog.models[0]?.name).toBe('first')
        expect(catalog.models[1]?.contextWindow).toBeUndefined()
        expect(catalog.models[1]?.maxTokens).toBeUndefined()
    })

    it('returns an empty catalog for an empty configuration', () => {
        expect(configCatalog([])).toEqual({ source: 'config', models: [] })
    })
})
