# AGENT.md — dsh-web-search (architecture)

The non-negotiable design rules for `@gitawego/dsh-web-search`. **LESSONS.md
holds the session history, debugging deep-dives, and host environment facts;
this file is the architecture and rulebook.**

## What this project is

A chained-fallback `WebSearchProvider` for DeepSeek Harness (DSH) 0.1.0-rc.7+.
Registers into `ctx.web` with **id `opencode-enhanced`** alongside the shipped
`dsh-web-search-deepseek` (id `deepseek-official`). The chain tries in
order:

1. **Custom LLM** — whatever the user typed into the card's LLM endpoint /
   model / credential (Anthropic `web_search_20250305` tool or
   OpenAI-compatible web search). Only tried when `llm.enabled === true`.
2. **opencode Go default** — hardcoded `https://opencode.ai/zen/go/v1` with
   `deepseek-v4-flash` and the `OPENCODE_GO_API_KEY` credential-ref name.
   Always tried (independent of `llm.enabled`); silently skipped when the
   credential isn't configured.
3. **Parallel** — free MCP endpoint (`search.parallel.ai/mcp`), no API key.
4. **Exa** — free MCP endpoint (`mcp.exa.ai/mcp`), no API key.

Each stage is attempted in order; the first non-empty result wins. Only
throws `WebError` when every stage fails. Respects the abort signal and
the request's `maxResults` bound.

## Design rule — the section's layout IS the fallback chain (NON-NEGOTIABLE)

The settings surface is a **section** (`settings.section`, id `web-search`, order
45), and its structure encodes the provider's semantics: the chain tries backends
in order, so each row carries its rank and the rows are numbered. Numbering is
justified here and only here — the content is a sequence.

Two rules the previous card got wrong and this one must keep:

- **A shipped endpoint is read-only.** `BUILTIN_MCP_SERVERS` is the list of
  addresses we tested; an editable one turns a working free backend into a typo
  that silently falls through the chain. Only the token is configurable.
- **An endpoint and its token are one row.** Grouping by *backend* rather than by
  field type is the whole point: the old layout put `Parallel endpoint`, `Exa
  endpoint`, `Parallel token`, `Exa token` in one flat list, so neither pair read
  as a unit.

## Design rule — the browser half never imports the schema (NON-NEGOTIABLE)

`config.ts` imports schemastery. The shared data the browser needs — the shipped
server table and the entry type — lives in `mcp-servers.ts` so that rendering
three strings does not pull a validation library into the bundle.
`tests/bundle.spec.ts` asserts the built bundle contains no `schemastery` and no
relative `require`, and that it registers a section rather than a plugin card.

## Design rule — a write must not clobber the other sub-section's draft (NON-NEGOTIABLE)

`save()` writes `llm` and `free` in turn, and the settings scope publishes after
each write — which fires the subscription that rebuilds the draft from the stored
section. Reloading there discarded the edits staged for the *other* sub-section,
so saving dropped every added server. The subscription now skips while a write is
in flight, and a successful save re-reads once afterwards; a refused write keeps
the draft so it can be corrected. `tests/section-controller.spec.ts` pins it.

## Design rule — the free backends stay free, and their tokens are optional (NON-NEGOTIABLE)

Both hosted MCP endpoints work anonymously and both accept an API key as a
Bearer token for higher rate limits:

- `search.parallel.ai/mcp` — "free to use anonymously at lower rate limits. Pass
  a Parallel API key as a Bearer token to unlock higher limits";
- `mcp.exa.ai/mcp` — the same shape and the same header.

So `free.parallelCredential` / `free.exaCredential` are credential **references**
(never literals, per the repo rule), absent by default, and their absence must
leave the request byte-identical to the anonymous one: `bearerAuth()` returns
`{}` for undefined, empty, or blank, and the provider does not even ask the
credential seam when no reference is configured. A token that fails to resolve
keeps the free path rather than failing the search — the endpoint is free, so a
missing key is not an error.

`tests/free-token.spec.ts` pins all of that, including that no `authorization`
header is sent when no token is configured.

## Design rule — the opencode Go step's model id is configuration, not folklore (NON-NEGOTIABLE)

The hardcoded fallback step names a model id, and a stale one 404s silently
against a gateway that has moved on. It is `deepseek-v4.1-flash`, matching
`DEFAULT_CONFIG.llm.model`; `tests/free-token.spec.ts` asserts the id the step
actually requests, so the two cannot drift.

## Design rule — install/uninstall contract (NON-NEGOTIABLE)

The bundle's `cordis.patch.yml` is the entire install contract. It does
two things and **must do both**:

1. `insert` the plugin row so its `apply()` runs at boot.
2. Override `id: web`'s `config.searchProvider` to `opencode-enhanced` so the
   seam routes `web_search` calls to this provider instead of the shipped
   `deepseek-official`.

Uninstall removes the bundle layer entirely; on the next boot the `id: web`
row reverts to whatever the next-lower layer wrote (default
`deepseek-official`). No persistent state is left behind.

A user override on the profile's own `cordis.patch.yml` (later layer wins)
or the `$DSH_WEB_SEARCH_PROVIDER` env var outranks this layer.

## Design rule — React UI staging (NON-NEGOTIABLE)

The card uses a hand-rolled snapshot store backed by `useSyncExternalStore`.
The store **must** recompute its cached snapshot on every `publish()` call
— `getSnapshot()` returns a memoized reference, so React's hook only
re-renders when the underlying controller state changed. See
[LESSONS.md](./LESSONS.md) for the failure mode.

The only way to refresh the snapshot during a controller mutation is to
call `this.store.set(this.computeSnapshot())` from inside `publish()`,
NOT to iterate listeners manually. The shipped `dsh-client-ui-settings`
plugin's `CardForm` does this with its own `bind()` projection; my card
reimplements it locally because the bundle-purity gate forbids importing
their chrome as values (see the rc.7 `dsh-client-ui-settings-plugins`
README, "Known Limitations and Deferred Work").

## Design rule — DSH Settings Card adapter (NON-NEGOTIABLE)

The plugin contributes one card via the `settings.plugin.item` slot, keyed
by the `web-search-enhanced` namespace. The card:

- Inlines the `declare module '@deepseek-ai/dsh-client-ui-slots'` slot
  augmentation for `settings.plugin.item` (which `dsh-client-ui-settings-plugins`
  augments at runtime) — pure types, no value import, so the bundle-purity
  gate is satisfied.
- Authors its own `PluginCardShell` (disclosure chrome), `ValueField`,
  `ToggleField`, `SelectField` controls styled with `var(--dsw-*)` tokens so
  the visual matches DSH primitives.
- Uses `ctx.settingsScope.bind({ namespace: WEB_SEARCH_SETTINGS_NAMESPACE })`
  to read/write the namespace through the standard DSH settings seam — no
  plugin-owned HTTP route, no `installWebSearchWeb` backdoor.

The card defaults to **open by default** so the toggle is immediately
visible on mobile (collapsed cards hide the toggle behind a tap that users
often don't realize they need to make).

## Design rule — SettingsScopeController.writable timing

`ctx.settingsScope` returns `writable: false` in its initial snapshot and
only updates it once the describe RPC completes. While loading (or while
the websocket is reconnecting), `raw.writable === false` even when the host
is genuinely writable. The card treats the writable flag as opt-in:

```ts
writable: raw.status === 'ready' ? raw.writable === true : true,
```

While loading, default to writable so the user can stage drafts; the
Save button itself still guards on the actual write attempt. The
read-only banner also gates on `status === 'ready'` to avoid showing
"this deployment is read-only" during a transient loading state.

## Runtime surface — `src/index.ts` (apply)

```ts
export const inject = ['web', 'settings', 'credentials']

export function apply(ctx: Context, config: Partial<WebSearchConfig> = {}): () => void {
  const settings = ctx.settings.register(WEB_SEARCH_SETTINGS_NAMESPACE, Config, {
    base: config,
    applies: 'live',
    validate: (value) => createResolvedConfig(value),
  })
  const provider = createSearchProvider(() => resolved, {
    resolveGoApiKey: async () => { /* ctx.credentials.resolve for user credential */ },
    resolveOpenCodeGoApiKey: async () => { /* ctx.credentials.resolve for OPENCODE_GO_API_KEY */ },
  })
  const disposeProvider = ctx.web.registerSearchProvider(provider)
  return () => { disposeProvider(); settings.watch dispose }
}
```

Lifecycle:
- `ctx.settings.register` is effect-scoped on this plugin's fiber; card
  registration is cleaned up by the fiber itself.
- `ctx.web.registerSearchProvider` puts the effect on the WebRuntime's
  fiber (NOT ours), so `apply` returns a disposer that drops it manually.

## Source layout

- `src/index.ts` — apply + dispose
- `src/config.ts` — schemastery schema + `createResolvedConfig` for
  defaults projection on the client side
- `src/provider.ts` — `createSearchProvider` returning a `WebSearchProvider`
  with the 4-stage chain
- `src/backends/{llm,parallel,exa}.ts` — wire adapters per backend
- `src/normalize.ts` — backend-specific response parsing → `WebSearchSource`
- `src/client/index.tsx` — browser-side card with the snapshot store

## Key data flows

- **LLM backend (Anthropic)**: POST `/v1/messages` with the
  `web_search_20250305` server tool. Parse `web_search_tool_result` blocks.
- **LLM backend (OpenAI)**: POST `/chat/completions` with a `web_search` tool
  (best-effort; only servers that implement it return structured results).
- **Free backends**: parse MCP JSON-RPC / newline-delimited JSON envelopes
  into `RawSource[]`, then `dedupeAndCap` by URL.

## Browser-side settings UI

The Web bundle ships a `settings.plugin.item` card keyed by
`web-search-enhanced`. The **Plugins → Plugin configuration** tab
(`dsh-client-ui-settings-plugins`) pairs the card with the namespace the
host serves, so the card lives in the standard settings surface — no
bespoke section, no plugin-owned HTTP route (the latter was removed in
favor of the native card mechanism).

The card stages edits and saves them through the standard settings scope, so
every write is revision-fenced, dirty-tracking is automatic, and the saved
values ride the same wire every other plugin uses.

## Process restart policy (NON-NEGOTIABLE)

**Never `kill` or `pgrep ... | xargs kill` the `dsh` process from this
session.** On Termux, killing dsh and respawning it via `nohup ... &` is
fragile — the nohup child often dies with the shell, or the kill matches
the parent, and the GPU/zygote children leak. The browser fetches each
plugin's `client.js` fresh on every new tab via the `__DSH_BOOT__` script's
URL, so a rebuilt bundle is picked up by **opening a new tab** — no
process restart needed. If dsh really is wedged, restart it via the
user's interactive shell, not from this session.

## Resume / restart checklist

1. `cd packages/web-search && pnpm install --offline && pnpm typecheck && pnpm test && pnpm build`
2. Refresh the worker in the web profile: `cd ~/.dsh/profiles/web && rm -rf node_modules/@gitawego/dsh-web-search && pnpm install --offline`
3. **Do NOT restart dsh.** Open a new browser tab.
4. The Web Search (enhanced) card appears under Settings → Plugins →
   Plugin configuration. Toggle, stage, save.

## References

- [LESSONS.md](./LESSONS.md) — session history, debugging deep-dives, host
  facts, tool pitfalls.
- `../../packages/llm-provider/AGENT.md` — sibling plugin, the reference for
  the adapter-side conventions (host-package peers, wire-level tests).
- DSH API docs: `<dsh prefix>/lib/node_modules/@deepseek-ai/<pkg>/README.md`
  (the installed host is the authority; the published docs site tracks master,
  which is ahead of the pinned host version on the settings seam).

## Cross-reference

- [../../AGENT.md](../../AGENT.md) — monorepo-wide rules (process
  restart policy, DSH version pinning, bundle install contract, Settings
  Card extension point, real-browser debugging). The "do not kill dsh"
  rule is recorded here and in the root; per-package docs may elaborate
  with package-specific tooling pitfalls.
