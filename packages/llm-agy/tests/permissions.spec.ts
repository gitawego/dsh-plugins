import { describe, expect, it } from 'vitest'
import {
    choosePermissionOption,
    permissionReason,
    permissionResponse,
    permissionToolName,
} from '../src/permissions.ts'
import type { AcpPermissionOption, AcpRequestPermissionRequest } from '../src/protocol.ts'

const allow: AcpPermissionOption = { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }
const reject: AcpPermissionOption = { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }

function request(options: AcpPermissionOption[]): AcpRequestPermissionRequest {
    return {
        sessionId: 'sess',
        toolCall: { toolCallId: 'tc1', title: 'Write a file', kind: 'edit' },
        options,
    }
}

describe('permissionToolName', () => {
    it('prefers the programmatic name, then the title, then the kind', () => {
        expect(permissionToolName({ toolCallId: '1', name: 'write_file', title: 'Write a file', kind: 'edit' })).toBe('write_file')
        expect(permissionToolName({ toolCallId: '1', title: 'Write a file', kind: 'edit' })).toBe('Write a file')
        expect(permissionToolName({ toolCallId: '1', kind: 'edit' })).toBe('edit')
        expect(permissionToolName({ toolCallId: '1' })).toBe('agy tool')
    })
})

describe('permissionReason', () => {
    it('combines title and kind when both exist', () => {
        expect(permissionReason({ toolCallId: '1', title: 'Write a file', kind: 'edit' })).toBe('Write a file (edit)')
        expect(permissionReason({ toolCallId: '1', title: 'Write a file' })).toBe('Write a file')
        expect(permissionReason({ toolCallId: '1' })).toBeUndefined()
    })
})

describe('choosePermissionOption', () => {
    it('selects the matching allow/reject kinds', () => {
        expect(choosePermissionOption([reject, allow], 'allowed-once')).toBe(allow)
        expect(choosePermissionOption([allow, reject], 'rejected')).toBe(reject)
    })

    it('falls back to option labels when the agent uses unknown kinds', () => {
        const labeled = { optionId: 'yes', name: 'Allow this', kind: 'custom' }
        expect(choosePermissionOption([labeled], 'allowed-once')).toBe(labeled)
    })

    it('returns undefined for cancelled and unavailable outcomes', () => {
        expect(choosePermissionOption([allow], 'cancelled')).toBeUndefined()
        expect(choosePermissionOption([allow], 'unavailable')).toBeUndefined()
    })
})

describe('permissionResponse', () => {
    it('returns the selected option for a grant', () => {
        expect(permissionResponse(request([allow, reject]), 'allowed-once')).toEqual({
            outcome: { outcome: 'selected', optionId: 'allow-once' },
        })
    })

    it('returns the selected reject option for a rejection', () => {
        expect(permissionResponse(request([allow, reject]), 'rejected')).toEqual({
            outcome: { outcome: 'selected', optionId: 'reject-once' },
        })
    })

    it('cancels when the agent offered no usable option', () => {
        expect(permissionResponse(request([]), 'allowed-once')).toEqual({ outcome: { outcome: 'cancelled' } })
        expect(permissionResponse(request([allow]), 'unavailable')).toEqual({ outcome: { outcome: 'cancelled' } })
    })
})
