/**
 * ACP tool permission ↔ harness approval bridge.
 *
 * `agy` executes its own tools and asks the client for a decision. The adapter
 * maps that question onto `ctx.approval.request`, so the normal DSH approval
 * UI owns the answer instead of the provider silently auto-approving. No live
 * agent or no answerer means the request is cancelled — fail closed.
 *
 * @module @gitawego/dsh-llm-agy/permissions
 */
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AcpPermissionOption, AcpRequestPermissionRequest, AcpRequestPermissionResponse, AcpToolCallUpdate } from './protocol.ts'

/** Human-readable tool identity for the approval prompt. */
export function permissionToolName(tool: AcpToolCallUpdate): string {
    const title = typeof tool.title === 'string' && tool.title.trim().length > 0 ? tool.title.trim() : undefined
    const name = typeof tool.name === 'string' && tool.name.trim().length > 0 ? tool.name.trim() : undefined
    return name ?? title ?? (typeof tool.kind === 'string' && tool.kind.length > 0 ? tool.kind : 'agy tool')
}

/** The approval reason shown to the user. */
export function permissionReason(tool: AcpToolCallUpdate): string | undefined {
    const title = typeof tool.title === 'string' && tool.title.trim().length > 0 ? tool.title.trim() : undefined
    const kind = typeof tool.kind === 'string' && tool.kind.length > 0 ? tool.kind : undefined
    if (title !== undefined && kind !== undefined) return `${title} (${kind})`
    return title ?? kind
}

/** Pick the option matching an approval outcome; undefined means cancel. */
export function choosePermissionOption(
    options: readonly AcpPermissionOption[],
    outcome: ApprovalOutcome,
): AcpPermissionOption | undefined {
    if (outcome === 'allowed-once') {
        return (
            options.find((option) => option.kind === 'allow_once') ??
            options.find((option) => option.kind === 'allow_always') ??
            options.find((option) => /allow/i.test(`${option.optionId} ${option.name}`))
        )
    }
    if (outcome === 'rejected') {
        return (
            options.find((option) => option.kind === 'reject_once') ??
            options.find((option) => option.kind === 'reject_always') ??
            options.find((option) => /reject|deny/i.test(`${option.optionId} ${option.name}`))
        )
    }
    return undefined
}

/**
 * Translate one approval outcome into the ACP response.
 * @param request - the agent's permission request.
 * @param outcome - the harness approval outcome.
 * @returns the ACP response, never a throw.
 */
export function permissionResponse(
    request: AcpRequestPermissionRequest,
    outcome: ApprovalOutcome,
): AcpRequestPermissionResponse {
    const option = choosePermissionOption(request.options ?? [], outcome)
    return option === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: option.optionId } }
}
