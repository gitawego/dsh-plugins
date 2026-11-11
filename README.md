# dsh-plugins

Monorepo of DeepSeek Harness (DSH) plugins. Each package is a publishable DSH
plugin under the `@gitawego` npm scope, targeting DSH **0.2.2-rc.1** (the
0.1.x line is not supported by the current versions — see
[`COMPATIBILITY.md`](COMPATIBILITY.md)).

## Commands

```bash
pnpm check:pins   # every @deepseek-ai/* / @earendil-works/* pin must match the installed harness
pnpm verify       # check:pins + typecheck + build + tests
pnpm fix:pins     # rewrite drifted pins to the host's resolved versions
```

A plugin runs *inside* the harness process, so a host package it declares at
runtime is a second copy: an older protocol, catalog, or endpoint than the host
it loads into. That is not theory — one package here pinned `pi-ai@0.85.1`
against a `1.5.0` host and grew a whole provider route to compensate.
`pnpm check:pins` fails the build before that reaches a profile, and
`scripts/install-plugins.sh` refuses to deploy on it.

## Packages

- [packages/llm-provider](packages/llm-provider/) — `@gitawego/dsh-llm-provider`:
  the **OpenCode Go** dashboard. It serves no route: `dsh-llm-pi-ai` owns the
  route, the endpoint, the model catalog, and the `x-opencode-session` header
  (pi-ai 1.5.0 stamps it from the session id). The plugin reports the two facts
  no host seam owns — the provider's live model list versus the installed
  catalog (plus the `models:` block that reconciles them) and the 5-hour /
  weekly / monthly allowance — through a command, a tool, a guarded loopback
  route, and a settings section.
- [packages/llm-agy](packages/llm-agy/) — `@gitawego/dsh-llm-agy`:
  the **Antigravity (`agy`) ACP** provider. Registers the `agy` route and drives
  `agy acp` over ndjson JSON-RPC, discovering models and `thought_level` from
  ACP config options and bridging ACP tool permissions into DSH approvals. It is
  an agent-delegate:
  `agy` runs its own tools, so DSH tool schemas are not sent. Authentication is
  the CLI's existing Google/Antigravity login; no API key is stored.
- [packages/web-search](packages/web-search/) — `@gitawego/dsh-web-search`:
  **deprecated** (kept working, no new features). Enhanced web search provider:
  works with **no API key** (free Parallel/Exa MCP backends) and optionally any
  LLM-backed web-search endpoint via `opencode-enhanced`. DSH 0.2 ships its own
  web stack (DeepSeek search with account sign-in, Search-API/Exa/Perplexity
  providers, `web_fetch`, multi-query search, and a Web-search settings page);
  this plugin's remaining niche is the credential-free MCP chain and arbitrary
  MCP servers.
- [packages/lsp](packages/lsp/) — `@gitawego/dsh-lsp`: config-driven Language
  Server Protocol integration (official servers by default, persistent sessions,
  progressive diagnostics after edits, rich query tools, Web status card).

## Layout & tooling

- **pnpm workspace** (pnpm 12). Root `pnpm-workspace.yaml` declares
  `packages/*` and, importantly, the **`allowBuilds`** map for native
  dependencies that need a postinstall (esbuild, rollup + their platform
  binaries). When you add a package that brings one of these, extend
  `allowBuilds` — otherwise CI fails with `ERR_PNPM_IGNORED_BUILDS`.
- Each package self-contains its `package.json`, `tsconfig*.json`,
  `src/`, `tests/`, `scripts/`, and `cordis.patch.yml` (mirroring a
  standalone DSH plugin). A package is server-only, or also ships a Web client
  (`dsh.client` block -> `scripts/build-client.mjs` -> `lib/client.js`).

### Add a new plugin package

1. `mkdir packages/<name>` and give it a publishable
   `"name": "@gitawego/dsh-<name>"` with a build that emits `lib/`.
2. Add its `cordis.patch.yml` (bundle patch) and, if it renders in the Web
   GUI, a `dsh.client` declaration.
3. Extend `allowBuilds` in `pnpm-workspace.yaml` for any native deps.
4. Install into a DSH profile (e.g. web) as a `file:` dep + `dsh plugin
   --profile <name> install`.

## Commands

- `pnpm install` — install all workspace deps (runs each package's `prepare`
  build).
- `pnpm -r --parallel typecheck` / `test` — per-package typecheck/tests.
- `pnpm -r build` — build all packages to `lib/`.

## CI / release

- **CI** (`.github/workflows/ci.yml`): on push/PR, pnpm install →
  typecheck → test → build for every package.
- **Release** (`.github/workflows/release.yml`): push a `v*` tag → test/build
  → publish **every package whose version isn't already on npm** via OIDC
  trusted publishing (no token). The publish loop globs `packages/*`
  automatically, so adding a package needs **no workflow change** — just bump
  its version and tag once. See the header comment in release.yml for the
  per-package npm trusted-publisher setup.
