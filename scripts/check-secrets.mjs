#!/usr/bin/env node
/**
 * High-confidence secret scan for tracked files and unpushed commits.
 *
 * This is deliberately narrower than a general entropy scanner: it catches
 * credential formats this repository has actually risked, plus environment
 * paths that should never be committed. It scans `git ls-files`, so build
 * output and node_modules are excluded, and it scans `origin/main..HEAD` when
 * that range exists.
 *
 * It never prints a matched value, only its location and category.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PATTERNS = [
    { name: 'Google OAuth client secret', re: /GOCSPX-[A-Za-z0-9_-]{28}/gu },
    { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/gu },
    { name: 'Google access token', re: /ya29\.[A-Za-z0-9._-]{20,}/gu },
    { name: 'OpenAI/Anthropic API key', re: /sk-(?:ant-)?[A-Za-z0-9_-]{24,}/gu },
    { name: 'GitHub token', re: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu },
    { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/gu },
    { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/gu },
    { name: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu },
    { name: 'Personal host path', re: /(?:\/home\/hlu|\/data\/data\/com\.termux\/files\/home|\/mnt\/data\/workspace)/gu },
]

/** Scan one text body; return the categories that matched. */
function categoriesOf(text) {
    const found = new Set()
    for (const pattern of PATTERNS) {
        pattern.re.lastIndex = 0
        if (pattern.re.test(text)) found.add(pattern.name)
    }
    return [...found]
}

const findings = []

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const file of files) {
    let body
    try {
        body = readFileSync(file)
    } catch {
        continue
    }
    if (body.includes(0)) continue
    const categories = categoriesOf(body.toString('utf8'))
    if (categories.length > 0) findings.push({ scope: 'working tree', file, categories })
}

let commits = []
try {
    commits = execFileSync('git', ['rev-list', 'origin/main..HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
} catch {
    commits = []
}
if (commits.length > 0) {
    const objects = execFileSync('git', ['rev-list', '--objects', ...commits], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    const seen = new Set()
    for (const line of objects) {
        const space = line.indexOf(' ')
        const oid = space === -1 ? line : line.slice(0, space)
        const path = space === -1 ? '' : line.slice(space + 1)
        if (seen.has(oid)) continue
        seen.add(oid)
        let type
        try {
            type = execFileSync('git', ['cat-file', '-t', oid], { encoding: 'utf8' }).trim()
        } catch {
            continue
        }
        if (type !== 'blob') continue
        let body
        try {
            body = execFileSync('git', ['cat-file', '-p', oid])
        } catch {
            continue
        }
        if (body.includes(0)) continue
        const categories = categoriesOf(body.toString('utf8'))
        if (categories.length > 0) findings.push({ scope: 'unpushed history', file: path || oid.slice(0, 12), categories })
    }
}

if (findings.length === 0) {
    console.log(`check-secrets: clean (${files.length} tracked files, ${commits.length} unpushed commits)`)
    process.exit(0)
}
for (const finding of findings) {
    console.error(`check-secrets: ${finding.scope} ${finding.file}: ${finding.categories.join(', ')}`)
}
console.error('check-secrets: remove the value, rotate it if it was real, and rewrite the history before pushing.')
process.exit(1)
