import { describe, expect, it } from 'vitest'
import { AcpAbortError, AcpProcessError, AcpRemoteError, AcpTimeoutError } from '../src/acp-client.ts'
import { authMessage, classifyAcpError } from '../src/errors.ts'

function codeOf(error: unknown): string {
    return (error as { code: string }).code
}

describe('classifyAcpError', () => {
    it('classifies auth wording and adds the CLI remediation', () => {
        const error = classifyAcpError(new AcpRemoteError('Not logged in. Run agy to authenticate.', -32000, undefined))
        expect(codeOf(error)).toBe('AUTH')
        expect(error.message).toContain('Antigravity CLI is not signed in')
        expect(error.message).toContain('agy acp --login')
    })

    it('classifies quota, rate limit, context, and model errors', () => {
        expect(codeOf(classifyAcpError(new AcpRemoteError('quota exhausted', -32000, undefined)))).toBe('QUOTA')
        expect(codeOf(classifyAcpError(new AcpRemoteError('429 too many requests', -32000, undefined)))).toBe('RATE_LIMIT')
        expect(codeOf(classifyAcpError(new AcpRemoteError('context window exceeded', -32000, undefined)))).toBe('CONTEXT_WINDOW_EXCEEDED')
        expect(codeOf(classifyAcpError(new AcpRemoteError('unknown model: x', -32602, undefined)))).toBe('UNKNOWN_MODEL')
    })

    it('uses JSON-RPC data as part of the classification text', () => {
        expect(codeOf(classifyAcpError(new AcpRemoteError('request failed', -32000, { type: 'authentication_error' })))).toBe('AUTH')
    })

    it('maps transport primitives', () => {
        expect(codeOf(classifyAcpError(new AcpAbortError('session/prompt')))).toBe('ABORTED')
        expect(codeOf(classifyAcpError(new AcpTimeoutError('session/prompt', 10)))).toBe('TIMEOUT')
        expect(codeOf(classifyAcpError(new AcpProcessError('exited', 1, null, 'boom')))).toBe('TRANSPORT')
    })

    it('preserves an existing LlmError', () => {
        const original = classifyAcpError(new AcpTimeoutError('x', 1))
        expect(classifyAcpError(original)).toBe(original)
    })

    it('wraps an unknown throw as TRANSPORT', () => {
        expect(codeOf(classifyAcpError(new Error('boom')))).toBe('TRANSPORT')
        expect(codeOf(classifyAcpError('boom'))).toBe('TRANSPORT')
    })

    it('exposes a reusable auth message', () => {
        expect(authMessage('Not signed in.')).toContain('Not signed in. Antigravity CLI is not signed in')
    })
})
