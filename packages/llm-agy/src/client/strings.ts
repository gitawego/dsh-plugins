/**
 * Copy for the Antigravity quota section.
 *
 * Kept apart from the view so the pure formatter can be tested without a JSX
 * project, and so the dictionary is the single source of the `Translate` key
 * domain.
 *
 * @module @gitawego/dsh-llm-agy/client/strings
 */

export const en = {
    nav: 'Antigravity',
    title: 'Antigravity (Gemini)',
    intro: 'Plan quota reported by the Antigravity CLI for Gemini, Claude/GPT, and Argon.',
    refresh: 'Refresh',
    reading: 'Reading quota…',
    accounts: 'Accounts',
    addAccount: 'Add account',
    active: 'Active',
    switchAccount: 'Switch',
    switching: 'Switching…',
    accountHint: 'The next prompt uses the active account.',
    noAccounts: 'No accounts yet.',
    addTitle: 'Add Antigravity account',
    addIntro: 'Sign in with Google, then paste the authorization code or the final redirect URL.',
    openSignIn: 'Open Google sign-in',
    waitingLink: 'Starting Google sign-in…',
    codeLabel: 'Authorization code or final URL',
    finish: 'Finish sign-in',
    cancel: 'Cancel',
    signingIn: 'Signing in…',
    signedIn: 'Signed in as {email}',
    switchFailed: 'Could not switch account',
    loginFailed: 'Could not sign in',
    accountsFailed: 'Could not read accounts',
    close: 'Close',
    empty: 'No quota reported.',
    exhausted: 'exhausted',
    failed: 'Could not read quota',
    left: '% left',
    weekly: 'Weekly limit',
    fiveHour: 'Five-hour limit',
    readAt: 'read {time}',
    resetting: 'resetting',
    inMinutes: 'in {n}m',
    inHours: 'in {n}h {m}m',
    inDays: 'in {n}d {h}h',
}

export const zh: typeof en = {
    nav: 'Antigravity',
    title: 'Antigravity（Gemini）',
    intro: '由 Antigravity CLI 汇报的 Gemini、Claude/GPT 与 Argon 套餐额度。',
    refresh: '刷新',
    reading: '正在读取额度…',
    accounts: '账户',
    addAccount: '添加账户',
    active: '当前',
    switchAccount: '切换',
    switching: '正在切换…',
    accountHint: '下一次对话将使用当前账户。',
    noAccounts: '还没有账户。',
    addTitle: '添加 Antigravity 账户',
    addIntro: '在浏览器中登录 Google，然后粘贴授权码或跳转后的完整网址。',
    openSignIn: '打开 Google 登录',
    waitingLink: '正在启动 Google 登录…',
    codeLabel: '授权码或最终网址',
    finish: '完成登录',
    cancel: '取消',
    signingIn: '正在登录…',
    signedIn: '已登录：{email}',
    switchFailed: '无法切换账户',
    loginFailed: '无法登录',
    accountsFailed: '无法读取账户',
    close: '关闭',
    empty: '未读取到额度。',
    exhausted: '已用尽',
    failed: '无法读取额度',
    left: '% 剩余',
    weekly: '每周额度',
    fiveHour: '五小时额度',
    readAt: '读取于 {time}',
    resetting: '即将重置',
    inMinutes: '{n} 分钟后',
    inHours: '{n} 小时 {m} 分后',
    inDays: '{n} 天 {h} 小时后',
}

/** Copy lookup bound to the section's namespace. */
export type Translate = (key: keyof typeof en) => string
