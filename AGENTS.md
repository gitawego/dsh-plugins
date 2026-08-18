# AGENTS.md — dsh-plugins monorepo

Monorepo-wide rules for every package in `dsh-plugins/`. Each package
has its own `AGENTS.md` (architecture + design rules) and `LESSONS.md`
(session history + debugging deep-dives). This root file holds the rules
that apply across packages.

## What this monorepo is

A collection of DSH (DeepSeek Harness) plugin packages maintained
together for version compatibility. Currently:

- `packages/web-search` — `@gitawego/dsh-web-search` — chained-fallback
  `WebSearchProvider` (Anthropic + free MCP backends).
- `packages/vision` — `@gitawego/dsh-vision` — capability-aware vision
  + paste extension.
- `packages/ui-mobile` — DSH mobile UI surface.
- `packages/lsp` — LSP bridge.

Each package is independently published and installed via `dsh plugin`,
but they share the same Node version, pnpm version, and rc.7 DSH pinning.

## Non-negotiable rules (apply to every package)

### Process restart policy — DO NOT kill dsh from this session

**Never `pgrep` / `kill` / `pkill` the `dsh` process from this session.**

On Termux the in-place restart is fragile:

- `pgrep -f "dsh.*bin.js.*web" | xargs -r kill` can match the parent shell
  or the user's own dsh instance.
- `nohup dsh --profile web > log 2>&1 &` from a background subshell
  silently dies when the subshell exits — the GPU/zygote children leak.
- Multiple `dsh web` processes end up racing on port 3080 and the live
  browser chrome uses whichever one wins.

The browser's `client.js` is loaded FRESH on each new tab via the
`__DSH_BOOT__` script's URL. After `pnpm install --offline` in the profile
directory (`~/.dsh/profiles/web`), **open a new browser tab** — the
rebuilt bundle is picked up immediately. No process restart needed.

If dsh is genuinely wedged (port unreachable, leaks, etc.), ask the user
to restart it in their interactive shell. Do not start, kill, or
restart dsh from this session.

This rule is recorded in each package's `AGENTS.md` as
"Process restart policy (NON-NEGOTIABLE)" and in each `LESSONS.md` under
"Tooling pitfalls".

### DSH version pinning

Every DSH peer dependency must be pinned to `^0.1.0-rc.7` (matching the
host install at `dsh-global/node_modules/@deepseek-ai/*`). Pinning to
`^0.1.0-rc.6` causes the plugin to fail to resolve against the host's
newer runtime (semver pre-release tags don't cross the `rc.6 → rc.7`
boundary). The DSH dependency set:

- `@deepseek-ai/dsh-credentials`
- `@deepseek-ai/dsh-settings`
- `@deepseek-ai/dsh-web`
- `@deepseek-ai/dsh-host-webserver` (peer of web-search, optional)
- `@deepseek-ai/dsh-client-connection` (client side)
- `@deepseek-ai/dsh-client-locale` (client side)
- `@deepseek-ai/dsh-client-runtime` (client side, includes `SettingsScope`)
- `@deepseek-ai/dsh-client-ui-settings` (client side, includes `settingsScope` service)
- `@deepseek-ai/dsh-client-ui-slots` (client side, includes slot types)
- `@deepseek-ai/cordis` (peer, `^4.0.1`)
- `@deepseek-ai/schemastery` (peer, `^3.18.1`)

A `pnpm install` against a host at a different rc level will fail or
silently use the wrong type contracts.

### Bundle install contract

Every plugin's `cordis.patch.yml` is the entire install contract. The
two operations it must do:

1. `insert` the plugin row so its `apply()` runs at boot.
2. Override any user-facing config row to make this plugin the active
   selection (e.g. `id: web`'s `config.searchProvider` for search plugins).

Uninstall rolls back automatically because the bundle layer disappears;
no persistent state is left behind.

A user override on the profile's own `cordis.patch.yml` (later layer
wins) or an env var (e.g. `$DSH_WEB_SEARCH_PROVIDER`) outranks this layer.

### RC.7 Settings Card extension point

Every plugin that ships a settings UI after rc.7 must use the native
`settings.plugin.item` slot keyed by its settings namespace. The slot
type is augmented at runtime by `dsh-client-ui-settings-plugins` (the
Plugins tab composition). The card lives under
**Settings → Plugins → Plugin configuration** automatically.

The bundle-purity gate forbids importing the shipped `dsh-client-ui-settings-plugins`
chrome as values. The plugin must:

- Author its own `PluginCardShell` / `ValueField` / `ToggleField` /
  `SelectField` components styled with `var(--dsw-alias-*)` tokens.
- Inline the `declare module '@deepseek-ai/dsh-client-ui-slots'` slot
  augmentation for `settings.plugin.item` (pure types, no value import).
- Use `ctx.settingsScope.bind({ namespace: ... })` from the runtime
  context — no plugin-owned HTTP route.

### Real browser debugging

Don't guess at UI behavior on mobile. Use headless Chrome + the Chrome
DevTools Protocol:

```bash
# Start CDP (idempotent)
bash /data/data/com.termux/files/home/workspace/agent-skills/skills/chrome-devtools-mcp-pi/scripts/start-cdp.sh

# Probe the live page from this session
node /data/data/com.termux/files/home/.local/share/dsh-test/probe-click.mjs
```

The probe scripts (under `~/.local/share/dsh-test/`) connect to the
existing dsh, open a fresh CDP tab, navigate to the GUI, click through
the settings flow, and dump the rendered DOM + console logs. Add
diagnostic `console.log` lines to the plugin's React component, rebuild
(`pnpm install --offline` in the profile dir), open a new CDP tab, and
read the logs.

This is the only way to verify `useSyncExternalStore` behavior, `useState`
re-renders, and mobile touch target hit-tests without a real device.

## Monorepo layout

```
dsh-plugins/
├── AGENTS.md               # this file (monorepo-wide rules)
├── README.md
├── package.json            # pnpm workspace root
├── pnpm-workspace.yaml
├── packages/
│   ├── web-search/
│   │   ├── AGENTS.md       # architecture + design rules
│   │   ├── LESSONS.md      # session history + debugging deep-dives
│   │   ├── src/
│   │   ├── tests/
│   │   ├── cordis.patch.yml
│   │   └── package.json
│   ├── vision/
│   │   ├── AGENTS.md
│   │   ├── LESSONS.md
│   │   └── ...
│   ├── ui-mobile/
│   └── lsp/
└── node_modules/           # workspace-level deps
```

## Resume / dev workflow

1. `cd dsh-plugins && pnpm install` (resolves workspace deps)
2. For each package you want to touch: `cd packages/<name> && pnpm typecheck && pnpm test && pnpm build` (22/22 tests green, typecheck clean)
3. `cd ~/.dsh/profiles/web && rm -rf node_modules/<your-package> && pnpm install --offline` (refresh the worker)
4. Open a new browser tab; the rebuilt bundle is picked up by the
   `__DSH_BOOT__` script.
5. To verify a real user flow: use headless Chrome + CDP as described
   above. Don't trust your own React state reasoning without seeing the
   rendered DOM.

Per-package AGENTS.md / LESSONS.md:

- `packages/web-search/AGENTS.md` — chained-fallback search provider design
- `packages/web-search/LESSONS.md` — session history, the "click does
  nothing" root cause, DSH Settings Card pitfalls, no-restart policy
- `packages/vision/AGENTS.md` — vision / paste extension design
- `packages/vision/LESSONS.md` — session history + RESCAN context
