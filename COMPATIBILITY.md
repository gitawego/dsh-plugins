# DSH compatibility audit

Audit date: 2026-11-03. Repo commit: `9f34a80`.

## What was tested

| | |
|---|---|
| Installed host | `@deepseek-ai/dsh@0.1.5-rc.1` (npm global, node 26.3.0 at `/home/hlu/.nvm/versions/node/v26.3.0`) |
| Live GUI | `dsh web` pid 1587143 on 127.0.0.1:3080 (same 0.1.5-rc.1 install) |
| Repo pins | every `@deepseek-ai/dsh-*` peer/dev dep pinned `0.1.5-rc.1` |
| Newest published | `0.2.1-rc.5` (2026-10-29), `0.2.2-alpha.3` (2026-11-03) |
| Profile | `~/.dsh/profiles/web` — the three `file:` packages, `lib/index.js` checksums match this repo |

```bash
# against the installed host
for p in packages/*/; do (cd "$p" && pnpm typecheck && pnpm test && pnpm build); done

# against the newest published line (scratch copy, pins bumped, fresh install)
rsync -a --exclude node_modules --exclude lib --exclude .git ./ /tmp/dsh02/
sed -i 's/0\.1\.5-rc\.1/0.2.1-rc.5/g' /tmp/dsh02/packages/*/package.json
cd /tmp/dsh02 && rm pnpm-lock.yaml && pnpm install --no-frozen-lockfile
for p in packages/*/; do (cd "$p" && npx tsc --noEmit); done
```

## Result

| Package | 0.1.5-rc.1 (old host) | 0.2.1-rc.5 (new host) |
|---|---|---|
| `llm-provider` | 286 tests, build | **port landed** — typecheck OK · 285 tests · build OK |
| `lsp` | 49 tests, build | **port landed** — typecheck OK · 49 tests · build OK |
| `web-search` | 75 tests, build | **port landed** — typecheck OK · 75 tests · build OK |

**Status: the `dsh-0.2` branch is ported to `0.2.1-rc.5`.** All three packages
typecheck, test, and build against the new host, and a stock 0.2.1 profile with
all three installed boots clean (composed tree includes each bundle; the GUI
serves every `client.js`; a headless Chrome load reports no console or page
errors).

The table above records the pre-port audit: before the port the same packages
produced 37 / 5 / 3 TypeScript errors against 0.2.1.

The break did not come with 0.2.0: `0.1.7-rc.2` already replaced the settings
service and the request-message vocabulary. `0.1.5-rc.3` and `0.1.6-alpha.2`
still expose the old `ctx.settings.register()` API (checked their `.d.ts`), so
every release from `0.1.7-rc.2` on is a breaking target — which is also why the
port targets `0.2.1-rc.5` and not the 0.1.7 line.

## How the port was done

- **Config** — each plugin now exports a `Config` schema whose user-editable
  fields are `volatile()`, and reads them per operation (`readConfig` /
  `readProviderConfig`). No `ctx.settings.register`, no watch: the loader
  supplies stable refs and a form write is visible to the next call.
- **Client scope** — `ctx.settingsScope.bind({ namespace })` became
  `ctx.configForms.get(entryId)`; the client's own `SettingsScopeLike` shapes
  kept the controllers unchanged. The namespace is the loader entry id
  (`llm-provider`, `lsp`, `web-search`), so the bundle patches and the form
  keys now agree.
- **LLM messages** — `context.ts` rebuilds tool results from `role: 'tool'`
  messages, preserves message identity, and follows the 0.2 image contract:
  the surface marks `offloaded`, the route prices the retained set and throws
  `IMAGE_OFFLOAD_REQUIRED` instead of offloading on its own.
- **LSP provenance** — its own `MessageSourceMap` entry (`kind: 'lsp'`)
  replaces the removed catch-all `plugin` source.

## Why it breaks

### 1. Settings are derived from plugin Config (all three packages)

`ctx.settings.register(namespace, schema, { base, applies, validate })` is gone.
`dsh-settings` now exports `SettingsForms` (`configure` / `describe` /
`update` / `replace` / `mutate`): a plugin's exported `Config` schema *is* the
form, its fields are `Volatile<T>` refs read with `.get()`, and the profile
patch owns the values. The UI page is auto-generated unless a companion
client package registers one.

- `llm-provider` — `src/index.ts` (`ctx.settings.register`, watch-driven config)
- `lsp` — `src/index.ts`
- `web-search` — `src/index.ts` + `src/config.ts` (`WEB_SEARCH_SETTINGS_NAMESPACE`)

### 2. LLM message model (`llm-provider`)

- `RequestMessage` is no longer assignable to `Message`: every message carries a
  branded `MessageId` and a required `source`.
- Request content parts no longer include `tool-result`; a tool result is a
  first-class `ToolResultMessage` (`role: 'tool'`, `source.kind: 'tool'`,
  `toolCallId`, `isError`) — `src/context.ts` (many sites) and
  `tests/context.spec.ts`.
- `offloadRequestImagesWithPolicy` is now a default export, and
  `ImageRequestTarget` requires `width`/`height`.
- Producer-specific sources are merge-extended: there is no catch-all
  `{ kind: 'plugin' }` any more — this is also what breaks `lsp`
  (`src/index.ts`, `createUserMessage`).

### 3. Client settings services (all three packages)

- `SettingsScope` is no longer exported by `@deepseek-ai/dsh-client-ui-settings`;
  `ctx.settingsScope` is gone. The replacements are `ctx.settingsSchema`
  (schema + path ops) and `ctx.configForms` (`ConfigForm`: snapshot /
  `set` / `unset` / `mutate`, revision-fenced).
- 0.1.5's `settings.plugin.item` card seat no longer exists. 0.2 plugin pages
  register as `settings.plugins.tab` contributions inside the Plugins page (a
  card injects `plugins.item`), or as a top-level `settings.section` — the
  0.2 `dsh-client-ui-settings-web-search` package is the reference shape.
- `RunningToolCall.argsRaw` no longer exists in every state (`lsp` client).

## Web-search: deprecation analysis

DSH 0.2.1-rc.5 ships a complete first-party web stack:

| Capability | 0.1.5 | 0.2.1 |
|---|---|---|
| DeepSeek Messages search (`web_search_20250305`) | yes (API key) | yes + **keyless via DeepSeek account sign-in** |
| DeepSeek Search API provider | no | `@deepseek-ai/dsh-web-deepseek-api` |
| Exa / Perplexity providers | no | `dsh-web-search-exa`, `dsh-web-search-perplexity` (separate packages) |
| `web_fetch` | no | yes (`dsh-web-fetch-http`, 200k cap, timeouts) |
| Multi-query `web_search` (up to 4 queries) | no | yes |
| Per-tool toggles, result caps, timeouts | no | yes (`dsh-tool-web` Config) |
| Web-search settings page in the GUI | no | `dsh-client-ui-settings-web-search` — provider switch, key, endpoint, limits |
| Provider **fallback chain** | no | no |
| Keyless anonymous Parallel/Exa MCP | **yes (this plugin)** | no |
| Arbitrary user MCP servers | **yes (this plugin)** | no |

Verdict: **yes, it can be deprecated.** What this plugin uniquely provides is
narrow — anonymous Parallel/Exa MCP search with no credential and a fallback
chain across backends/MCP servers. Everything else (provider choice, key
storage, config UI, fetch, multi-query, timeouts) is now first-party and
better integrated.

Caveats:

- The 0.2 keyless path only works for sessions on the `deepseek-account`
  route. On this machine the default model route is `opencode-go-session`
  (`~/.dsh/settings.yaml`), so built-in search would need `DEEPSEEK_API_KEY`
  (or an Exa/Perplexity key). Today the plugin's Parallel MCP is the only
  credential-free search in that setup.
- Retiring it on 0.1.5 removes that credential-free path; retiring it *while*
  porting to 0.2 is the cheaper move, because the 0.2 settings UI rewrite makes
  porting the plugin's section the most expensive part of its migration.

Recommended: stop porting `web-search` to the new line, mark it deprecated in
its README/package description, and keep the published 0.1.x-compatible
version. Port `lsp` and `llm-provider`.

## Migration checklist (when the host moves to 0.1.7+ / 0.2.x)

1. Bump every DSH pin (peer + dev) to the host's exact version; `pnpm install`.
2. `llm-provider`: rewrite `src/context.ts` against `Message` /
   `ToolResultMessage` / branded ids; use the default-exported image offload
   helper and its `width`/`height` target; replace `ctx.settings.register`
   with exported `Config` + `Volatile` refs; port the Models page integration
   to the 0.2 `ProviderCardExtrasOwnerProps` contract; replace client
   `settingsScope` with `settingsSchema` + `configForms`.
3. `lsp`: export `Config` (forms model); declare its own message source kind
   instead of `{ kind: 'plugin' }`; move the client card to
   `settings.plugins.tab` / `settings.section` with `configForms`; fix
   `RunningToolCall` narrowing.
4. `web-search`: retire (recommended) or do the same settings/client port plus
   the provider registration (the `ctx.web` seam itself is unchanged).
5. Update the ~40 test files that construct the old config/message shapes;
   re-run the scratch-workspace typecheck above.
6. **Re-enter the plugin settings in the upgraded profile.** The one-time
   `settings.yaml` import only lands sections the running composition accepts;
   `llm-provider`'s namespace is logged and left in `settings.yaml.imported`.
   The route then falls back to `apiKeyEnv: OPENCODE_API_KEY` while the key sits
   under the user's own reference, which surfaces as
   `No API key for provider: opencode-go-session` (chat) and
   `usage endpoint answered 401` (quota card). Verify with
   `dsh --profile web --dump-config` (the `llm-provider` entry must show the
   `config:` block). See `AGENT.md` → "Upgrading an existing profile".

## Policy note

`AGENT.md` says DSH pins follow the **installed host**, and warns against
bumping to npm's newest. That rule is what keeps the plugins loadable: this
audit is the evidence for why the pin must not move until the host does.
