/**
 * The monitoring profile's resolution rules.
 *
 * The profile carries four fields and no secrets: a route to report on, an
 * endpoint to ask, a credential *reference* to authenticate with, and a cache
 * lifetime. Everything a provider route needs to *serve* — protocol, catalog,
 * headers — is the host adapter's business, and a field that crept back in here
 * would be a second source of truth for it.
 */
import { describe, expect, it } from 'vitest'
import {
    DEFAULT_API_KEY_ENV,
    DEFAULT_MONITOR_ENDPOINT,
    DEFAULT_REFRESH_MINUTES,
    DEFAULT_ROUTE,
    LLM_PROVIDER_SETTINGS_NAMESPACE,
    readMonitorProfile,
    resolveProfile,
    type MonitorConfigRefs,
} from '../src/config.ts'

/** Volatile-reference stand-ins, as the loader hands them to `apply`. */
function refs(value: Record<string, unknown>): MonitorConfigRefs {
    return Object.fromEntries(
        Object.entries(value).map(([key, stored]) => [key, { get: () => stored }]),
    ) as unknown as MonitorConfigRefs
}

describe('the monitoring profile', () => {
    it('defaults to the host route and the reporting endpoint', () => {
        const profile = resolveProfile(undefined)
        expect(profile.route).toBe(DEFAULT_ROUTE)
        expect(profile.baseURL).toBe(DEFAULT_MONITOR_ENDPOINT)
        expect(profile.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
        expect(profile.refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES)
    })

    it('defaults the route to the installed pi-ai provider key, not a private route', () => {
        // The whole point of the cut: the plugin reports on the host adapter's
        // route, so the default must be a key dsh-llm-pi-ai already declares.
        expect(DEFAULT_ROUTE).toBe('opencode-go')
    })

    it('asks the inference/go reporting endpoint, which answers both reads', () => {
        expect(DEFAULT_MONITOR_ENDPOINT).toBe('https://opencode.ai/inference/go/v1')
    })

    it('trims stored values', () => {
        const profile = resolveProfile({ route: '  opencode-go  ', baseURL: ' https://example.test/v1 ', apiKeyEnv: ' OPENCODE_API_KEY ' })
        expect(profile.route).toBe('opencode-go')
        expect(profile.baseURL).toBe('https://example.test/v1')
        expect(profile.apiKeyEnv).toBe('OPENCODE_API_KEY')
    })

    it('keeps an explicitly cleared credential reference', () => {
        // Clearing the reference is meaningful: it says "these two read-only
        // calls go unauthenticated", and the card reports that instead of
        // silently falling back to a reference the user removed.
        expect(resolveProfile({ apiKeyEnv: '' }).apiKeyEnv).toBe('')
    })

    it('falls back field by field when a stored value is unusable', () => {
        const profile = resolveProfile({ route: '   ', baseURL: 42, apiKeyEnv: null, refreshMinutes: -1 })
        expect(profile.route).toBe(DEFAULT_ROUTE)
        expect(profile.baseURL).toBe(DEFAULT_MONITOR_ENDPOINT)
        expect(profile.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
        expect(profile.refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES)
    })

    it('accepts a fractional refresh interval', () => {
        expect(resolveProfile({ refreshMinutes: 0.5 }).refreshMinutes).toBe(0.5)
    })

    it('reads one stable snapshot from the loader references', () => {
        const profile = readMonitorProfile(refs({ route: 'my-route', baseURL: 'https://gw.test/v1', apiKeyEnv: 'MY_KEY', refreshMinutes: 5 }))
        expect(profile).toEqual({ route: 'my-route', baseURL: 'https://gw.test/v1', apiKeyEnv: 'MY_KEY', refreshMinutes: 5 })
    })

    it('resolves defaults when the loader hands no references at all', () => {
        expect(readMonitorProfile(undefined).route).toBe(DEFAULT_ROUTE)
    })

    it('owns exactly one settings namespace', () => {
        expect(LLM_PROVIDER_SETTINGS_NAMESPACE).toBe('llm-provider')
    })
})
