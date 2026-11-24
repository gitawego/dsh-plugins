# dsh-plugins

Monorepo of DeepSeek Harness (DSH) plugins. Each package is a publishable DSH
plugin under the `@gitawego` npm scope, targeting the DSH **`^0.2.2-rc.1`**
compatibility range (the lockfile pins the tested `0.2.2-rc.5`; the 0.1.x line
is not supported — see [`COMPATIBILITY.md`](COMPATIBILITY.md)).

## Commands

```bash
bun install        # install the workspace and build every package
bun run check:pins # every @deepseek-ai/* / @earendil-works/* declaration must accept the installed harness
bun run verify     # check:pins + typecheck + build + tests
bun run fix:pins   # widen declarations that reject the resolved host
```

A plugin runs *inside* the harness process, so a host package it declares at
runtime is a second copy: an older protocol, catalog, or endpoint than the host
it loads into. That is not theory — one package here pinned `pi-ai@0.85.1`
against a `1.5.0` host and grew a whole provider route to compensate. Runtime
host dependencies are still forbidden. Development and peer declarations use
ranges, and `bun run check:pins` only fails when a range cannot accept the host
that is actually installed. `scripts/install-plugins.sh` refuses to deploy on
that failure.

## Packages

- [packages/llm-provider](packages/llm-provider/) — `@gitawego/dsh-llm-provider`:
  the **OpenCode Go** dashboard. It serves no route: `dsh-llm-pi-ai` owns the
  route, the endpoint, the model catalog, and the `x-opencode-session` header
  (pi-ai 1.5.0 stamps it from the session id). The plugin reports the provider's
  live model list and the 5-hour / weekly / monthly allowance through a command,
  a tool, a guarded loopback route, and a settings section. The same section
  shows only the route's enabled models and writes their allowlist to
  `llm-pi-ai.providers.<route>.models` through the shared settings form.
- [packages/llm-agy](packages/llm-agy/) — `@gitawego/dsh-llm-agy`:
  the **Antigravity (`agy`) ACP** provider. Registers the `agy` route and drives
  `agy acp` over ndjson JSON-RPC, discovering models and `thought_level` from
  ACP config options, forwarding image attachments as ACP image blocks, and
  bridging ACP tool permissions into DSH approvals. It is an agent-delegate:
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

- **Bun workspace** (Bun 1.4.5). Root `package.json` declares
  `workspaces: ["packages/*"]`; `bun.lock` pins the tested dependency graph.
  Bun blocks dependency lifecycle scripts by default, so a package that needs a
  postinstall (for example esbuild) must be listed in the root
  **`trustedDependencies`**. Bun installs the workspace with an isolated
  `node_modules` layout; the DSH profile uses a flat, hoisted one.
- Each package self-contains its `package.json`, `tsconfig*.json`,
  `src/`, `tests/`, `scripts/`, and `cordis.patch.yml` (mirroring a
  standalone DSH plugin). A package is server-only, or also ships a Web client
  (`dsh.client` block -> `scripts/build-client.mjs` -> `lib/client.js`).

### Add a new plugin package

1. `mkdir packages/<name>` and give it a publishable
   `"name": "@gitawego/dsh-<name>"` with a build that emits `lib/`.
2. Add its `cordis.patch.yml` (bundle patch) and, if it renders in the Web
   GUI, a `dsh.client` declaration.
3. Extend `trustedDependencies` in the root `package.json` for any native deps
   whose postinstall must run.
4. Install into a DSH profile with `bash scripts/install-plugins.sh`, which
   writes the `file:` dependency and runs Bun. DSH's `dsh plugin` command
   forwards to pnpm, which this repository intentionally no longer uses.

## Commands

- `bun install` — install all workspace deps (runs each package's `prepare`
  build).
- `bun run --filter '*' typecheck` / `test` — per-package typecheck/tests.
- `bun run --filter '*' build` — build all packages to `lib/`.

## CI / release

- **CI** (`.github/workflows/ci.yml`): on push/PR, `bun install` →
  typecheck → build → test for every package.
- **Release** (`.github/workflows/release.yml`): push a `v*` tag → test/build
  → publish **every package whose version isn't already on npm** via OIDC
  trusted publishing (no token). The publish loop globs `packages/*`
  automatically, so adding a package needs **no workflow change** — just bump
  its version and tag once. See the header comment in release.yml for the
  per-package npm trusted-publisher setup.
