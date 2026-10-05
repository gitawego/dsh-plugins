/**
 * The regression these tests exist for: OpenCode Go answers
 * `400 MissingSessionID` unless the request carries `x-opencode-session`.
 * Everything here is about that one header reaching the wire with the
 * conversation's identity and nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import {
    OPENCODE_SESSION_HEADER,
    hasHeader,
    withSessionHeader,
    withSessionRouting,
    type SessionHeaderedOptions,
} from '../src/session-header.ts'

describe('withSessionHeader', () => {
    it('stamps the session id onto the request that would otherwise be refused', () => {
        const options = { sessionId: 'sess-1', apiKey: 'k' }
        expect(withSessionHeader(options)).toEqual({
            sessionId: 'sess-1',
            apiKey: 'k',
            headers: { [OPENCODE_SESSION_HEADER]: 'sess-1' },
        })
    })

    it('keeps existing headers and adds the session header beside them', () => {
        const routed = withSessionHeader({ sessionId: 'sess-2', headers: { 'x-trace': 't' } })
        expect(routed?.headers).toEqual({ 'x-trace': 't', [OPENCODE_SESSION_HEADER]: 'sess-2' })
    })

    it('leaves options untouched when there is no session id', () => {
        const options: SessionHeaderedOptions = { headers: { 'x-trace': 't' } }
        expect(withSessionHeader(options)).toBe(options)
    })

    it('treats an empty session id as absent rather than sending a blank header', () => {
        const options: SessionHeaderedOptions = { sessionId: '' }
        expect(withSessionHeader(options)).toBe(options)
    })

    it('passes undefined through, so a caller with no options stays a caller with no options', () => {
        expect(withSessionHeader(undefined)).toBeUndefined()
    })

    it('never overrides a caller that set the header itself, whatever the casing', () => {
        const routed = withSessionHeader({ sessionId: 'sess-3', headers: { 'X-OpenCode-Session': 'explicit' } })
        expect(routed?.headers).toEqual({ 'X-OpenCode-Session': 'explicit' })
    })

    it('does not mutate the caller options or its header map', () => {
        const headers = { 'x-trace': 't' }
        const options = { sessionId: 'sess-4', headers }
        withSessionHeader(options)
        expect(options).toEqual({ sessionId: 'sess-4', headers: { 'x-trace': 't' } })
    })
})

describe('hasHeader', () => {
    it('matches case-insensitively, because HTTP field names are', () => {
        expect(hasHeader({ 'X-OpenCode-Session': 'v' }, 'x-opencode-session')).toBe(true)
        expect(hasHeader({ 'x-opencode-session': 'v' }, 'x-opencode-session')).toBe(true)
    })

    it('reports absence for an empty or missing map', () => {
        expect(hasHeader(undefined, 'x-opencode-session')).toBe(false)
        expect(hasHeader({}, 'x-opencode-session')).toBe(false)
    })
})

describe('withSessionRouting', () => {
    const provider = () => ({
        stream: vi.fn((..._args: unknown[]) => 'streamed'),
        streamSimple: vi.fn((..._args: unknown[]) => 'simple'),
        name: 'OpenCode Go',
    })

    it('routes both pi-ai entry points through the header', () => {
        const base = provider()
        const wrapped = withSessionRouting(base, true)
        wrapped.stream({} as never, {} as never, { sessionId: 'sess-5' })
        wrapped.streamSimple({} as never, {} as never, { sessionId: 'sess-6' })
        expect(base.stream).toHaveBeenCalledWith({}, {}, { sessionId: 'sess-5', headers: { [OPENCODE_SESSION_HEADER]: 'sess-5' } })
        expect(base.streamSimple).toHaveBeenCalledWith({}, {}, { sessionId: 'sess-6', headers: { [OPENCODE_SESSION_HEADER]: 'sess-6' } })
    })

    it('preserves the rest of the provider untouched', () => {
        const wrapped = withSessionRouting(provider(), true)
        expect(wrapped.name).toBe('OpenCode Go')
    })

    it('returns the provider itself when the gateway needs no session routing', () => {
        const base = provider()
        expect(withSessionRouting(base, false)).toBe(base)
    })
})
