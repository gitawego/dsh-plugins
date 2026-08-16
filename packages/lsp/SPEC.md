# dsh-lsp — Implementation Spec

> Config-driven **[Language Server Protocol](https://microsoft.github.io/language-server-protocol/)**
> integration for **DeepSeek Harness (DSH)**, ported from
> [`@gitawego/pi-lsp`](https://github.com/gitawego/pi-lsp) (v0.1.0). Official LSP servers by default
> (typescript, kotlin, gopls, rust-analyzer, clangd, pyright, ruby-lsp, elixir-ls, zls), persistent
> per-(project-root, server) sessions, progressive diagnostics after agent edits, and rich query tools
> (hover, definition, references, symbols, call hierarchy, rename).

**Status:** proposed — review before implementation.
**Target dir:** `~/workspace/dsh-plugins/packages/lsp` (spec preview here; implementation lands in this directory).
**Conventions studied:** pi-lsp source at `~/workspace/pi-lsp` and DSH plugin conventions from the
`@gitawego/dsh-vision` / `@gitawego/dsh-web-search` packages in this monorepo, plus DSH APIs inspected in
`~/dsh-global/node_modules/@deepseek-ai/*` (`dsh-tools`, `dsh-settings`, `dsh-commands`, `dsh-agent`).

---

## 1. Goal

Give DSH agents — the same value pi-lsp gives pi agents — a language-aware editing loop:

- **Persistent LSP sessions** instead of spawn-per-call (no re-initialization cost / no lost language
  server artifacts per request).
- **Real type-checking diagnostics** from a config-driven catalog of **official** servers (never a linter
  standing in for a type-checker).
- **Progressive diagnostics after edits**: files an agent changed (`edit`, `write`, `lsp_fix`, bash
  redirects) are re-synced with the live session and a throttled, compact summary surfaces after each turn.
- **Rich query tools**: hover, definition, references, implementation, symbols, workspace symbols,
  call hierarchy, rename (preview-only — never writes), and `lsp_fix` (code action, default `source.fixAll`).

All pi-lsp features map onto DSH extension points; the pi-specific lifecycle surfaces (`session_start`,
`turn_end`, `registerCommand`/`registerTool`, `ctx.ui.setStatus`) map onto DSH `ctx.on(agent/…)`,
`ctx.tools.register(defineTool())`, `ctx.commands.register()`, `/lsp` slash command, and the DSH
**Web client** (a data-driven `/lsp` status view).

## 2. Feature/API parity matrix

| pi-lsp feature | dsh-lsp equivalent | DSH extension point |
| --- | --- | --- |
| `lsp_diagnostics` tool | same name + semantics | `ctx.tools.register(defineTool(...))` |
| `lsp_status` tool | same (sessions: id, root, status) | `defineTool` + `ctx.commands` `/lsp` |
| `lsp_fix` (code action, default `source.fixAll`, preview unless `write:true`) | same | `defineTool` |
| `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_implementation` | same names | `defineTool` |
| `lsp_symbols` (document symbols) | same | `defineTool` |
| `lsp_workspace_symbol` (kind-filtered, 10 max) | same | `defineTool` |
| `lsp_call_hierarchy` (prepare/incoming/outgoing) | same | `defineTool` |
| `lsp_rename` (workspace, preview-only) | same | `defineTool` |
| `/lsp` command (session status) | same | `ctx.commands.register` |
| session lifecycle (`session_start`/`session_shutdown`) | `agent/session-start` + disposal | `ctx.on('agent/session-start')`, `ctx.on('agent/disposed')` |
| turn-end progressive diagnostics (`turn_end`) | `agent/turn-stopping` hook re-syncs edited files | `ctx.on('agent/turn-stopping')` |
| Progressive inject surface (`status`/`widget`/`conversation`/`none`) | `statusline` → status card; `conversation` → injected report message; `none` → off; `widget` → reserved | `ctx.settings` + Web client slot |
| Config at `~/.pi/agent/pi-lsp.json` + project `.pi/pi-lsp.json` | DSH Settings document (`$DSH_HOME/settings.yaml`, `lsp` namespace) + per-call overrides | `ctx.settings` |
| Statusline entry while servers start | status card in Web + `/lsp` | client `settings.section` + tool-view slot |
| Managed installs (`autoDownload`, npm / github-release / go-install) | same | plain files under `$DSH_HOME/cache/dsh-lsp/bin` + binary resolver |

### Dropped / adapted for DSH

- **TUI statusline** → DSH Web status card (there is no DSH TUI). `progressive.inject = "status"` renders
  a status line in the Web sessions view; `"conversation"` injects a compact report message into the agent's
  own context after each turn (via `agent.inject()` — see §7.2).
- **pi trust gate** (project config only when pi trusts the project) → DSH equivalent: project-level LSP
  overrides are honored once the workspace is a trusted DSH workspace; see §5.

## 3. Packaging & install (matches dsh-plugins convention)

- npm package **`@gitawego/dsh-lsp`**, `type: module`, `main: lib/index.js`, `types: lib/types/index.d.ts`.
- **Bundle patch** `cordis.patch.yml`:

  ```yaml
  - insert:
      - id: lsp
        name: '@gitawego/dsh-lsp'
  ```

- `package.json` declares the `dsh` block:

  ```jsonc
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-tool"
      ],
      "platform": "web"
    }
  }
  ```

  and exports `./client` (built browser bundle committed as `lib/client.js`, like vision/web-search).
- Install: `dsh plugin --profile web add ~/workspace/dsh-plugins/packages/lsp`, then restart the Web profile
  (and `--profile headless` for parity).
- No **sharp**/**esbuild**/native deps → **no `allowBuilds` change** in `pnpm-workspace.yaml`; the package is
  pure Node + browser TS (servers are spawned child processes only).
- Peer deps: `cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-settings`,
  `@deepseek-ai/dsh-commands`, `schemastery`.
- `peerDependenciesMeta`: `@deepseek-ai/dsh-host-webserver` optional (for the `/lsp` settings route).
- **Failure policy:** servers that fail to **start** are marked broken (no retry storms) — identical to
  pi-lsp's manager. Missing binaries try `autoDownload` when enabled; otherwise the server is reported
  unavailable.

## 4. Services injected (`export const inject`)

`['tools', 'agents', 'settings', 'commands']` — all mounted by `dsh-base` in Web and Headless profiles.

## 5. Configuration

### 5.1 Settings namespace

Register `ctx.settings.register(settingsNamespace('lsp'), RESOLVED, { base, applies: 'live', validate })`
with a schemastery schema mirroring every pi-lsp config field:

- `timeout` (30000, ms) — request/RPC timeout; also spawn settle timeout.
- `binDir` (default `$DSH_HOME/cache/dsh-lsp/bin`) — managed-install directory.
- `progressive`: `{ enabled: true, inject: 'status', maxDiagnostics: 20, quietMs: 2000 }`
  (`inject ∈ status | conversation | none`; `widget` reserved for a future Web widget).
- `servers`: record keyed by server id with per-server options (mirrors pi-lsp `ServerConfig`):
  `command`, `extensions`, `languageId`, `rootMarkers`, `env`, `initialization`, `autoDownload`, `disabled`.
  Users may completely replace or drop defaults (e.g. `"kotlin": { "disabled": true }`) and add custom
  servers (e.g. `"my-lang": { "command": ["my-lang-lsp", "--stdio"], "extensions": [".mylang"] }`).

**Default catalog** (byte-for-byte identical to pi-lsp `src/catalog.ts`) — official servers only:

| id | extensions | install strategy | autoDownload |
| --- | --- | --- | --- |
| `typescript` | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | npm (`typescript-language-server`) | yes |
| `kotlin` | `.kt .kts` | github-release (`kotlin-lsp`; needs java) | yes |
| `gopls` | `.go` | go-install (`go install`) | yes |
| `rust-analyzer` | `.rs` | PATH only | — |
| `clangd` | `.c .h .cpp .cc .cxx .hpp .hh .hxx` | PATH only (ships with Termux) | — |
| `pyright` | `.py` | npm (`pyright-langserver`) | yes |
| `ruby-lsp` | `.rb .rake .gemspec .ru` | PATH only | — |
| `elixir-ls` | `.ex .exs` | PATH only | — |
| `zls` | `.zig .zon` | PATH only | — |

**Platform:** 64-bit only (`arm64` / `x64`). 32-bit installs are refused and reported unsupported — never a
crash (matches pi-lsp's platform matrix). Kotlin on **android-arm64 (Termux)** stays PATH-only by default;
a JVM server on PATH is configurable. This package port keeps pi-lsp's `platform.ts`/`download.ts`/`binary.ts`
behavior 1:1.

### 5.2 `/lsp` slash command

`ctx.commands.register({ name: 'lsp', description, handler(invocation) })` — `invocation.agent` + `rawInput`,
returning text. Bare `/lsp` → session status + pointer to Settings; `/lsp show` → detail listing
`<id> @ <root>: <status>` per live session; `refresh` → clear broken-state markers and re-resolve binaries.

### 5.3 Web Settings section (client plugin)

Register a `settings.section` slot (`id: 'lsp', label: 'LSP'`) rendering a read-mostly form over the `lsp`
settings namespace (`ctx.settingsScope.bind`): per-server enable/disable, command override (advanced JSON),
progressive mode, timeout, binDir, plus a live **session status card** and a "kill all sessions" action.
Host route `/_dsh/lsp` (optional, only when `ctx.hostWebserver` present) returns session + catalog facts.
Use `@deepseek-ai/dsh-client-locale` (`en`/`zh`) strings and a `tool.call.toolview` card for
`lsp_diagnostics` results (compact file:line:severity table), mirroring vision's client structure.

## 6. Module layout (mirrors pi-lsp lib split, DSH-flavored)

```
src/
  index.ts          # apply(): settings ns, tool registration, /lsp command, agent hooks, web backend
  config.ts         # LSP_CONFIG_NAMESPACE + RESOLVED schemastery schema + mergeConfig/resolveConfig clamps
  catalog.ts        # DEFAULT_SERVERS (official catalog)
  language.ts       # extension -> LSP languageId map (ported from pi-lsp src/language.ts)
  types.ts          # Position/Range/Diagnostic (+ LSP wire types used by tools)
  root.ts           # nearestRoot / strictNearestRoot marker-file root detection
  platform.ts       # 64-bit gate, managed binDir, per-arch entries (port of pi-lsp platform.ts)
  download.ts       # npm / github-release / go-install managed install (port)
  binary.ts         # resolveCommand: PATH -> autoDownload -> binDir (port)
  manager.ts        # LspManager: lazy persistent client pool keyed by (root, server)
  client.ts         # LspClient: LSP JSON-RPC framing over child_process, push+pull diag merge
  tools.ts          # lsp_diagnostics + lsp_status + lsp_fix factories
  queries.ts        # hover/definition/references/implementation/symbols/workspaceSymbol/callHierarchy/rename
  progressive.ts    # collectEditedFiles + buildInjection + ProgressiveSink (port + DSH hook)
  web.ts            # optional HTTP route /_dsh/lsp
  client/index.tsx  # browser plugin: settings.section + tool.call.toolview + locale
cordis.patch.yml
tests/*.spec.ts     # vitest, pure seams (config, catalog, root, binary, progressive, manager, queries)
```

## 7. Architecture decisions (DSH-specific)

### 7.1 Persistent client pool (unchanged from pi-lsp)

`LspManager` keeps one `LspClient` per **`(project root, serverID)`**, discovered lazily via
`nearestRoot` marker-file detection (`package-lock.json`, `go.mod`, `Cargo.toml`, `mix.exs`, …), reused
across tool calls, marked broken on spawn failure (no retry storm), and torn down when the agent/session is
disposed (`ctx.on('agent/disposed')` → `manager.shutdown()`). `LspClient` implements JSON-RPC 2.0 framing
(`Content-Length:` headers) over a spawned child process, tracks open document versions, answers
server-initiated notifications (`workspace/configuration`, `client/registerCapability`,
`workspace/workspaceFolders`), and **merges push (`publishDiagnostics`) + pull (`textDocument/diagnostic`)**
results with dedupe. This is a straight port of `src/client.ts` / `src/manager.ts`.

### 7.2 Progressive diagnostics via `agent/turn-stopping`

pi-lsp hooked `turn_end`; the DSH equivalent is the serial **`agent/turn-stopping`** hook. After each turn
closes, collect files the agent touched this turn — `edit`/`write`/`lsp_fix` tool outputs plus bash
`>` / `>>` redirect targets (port of `collectEditedFiles`) — and, subject to the `quietMs` throttle, re-sync
them with the live session (`touchFile` + settle), then build a compact summary (`buildInjection`) and surface it
according to `progressive.inject`:

- `status` (default) → status card / running line text (Web).
- `conversation` → re-inject a short report message into the loop context via `agent.inject()` after the turn
  (only when `enabled && maxDiagnostics > 0`); never blocks the turn.
- `none` → disabled.

The re-sync waits for a **document**-mode settle (fast, uses the agent-chosen `version`); `wait: 'full'`
(real, non-empty diagnostics) remains available on the `lsp_diagnostics` tool for cold projects, exactly as in
pi-lsp's progressive design.

### 7.3 Tool surface

All tools built as factories over a **manager getter** (`getManager`), registered once in `apply()` with
`ctx.tools.register(defineTool(...))`. `defineTool` from `@deepseek-ai/dsh-tools` (zod-like
`parameterSchemaSpecToJsonSchema`), parameters declared with the DSH schema spec (`Type.Object`,
`Type.Array`, `StringEnum`), `timeoutMs` set from config, `signal` honored for abort.

Tools:

- `lsp_diagnostics { paths?, server?, wait?: 'document'|'full' }` — default whole workspace; resolves paths
  under the agent workspace root; surfaces `file:line:col severity source code: message`; reports
  "No LSP server available" + which servers are in error when nothing matches.
- `lsp_status {}` — live sessions: `id`, `root`, `status` (`connected`|`error`), plus which default servers
  failed to resolve.
- `lsp_fix { path, range?, server?, id?, write?: boolean }` — resolve a code action, default `source.fixAll`;
  **preview the resulting edit (never writes) unless `write: true`**.
- `lsp_hover { file, line, character }` → markdown documentation at position.
- `lsp_definition { file, line, character }` → definition locations.
- `lsp_references { file, line, character, includeDeclaration? }` → all references (includeDeclaration default true).
- `lsp_implementation { file, line, character }` → implementations of the symbol.
- `lsp_symbols { file }` → symbols declared in the file.
- `lsp_workspace_symbol { query?, server? }` → workspace-wide symbol search, kind-filtered to the OpenCode
  symbol-kind set, ≤ 10 results.
- `lsp_call_hierarchy { file, line, character, direction?: 'prepare'|'incoming'|'outgoing' }` → prepare /
  incoming / outgoing.
- `lsp_rename { file, line, character, newName, server? }` → workspace rename edits as a **preview** —
  never writes.

`lsp_fix` / `lsp_rename` apply edits through DSH's normal edit-equivalent submission so the agent (and the
progressive hook) observes files as changed.

## 8. Concurrency, resource & robustness notes

- **Single buffered stderr**: `child.stderr.resume()` discards server noise; all framing is over `stdin`/`stdout`.
- **Timeout behavior**: per-request `timeoutMs` resolves to `null` on expiry (never hangs the turn). The
  manager uses an `AbortSignal` tied to the agent turn to kill blocked clients at shutdown.
- **No retry storms**: a failed spawn puts `(root, server)` in a broken set; `/lsp refresh` clears it.
- **Request coalescing**: multiple concurrent diagnostics for the same file share one in-flight spawn + client.
- **Memory**: clients hold open documents (map keyed by path) — bounded by files actually touched; sessions
  torn down on `agent/disposed`.
- **Android/Termux**: 64-bit only; managed installs refused off-platform; missing binaries are reported
  unavailable (catalog `PATH`-only entries), never a crash.

## 9. Test plan (vitest, single-process — Termux-safe)

Pure-seam tests (no server binary required): `config.spec.ts` (parse clamps, defaults, disable/override),
`catalog.spec.ts` (extends/custom servers merge), `language.spec.ts` (languageId map), `root.spec.ts`
(nearestRoot walking with fixture dirs), `binary.spec.ts` (PATH resolution + autoDownload dispatch, mocked),
`progressive.spec.ts` (`collectEditedFiles` for edit/write/bash-redirects; `buildInjection` budget),
`types.spec.ts`. Integration-light: `client.spec.ts` / `manager.spec.ts` against a **fake JSON-RPC server**
fixture (port of `test/fixtures/fake-server.mjs`) that echoes `initialize`, serves `publishDiagnostics` on
`didOpen`, and answers textDocument requests. Web client: `vitest` with jsdom for settings-section render + locale.

## 10. Deliverables & acceptance

- `packages/lsp/` with `SPEC.md`, `cordis.patch.yml`, package.json, tsconfigs, `src/*`, `src/client/index.tsx`,
  `tests/*`, and `lib/` built output.
- Typecheck (`tsc --noEmit` x2), `pnpm test`, `pnpm build` all green; `pnpm -r --parallel` covers it.
- Live smoke against a real `typescript-language-server` on a small TS fixture: `lsp_diagnostics` returns real
  type errors; progressive hook surfaces a summary after an `edit` that introduces an error; `/lsp` shows the
  session; `lsp_rename` + `lsp_hover` return correct payloads.
- Web GUI: `LSP` settings section renders; `lsp_diagnostics` tool card renders results.

## 11. Milestones

1. **M1 — Core engine + tools**: config/catalog/language/root/platform/download/binary, `LspManager` +
  `LspClient` (fake-server tested), all 11 tools, `/lsp` command. No progressive, no Web.
2. **M2 — Progressive diagnostics + lifecycle**: `agent/turn-stopping` hook, `collectEditedFiles` +
  `buildInjection`, `status`/`conversation`/`none`, `agent/disposed` teardown.
3. **M3 — Web client + polish**: `settings.section` LSP panel, `tool.call.toolview`, locale, `/_dsh/lsp`
  route, `wait:'full'` guidance, README.
