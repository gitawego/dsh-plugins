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
