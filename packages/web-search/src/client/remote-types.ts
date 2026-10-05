/**
 * Pure type declaration for the credentials Remote namespace.
 *
 * `dsh-credentials` ships the credentials *service* types but no generated
 * Remote contribution in this host build, so `ctx.remote.credentials` exists at
 * runtime (the shipped Models page calls exactly `describe`/`set`/`unset`) with
 * no declaration to type it. Declaring it here keeps that gap local and typed:
 * types only, no value import, so nothing of the host's chrome enters the
 * bundle.
 *
 * The shapes come from the shipped consumer, not from invention:
 *
 * ```ts
 * const response = await ctx.remote.credentials.describe([ref])
 * const info = response.ok ? response.value[ref] : undefined
 * const written = await ctx.remote.credentials.set(ref, value)
 * ```
 *
 * @module @gitawego/dsh-web-search/client/remote-types
 */
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { CredentialInfo, RemoteResult } from './remote-type-imports.ts'

declare module '@deepseek-ai/dsh-api-gateway/client' {
    interface ClientRemote {
        /** Provider-managed credential references, read and written by name. */
        credentials: {
            describe(refs: readonly string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>
            set(ref: string, value: string): Promise<RemoteResult<unknown>>
            unset(ref: string): Promise<RemoteResult<unknown>>
        }
    }
}
