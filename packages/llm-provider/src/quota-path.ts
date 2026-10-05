/**
 * The quota route's pathname, in a module both halves can import.
 *
 * The host half registers the route and the browser half reads it, so the string
 * lives here rather than in `quota-route.ts`: that module imports `node:http`,
 * and a client bundle must not pull Node built-ins in behind a constant.
 *
 * @module @gitawego/dsh-llm-provider/quota-path
 */

/** Path the card reads; the host registers exactly this. */
export const QUOTA_ROUTE_PATH = '/llm-provider/quota'
