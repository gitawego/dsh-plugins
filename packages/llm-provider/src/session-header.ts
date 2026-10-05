/**
 * The OpenCode Go session-routing header.
 *
 * `opencode.ai/zen/go` refuses a request that does not carry a conversation
 * identity:
 *
 * ```text
 * 400 {"type":"error","error":{"type":"MissingSessionID","message":
 *   "Request is missing x-opencode-session and cannot be routed efficiently."}}
 * ```
 *
 * The value is opaque to the gateway, but it is what pins one conversation to
 * one backend lane (and therefore to one warm prompt cache), so it must be
 * stable per conversation and distinct across conversations. That is exactly
 * what the harness stamps into `GenerateOptions.sessionId`, so this module
 * moves that value onto the wire and never invents one of its own.
 *
 * Upstream pi-ai grew the same wrapper in 1.0.x (`withOpenCodeSessionHeader`,
 * applied inside its built-in `opencode-go` provider). The pi-ai build the
 * harness (0.1.5-rc.1) depends on is 0.85.1, which predates it — which is why
 * this lives here rather than in a dependency bump.
 *
 * @module @gitawego/dsh-llm-provider/session-header
 */

/** Wire header name as pi-ai and the gateway spell it. */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/**
 * The subset of a pi-ai request-options object this module reads and writes.
 * Declared structurally so the wrapper can be unit-tested without constructing
 * pi-ai types, and so it stays assignable to `SimpleStreamOptions`.
 */
export interface SessionHeaderedOptions {
    /** Harness conversation identity; pi-ai forwards it verbatim. */
    sessionId?: string
    /** Caller headers; an explicit `x-opencode-session` always wins. */
    headers?: Record<string, string | null>
}

/**
 * Whether a header map already carries a field, case-insensitively — HTTP
 * field names are case-insensitive, and a caller that set
 * `X-OpenCode-Session` must not end up with two competing values.
 * @param headers - the caller's header map, when any.
 * @param name - lowercase field name to look for.
 * @returns true when the field is present under any casing.
 */
export function hasHeader(
    headers: Record<string, string | null> | undefined,
    name: string,
): boolean {
    if (headers === undefined) return false
    const expected = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === expected)
}

/**
 * Return `options` with the OpenCode session header added.
 *
 * Nothing is added when there is no session id (a hand-built one-shot call
 * carries none, and a blank header value would be refused by Fetch anyway) or
 * when the caller already set the header — the caller's explicit value is the
 * more specific instruction.
 * @param options - pi-ai stream options, possibly undefined.
 * @param headerName - field name to set; defaults to {@link OPENCODE_SESSION_HEADER}.
 * @returns the same options object when nothing changes, otherwise a copy.
 */
export function withSessionHeader<T extends SessionHeaderedOptions>(
    options: T | undefined,
    headerName: string = OPENCODE_SESSION_HEADER,
): T | undefined {
    const sessionId = options?.sessionId
    if (options === undefined || sessionId === undefined || sessionId.length === 0) return options
    if (hasHeader(options.headers, headerName)) return options
    return { ...options, headers: { ...options.headers, [headerName]: sessionId } }
}

/** The two stream entry points a pi-ai provider exposes. */
export interface SessionHeaderedStreams {
    stream: (...args: never[]) => unknown
    streamSimple: (...args: never[]) => unknown
}

/**
 * Wrap a pi-ai provider's `stream`/`streamSimple` so every dispatch carries the
 * session header. The argument list is forwarded untouched apart from the
 * options object, and the wrapper preserves the provider's own `this`-free
 * closure methods (pi-ai builds them in `createProvider`).
 * @param provider - provider whose stream entry points to wrap.
 * @param enabled - false returns the provider unchanged (route does not need it).
 * @returns a provider-shaped object with the wrapped entry points.
 */
export function withSessionRouting<P extends {
    stream: (model: never, context: never, options?: SessionHeaderedOptions) => unknown
    streamSimple: (model: never, context: never, options?: SessionHeaderedOptions) => unknown
}>(provider: P, enabled: boolean): P {
    if (!enabled) return provider
    return {
        ...provider,
        stream: (model: never, context: never, options?: SessionHeaderedOptions) =>
            provider.stream(model, context, withSessionHeader(options)),
        streamSimple: (model: never, context: never, options?: SessionHeaderedOptions) =>
            provider.streamSimple(model, context, withSessionHeader(options)),
    }
}
