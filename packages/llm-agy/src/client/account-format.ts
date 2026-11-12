/**
 * Pure parsing for the account routes' browser payloads.
 *
 * The card treats every response as untrusted input: a malformed row is
 * dropped, and an unknown source collapses to `keyring` rather than becoming
 * a rendered string.
 *
 * @module @gitawego/dsh-llm-agy/client/account-format
 */

/** Where a saved credential came from. */
export type AccountSource = 'keyring' | 'login'

/** One account row. */
export interface AccountView {
    id: string
    identity: string
    label?: string
    source: AccountSource
    active: boolean
}

/** The account list payload. */
export interface AccountListView {
    accounts: AccountView[]
    activeEmail?: string
}

/** The sign-in start payload. */
export interface LoginView {
    loginId: string
    url: string
}

/** Poll result for one sign-in. */
export type LoginStatusView =
    | { status: 'pending' }
    | { status: 'success'; accounts: AccountView[]; activeEmail?: string }
    | { status: 'error'; error: string }

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Parse `GET /llm-agy/accounts`.
 * @param payload - the decoded body.
 * @returns the view, or undefined when the body is not an object.
 */
export function parseAccountList(payload: unknown): AccountListView | undefined {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const raw = payload as Record<string, unknown>
    const accounts: AccountView[] = []
    for (const entry of Array.isArray(raw['accounts']) ? raw['accounts'] : []) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const row = entry as Record<string, unknown>
        const id = str(row['id'])
        const identity = str(row['identity'])
        if (id === undefined || identity === undefined) continue
        const label = str(row['label'])
        accounts.push({
            id,
            identity,
            ...(label !== undefined ? { label } : {}),
            source: row['source'] === 'login' ? 'login' : 'keyring',
            active: row['active'] === true,
        })
    }
    const activeEmail = str(raw['activeEmail'])
    return {
        accounts,
        ...(activeEmail !== undefined ? { activeEmail } : {}),
    }
}

/**
 * Parse the sign-in start payload.
 * @param payload - the decoded body.
 * @returns the view, or undefined when the URL is missing.
 */
export function parseLoginStart(payload: unknown): LoginView | undefined {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const raw = payload as Record<string, unknown>
    const loginId = str(raw['loginId'])
    const url = str(raw['url'])
    if (loginId === undefined || url === undefined) return undefined
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return undefined
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') return undefined
    return { loginId, url }
}

/**
 * Parse `GET /llm-agy/accounts/login/status`.
 * @param payload - the decoded body.
 * @returns the status, or undefined when the body is unusable.
 */
export function parseLoginStatus(payload: unknown): LoginStatusView | undefined {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const raw = payload as Record<string, unknown>
    if (raw['status'] === 'pending') return { status: 'pending' }
    if (raw['status'] === 'error') {
        return { status: 'error', error: str(raw['error']) ?? 'sign-in failed' }
    }
    if (raw['status'] === 'success') {
        const list = parseAccountList(raw)
        if (list === undefined) return undefined
        return {
            status: 'success',
            accounts: list.accounts,
            ...(list.activeEmail !== undefined ? { activeEmail: list.activeEmail } : {}),
        }
    }
    return undefined
}
