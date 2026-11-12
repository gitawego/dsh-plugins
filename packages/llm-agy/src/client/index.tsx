/**
 * Antigravity section for Settings → Antigravity.
 *
 * The account list and quota come from guarded loopback routes owned by the
 * plugin; this half renders the active account, one-click switching, the
 * Google sign-in exchange, and the grouped quota buckets with the same meter
 * language as the OpenCode Go card.
 *
 * @module @gitawego/dsh-llm-agy/client
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { parseAccountList, parseLoginStart, parseLoginStatus, sortAccountViews, type AccountView, type LoginView } from './account-format.ts'
import { formatCountdown, geminiQuota, labelFor, parseQuotaView, toneFor, type QuotaView, type QuotaWindow } from './quota-format.ts'
import { en, zh, type Translate } from './strings.ts'

/** Paths served by the host half. */
const QUOTA_PATH = '/llm-agy/quota'
const ACCOUNTS_PATH = '/llm-agy/accounts'
const ACCOUNT_QUOTA_PATH = '/llm-agy/accounts/quota'
const SWITCH_PATH = '/llm-agy/accounts/switch'
const LOGIN_PATH = '/llm-agy/accounts/login'
const LOGIN_STATUS_PATH = '/llm-agy/accounts/login/status'
const LOGIN_CANCEL_PATH = '/llm-agy/accounts/login/cancel'

const NS = 'llm-agy-quota'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'llm-agy-quota': keyof typeof en
    }
}

const CSS = `
.aq-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.aq-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.aq-title{margin:0;font-size:15px;font-weight:600}
.aq-intro{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.aq-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.aq-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.aq-btn:disabled{opacity:.45;cursor:default}
.aq-group{display:flex;flex-direction:column;gap:6px}
.aq-group h3{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.aq-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.aq-row{display:grid;grid-template-columns:minmax(150px,1.2fr) minmax(80px,1fr) 66px 82px;align-items:center;gap:10px}
.aq-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.aq-track{height:8px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.aq-fill{display:block;height:100%;min-width:2px;border-radius:999px;background:var(--dsw-alias-state-success-primary);transition:width .18s ease}
.aq-row[data-tone="warn"] .aq-fill{background:var(--dsw-alias-state-warn-primary)}
.aq-row[data-tone="critical"] .aq-fill{background:var(--dsw-alias-state-error-primary)}
.aq-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}
.aq-row[data-tone="warn"] .aq-value{color:var(--dsw-alias-state-warn-primary)}
.aq-row[data-tone="critical"] .aq-value{color:var(--dsw-alias-state-error-primary)}
.aq-reset{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}
.aq-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.aq-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.aq-divider{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}
.aq-view-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.aq-accounts{display:flex;flex-direction:column;gap:8px}
.aq-accounts-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.aq-accounts h3{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.aq-account-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.aq-account{display:grid;grid-template-columns:8px minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.aq-account[data-active="true"]{border-color:var(--dsw-alias-brand-primary)}
.aq-account-mark{width:8px;height:8px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2)}
.aq-account[data-active="true"] .aq-account-mark{background:var(--dsw-alias-brand-primary);border-color:transparent}
.aq-account-id{display:flex;flex-direction:column;gap:1px;min-width:0;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aq-account-id small{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aq-account-quota{padding:0;border:0;background:none;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
.aq-account-quota:hover{color:var(--dsw-alias-label-primary)}
.aq-account-quota[data-selected="true"]{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.aq-account-quota[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.aq-account-quota[data-tone="critical"]{color:var(--dsw-alias-state-error-primary)}
.aq-account-actions{display:flex;align-items:center;gap:6px}
.aq-pill{flex:none;padding:2px 8px;border:1px solid var(--dsw-alias-brand-primary);border-radius:999px;color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px;white-space:nowrap}
.aq-btn--small{padding:2px 8px;font-size:11px;line-height:16px}
.aq-dialog{width:min(520px,92vw);padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.aq-dialog::backdrop{background:#0009}
.aq-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.aq-dialog-head h3{margin:0;font-size:15px;font-weight:600}
.aq-dialog p{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.aq-dialog p.aq-error{color:var(--dsw-alias-state-error-primary)}
.aq-link{display:inline-block;margin-top:10px;color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;word-break:break-all}
.aq-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.aq-wait{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.aq-spinner{width:10px;height:10px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:aq-spin .8s linear infinite}
@keyframes aq-spin{to{transform:rotate(360deg)}}
`

function installStyles(): () => void {
    const style = document.createElement('style')
    style.dataset['dshLlmAgy'] = 'quota'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
}

/** What the section's slot entry injects. */
interface AgyQuotaFace {
    t: Translate
}

/** Human-readable message from an unknown error. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** Read one JSON response. */
async function getJson(path: string): Promise<unknown> {
    const response = await fetch(path, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`request refused (${response.status})`)
    return response.json()
}

/** POST one JSON request with the guard's required header. */
async function postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-dsh-llm-agy': '1',
        },
        body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) {
        const error = payload !== null && typeof payload === 'object' && typeof (payload as Record<string, unknown>)['error'] === 'string'
            ? (payload as Record<string, string>)['error']
            : `request refused (${response.status})`
        throw new Error(error)
    }
    return payload
}

/** The account and quota card. */
export function AntigravityQuotaPanel(props: PropsRuntime<'settings.section'> & InjectFace<AgyQuotaFace>): JSX.Element {
    const [view, setView] = useState<QuotaView | undefined>()
    const [loading, setLoading] = useState(true)
    const [fetchedAt, setFetchedAt] = useState<number | undefined>()
    const [accounts, setAccounts] = useState<AccountView[]>([])
    const [accountQuotas, setAccountQuotas] = useState<Record<string, QuotaView | undefined>>({})
    const [accountsLoaded, setAccountsLoaded] = useState(false)
    const [accountError, setAccountError] = useState<string | undefined>()
    const [accountNote, setAccountNote] = useState<string | undefined>()
    const [switchingId, setSwitchingId] = useState<string | undefined>()
    const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>()
    const [dialogOpen, setDialogOpen] = useState(false)
    const [login, setLogin] = useState<LoginView | undefined>()
    const [loginHint, setLoginHint] = useState<string | undefined>()
    const [loginError, setLoginError] = useState<string | undefined>()
    const dialogRef = useRef<HTMLDialogElement>(null)
    const addAttempt = useRef(0)
    const lastAutoRefresh = useRef(0)

    const loadQuota = async (force: boolean): Promise<void> => {
        setLoading(true)
        try {
            const parsed = parseQuotaView(await getJson(`${QUOTA_PATH}${force ? '?refresh=1' : ''}`))
            setView(parsed)
            setFetchedAt(parsed?.fetchedAt ?? Date.now())
        } catch (error) {
            setView({ windows: [], error: messageOf(error) })
            setFetchedAt(Date.now())
        } finally {
            setLoading(false)
        }
    }

    const loadAccounts = async (): Promise<void> => {
        try {
            const parsed = parseAccountList(await getJson(ACCOUNTS_PATH))
            setAccounts(sortAccountViews(parsed?.accounts ?? []))
            setAccountsLoaded(true)
            setAccountError(undefined)
        } catch (error) {
            setAccountsLoaded(true)
            setAccountError(`${props.t('accountsFailed')}: ${messageOf(error)}`)
        }
    }

    const loadAccountQuotas = async (force: boolean, current: AccountView[]): Promise<void> => {
        const next: Record<string, QuotaView | undefined> = {}
        // Sequential on purpose: a refresh may rotate each account's token and
        // persist it, and concurrent store writes would race.
        for (const account of current) {
            try {
                const view = parseQuotaView(await getJson(`${ACCOUNT_QUOTA_PATH}?id=${encodeURIComponent(account.id)}${force ? '&refresh=1' : ''}`))
                next[account.id] = view
            } catch (error) {
                next[account.id] = { windows: [], error: messageOf(error), fetchedAt: Date.now() }
            }
        }
        setAccountQuotas(next)
    }

    useEffect(() => {
        void loadAccounts()
        void loadQuota(false)
    }, [])

    useEffect(() => {
        void loadAccountQuotas(false, accounts)
    }, [accounts])

    useEffect(() => {
        if (selectedAccountId !== undefined && !accounts.some((account) => account.id === selectedAccountId)) {
            setSelectedAccountId(undefined)
        }
    }, [accounts, selectedAccountId])

    useEffect(() => {
        const dialog = dialogRef.current
        if (dialogOpen && dialog !== null && !dialog.open) dialog.showModal()
    }, [dialogOpen])

    // Returning from the Google tab (or another window) must reconcile the
    // account list even if the dialog was closed before its last poll.
    useEffect(() => {
        const refresh = (): void => {
            if (document.visibilityState === 'hidden') return
            const now = Date.now()
            if (now - lastAutoRefresh.current < 1500) return
            lastAutoRefresh.current = now
            void loadAccounts()
            void loadQuota(false)
        }
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        const timer = window.setInterval(refresh, 10_000)
        return () => {
            window.removeEventListener('focus', refresh)
            document.removeEventListener('visibilitychange', refresh)
            window.clearInterval(timer)
        }
    }, [])

    const switchAccount = async (account: AccountView): Promise<void> => {
        setSwitchingId(account.id)
        setAccountError(undefined)
        setAccountNote(undefined)
        try {
            const parsed = parseAccountList(await postJson(SWITCH_PATH, { id: account.id }))
            if (parsed !== undefined) setAccounts(sortAccountViews(parsed.accounts))
            setSelectedAccountId(undefined)
            await loadQuota(true)
        } catch (error) {
            setAccountError(`${props.t('switchFailed')}: ${messageOf(error)}`)
        } finally {
            setSwitchingId(undefined)
        }
    }

    const openAdd = async (emailHint?: string): Promise<void> => {
        const attempt = ++addAttempt.current
        setLogin(undefined)
        setLoginHint(emailHint)
        setLoginError(undefined)
        setAccountNote(undefined)
        setDialogOpen(true)
        try {
            const parsed = parseLoginStart(await postJson(LOGIN_PATH, emailHint !== undefined ? { email: emailHint } : {}))
            if (parsed === undefined) throw new Error('unexpected sign-in response')
            if (attempt !== addAttempt.current) {
                // The dialog was cancelled while the listener was starting.
                void postJson(LOGIN_CANCEL_PATH, { loginId: parsed.loginId }).catch(() => {})
                return
            }
            setLogin(parsed)
        } catch (error) {
            if (attempt !== addAttempt.current) return
            setLoginError(`${props.t('loginFailed')}: ${messageOf(error)}`)
        }
    }

    const cancelAdd = (): void => {
        addAttempt.current += 1
        const pending = login
        setLogin(undefined)
        setLoginError(undefined)
        setDialogOpen(false)
        dialogRef.current?.close()
        if (pending !== undefined) void postJson(LOGIN_CANCEL_PATH, { loginId: pending.loginId }).catch(() => {})
        // A callback may have completed just before the cancel; reconcile.
        void loadAccounts()
    }

    useEffect(() => {
        if (!dialogOpen || login === undefined) return
        let stopped = false
        const tick = async (): Promise<void> => {
            try {
                const status = parseLoginStatus(await getJson(`${LOGIN_STATUS_PATH}?loginId=${encodeURIComponent(login.loginId)}`))
                if (stopped || status === undefined) return
                if (status.status === 'success') {
                    stopped = true
                    setAccounts(sortAccountViews(status.accounts))
                    setSelectedAccountId(undefined)
                    const email = status.activeEmail ?? loginHint
                    setAccountNote(email !== undefined && email.length > 0 ? props.t('signedIn').replace('{email}', email) : undefined)
                    setLogin(undefined)
                    setLoginError(undefined)
                    setDialogOpen(false)
                    dialogRef.current?.close()
                    await loadQuota(true)
                } else if (status.status === 'error') {
                    stopped = true
                    setLoginError(`${props.t('loginFailed')}: ${status.error}`)
                    setLogin(undefined)
                }
            } catch {
                /* a transient poll failure is retried on the next tick */
            }
        }
        void tick()
        const timer = window.setInterval(() => { void tick() }, 1000)
        return () => {
            stopped = true
            window.clearInterval(timer)
        }
    }, [dialogOpen, login])

    const selectedAccount = selectedAccountId !== undefined
        ? accounts.find((account) => account.id === selectedAccountId)
        : undefined
    const detailView = selectedAccount !== undefined && !selectedAccount.active
        ? accountQuotas[selectedAccount.id]
        : view
    const detailFetchedAt = detailView?.fetchedAt
    const groups = useMemo(() => {
        const byGroup = new Map<string, QuotaWindow[]>()
        for (const window of detailView?.windows ?? []) {
            const list = byGroup.get(window.group) ?? []
            list.push(window)
            byGroup.set(window.group, list)
        }
        return [...byGroup.entries()]
    }, [detailView])

    const now = Date.now()
    return (
        <div className="aq-card">
            <div className="aq-head">
                <div>
                    <h2 className="aq-title">{props.t('title')}</h2>
                    <p className="aq-intro">{props.t('intro')}</p>
                </div>
                <button
                    className="aq-btn"
                    type="button"
                    disabled={loading}
                    onClick={() => {
                        void loadAccounts()
                        void loadQuota(true)
                        void loadAccountQuotas(true, accounts)
                    }}
                >
                    {loading ? props.t('reading') : props.t('refresh')}
                </button>
            </div>

            <section className="aq-accounts">
                <div className="aq-accounts-head">
                    <h3>{props.t('accounts')}</h3>
                    <button className="aq-btn aq-btn--small" type="button" onClick={() => { void openAdd() }}>
                        {props.t('addAccount')}
                    </button>
                </div>
                {accounts.length > 0 ? (
                    <ul className="aq-account-list">
                        {accounts.map((account) => {
                            const quota = accountQuotas[account.id]
                            const compact = geminiQuota(quota)
                            const lowest = compact.lowest
                            const tone = lowest === undefined ? 'ok' : lowest < 20 ? 'critical' : lowest < 50 ? 'warn' : 'ok'
                            const detail = quota?.error
                                ?? (quota !== undefined && quota.windows.length > 0
                                    ? quota.windows.map((window) => `${window.group} · ${labelFor(window, props.t)}: ${window.percentRemaining}%`).join('\n')
                                    : undefined)
                            return (
                                <li className="aq-account" key={account.id} data-active={account.active}>
                                    <span className="aq-account-mark" aria-hidden="true" />
                                    <span className="aq-account-id">
                                        {account.identity}
                                        {account.label !== undefined && account.label !== account.identity ? <small>{account.label}</small> : null}
                                    </span>
                                    <button
                                        className="aq-account-quota"
                                        type="button"
                                        data-tone={tone}
                                        data-selected={!account.active && selectedAccountId === account.id}
                                        title={detail ?? props.t('viewQuota').replace('{email}', account.identity)}
                                        aria-label={props.t('viewQuota').replace('{email}', account.identity)}
                                        onClick={() => setSelectedAccountId(account.active ? undefined : account.id)}
                                    >
                                        {compact.weekly !== undefined ? `${Math.round(compact.weekly)}%` : '—'}
                                        {compact.fiveHour !== undefined ? ` · ${Math.round(compact.fiveHour)}%` : ''}
                                    </button>
                                    <span className="aq-account-actions">
                                        <button
                                            className="aq-btn aq-btn--small"
                                            type="button"
                                            onClick={() => { void openAdd(account.identity) }}
                                        >
                                            {props.t('reauth')}
                                        </button>
                                        {account.active ? (
                                            <span className="aq-pill">{props.t('active')}</span>
                                        ) : (
                                            <button
                                                className="aq-btn aq-btn--small"
                                                type="button"
                                                disabled={switchingId !== undefined}
                                                onClick={() => { void switchAccount(account) }}
                                            >
                                                {switchingId === account.id ? props.t('switching') : props.t('switchAccount')}
                                            </button>
                                        )}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                ) : accountsLoaded ? <p className="aq-hint">{props.t('noAccounts')}</p> : null}
                {accountError !== undefined ? <p className="aq-error">{accountError}</p> : null}
                {accountNote !== undefined ? <p className="aq-hint">{accountNote}</p> : null}
                <p className="aq-hint">{props.t('accountHint')}</p>
            </section>

            <div className="aq-divider" />

            {selectedAccount !== undefined && !selectedAccount.active ? (
                <div className="aq-view-head">
                    <span>{props.t('viewingQuota').replace('{email}', selectedAccount.identity)}</span>
                    <button className="aq-btn aq-btn--small" type="button" onClick={() => setSelectedAccountId(undefined)}>
                        {props.t('showActive')}
                    </button>
                </div>
            ) : null}
            {detailView?.error !== undefined ? <p className="aq-error">{`${props.t('failed')}: ${detailView.error}`}</p> : null}
            {selectedAccount !== undefined && !selectedAccount.active && detailView === undefined
                ? <p className="aq-hint">{props.t('reading')}</p>
                : null}
            {detailView !== undefined && detailView.windows.length === 0 && detailView.error === undefined ? <p className="aq-hint">{props.t('empty')}</p> : null}
            {groups.map(([group, windows]) => (
                <section className="aq-group" key={group}>
                    <h3>{group}</h3>
                    <ul className="aq-rows">
                        {windows.map((window) => {
                            const tone = toneFor(window.percentUsed)
                            const label = labelFor(window, props.t)
                            return (
                                <li className="aq-row" key={window.id} data-tone={tone}>
                                    <span className="aq-label">{label}</span>
                                    <span className="aq-track" role="img" aria-label={`${label}: ${window.percentRemaining}% left`}>
                                        <span className="aq-fill" style={{ width: `${Math.max(0, Math.min(100, window.percentUsed))}%` }} />
                                    </span>
                                    <span className="aq-value">{window.percentRemaining}{props.t('left')}</span>
                                    <span className="aq-reset">
                                        {window.resetsAt !== undefined ? formatCountdown(window.resetsAt, now, props.t) : (window.status === 'exhausted' ? props.t('exhausted') : '')}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                </section>
            ))}
            {detailFetchedAt !== undefined ? <p className="aq-hint">{props.t('readAt').replace('{time}', new Date(detailFetchedAt).toLocaleTimeString())}</p> : null}

            <dialog
                ref={dialogRef}
                className="aq-dialog"
                onCancel={(event) => {
                    event.preventDefault()
                    cancelAdd()
                }}
                onClose={() => {
                    addAttempt.current += 1
                    setDialogOpen(false)
                    setLogin(undefined)
                    setLoginError(undefined)
                    void loadAccounts()
                }}
            >
                <div className="aq-dialog-head">
                    <h3>
                        {loginHint !== undefined
                            ? props.t('reauthTitle').replace('{email}', loginHint)
                            : props.t('addTitle')}
                    </h3>
                    <button className="aq-btn aq-btn--small" type="button" aria-label={props.t('close')} onClick={cancelAdd}>×</button>
                </div>
                {loginError !== undefined ? <p className="aq-error">{loginError}</p> : null}
                {login !== undefined ? (
                    <>
                        <p>{props.t('addIntro')}</p>
                        <a className="aq-link" href={login.url} target="_blank" rel="noreferrer noopener">{props.t('openSignIn')}</a>
                        <div className="aq-wait">
                            <span className="aq-spinner" aria-hidden="true" />
                            <span>{props.t('waitingCallback')}</span>
                        </div>
                    </>
                ) : loginError === undefined ? <p>{props.t('waitingLink')}</p> : null}
                <div className="aq-dialog-actions">
                    <button className="aq-btn" type="button" onClick={cancelAdd}>{props.t('cancel')}</button>
                </div>
            </dialog>
        </div>
    )
}

/** Services required by the client half. */
export const inject = ['slots', 'locale']

/** Mount the section. */
export function apply(ctx: ClientContext): void {
    ctx.effect(installStyles, 'llm-agy: quota styles')
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'llm-agy: quota locale')
    const t = ctx.locale.bind(NS)
    const face: AgyQuotaFace = { t }
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'llm-agy-quota',
        order: 51,
        label: () => t('nav'),
        locale: NS,
        inject: () => face,
    }, AntigravityQuotaPanel as never))
}

export type { QuotaView, QuotaWindow }
