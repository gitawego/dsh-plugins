/**
 * The settings section's logic, split from its view.
 *
 * Carries no JSX: the server project typechecks `tests/`, and a test importing a
 * `.tsx` module would need a `jsx` option that project does not set.
 *
 * @module @gitawego/dsh-llm-provider/client/section-face
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares `ctx.locale`, which this module reads.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MonitorProfile } from '../config.ts'
import { createDashboard, type DashboardSnapshot, type DashboardActions } from './controller.ts'
import { en } from './strings.ts'

/** Settings namespace this section owns; also the slot keys it registers. */
export const NS = 'llm-provider'

/** Copy lookup bound to the plugin's namespace. */
export type Translate = (key: keyof typeof en) => string

/** What the section's slot entry injects. */
export interface LlmProvidersFace {
    hooks: { dashboard: { getSnapshot: () => DashboardSnapshot; subscribe: (listener: () => void) => () => void } }
    t: Translate
    actions: DashboardActions
}

/**
 * Build the section's face.
 * @param ctx - the client context.
 * @param scope - the `llm-provider` entry's config form.
 * @returns the section's injected face.
 */
export function createSectionFace(ctx: ClientContext, scope: ConfigForm<MonitorProfile>): LlmProvidersFace {
    const t = ctx.locale.bind(NS) as unknown as Translate
    const dashboard = createDashboard(ctx, scope)
    return {
        hooks: { dashboard: { getSnapshot: dashboard.getSnapshot, subscribe: dashboard.subscribe } },
        t,
        actions: dashboard.actions,
    }
}
