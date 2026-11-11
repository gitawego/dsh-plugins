/**
 * The ACP v1 surface this adapter actually consumes.
 *
 * The installed harness carries `@agentclientprotocol/sdk@1.4.0`, but this
 * package deliberately keeps no runtime dependency on it: the wire is
 * newline-delimited JSON-RPC, and the subset below is small enough to own.
 * Keeping the types local also means a host SDK upgrade cannot silently change
 * the shape of a provider request.
 *
 * @module @gitawego/dsh-llm-agy/protocol
 */

/** One content block in a prompt or an update. */
export type AcpContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'audio'; data: string; mimeType: string }
    | { type: 'resource_link'; uri: string; name?: string }
    | { type: 'resource'; resource: unknown }

/** Token accounting returned by an ACP prompt turn (experimental in ACP). */
export interface AcpUsage {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    thoughtTokens?: number | null
    cachedReadTokens?: number | null
    cachedWriteTokens?: number | null
}

/** One selectable value of an ACP session config option. */
export interface AcpConfigSelectOption {
    value: string
    name: string
    description?: string | null
}

/** A grouped set of selectable values. */
export interface AcpConfigSelectGroup {
    group: string
    name: string
    options: AcpConfigSelectOption[]
}

/** One ACP session config option (`model`, `thought_level`, `mode`, …). */
export interface AcpSessionConfigOption {
    id: string
    name: string
    description?: string | null
    category?: string | null
    type: 'select' | 'boolean'
    currentValue?: string | boolean
    options?: Array<AcpConfigSelectOption | AcpConfigSelectGroup>
}

/** Response of `session/new`. */
export interface AcpNewSessionResponse {
    sessionId: string
    configOptions?: AcpSessionConfigOption[] | null
    modes?: {
        currentModeId: string
        availableModes: Array<{ id: string; name: string; description?: string | null }>
    } | null
}

/** Response of `initialize`. */
export interface AcpInitializeResponse {
    protocolVersion: number
    agentCapabilities?: {
        loadSession?: boolean
        promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
        sessionCapabilities?: Record<string, unknown>
    } | null
    agentInfo?: { name?: string; version?: string } | null
    authMethods?: Array<{ id: string; name: string; description?: string | null }> | null
}

/** One `session/update` notification. */
export interface AcpSessionUpdate {
    sessionUpdate: string
    content?: AcpContentBlock
    messageId?: string | null
    toolCallId?: string
    title?: string
    kind?: string
    status?: string
    [key: string]: unknown
}

/** Details of the tool call an agent wants permission to run. */
export interface AcpToolCallUpdate {
    toolCallId: string
    title?: string | null
    name?: string | null
    kind?: string | null
    status?: string | null
    rawInput?: unknown
    locations?: Array<{ path?: string }>
    [key: string]: unknown
}

/** One permission choice the agent offers. */
export interface AcpPermissionOption {
    optionId: string
    name: string
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

/** `session/request_permission` request. */
export interface AcpRequestPermissionRequest {
    sessionId: string
    toolCall: AcpToolCallUpdate
    options: AcpPermissionOption[]
}

/** `session/request_permission` response; ACP nests the outcome object. */
export type AcpRequestPermissionResponse =
    | { outcome: { outcome: 'selected'; optionId: string } }
    | { outcome: { outcome: 'cancelled' } }

/** Response of `session/prompt`. */
export interface AcpPromptResponse {
    stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string
    usage?: AcpUsage | null
}

/** A JSON-RPC request/notification envelope as seen on the wire. */
export interface AcpMessage {
    jsonrpc?: '2.0'
    id?: number | string | null
    method?: string
    params?: unknown
    result?: unknown
    error?: { code?: number; message?: string; data?: unknown }
}

/** Flatten a select option list, accepting ACP's optional grouping. */
export function selectOptions(option: AcpSessionConfigOption | undefined): AcpConfigSelectOption[] {
    if (option === undefined || option.type !== 'select' || option.options === undefined) return []
    const values: AcpConfigSelectOption[] = []
    for (const entry of option.options) {
        if (entry !== null && typeof entry === 'object' && 'options' in entry && Array.isArray(entry.options)) {
            values.push(...entry.options)
        } else {
            values.push(entry as AcpConfigSelectOption)
        }
    }
    return values
}

/** Find a session config option by category first, then by id. */
export function findConfigOption(
    options: readonly AcpSessionConfigOption[],
    category: string,
    id: string,
): AcpSessionConfigOption | undefined {
    return options.find((option) => option.category === category) ?? options.find((option) => option.id === id)
}

/** Narrow an unknown value to a string. */
export function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

/** Narrow an unknown value to a record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}
