/**
 * @gitawego/dsh-llm-agy — the Antigravity (`agy`) ACP provider for DSH.
 *
 * `apply()` registers one route, `agy`, at the `ctx.llm` adapter seam. The
 * route drives `agy acp` as an agent-delegate: the CLI brings its own tools and
 * Google/Antigravity login, while DSH sees the agent's text/reasoning stream.
 *
 * The plugin never stores or reads a credential. The only host services it
 * touches are optional lookups: `sessions`/`workingDirectory` for the session's
 * cwd, and `agents`/`approval` to route ACP tool permission questions into the
 * normal DSH approval UI. Missing services degrade to `process.cwd()` and a
 * fail-closed permission decision.
 *
 * @module @gitawego/dsh-llm-agy
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { LlmError, type ImageBlock, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, type AgyHost } from './adapter.ts'
import { readAgyQuota, type AgyQuota } from './quota.ts'
import { registerAgyQuotaRoute } from './quota-route.ts'
import {
    AGY_PROVIDER,
    AGY_SETTINGS_NAMESPACE,
    Config,
    DEFAULT_COMMAND,
    DEFAULT_DISPLAY_NAME,
    DEFAULT_MODEL,
    DEFAULT_QUOTA_COMMAND,
    readConfig,
    resolveConfig,
    type AgyConfigRefs,
    type AgyMode,
    type AgyPermissionMode,
    type ResolvedAgyConfig,
} from './config.ts'

/** Plugin display name for diagnostics. */
export const name = '@gitawego/dsh-llm-agy'

/** The only service required at load time; all others are optional lookups. */
export const inject = ['llm']

export {
    Config,
    AGY_PROVIDER,
    AGY_SETTINGS_NAMESPACE,
    DEFAULT_COMMAND,
    DEFAULT_DISPLAY_NAME,
    DEFAULT_MODEL,
    DEFAULT_QUOTA_COMMAND,
}
export { readConfig, resolveConfig, type AgyConfigRefs, type AgyMode, type AgyPermissionMode, type ResolvedAgyConfig }
export { parseAgyUsage, readAgyQuota, type AgyQuota, type AgyQuotaWindow } from './quota.ts'
export { AGY_QUOTA_ROUTE_PATH, createAgyQuotaHandler, isTrustedLocalRequest, registerAgyQuotaRoute } from './quota-route.ts'
export { AgyAdapter, type AgyHost }
export { AcpClient, AcpAbortError, AcpProcessError, AcpRemoteError, AcpTimeoutError } from './acp-client.ts'
export { AcpSession } from './acp-session.ts'
export { configCatalog, sessionCatalog, type Catalog, type CatalogEffort, type CatalogModel, type ConfiguredModel } from './catalog.ts'
export { classifyAcpError, authMessage } from './errors.ts'
export { mapAcpUsage } from './usage.ts'
export { permissionResponse, choosePermissionOption, permissionToolName, permissionReason } from './permissions.ts'
export { ChunkTranslator, finishReason } from './stream.ts'

/**
 * Mount the `agy` route.
 * @param ctx - the plugin context.
 * @param config - the loader-supplied volatile configuration references.
 * @returns a disposer that unregisters the route and closes every session.
 */
export function apply(ctx: Context, config: AgyConfigRefs | undefined = undefined): () => void {
    const adapter = new AgyAdapter({ host: createAgyHost(ctx, config), config: () => readConfig(config) })
    const registration = ctx.llm.registerAdapter([AGY_PROVIDER], adapter)

    let quotaCache: { at: number; value: AgyQuota } | undefined
    const quotaOf = async (force: boolean): Promise<AgyQuota> => {
        const current = readConfig(config)
        if (!force && quotaCache !== undefined && Date.now() - quotaCache.at < current.quotaRefreshMinutes * 60_000) {
            return quotaCache.value
        }
        const value = await readAgyQuota({
            command: current.quotaCommand,
            cwd: current.cwd || process.cwd(),
            timeoutMs: Math.min(current.promptTimeoutMs, 90_000),
        })
        quotaCache = { at: Date.now(), value }
        return value
    }
    registerAgyQuotaRoute(ctx, { quotaOf })

    return () => {
        registration()
        void adapter.dispose()
    }
}

/**
 * Adapt the Cordis context into the narrow host seam the adapter consumes.
 * Every service except `llm` is optional: a profile without approvals or
 * working-directory support still loads, with cwd fallback and fail-closed
 * permissions.
 */
export function createAgyHost(ctx: Context, config: AgyConfigRefs | undefined): AgyHost {
    const logger = ctx.logger(name)
    return {
        logger: {
            debug: (message, ...args) => logger.debug(message, ...args),
            warn: (message, ...args) => logger.warn(message, ...args),
        },
        resolveCwd(sessionId?: string): string {
            const sessions = ctx.get('sessions')
            const session = sessionId === undefined ? undefined : sessions?.get(sessionId as SessionId)
            if (session !== undefined) {
                const workingDirectory = ctx.get('workingDirectory')
                if (workingDirectory !== undefined) return workingDirectory.get(session)
                if (session.header.cwd !== undefined && session.header.cwd.length > 0) return session.header.cwd
            }
            return readConfig(config).cwd || process.cwd()
        },
        async readImage(ref: ImageBlock['attachment'], signal?: AbortSignal) {
            const attachments = ctx.get('attachments') as {
                readImageRequest: (
                    attachment: ImageBlock['attachment'],
                    target: { width: number; height: number; maxBytes: number },
                    signal?: AbortSignal,
                ) => Promise<{ data: Uint8Array; mediaType: string }>
            } | undefined
            if (attachments === undefined) {
                throw new LlmError(
                    'Antigravity image input requires the durable attachment service',
                    'UNSUPPORTED_CONTENT',
                )
            }
            const image = await attachments.readImageRequest(
                ref,
                { width: 2048, height: 2048, maxBytes: 4 * 1024 * 1024 },
                signal,
            )
            return { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType }
        },
        async requestApproval(input) {
            const approval = ctx.get('approval')
            const agents = ctx.get('agents')
            if (approval === undefined || agents === undefined) return 'unavailable'
            const agent = agents.currentInitiator() ?? (input.sessionId === undefined ? undefined : agents.get(input.sessionId as SessionId))
            if (agent === undefined) return 'unavailable'
            return approval.request({
                agent,
                toolName: input.toolName,
                ...(input.callId !== undefined ? { callId: input.callId as ToolCallId } : {}),
                ...(input.reason !== undefined ? { reason: input.reason } : {}),
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
            })
        },
    }
}
