/**
 * Recovery for DeepSeek tool calls that arrive as markup instead of `tool_calls`.
 *
 * DeepSeek V3.2/V4 lanes describe a tool call in DSML — a tag dialect wrapped in
 * the `｜｜DSML｜｜` token (U+FF5C fullwidth bars) — and the serving lane is supposed
 * to parse that into structured `tool_calls`. Intermittently it does not: the
 * raw markup lands in `content` with `finish_reason: "stop"`, so an
 * OpenAI-compatible client reads a *completed* turn, the tool never runs, and
 * the agent loop goes idle with markup on screen. It is reported for
 * `opencode-go/deepseek-v4.1-flash` — this route's own lane — and for other
 * DeepSeek lanes, and the leaked markup also teaches the model to repeat it.
 *
 * ```text
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="skill">
 * <｜｜DSML｜ parameter name="name" string="true">cordis-plugin-development</｜ parameter>
 * </｜ invoke>
 * </｜ calls>
 * ```
 *
 * Parsing rules that matter, all of them learned from the failure rather than
 * from a spec:
 *
 * - the `tool_calls` wrapper is optional. A lane that drops the opening token
 *   still emits well-formed `invoke` blocks, so detection anchors on a closed
 *   `invoke` block that carries at least one `parameter` — never on the wrapper;
 * - tags arrive as `<｜｜DSML｜｜ invoke …>` with the token *inside* the tag, so after
 *   stripping the token every tag keeps the space the model wrote: `< invoke …>`.
 *   The patterns therefore tolerate whitespace after `<` and `</`;
 * - a closed block with no parameter is not a call. Prose that merely *quotes*
 *   the markup (a code review, this comment) must not be replayed as a phantom
 *   tool call;
 * - `string="true"` means the value is literal text: never coerce it, and never
 *   trim it — a file's `content` keeps its leading and trailing newlines;
 * - any other parameter is a JSON value (`string="false"` carries arrays and
 *   objects), falling back to the literal text when it does not parse.
 *
 * @module @gitawego/dsh-llm-provider/dsml
 */

/** The DeepSeek special token wrapping every DSML tag. */
export const DSML_TOKEN = '\u{FF5C}\u{FF5C}DSML\u{FF5C}\u{FF5C}'

/** One recovered tool call, in the shape pi-ai would have produced. */
export interface DsmlToolCall {
    /** Tool name from the `invoke` tag. */
    name: string
    /** Arguments from the `parameter` tags. */
    arguments: Record<string, unknown>
}

/** A closed `invoke` block, spanning newlines and tolerating the token's space. */
const INVOKE = /<\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\s*invoke\s*>/g

/** One `parameter` tag, keeping its attribute blob so `string="true"` survives. */
const PARAMETER = /<\s*parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/\s*parameter\s*>/g

/** The `tool_calls` wrapper once the token is gone: `< calls>` or `<tool_calls>`. */
const WRAPPER = /<\/?\s*(?:tool_calls|calls)\s*>/g

/**
 * Remove the DSML token, leaving plain `< invoke>` / `< parameter>` tags.
 *
 * Only tag prefixes carry the token, so removing every occurrence cannot touch a
 * parameter *value* — and values must survive byte for byte.
 * @param text - assistant text that may carry markup.
 * @returns the same text with the token stripped.
 */
function stripToken(text: string): string {
    return text.split(DSML_TOKEN).join('')
}

/**
 * Coerce one parameter's raw text into a JSON value.
 * @param raw - the text between the `parameter` tags, verbatim.
 * @param declaredString - whether the tag said `string="true"`.
 * @returns the literal text when it is declared a string, otherwise the parsed
 *   JSON value, otherwise the literal text.
 */
function coerce(raw: string, declaredString: boolean): unknown {
    if (declaredString) return raw
    try {
        return JSON.parse(raw.trim())
    } catch {
        return raw
    }
}

/**
 * Parse every tool call a DSML block describes.
 * @param text - assistant text that may carry markup.
 * @returns the recovered calls in order; empty when the text carries none.
 */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
    if (!text.includes(DSML_TOKEN)) return []
    const cleaned = stripToken(text)
    // No parameter tag anywhere means no call: a quoted tag or a bare
    // `invoke` without arguments is prose about the markup, not a request.
    if (!cleaned.includes('parameter')) return []
    const calls: DsmlToolCall[] = []
    for (const invoke of cleaned.matchAll(INVOKE)) {
        const name = invoke[1]?.trim() ?? ''
        if (name.length === 0) continue
        const arguments_: Record<string, unknown> = {}
        for (const parameter of (invoke[2] ?? '').matchAll(PARAMETER)) {
            const key = parameter[1]?.trim() ?? ''
            if (key.length === 0) continue
            arguments_[key] = coerce(parameter[3] ?? '', (parameter[2] ?? '').includes('string="true"'))
        }
        if (Object.keys(arguments_).length === 0) continue
        calls.push({ name, arguments: arguments_ })
    }
    return calls
}

/**
 * Whether a text block carries recoverable tool calls.
 * @param text - assistant text.
 * @returns true when at least one `invoke` block parses to a call.
 */
export function hasDsmlToolCalls(text: string): boolean {
    return parseDsmlToolCalls(text).length > 0
}

/**
 * Split assistant text into the prose the user should see and the calls it hid.
 *
 * The prose is what remains after the blocks and their wrapper are removed; a
 * block that is nothing but markup leaves an empty string, which is the honest
 * answer — the user asked for a tool run, not for a transcript of the model's
 * syntax.
 * @param text - assistant text.
 * @returns the prose without markup, and the recovered calls.
 */
export function splitDsml(text: string): { text: string; calls: DsmlToolCall[] } {
    const calls = parseDsmlToolCalls(text)
    if (calls.length === 0) return { text, calls }
    const prose = stripToken(text).replace(INVOKE, '').replace(WRAPPER, '').trim()
    return { text: prose, calls }
}

/**
 * How much of a streamed text buffer is safe to show, given that a DSML token
 * can arrive split across deltas.
 *
 * Everything from the first token onward is withheld, as is a trailing fragment
 * that could still become one (`<`, `｜`, `<｜｜D`, …). The token starts with
 * U+FF5C, which ordinary prose does not contain, so the holdback costs at most a
 * character of latency on real text and is flushed at the block's end.
 * @param buffer - text received so far and not yet emitted.
 * @returns the index from which the buffer must be withheld; equal to the
 *   buffer's length when all of it is safe.
 */
export function dsmlHoldIndex(buffer: string): number {
    const at = buffer.indexOf(DSML_TOKEN)
    // Hold the tag's own `<` too: releasing it would leave a stray angle bracket
    // at the end of the prose the caller already received.
    if (at >= 0) return at > 0 && buffer[at - 1] === '<' ? at - 1 : at
    // A tag opens with `<` immediately before the token, and the token itself
    // can arrive alone (a `parameter` closing tag has no `<` of its own to give
    // the fragment away), so both forms count as a possible start.
    const starts = [`<${DSML_TOKEN}`, DSML_TOKEN]
    let hold = buffer.length
    for (const start of starts) {
        const longest = Math.min(buffer.length, start.length - 1)
        for (let length = longest; length > 0; length -= 1) {
            if (!start.startsWith(buffer.slice(-length))) continue
            hold = Math.min(hold, buffer.length - length)
            break
        }
    }
    return hold
}
