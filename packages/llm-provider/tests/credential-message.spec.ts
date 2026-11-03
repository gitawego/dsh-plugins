import { describe, expect, it } from 'vitest'
import { missingCredentialMessage } from '../src/credential-message.ts'

describe('missingCredentialMessage', () => {
    it('names the reference a profile points at', () => {
        const message = missingCredentialMessage('opencode-go-session', 'OPENCODE_GO_CUSTOM_API_KEY')
        expect(message).toContain('"OPENCODE_GO_CUSTOM_API_KEY"')
        expect(message).toContain('opencode-go-session')
        expect(message).toContain('apiKeyEnv')
    })

    it('says so when the profile names no reference at all', () => {
        const message = missingCredentialMessage('opencode-go-session', '')
        expect(message).toContain('names no credential reference')
        expect(message).not.toContain('""')
    })

    it('always says where the key is set', () => {
        for (const ref of ['SOME_REF', '']) {
            const message = missingCredentialMessage('opencode-go-session', ref)
            expect(message).toContain('.credentials.yaml')
            expect(message).toContain('Settings')
        }
    })
})
