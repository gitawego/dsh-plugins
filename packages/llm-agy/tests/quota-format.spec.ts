import { describe, expect, it } from 'vitest'
import { formatCountdown, labelFor, parseQuotaView, toneFor, type QuotaWindow } from '../src/client/quota-format.ts'
import { en, zh, type Translate } from '../src/client/strings.ts'

/** Bind a dictionary the way the locale service does. */
function translate(dictionary: typeof en): Translate {
    return (key) => dictionary[key]
}

const tEn = translate(en)
const tZh = translate(zh)

describe('parseQuotaView', () => {
    it('keeps well-formed rows and drops malformed ones', () => {
        const view = parseQuotaView({
            windows: [
                {
                    id: 'Gemini Models:gemini-weekly',
                    group: 'Gemini Models',
                    label: 'Weekly Limit Remaining',
                    window: 'weekly',
                    percentRemaining: 94.01,
                    percentUsed: 5.99,
                    resetsAt: '2026-11-15T11:22:35Z',
                    status: 'ok',
                },
                { id: 'missing-fields' },
                'not an object',
            ],
            fetchedAt: 42,
        })
        expect(view).toEqual({
            windows: [{
                id: 'Gemini Models:gemini-weekly',
                group: 'Gemini Models',
                label: 'Weekly Limit Remaining',
                window: 'weekly',
                percentRemaining: 94.01,
                percentUsed: 5.99,
                resetsAt: '2026-11-15T11:22:35Z',
                status: 'ok',
            }],
            fetchedAt: 42,
        })
    })

    it('preserves an error report and survives a non-object body', () => {
        expect(parseQuotaView({ windows: [], error: 'agy missing' })).toEqual({ windows: [], error: 'agy missing' })
        expect(parseQuotaView('nope')).toBeUndefined()
        expect(parseQuotaView(null)).toBeUndefined()
    })
})

describe('labelFor', () => {
    const bucket = (window: string, label: string): QuotaWindow => ({
        id: `id-${window}`,
        group: 'Gemini Models',
        label,
        window,
        percentRemaining: 99,
        percentUsed: 1,
        status: 'ok',
    })

    it('shortens the CLI prose to its cadence', () => {
        expect(labelFor(bucket('weekly', 'Weekly Limit Remaining'), tEn)).toBe('Weekly limit')
        expect(labelFor(bucket('5h', 'Five Hour Limit Remaining'), tEn)).toBe('Five-hour limit')
        expect(labelFor(bucket('weekly', 'Weekly Limit Remaining'), tZh)).toBe('每周额度')
    })

    it('keeps a label whose cadence is unknown', () => {
        expect(labelFor(bucket('daily', 'Daily Limit Remaining'), tEn)).toBe('Daily Limit Remaining')
    })
})

describe('toneFor', () => {
    it('moves through ok, warn, and critical at the card thresholds', () => {
        expect(toneFor(0)).toBe('ok')
        expect(toneFor(79.99)).toBe('ok')
        expect(toneFor(80)).toBe('warn')
        expect(toneFor(94.99)).toBe('warn')
        expect(toneFor(95)).toBe('critical')
    })
})

describe('formatCountdown', () => {
    const now = Date.parse('2026-11-12T00:00:00Z')

    it('renders minutes, hours, and days in the requested language', () => {
        expect(formatCountdown('2026-11-12T00:14:12Z', now, tEn)).toBe('in 14m')
        expect(formatCountdown('2026-11-12T03:20:00Z', now, tEn)).toBe('in 3h 20m')
        expect(formatCountdown('2026-11-14T03:00:00Z', now, tEn)).toBe('in 2d 3h')
        expect(formatCountdown('2026-11-12T00:14:12Z', now, tZh)).toBe('14 分钟后')
        expect(formatCountdown('2026-11-14T03:00:00Z', now, tZh)).toBe('2 天 3 小时后')
    })

    it('says resetting once the window has passed and leaves invalid timestamps alone', () => {
        expect(formatCountdown('2026-11-11T23:59:00Z', now, tEn)).toBe('resetting')
        expect(formatCountdown('not a date', now, tEn)).toBe('not a date')
    })
})
