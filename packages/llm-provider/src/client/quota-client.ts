/**
 * Reading quota from the host for the settings card.
 *
 * The tool card gets its payload from `presentationMeta`; the card has to ask,
 * and the only path is the plugin's guarded local route (see
 * `src/quota-route.ts` for why there is no seam). Same payload shape either way,
 * so both surfaces parse with one function.
 *
 * @module @gitawego/dsh-llm-provider/client/quota-client
 */
import { QUOTA_ROUTE_PATH } from '../quota-path.ts'
import { parseQuotaView, type QuotaView } from './quota-format.ts'

/** Fetch one route's quota from the host. */
export type QuotaReader = (route: string) => Promise<QuotaView>

/**
 * Build the reader.
 * @param fetchImpl - fetch implementation; defaults to the global one.
 * @returns a reader that resolves the parsed report, or throws with a reason.
 */
export function createQuotaReader(fetchImpl?: typeof fetch): QuotaReader {
    const doFetch = fetchImpl ?? fetch
    return async (route) => {
        const response = await doFetch(`${QUOTA_ROUTE_PATH}?route=${encodeURIComponent(route)}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
        })
        if (!response.ok) throw new Error(`quota read refused (${response.status})`)
        const view = parseQuotaView(await response.json())
        if (view === undefined) throw new Error('quota reply carried no windows')
        return view
    }
}
