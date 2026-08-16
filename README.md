# dsh-plugins

Monorepo of DeepSeek Harness (DSH) plugins. Each package is a publishable DSH
plugin under the `@gitawego` npm scope.

## Packages

- [packages/vision](packages/vision/) — `@gitawego/dsh-vision`: capability-aware
  vision + paste extension (describe_image tool, delegation, paste markers,
  data-driven settings page / tool card).
- [packages/web-search](packages/web-search/) — `@gitawego/dsh-web-search`:
  enhanced web search provider. Works with **no API key** (free Parallel/Exa MCP
  backends) and optionally any LLM-backed web-search endpoint (Anthropic or
  OpenAI protocol) via `opencode-enhanced`.
- [packages/lsp](packages/lsp/) — `@gitawego/dsh-lsp`: config-driven Language
  Server Protocol integration (official servers by default, persistent sessions,
  progressive diagnostics after edits, rich query tools, Web status card).

## Layout & tooling

- **pnpm workspace** (pnpm 12). Root `pnpm-workspace.yaml` declares
  `packages/*` and, importantly, the **`allowBuilds`** map for native
  dependencies that need a postinstall (esbuild, sharp, rollup + their platform
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
