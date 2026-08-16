# @gitawego/dsh-lsp

Config-driven [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) integration
for **DeepSeek Harness (DSH)**, ported 1:1 from `@gitawego/pi-lsp`. Official LSP servers by default,
persistent per-(project, server) sessions, progressive diagnostics after agent edits, and rich query tools.

## Install

```bash
dsh plugin --profile web add ~/workspace/dsh-plugins/packages/lsp
```

Restart the Web profile (`--profile headless` for parity). The plugin registers the `lsp` bundle patch and,
in the Web GUI, an *Language Servers* settings section plus an `lsp_diagnostics` tool card.

## Tools

| Tool | Purpose |
| --- | --- |
| `lsp_diagnostics` | Diagnostics for files/directories via the file's LSP server |
| `lsp_status` | Live LSP server sessions (id, root, status) |
| `lsp_fix` | Apply a source code action (default `source.fixAll`; preview unless `write: true`) |
| `lsp_hover` | Hover documentation at a position |
| `lsp_definition` | Definition locations for the symbol at a position |
| `lsp_references` | All references (including the declaration) |
| `lsp_implementation` | Implementations of the symbol at a position |
| `lsp_symbols` | Symbols declared in a file |
| `lsp_workspace_symbol` | Workspace-wide symbol search by query (up to 10 results) |
| `lsp_call_hierarchy` | Call hierarchy: prepare / incoming / outgoing |
| `lsp_rename` | Workspace rename edits (preview only — never writes) |

Also: `/lsp` command (session status + `refresh`) and a data-driven *Language Servers* status card
in the Web settings page while servers start.

## Progressive diagnostics

After each agent turn, files the agent edited (`edit`, `write`, `lsp_fix`, bash redirects) are re-synced
with the live LSP sessions and a throttled, compact diagnostics summary is surfaced
(`progressive.inject`):

- `status` (default) — status line / Web card
- `conversation` — injected into the agent conversation via `agent.inject`
- `none` — disabled

The re-sync waits for a **document**-mode settle; `lsp_diagnostics` with `wait: "full"` waits for real
(non-empty) diagnostics on cold projects.

## Default catalog (official servers)

| Server | Languages | Install strategy |
| --- | --- | --- |
| `typescript` | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | `typescript-language-server` (npm, auto) |
| `kotlin` | `.kt .kts` | `kotlin-lsp` (GitHub release; needs `java`) |
| `gopls` | `.go` | `gopls` (go-install; needs `go`) |
| `rust-analyzer` | `.rs` | `rust-analyzer` (PATH only) |
| `clangd` | `.c .h .cpp .cc .cxx .hpp .hh .hxx` | `clangd` (PATH; ships with Termux) |
| `pyright` | `.py` | `pyright-langserver` (npm, auto) |
| `ruby-lsp` | `.rb .rake .gemspec .ru` | `ruby-lsp` (PATH) |
| `elixir-ls` | `.ex .exs` | `elixir-ls` (PATH) |
| `zls` | `.zig .zon` | `zls` (PATH) |

The TypeScript server is the official `typescript-language-server` — never a linter standing in for a
type-checker.

### Platform matrix (64-bit only: `arm64` / `x64`)

| Strategy | Works on |
| --- | --- |
| npm (typescript, pyright) | everywhere, including android-arm64 (pure JS) |
| github-release (kotlin-lsp) | Linux/macOS/Windows with `java`; refused on android (bionic) |
| go-install (gopls) | anywhere with `go` on PATH |
| PATH-only | wherever the binary is installed; clangd ships with Termux |

32-bit architectures are unsupported: managed installs are refused and the platform is reported
unsupported — never a crash.

### Transparent global TypeScript install

`typescript-language-server` needs a real `typescript` payload (`lib/tsserver.js`) reachable at boot.
The plugin resolves one transparently in this order and surfaces the action in the LSP status line:

1. an explicit `tsserver.path` you configured, or
2. a project-local `node_modules/typescript`, or
3. an already-managed global `typescript`, or
4. **auto-installs `typescript@6` globally** into the managed `binDir`
   (`~/.cache/dsh-lsp/bin`) and points `tsserver.path` at it.

By default it is pinned to the **6.x major** (`payloadVersion: "6"`) because that is the current
stable release that still ships the classic `lib/tsserver.js` layout `typescript-language-server`
consumes (`typescript@7+/latest` replaced it with a new layout).

**The payload version is configurable:**
```yaml
lsp:
  servers:
    typescript:
      payloadVersion: "5"        # install typescript@5 instead of the default 6
      initialization:
        tsserver:
          path: /path/to/typescript/lib/tsserver.js   # optional explicit override
```
An explicit `tsserver.path` always wins; otherwise the configured `payloadVersion` (default `6`) is
installed globally into the managed bin dir.

## Configuration (config-driven)

Configuration lives in the DSH Settings document under the `lsp` namespace (`$DSH_HOME/settings.yaml`
and/or the Web Settings page). Defaults come from the official server catalog; each source overrides
the previous:

```yaml
lsp:
  timeout: 30000          # request/RPC + spawn-settle timeout (ms)
  binDir: ~/.cache/dsh-lsp/bin   # managed installs
  progressive:
    enabled: true
    inject: status        # status | conversation | none  (widget reserved)
    maxDiagnostics: 20
    quietMs: 2000
  servers:
    kotlin: { disabled: true }          # drop a default server
    my-lang: {                           # add a custom server
      command: [my-lang-lsp, --stdio],
      extensions: [.mylang]
    }
```

Per-server options: `command`, `extensions`, `languageId`, `rootMarkers`, `env`, `initialization`,
`autoDownload`, `disabled`.

## How it works

OpenCode/pi-lsp-inspired architecture: one persistent LSP client per (project root, server), discovered
lazily with marker-file root detection (`package-lock.json`, `go.mod`, `Cargo.toml`, …), kept alive for
the agent's lifetime, and shut down on `agent/disposed`. Documents are tracked with versions; `touchFile`
sends `didChangeWatchedFiles` + `didOpen`/`didChange`; diagnostics merge push (`publishDiagnostics`) and
pull (`textDocument/diagnostic`) results with dedupe. Servers that fail to start are marked broken
(`/lsp refresh` clears them) so there are no retry storms; `autoDownload` servers that are missing a
binary attempt a managed install first.

## Development

```bash
pnpm install
pnpm test            # vitest (34 tests; run serially — the fake-server integrations use stdio)
pnpm typecheck       # tsc --noEmit (server + client)
pnpm build           # tsc x2 + build-client → lib/
```

Design and feature-parity matrix: `SPEC.md`.

## License

MIT — see LICENSE.
