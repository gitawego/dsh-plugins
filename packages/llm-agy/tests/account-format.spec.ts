import { describe, expect, it } from 'vitest'
import { parseAccountList, parseLoginStart, parseLoginStatus } from '../src/client/account-format.ts'

describe('parseAccountList', () => {
    it('keeps valid rows and drops malformed ones', () => {
        const view = parseAccountList({
            activeEmail: 'a@example.com',
            accounts: [
                { id: 'a@example.com', identity: 'A@example.com', label: 'A', source: 'keyring', active: true },
                { id: 'b@example.com', identity: 'b@example.com', source: 'login', active: false },
                { id: 'missing-identity' },
                null,
            ],
        })
        expect(view).toEqual({
            activeEmail: 'a@example.com',
            accounts: [
                { id: 'a@example.com', identity: 'A@example.com', label: 'A', source: 'keyring', active: true },
                { id: 'b@example.com', identity: 'b@example.com', source: 'login', active: false },
            ],
        })
    })

    it('rejects a non-object body and normalizes an unknown source', () => {
        expect(parseAccountList(null)).toBeUndefined()
        expect(parseAccountList({ accounts: [{ id: 'a', identity: 'A', source: 'other' }] })?.accounts[0]?.source).toBe('keyring')
    })
})

describe('parseLoginStatus', () => {
    it('parses pending, success, and error states', () => {
        expect(parseLoginStatus({ status: 'pending' })).toEqual({ status: 'pending' })
        expect(parseLoginStatus({
            status: 'success',
            activeEmail: 'a@example.com',
            accounts: [{ id: 'a@example.com', identity: 'a@example.com', source: 'login', active: true }],
        })).toEqual({
            status: 'success',
            activeEmail: 'a@example.com',
            accounts: [{ id: 'a@example.com', identity: 'a@example.com', source: 'login', active: true }],
        })
        expect(parseLoginStatus({ status: 'error', error: 'access_denied' })).toEqual({ status: 'error', error: 'access_denied' })
        expect(parseLoginStatus({ status: 'error' })).toEqual({ status: 'error', error: 'sign-in failed' })
    })

    it('rejects unknown and malformed states', () => {
        expect(parseLoginStatus(null)).toBeUndefined()
        expect(parseLoginStatus({ status: 'other' })).toBeUndefined()
    })
})

describe('parseLoginStart', () => {
    it('accepts only a Google accounts URL', () => {
        expect(parseLoginStart({
            loginId: 'login-1',
            url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
        })).toEqual({
            loginId: 'login-1',
            url: 'https://accounts.google.com/o/oauth2/auth?client_id=fake',
        })
        expect(parseLoginStart({ loginId: 'login-1', url: 'https://example.com/phish' })).toBeUndefined()
        expect(parseLoginStart({ loginId: 'login-1' })).toBeUndefined()
        expect(parseLoginStart('nope')).toBeUndefined()
    })
})
