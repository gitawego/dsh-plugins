#!/usr/bin/env node
/**
 * Guard against host-version drift.
 *
 * A plugin that runs inside the harness is not a client of it: the harness's
 * own `node_modules` is where every `@deepseek-ai/dsh-*` service and every
 * `@earendil-works/*` library is resolved at boot. A package that *declares* one
 * of those as a runtime dependency installs a second copy, and the copy is the
 * one its code imports — so the plugin silently speaks an older protocol, an
 * older catalog, or an older endpoint than the host it is loaded into.
 *
 * That is not a hypothetical. `@gitawego/dsh-llm-provider` once pinned
 * `@earendil-works/pi-ai@0.85.1` while the host had moved to `1.5.0`. The pinned
 * build had no `x-opencode-session` header, served the retired `zen/go`
 * endpoint, and did not list the model the user was running; the plugin grew a
 * route, a transport, a header helper, a catalog feed, and a retry classifier to
 * compensate — all of it dead once the pin was corrected.
 *
 * Two rules, checked on every package:
 *
 * 1. **No host-internal package at runtime.** `@deepseek-ai/*` and
 *    `@earendil-works/*` may appear in `devDependencies` (for types) or
 *    `peerDependencies`, never in `dependencies`.
 * 2. **Every declaration must accept the host that is actually installed.**
 *    Ranges are the normal case (`^0.2.2-rc.1`), and exact pins are also
 *    accepted. A declaration that cannot accept the resolved host copy fails,
 *    because the plugin would either install a second incompatible copy or
 *    declare a peer that the running harness cannot satisfy. The lockfile still
 *    pins the build a package was tested against; the range is the compatibility
 *    contract, not a promise that every future host was tested.
 *
 * Usage:
 *   node scripts/check-host-pins.mjs            # check
 *   node scripts/check-host-pins.mjs --fix      # widen failing declarations
 *   node scripts/check-host-pins.mjs --host /path/to/@deepseek-ai/dsh
 *
 * Exit code 1 on any violation, so `pnpm check` fails a build rather than
 * letting a stale pin reach a profile.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_PACKAGE = '@deepseek-ai/dsh'

/** Dependency sections in the order they are reported. */
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies']

/** Read one JSON file, or undefined when it is absent. */
function readJson(path) {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
}

/** Whether a name belongs to the harness itself. */
function isHostInternal(name) {
    return name.startsWith('@deepseek-ai/') || name.startsWith('@earendil-works/')
}

/** Find an executable on PATH without assuming a user's home or Node install. */
function findOnPath(name) {
    for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
        if (directory.length === 0) continue
        const candidate = join(directory, name)
        try {
            accessSync(candidate, constants.X_OK)
            return candidate
        } catch {
            /* keep looking */
        }
    }
    return undefined
}

/** Locate the harness installation. */
function findHost(explicit) {
    const candidates = []
    if (explicit !== undefined) candidates.push(explicit)
    if (process.env['DSH_HOST'] !== undefined) candidates.push(process.env['DSH_HOST'])
    // The profile resolves the harness it boots; prefer the one in use.
    const profiles = join(process.env['HOME'] ?? '', '.dsh', 'profiles')
    if (existsSync(profiles)) {
        for (const entry of readdirSync(profiles)) candidates.push(join(profiles, entry, 'node_modules', HOST_PACKAGE))
    }
    // The running Node prefix contains the global harness package.
    candidates.push(resolve(process.execPath, '..', '..', 'lib', 'node_modules', HOST_PACKAGE))
    // `which dsh` → the package root above its bin, if PATH points there.
    const bin = process.env['DSH_BIN'] ?? findOnPath('dsh')
    if (bin !== undefined && existsSync(bin)) candidates.push(resolve(bin, '..', '..', 'lib', 'node_modules', HOST_PACKAGE))

    for (const candidate of candidates) {
        const pkg = readJson(join(candidate, 'package.json'))
        if (pkg?.name === HOST_PACKAGE) return candidate
    }
    return undefined
}

/** Parse `^1.2.3`, `~1.2.3`, `1.2.3`, `1.x`, `*` into a matcher. */
function satisfies(version, range) {
    const clean = String(range).trim()
    if (clean === '*' || clean === 'latest') return true
    const parse = (text) => {
        const match = /^[~^]?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/u.exec(text)
        if (match === null) return undefined
        return [Number(match[1]), match[2] === undefined || /[xX*]/u.test(match[2]) ? undefined : Number(match[2]), match[3] === undefined || /[xX*]/u.test(match[3]) ? undefined : Number(match[3])]
    }
    const wanted = parse(clean)
    const actual = parse(version)
    if (wanted === undefined || actual === undefined) return false
    const [aMajor, aMinor = 0, aPatch = 0] = actual
    const [wMajor, wMinor, wPatch] = wanted
    if (clean.startsWith('^')) {
        if (aMajor !== wMajor) return false
        // Caret: anything below the next major (0.x behaves like tilde).
        if (wMajor !== 0) return true
        return wMinor === undefined || (aMinor === wMinor && (wPatch === undefined || aPatch >= wPatch))
    }
    if (clean.startsWith('~')) {
        return aMajor === wMajor && (wMinor === undefined || aMinor === wMinor) && (wPatch === undefined || aPatch >= wPatch)
    }
    return aMajor === wMajor && (wMinor === undefined || aMinor === wMinor) && (wPatch === undefined || aPatch === wPatch)
}

/** The version the host resolves for a package, or undefined. */
function hostVersion(hostDir, name) {
    // Direct dependency of the harness, then hoisted one level up (pnpm store).
    const direct = readJson(join(hostDir, 'node_modules', name, 'package.json'))
    if (direct !== undefined) return direct.version
    const hoisted = readJson(join(hostDir, '..', '..', name, 'package.json'))
    return hoisted?.version
}

/**
 * The version this workspace builds a package against.
 *
 * Browser-side `@deepseek-ai/dsh-client-*` packages are not installed in the
 * server tree: they ship inside the web app's client bundle, and a plugin only
 * *types* against them. Their version therefore has to be checked against the
 * copy the workspace resolves, and held to the harness release that bundle
 * belongs to.
 */
function workspaceVersion(manifestPath, name) {
    const local = readJson(join(dirname(manifestPath), 'node_modules', name, 'package.json'))
    return local?.version
}

/** Every workspace package's manifest, in name order. */
function workspacePackages() {
    const dir = join(ROOT, 'packages')
    return readdirSync(dir)
        .map((entry) => join(dir, entry, 'package.json'))
        .filter((path) => existsSync(path))
        .map((path) => ({ path, manifest: readJson(path) }))
        .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
}

/** Report one violation. */
const violations = []
function fail(pkg, message) {
    violations.push({ pkg, message })
}

const hostArgIndex = process.argv.indexOf('--host')
const hostDir = findHost(hostArgIndex === -1 ? undefined : process.argv[hostArgIndex + 1])
const fix = process.argv.includes('--fix')

if (hostDir === undefined) {
    console.error('check-host-pins: could not locate the @deepseek-ai/dsh installation.')
    console.error('Pass --host /path/to/node_modules/@deepseek-ai/dsh or set DSH_HOST.')
    process.exit(2)
}

const host = readJson(join(hostDir, 'package.json'))
console.log(`check-host-pins: host ${HOST_PACKAGE}@${host.version} at ${hostDir}`)

for (const { path, manifest } of workspacePackages()) {
    let changed = false
    for (const section of SECTIONS) {
        const entries = manifest[section] ?? {}
        for (const [name, declared] of Object.entries(entries)) {
            if (!isHostInternal(name)) continue

            // Rule 1: nothing host-internal ships at runtime.
            if (section === 'dependencies') {
                fail(manifest.name, `${section}.${name} = "${declared}": the harness provides this at runtime; a runtime dependency installs a second copy. Move it to devDependencies (types) or peerDependencies.`)
                continue
            }

            const fromHost = hostVersion(hostDir, name)
            const fromWorkspace = workspaceVersion(path, name)
            const pinned = fromHost ?? fromWorkspace
            if (pinned === undefined) {
                fail(manifest.name, `${section}.${name} = "${declared}": neither the host nor this workspace installs it, so nothing can provide it at runtime.`)
                continue
            }
            // A browser-side package ships with the harness release whose client
            // bundle serves it. The range must cover both the copy this workspace
            // builds against and the release that will serve it.
            if (fromHost === undefined && name.startsWith('@deepseek-ai/dsh-')) {
                if (satisfies(pinned, declared) && satisfies(host.version, declared)) continue
                if (fix) {
                    entries[name] = `^${host.version}`
                    changed = true
                    console.log(`  fixed ${manifest.name}: ${section}.${name} ${declared} → ^${host.version}`)
                } else {
                    fail(manifest.name, `${section}.${name} = "${declared}" does not accept workspace ${pinned} and host ${host.version}; widen the range or run \`pnpm check:pins --fix\`.`)
                }
                continue
            }

            // Rule 2: the declaration is a compatibility contract; the installed
            // host copy has to satisfy it.
            if (satisfies(pinned, declared)) continue
            if (fix) {
                entries[name] = `^${pinned}`
                changed = true
                console.log(`  fixed ${manifest.name}: ${section}.${name} ${declared} → ^${pinned}`)
            } else {
                fail(manifest.name, `${section}.${name} = "${declared}" does not accept the resolved ${name}@${pinned}. Widen the range or run \`pnpm check:pins --fix\`.`)
            }
        }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(manifest, null, 4)}\n`)
}

if (violations.length > 0) {
    console.error(`\ncheck-host-pins: ${violations.length} violation(s)\n`)
    for (const violation of violations) console.error(`  ✗ ${violation.pkg}\n    ${violation.message}`)
    console.error('\nWhy this matters: a plugin runs inside the harness process, so a host package it declares is a *second copy* — an older protocol, catalog, or endpoint than the host it loads into.')
    process.exit(1)
}

console.log(`check-host-pins: ${workspacePackages().length} package(s) agree with the host.`)
