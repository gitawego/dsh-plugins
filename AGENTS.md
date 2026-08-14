# AGENTS.md — dsh-vision (session handoff)

Read this first. It records the full session history, the exact repo state, and
everything a fresh session needs to resume the work.

## What this project is

`dsh-vision` — a capability-aware vision + paste extension for **DeepSeek Harness
(DSH)**, ported 1:1 from [`@gitawego/pi-vision`](https://github.com/gitawego/pi-vision)
(v0.6.0). Private repo: **gitawego/dsh-vision** (clone: `~/workspace/dsh-vision`).
Full design: [SPEC.md](SPEC.md) (feature-parity matrix, architecture, KV-cache
requirements §18, milestones §15).

Core idea: multimodal primary models see images natively (`describe_image` is hidden —
delegation is structurally impossible); text-only primaries get a visible
`describe_image` tool that delegates through a cache/retry/fallback pipeline.

## Repo state (as of handoff)

- **Commit:** `06f6cea` "M1: dsh-vision scaffold + describe_image tool …" — pushed to
  `origin/main`. Branch `main` tracks `origin/main`.
- **Status:** `npx tsc --noEmit` clean · `npm run build` works (lib/) · `npm test`
  green (17 vitest tests in `tests/smoke.spec.ts`).
- **`node_modules/` and `lib/` are gitignored** — a fresh checkout needs
  `npm install` + `npm run build`.
- Dev deps installed from npm (`@deepseek-ai/*@0.1.0-rc.6` published). Runtime deps:
  `sharp` + `@img/sharp-wasm32` (host Termux uses the wasm32 variant; the DSH install
  at dsh-global already ships it).

## Session history (what was done)

1. **Studied pi-vision** (`~/workspace/pi-vision`): vision.ts / paste.ts extensions,
   lib/{config,delegate,capability,cache,audit,image}.ts — the feature surface and
   the exact delegation pipeline to port.
2. **Studied DSH plugin APIs** in the harness install at
   `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/*`:
   - `dsh-tools` — `ctx.tools.register(defineTool(...))`, `ToolDefinition` output
     contract, `agent.ctx.tools.register/restrict` for per-agent visibility.
   - `dsh-agent` — `agent/created|disposed`, `agent/request` waterfall (authoritative
     per-request `LlmCallConfig.provider/model`), `agent/pre-step` waterfall
     (`{agent, messages, turn, step, signal}` → `PreStepDecision`).
   - `dsh-llm` — `LlmModelInfo.inputModalities` (absent=unknown, `[]`=negative),
     `resolveModelInfo(provider, model)`, `listProviders()`, `listModels(provider)`,
     `stream(GenerateOptions)`, `BlockAssembler`, `createUserMessage`, `ImageBlock`.
   - `dsh-attachment` — `ctx.attachments.saveImage/readImage`, `ImageAttachmentRef`.
   - `dsh-credentials` — `credentialRef(name)` + `ctx.credentials.resolve(ref)`.
   - `dsh-settings` — `ctx.settings.register(ns, schema, {base, applies:'live',
     validate})` → `SettingsScope {get, watch, update, replace}`; `mutate(ns, ops)`
     only on the service (not the scope). `ctx.settings.mutate(ns, ops)` for unsets.
   - `dsh-commands` — `ctx.commands.register({name, description, handler(invocation)})`
     → `CommandResult {kind:'success', text?} | {kind:'error', text}`.
   - `dsh-llm-pi-ai` — the adapter resolves ImageBlock refs via
     `resolveAttachments: () => ctx.get('attachments')`; `listModels` reports
     `inputModalities` from entry input → catalog → route `defaultInput`. This makes
     the **native transport** (ctx.llm.stream with an ImageBlock) work for registered
     pi-ai vision routes.
   - Web surface: agent presets (dsh-agent-presets) — host-plane global tools are
     visible to every agent via `agent → preset → global` scope chain; the client
     plugin contract (`dsh.client` in package.json, `./client` export, `slots`,
     `locale`, `settings.section` + `tool.call.toolview` slots).
3. **Studied the working reference plugin**
   `~/workspace/dsh-vision-toolkit-ref` (cloned from Anionex/dsh-vision-toolkit):
   bundle patch + `dsh.bundle.patch`, agent-scoped progressive exposure via
   `agent.ctx.tools.register`/`restrict` (its `VisionToolExposure` class is the
   template for our gate), credentials, settings, Web client structure.
4. **Wrote the implementation spec** → `SPEC.md` (17+1 sections; later moved into the
   repo). §18 added on request: **high token-cache-rate rules** (byte-stable schema
   registered once, rare/idempotent visibility flips, zero dynamic prompt
   contribution, suffix-only paste rewrites, stable delegation request shape,
   verification via `cacheReadTokens`/`cacheWriteTokens`).
5. **Created the repo**: `gh repo create dsh-vision --private` (gitawego), cloned to
   `~/workspace/dsh-vision`.
6. **Implemented M1** (all in `src/`, typecheck-clean, tested):
   - `config.ts` — full pi-vision config surface + DSH-only `delegation`
     ('auto'|'native'|'http') and `http {baseUrl, credential, model, protocol}`.
   - `errors.ts`, `capability.ts` (isImageCapable), `image.ts` (load/hash/MIME sniff/
     sharp compress with graceful fallback), `marker.ts`, `batch.ts`
     (mapWithConcurrency, abort-aware), `cache.ts` (memory+disk LRU, content-addressed
     keys), `audit.ts` (JSONL, privacy-truncated paths).
   - `transport.ts` — http (OpenAI /chat/completions + Anthropic /v1/messages bodies)
     and native (ImageBlock via ctx.attachments + ctx.llm.stream + BlockAssembler).
   - `delegate.ts` — the full pipeline: preflight → load+hash → cache → local-only
     gate → compress on miss → retry+fallback → cache-store (never fallback) → audit.
   - `exposure.ts` — `VisionGate`: per-agent primary-model tracking via
     `agent/created` + `agent/request`, deny-mask via `agent.ctx.tools.restrict`,
     idempotent flips only (KV-cache).
   - `tool.ts` — `describe_image` (single + batch ≤50, `image_paths`), constant
     schema, redirect for multimodal primaries, throw → isError on all-failed.
   - `defaults.ts` — data-driven auto-detect (Tier-1 live catalog scan, prefers the
     active primary's provider).
   - `commands.ts` — `/vision` with all pi-vision subcommands writing through settings.
   - `index.ts` — apply(): settings ns + live watch, gate install, tool register,
     command register, auto-detect on agent/created, disposers.
   - `tests/smoke.spec.ts` — 17 tests (config clamps, credential validation,
     capability, markers, batch concurrency+abort, cache LRU+disk, audit, truncation).

## What is NOT done (next milestones)

- **M2 — paste UX** (`src/paste.ts`): `agent/pre-step` waterfall — detect image path
  tokens in user messages, rewrite to `[Image-#N]` markers, attach ImageBlocks
  (multimodal) / hint / auto-delegate (text-only) per `textOnlyPasteMode`.
- **M3 — Web client plugin**: `dsh.client` declaration + `src/client/index.tsx`
  (settings.section for the Vision form, `tool.call.toolview` card for
  describe_image, locale, optional `/_dsh/vision/...` host routes via
  dsh-host-webserver), plus a separate client tsconfig + bundle build
  (reference: dsh-vision-toolkit-ref's tsconfig.client.json + scripts/build-client.mjs).
- **M3 — native transport e2e** untested against a real vision route; **auto-detect**
  untested with a live pi-ai provider.
- **Install/verify in a real profile**: `dsh plugin --profile web add ~/workspace/dsh-vision`,
  restart `dsh web`, `/vision show`, describe an image, check audit tail + cache stats;
  KV-cache check per SPEC §18.9.
- **M4 — polish**: compose preview slot, headless profile verification, README
  expansion, CHANGELOG.
- `allowedDirs` hardening (SPEC §16.4) is deferred to v2.

## Environment facts a resuming session needs

- **DSH install (source of truth for API types):**
  `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/*` — read
  README.md + lib/types/*.d.ts there before changing API usage.
- **DSH_HOME:** `/data/data/com.termux/files/home/.dsh`; profiles: `web` (GUI at
  http://127.0.0.1:3080), `headless`, `tui`. Web profile bundles: dsh-base + dsh-web-app.
- **gh** authenticated as `gitawego` (ssh protocol; repo `gitawego/dsh-vision`).
- **Session workspace quirk:** the agent session workspace is
  `~/workspace/dsh-mcp-adapter` (a different project). The `write` tool is EACCES
  everywhere in this environment; **all file writes go through bash heredocs**.

## Tooling pitfalls (learned the hard way — do not repeat)

1. **run_code + template literals:** every backtick in a bash-command template literal
   MUST be escaped `\``, and `${...}` must be `\${...}`, or the code fails to parse
   ("Expected ',', got 'ident'"). A `\n` inside a template literal is a REAL newline
   (write `\\n` for a literal backslash-n, e.g. inside single-quoted heredocs the
   content must keep `\n` as two characters).
2. **Heredocs:** write ONE file per bash call (multiple heredocs in one template
   literal have intermittently failed to parse). Use `<<'EOF'` (quoted delimiter) so
   `$`, backticks, and backslashes in the content are preserved literally.
3. **Shell quoting of argv:** do NOT pass TS code with single quotes through bash
   single-quoted args (quotes get stripped/concatenated). Prefer writing a patch
   script file (heredoc) and running it; the helper pattern
   `node <file> '<JSON pairs>'` also breaks on single quotes — use the script-file
   approach instead.
4. **npm:** esbuild's postinstall was skipped by npm's allowScripts gate; vitest still
   ran fine. If a future install breaks esbuild, run
   `npm install-scripts approve esbuild && npm rebuild esbuild`.
5. **The write tool is unusable here** (EACCES even in the session workspace) — bash
   heredocs are the only reliable file-writing path.

## Useful reference paths

- pi-vision source: `~/workspace/pi-vision` (extensions/ + lib/)
- reference DSH plugin: `~/workspace/dsh-vision-toolkit-ref` (src/ + cordis.patch.yml)
- DSH API docs: `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/<pkg>/README.md`
- SPEC (this project's design + KV-cache rules): `SPEC.md`

## Resume checklist

1. `cd ~/workspace/dsh-vision && npm install && npm run build && npm test` — expect all
   green (typecheck + 17 tests).
2. Implement M2 paste hook (`src/paste.ts` + wire into `index.ts` via `agent/pre-step`).
3. Implement M3 client plugin + native-transport e2e.
4. Install into the web profile and verify manually; commit + push each milestone.
