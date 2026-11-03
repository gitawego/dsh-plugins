import { describe, expect, it } from 'vitest'
import { DSML_TOKEN, dsmlHoldIndex, hasDsmlToolCalls, parseDsmlToolCalls, splitDsml } from '../src/dsml.ts'

/**
 * The markup that actually reached the user's session log, verbatim — fullwidth
 * bars, the space before `calls`, the trailing newline.
 */
const LEAKED =
    `<${DSML_TOKEN} calls>\n` +
    `<${DSML_TOKEN} invoke name="skill">\n` +
    `<${DSML_TOKEN} parameter name="name" string="true">cordis-plugin-development</${DSML_TOKEN} parameter>\n` +
    `</${DSML_TOKEN} invoke>\n` +
    `</${DSML_TOKEN} calls>`

describe('parseDsmlToolCalls', () => {
    it('recovers the call a leaked block describes', () => {
        expect(parseDsmlToolCalls(LEAKED)).toEqual([
            { name: 'skill', arguments: { name: 'cordis-plugin-development' } },
        ])
    })

    it('parses several invokes in one block', () => {
        const text =
            `<${DSML_TOKEN} invoke name="bash"><${DSML_TOKEN} parameter name="command" string="true">ls</${DSML_TOKEN} parameter></${DSML_TOKEN} invoke>` +
            `<${DSML_TOKEN} invoke name="read"><${DSML_TOKEN} parameter name="path" string="true">a.ts</${DSML_TOKEN} parameter></${DSML_TOKEN} invoke>`
        expect(parseDsmlToolCalls(text).map((call) => call.name)).toEqual(['bash', 'read'])
    })

    it('recovers a bare invoke when the wrapper token was dropped', () => {
        const text = `<${DSML_TOKEN} invoke name="glob"><${DSML_TOKEN} parameter name="pattern" string="true">*.ts</${DSML_TOKEN} parameter></${DSML_TOKEN} invoke>`
        expect(parseDsmlToolCalls(text)).toEqual([{ name: 'glob', arguments: { pattern: '*.ts' } }])
    })

    it('keeps a declared string verbatim, digits and whitespace included', () => {
        const text = `<${DSML_TOKEN} invoke name="write"><${DSML_TOKEN} parameter name="content" string="true">123\nline\n</${DSML_TOKEN} parameter></${DSML_TOKEN} invoke>`
        expect(parseDsmlToolCalls(text)[0]?.arguments['content']).toBe('123\nline\n')
    })

    it('parses an undeclared parameter as JSON, so arrays and objects survive', () => {
        const text = `<${DSML_TOKEN} invoke name="ask"><${DSML_TOKEN} parameter name="questions" string="false">[{"id":"q1"}]</${DSML_TOKEN} parameter><${DSML_TOKEN} parameter name="n" string="false">2</${DSML_TOKEN} parameter><${DSML_TOKEN} parameter name="ok" string="false">true</${DSML_TOKEN} parameter></${DSML_TOKEN} invoke>`
        expect(parseDsmlToolCalls(text)[0]?.arguments).toEqual({ questions: [{ id: 'q1' }], n: 2, ok: true })
    })

    it('leaves ordinary prose and markup-less text alone', () => {
        expect(parseDsmlToolCalls('just a normal answer about config.py')).toEqual([])
        expect(parseDsmlToolCalls('<invoke name="read">unclosed')).toEqual([])
    })

    it('does not replay an explanation of the markup as a phantom call', () => {
        const prose = `To call a tool the model writes <${DSML_TOKEN} invoke name="read"> and closes it with </${DSML_TOKEN} invoke>, but here I am only describing it.`
        // The tags are quoted without a closed block of parameters: no call.
        expect(hasDsmlToolCalls(prose)).toBe(false)
    })
})

describe('splitDsml', () => {
    it('separates the prose from the markup', () => {
        expect(splitDsml(`I'll load that skill.\n${LEAKED}`)).toEqual({
            text: "I'll load that skill.",
            calls: [{ name: 'skill', arguments: { name: 'cordis-plugin-development' } }],
        })
    })

    it('returns the text untouched when nothing parses', () => {
        expect(splitDsml('plain answer')).toEqual({ text: 'plain answer', calls: [] })
    })
})

describe('dsmlHoldIndex', () => {
    it('releases ordinary text immediately', () => {
        expect(dsmlHoldIndex('the answer is 42')).toBe('the answer is 42'.length)
    })

    it('withholds everything from a complete token onward', () => {
        const buffer = `prose<${DSML_TOKEN} invoke name="x">`
        expect(dsmlHoldIndex(buffer)).toBe('prose'.length)
    })

    it('withholds a token split across deltas', () => {
        const head = `prose<${DSML_TOKEN.slice(0, 3)}`
        expect(dsmlHoldIndex(head)).toBe('prose'.length)
    })

    it('withholds a lone tag opener, which may yet become a token', () => {
        expect(dsmlHoldIndex('a <')).toBe(2)
        expect(dsmlHoldIndex('a ｜')).toBe(2)
    })
})
