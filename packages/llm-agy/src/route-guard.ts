/**
 * Loopback trust rules shared by the quota and account routes.
 *
 * These routes expose local CLI state to the browser. They follow the host's
 * `/api` bridge rules: the `Host` must be loopback, a cross-site fetch is
 * refused, and an `Origin` that disagrees with `Host` is refused. Mutations add
 * two requirements a cross-origin page cannot satisfy: a JSON content type
 * (which forces a CORS preflight) and a custom request header.
 *
 * @module @gitawego/dsh-llm-agy/route-guard
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Header the browser client sets on every mutating account request. */
export const MUTATION_HEADER = 'x-dsh-llm-agy'

/** Required value for {@link MUTATION_HEADER}. */
export const MUTATION_HEADER_VALUE = '1'

/** Request facts used by the trust decisions. */
export interface RequestFacts {
    method?: string | undefined
    host?: string | undefined
    origin?: string | undefined
    secFetchSite?: string | undefined
    contentType?: string | undefined
    requestHeader?: string | undefined
}

/** Read one header, taking the first value of a repeated header. */
export function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
}

/** Whether a hostname is a loopback (or wildcard-bind) literal. */
export function isLoopback(hostname: string): boolean {
    const bare = hostname.startsWith('[') ? hostname.slice(1, hostname.indexOf(']')) : hostname
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1' || bare === '0.0.0.0'
}

/** Parse the Host authority and confirm it is loopback. */
function loopbackAuthority(host: string | undefined): URL | undefined {
    if (host === undefined || host.length === 0) return undefined
    try {
        const authority = new URL(`http://${host}`)
        return isLoopback(authority.hostname) ? authority : undefined
    } catch {
        return undefined
    }
}

/** Whether an Origin header agrees with the Host authority. */
function originMatches(origin: string | undefined, authority: URL): boolean {
    if (origin === undefined) return true
    try {
        return new URL(origin).host === authority.host
    } catch {
        return false
    }
}

/** Whether one GET may read local state. */
export function isTrustedLocalRequest(facts: RequestFacts): boolean {
    if (facts.method !== 'GET') return false
    const authority = loopbackAuthority(facts.host)
    if (authority === undefined) return false
    if (facts.secFetchSite === 'cross-site') return false
    return originMatches(facts.origin, authority)
}

/** Whether one POST may change local state. */
export function isTrustedLocalMutation(facts: RequestFacts): boolean {
    if (facts.method !== 'POST') return false
    const authority = loopbackAuthority(facts.host)
    if (authority === undefined) return false
    if (facts.secFetchSite === 'cross-site') return false
    if (!originMatches(facts.origin, authority)) return false
    if (facts.requestHeader !== MUTATION_HEADER_VALUE) return false
    const type = facts.contentType?.toLowerCase() ?? ''
    return type.startsWith('application/json')
}

/** Write one JSON response with no-store caching. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
    })
    res.end(text)
}

/** Read a bounded JSON request body. */
export async function readJsonBody(req: IncomingMessage, limit = 32 * 1024): Promise<unknown> {
    const declared = Number(header(req, 'content-length') ?? 0)
    if (Number.isFinite(declared) && declared > limit) throw new Error('request body is too large')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > limit) throw new Error('request body is too large')
        chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text.length === 0) return undefined
    try {
        return JSON.parse(text)
    } catch {
        throw new Error('request body is not valid JSON')
    }
}
