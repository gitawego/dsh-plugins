/**
 * ACP/transport failure → DSH `LlmError` classification.
 *
 * ACP has no HTTP status on most failures, so the classifier uses the JSON-RPC
 * error code/data and the message text. Auth and quota are terminal; transport,
 * timeout, and server failures are left to the harness retry policy.
 *
 * @module @gitawego/dsh-llm-agy/errors
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AcpAbortError, AcpProcessError, AcpRemoteError, AcpTimeoutError } from './acp-client.ts'

/** Join every text field a remote error carries. */
function detailOf(error: AcpRemoteError): string {
    const data = error.data === undefined ? '' : safeJson(error.data)
    return `${error.message} ${data}`.toLowerCase()
}

/** JSON without throwing on cycles. */
function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

/** Build the adapter's stable, actionable auth message. */
export function authMessage(original: string): string {
    return `${original} Antigravity CLI is not signed in. Run \`agy\` interactively (or \`agy acp --login\`) and sign in with Google, then retry.`
}

/**
 * Normalize any failure thrown by the ACP layer.
 * @param error - the caught value.
 * @returns a DSH error with a stable code.
 */
export function classifyAcpError(error: unknown): LlmError {
    if (error instanceof LlmError) return error

    if (error instanceof AcpAbortError) {
        return new LlmError('Antigravity ACP request was aborted', 'ABORTED', { cause: error })
    }
    if (error instanceof AcpTimeoutError) {
        return new LlmError(error.message, 'TIMEOUT', { cause: error })
    }
    if (error instanceof AcpProcessError) {
        return new LlmError(error.message, 'TRANSPORT', { cause: error })
    }
    if (error instanceof AcpRemoteError) {
        const detail = detailOf(error)
        if (/auth|login|sign in|oauth|unauthor|forbidden|credential|401|403/.test(detail)) {
            return new LlmError(authMessage(error.message), 'AUTH', { cause: error })
        }
        if (/quota|credit|balance|billing|limit reached|402/.test(detail)) {
            return new LlmError(error.message, 'QUOTA', { cause: error })
        }
        if (/rate.?limit|too many requests|429/.test(detail)) {
            return new LlmError(error.message, 'RATE_LIMIT', { cause: error })
        }
        if (/context|too long|maximum.*token|token.*maximum|window/.test(detail)) {
            return new LlmError(error.message, 'CONTEXT_WINDOW_EXCEEDED', { cause: error })
        }
        if (/unknown model|model.*not found|unsupported model|does-not-exist/.test(detail)) {
            return new LlmError(error.message, 'UNKNOWN_MODEL', { cause: error })
        }
        if (/invalid|bad request|400/.test(detail)) {
            return new LlmError(error.message, 'INVALID_REQUEST', { cause: error })
        }
        return new LlmError(error.message, 'ACP_ERROR', { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)
    return new LlmError(message.length > 0 ? message : 'Antigravity ACP failure', 'TRANSPORT', {
        cause: error instanceof Error ? error : undefined,
    })
}
