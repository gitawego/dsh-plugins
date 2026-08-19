/**
 * @gitawego/dsh-ui-mobile — mobile-responsive web UI overlay for the DeepSeek
 * Harness web surface.
 *
 * Client-only plugin: all behavior lives in the browser bundle (`./client`).
 * This server entry exists so the package is a valid host plugin for the
 * `ui-mobile` row the bundle patch inserts (a bundle layer's row must
 * activate on the host Loader); it activates without doing any server work.
 */
export const name = '@gitawego/dsh-ui-mobile'

export const inject: string[] = []

/**
 * Host-side apply: intentionally a no-op — this plugin has no server surface.
 * @param _ctx - the host plugin context (unused).
 */
export function apply(_ctx: unknown): void {
  /* client-only; nothing to do server-side */
}
