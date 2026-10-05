import { describe, expect, it } from 'vitest'
import { formatCountdown, parseQuotaView, toneFor } from '../src/client/quota-format.ts'

/** A tool result's meta, as the tool's `presentationMeta` produces it. */
const meta = () => ({
    route: 'opencode-go-session',
    error: null,
    fetchedAt: 1_791_212_000_000,
    windows: [
        { id: 'rolling', label: '5-hour', percentUsed: 3, percentRemaining: 97, status: 'ok', resetsAt: '2026-10-05T19:56:40.000Z' },
        { id: 'weekly', label: 'weekly', percentUsed: 1, percentRemaining: 99, status: 'ok', resetsAt: '2026-10-12T00:00:00.000Z' },
        { id: 'monthly', label: 'monthly', percentUsed: 82, percentRemaining: 18, status: 'ok', resetsAt: '2026-11-01T15:37:28.000Z' },
    ],
})

describe('toneFor', () => {
    it('stays quiet until the number stops being informational', () => {
        expect(toneFor(0)).toBe('ok')
        expect(toneFor(79)).toBe('ok')
        expect(toneFor(80)).toBe('warn')
        expect(toneFor(94)).toBe('warn')
        expect(toneFor(95)).toBe('critical')
        expect(toneFor(100)).toBe('critical')
    })
})

describe('parseQuotaView', () => {
    it('reads the three windows the provider reports, in order', () => {
        const view = parseQuotaView(meta())
        expect(view?.route).toBe('opencode-go-session')
        expect(view?.fetchedAt).toBe(1_791_212_000_000)
        expect(view?.windows.map((window) => [window.label, window.percentRemaining, window.tone])).toEqual([
            ['5-hour', 97, 'ok'],
            ['weekly', 99, 'ok'],
            ['monthly', 18, 'warn'],
        ])
    })

    it('derives what is left when only what is used was reported', () => {
        const view = parseQuotaView({ route: 'r', windows: [{ label: '5-hour', percentUsed: 12.5 }] })
        expect(view?.windows[0]?.percentRemaining).toBe(87.5)
    })

    it('treats a missing window as absent, never as zero', () => {
        const view = parseQuotaView({ route: 'r', windows: [{ label: '5-hour', percentUsed: 1, percentRemaining: 99 }] })
        expect(view?.windows).toHaveLength(1)
    })

    it('skips a window without a usable percentage or label rather than drawing a zero bar', () => {
        const view = parseQuotaView({ route: 'r', windows: [{ label: 'x' }, { percentUsed: 5 }, null, 'nope'] })
        expect(view?.windows).toEqual([])
    })

    it('carries the failure reason through, so an unreadable report says why', () => {
        const view = parseQuotaView({ route: 'r', windows: [], error: 'usage endpoint answered 429' })
        expect(view?.error).toBe('usage endpoint answered 429')
        expect(view?.windows).toEqual([])
    })

    it('answers undefined for a result with nothing structured to draw', () => {
        // A result from before this view existed, or another tool's, renders text.
        expect(parseQuotaView(undefined)).toBeUndefined()
        expect(parseQuotaView(null)).toBeUndefined()
        expect(parseQuotaView({ windows: [] })).toBeUndefined()
        expect(parseQuotaView('5-hour: 98% left')).toBeUndefined()
    })

    it('never throws on a malformed payload, because a slot renderer that throws takes the card down', () => {
        for (const bad of [{ route: 'r', windows: 'nope' }, { route: 'r', windows: [42] }, { route: 7 }, {}]) {
            expect(() => parseQuotaView(bad)).not.toThrow()
        }
    })
})

describe('formatCountdown', () => {
    const now = Date.parse('2026-10-05T16:00:00.000Z')

    it('reads as a time to wait, not a timestamp to decode', () => {
        expect(formatCountdown('2026-10-05T16:45:00.000Z', now)).toBe('in 45m')
        expect(formatCountdown('2026-10-05T19:56:40.000Z', now)).toBe('in 3h 57m')
        expect(formatCountdown('2026-10-07T16:00:00.000Z', now)).toBe('in 2d 0h')
    })

    it('says the window is resetting rather than showing a negative wait', () => {
        expect(formatCountdown('2026-10-05T15:59:00.000Z', now)).toBe('resetting')
    })

    it('falls back to the raw value when the timestamp cannot be parsed', () => {
        expect(formatCountdown('whenever', now)).toBe('whenever')
    })
})
