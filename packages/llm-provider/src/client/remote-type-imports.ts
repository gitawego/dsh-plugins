/**
 * Type-only re-exports of the Remote carrier's vocabulary.
 *
 * Kept in its own module so `remote-types.ts` states one augmentation and
 * nothing else, and so the imports stay type-only (required by the bundle-purity
 * rule: this client half may not pull host chrome in as values).
 *
 * @module @gitawego/dsh-llm-provider/client/remote-type-imports
 */
export type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
export type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
