/**
 * Pure type declarations for the Remote namespaces this client half uses.
 *
 * `dsh-credentials` ships the credentials *service* types but no generated
 * Remote contribution in this host build, so `ctx.remote.credentials` exists at
 * runtime (the shipped Models page calls exactly `describe`/`set`/`unset`) and
 * has no declaration to type it. Declaring it here keeps that gap local and
 * typed, in the same spirit as the slot-map augmentation in `index.tsx`: types
 * only, no value import, so nothing of the host's chrome is pulled into this
 * bundle.
 *
 * The shapes are taken from the shipped consumer, not invented:
 *
 * ```ts
 * const response = await ctx.remote.credentials.describe([ref])
 * const info = response.ok ? response.value[ref] : undefined
 * const written = await ctx.remote.credentials.set(ref, value)
 * ```
 *
 * @module @gitawego/dsh-llm-provider/client/remote-types
 */
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { CredentialInfo, RemoteResult } from './remote-type-imports.ts'

declare module '@deepseek-ai/dsh-api-gateway/client' {
    interface ClientRemote {
        /** Provider-managed credential references, read and written by name. */
        credentials: {
            /**
             * Describe several references at once.
             * @param refs - reference names to look up.
             * @returns a map from reference name to its state.
             */
            describe(refs: readonly string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>
            /**
             * Store a literal value under one reference.
             * @param ref - reference name.
             * @param value - the secret to store.
             * @returns the write outcome.
             */
            set(ref: string, value: string): Promise<RemoteResult<unknown>>
            /**
             * Remove the stored value of one reference.
             * @param ref - reference name.
             * @returns the removal outcome.
             */
            unset(ref: string): Promise<RemoteResult<unknown>>
        }
    }
}
