# AGENT.md

Project conventions for AI agents working in this repo.

## TDD is mandatory

Every behavior change — feature, bug fix, or refactor — MUST be written
test-first (red → green → refactor) with a unit test that fails before the
change and passes after. Do not skip tests on "small" fixes; the fix cost is
the same, the regression risk is not.

Use the repo's test runner (`vitest run` in each package). Tests live in
`packages/<name>/tests/`.

### Why (real incident, 2026-08-16)

`packages/lsp` broke `dsh web` at boot: `lib/manager.js` does
`import { createClient } from './client.js'`, but the build pipeline compiled
the browser UI (`src/client/index.tsx`) through `scripts/build-client.mjs`
into the SAME output path `lib/client.js`, clobbering the server-side LSP
client module (`src/client.ts`) that exports `createClient`. The runtime
error surfaced only when the harness loaded the plugin:

```
SyntaxError: The requested module './client.js' does not provide an export named 'createClient'
```

A unit test asserting that `lib/manager.js`'s import graph resolves (or,
better, a test importing `createClient` from the built server module and
exercising it) would have caught the collision at build time instead of at
boot.

### Practical guardrails

- Build-output collisions: when a package builds both server modules and a
  browser bundle, assert in a test that each built entry exports the symbols
  its importers require (e.g. `manager.js` → `createClient`).
- Import-graph tests are cheap and fast; prefer them over waiting for
  integration/boot failures.
- Any test that touches build artifacts MUST run against a freshly built
  output (`npm run build` first), never a stale `lib/`.

---

# dsh-plugins monorepo rules

Monorepo-wide rules for every package in `dsh-plugins/`. Each package
has its own `AGENT.md` (architecture + design rules) and `LESSONS.md`
(session history + debugging deep-dives). This file holds the rules
that apply across packages.

## What this monorepo is

A collection of DSH (DeepSeek Harness) plugin packages maintained
together for version compatibility. Currently:

- `packages/llm-provider` — `@gitawego/dsh-llm-provider` — LLM provider
  routes (OpenCode Go first), including the gateway's required
  `x-opencode-session` routing header.
- `packages/web-search` — `@gitawego/dsh-web-search` — chained-fallback
  `WebSearchProvider` (Anthropic + free MCP backends).
- `packages/lsp` — LSP bridge.

Each package is independently published and installed via `dsh plugin`,
but they share the same Node version, pnpm version, and `0.1.5-rc.1` DSH pinning.

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
rebuilt bundle is picked up immediately.

**Host halves are different: they need a restart.** A plugin's server-side
`apply()` runs at boot, so new host code (a route registration, an adapter
change, a settings namespace) is invisible to an already-running `dsh` — the
symptom is a 404 from a route that exists on disk, or a fix that appears not to
work. Client bundles reload per tab; host code does not. Ask the user to restart
in their own shell rather than restarting it from a session.

If dsh is genuinely wedged (port unreachable, leaks, etc.), ask the user
to restart it in their interactive shell. Do not start, kill, or
restart dsh from this session.

This rule is recorded in each package's `AGENT.md` as
"Process restart policy (NON-NEGOTIABLE)" and in each `LESSONS.md` under
"Tooling pitfalls".

### DSH version pinning

Every DSH dependency must be pinned to the **exact** host version (currently
`0.1.5-rc.1`, matching the host install at
`<dsh prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`). Caret ranges are forbidden for DSH
packages: semver pre-release tags don't cross rc boundaries, so `^0.1.1-rc.1`
silently resolves to a newer host level (`rc.2`, ...) and drifts from the
running install. Only `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` keep ranged pins — they are stable across dsh rc
levels — and those ranges are kept at the **newest published release**
(currently `^4.0.4` / `^3.18.4`).

**Never bump a `@deepseek-ai/dsh-*` pin to npm's newest published version.**
The newest published DSH line (`0.2.x` alpha/rc) is ahead of the installed
host; pinning to it makes the plugins load against a host they were never
typed against. "Upgrade dependencies" always means: non-DSH deps to latest,
cordis/schemastery to latest, DSH to **the host's exact version**.

After every host upgrade, run `pnpm install` in the profile directory
(`~/.dsh/profiles/web`) WITHOUT `--offline`/frozen lockfile, so stale pinned
copies of host packages cannot linger there: the loader resolves bare module
names profile-first, and a stale profile copy shadows the upgraded host
(this is exactly how `dsh web` started serving bare HTTP 400 for `/` after
the `0.1.0-rc.7 → 0.1.1-rc.1` upgrade: a profile-local
`dsh-host-webserver@0.1.0-rc.7` without the new `renderIndex()` shadowed the
host's rc.1 copy). Never add `dsh-host-webserver` as a regular dependency:
it must stay an optional peer or be omitted entirely, otherwise pnpm hoists a
frozen copy into the profile that later shadows the host.

The DSH dependency set:

- `@deepseek-ai/dsh-credentials`
- `@deepseek-ai/dsh-settings`
- `@deepseek-ai/dsh-web`
- `@deepseek-ai/dsh-llm` (server side; adapter seam)
- `@deepseek-ai/dsh-attachment` (server side; request images)
- `@deepseek-ai/dsh-util-values` (server side; `JsonValue`)
- `@deepseek-ai/dsh-llm-pi-ai` (server side; pi-ai catalog adapter — a
  reference implementation, never a runtime dependency of our packages)
- `@deepseek-ai/dsh-client-connection` (client side)
- `@deepseek-ai/dsh-client-store` (client side; `SnapshotStore`)
- `@deepseek-ai/dsh-client-locale` (client side)
- `@deepseek-ai/dsh-client-ui-renderer` (client side; provides `ctx.slots`)
- `@deepseek-ai/dsh-client-ui-settings` (client side, includes `settingsScope` service
  and the `SettingsScope` type)
- `@deepseek-ai/dsh-client-ui-slots` (client side, types only — the slot map)
- `@deepseek-ai/dsh-client-ui-chat` / `-conversation` / `-tool` (client side, tool cards)
- `@deepseek-ai/cordis` (peer, `^4.0.4`)
- `@deepseek-ai/schemastery` (peer, `^3.18.4`)

A `pnpm install` against a host at a different rc level will fail or
silently use the wrong type contracts.

### Non-DSH dependency policy

The toolchain is kept at latest: `typescript` (7.x), `vitest` (5.x),
`@types/node` (26.x). Two deliberate exceptions, both to match the running
host:

- **React stays on 18.x** (`react@^18.3.1`, `@types/react@~18.3.31`,
  `@types/react-dom@~18.3.7`). The 0.1.5 client runtime is built against
  React 18 (`dsh-client-ui-renderer` devDepends on `react ^18.2.0`), and the
  browser bundle resolves `react` from the host page. React 19 typings would
  typecheck against a runtime the host does not have.
- **`@earendil-works/pi-ai` is pinned to the host's copy** (`0.85.1`, the
  version `dsh-llm-pi-ai` depends on). A different minor changes the
  `Model`/`Provider`/`AssistantMessageEvent` contracts the adapter is
  written against.

### Client halves with more than one module must bundle

The browser module system wraps ONE entry file in a `factory(require)` whose
`require` answers only the host's externals, so a relative `require` inside the
shipped bundle is a boot-time crash. A client written as a single source file
(`web-search`, `lsp`) can ship tsc output directly; one written as several
modules (`llm-provider`) must bundle. `packages/llm-provider/scripts/build-client.mjs`
is the reference: esbuild, `platform: browser`, `react*` external, output wrapped
in `window.__ModuleLoader__.load({ id: <pkg name>, factory })`, and
`packages/llm-provider/tests/bundle.spec.ts` is the guard that proves it.

### TypeScript 7 and the client tsconfig

TS 7 **removed** `moduleResolution: node` (`node10`). The client projects
emit CommonJS on purpose (the browser module loader hands the bundle a
`require`), so they cannot move to `nodenext`/`bundler`. Omit
`moduleResolution` entirely in `tsconfig.client.json` — TS 7 then resolves
the `@deepseek-ai/dsh-client-*/client` subpaths through the `paths` map while
still emitting the CommonJS bundle the loader expects. `tsconfig.json`
(server) stays on `module: NodeNext` / `moduleResolution: NodeNext`.

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

### Settings Card extension point

Every plugin that ships a settings UI must use the native
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
├── AGENT.md                # this file (monorepo-wide + agent rules)
├── README.md
├── package.json            # pnpm workspace root
├── pnpm-workspace.yaml
├── packages/
│   ├── llm-provider/
│   │   ├── AGENT.md       # architecture + design rules
│   │   ├── src/
│   │   ├── tests/
│   │   ├── cordis.patch.yml
│   │   └── package.json
│   ├── web-search/
│   │   ├── AGENT.md       # architecture + design rules
│   │   ├── LESSONS.md      # session history + debugging deep-dives
│   │   ├── src/
│   │   ├── tests/
│   │   ├── cordis.patch.yml
│   │   └── package.json
│   └── lsp/
└── node_modules/           # workspace-level deps
```

## Resume / dev workflow

1. `cd dsh-plugins && pnpm install` (resolves workspace deps)
2. For each package you want to touch: `cd packages/<name> && pnpm typecheck && pnpm test && pnpm build` (2026-10: 166 tests green across web-search/lsp/llm-provider, typecheck clean)
3. `cd ~/.dsh/profiles/web && rm -rf node_modules/<your-package> && pnpm install --offline` (refresh the worker)
4. Open a new browser tab; the rebuilt bundle is picked up by the
   `__DSH_BOOT__` script.
5. To verify a real user flow: use headless Chrome + CDP as described
   above. Don't trust your own React state reasoning without seeing the
   rendered DOM.

Per-package AGENT.md / LESSONS.md:

- `packages/llm-provider/AGENT.md` — provider-route design, OpenCode Go
  transport facts, `x-opencode-session` contract
- `packages/web-search/AGENT.md` — chained-fallback search provider design
- `packages/web-search/LESSONS.md` — session history, the "click does
  nothing" root cause, DSH Settings Card pitfalls, no-restart policy
