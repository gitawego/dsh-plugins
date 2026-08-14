# AGENTS.md — dsh-vision (session handoff)

Read this first. It records the full session history, the exact repo state, and
everything a fresh session needs to resume the work.

## What this project is

`dsh-vision` — a capability-aware vision + paste extension for **DeepSeek
Harness (DSH)**, ported 1:1 from [`@gitawego/pi-vision`](https://github.com/gitawego/pi-vision)
(v0.6.0). Private repo: **gitawego/dsh-vision** (clone: `~/workspace/dsh-vision`).
Full design: [SPEC.md](SPEC.md) (feature-parity matrix, architecture, KV-cache
requirements §18, milestones §15).

Core idea: multimodal primary models see images natively (`describe_image` is hidden —
delegation is structurally impossible); text-only primaries get a visible
`describe_image` tool that delegates through a cache/retry/fallback pipeline.

## Repo state (as of handoff)

- **Commit:** `95e07c5` "M3: Web client plugin …" — pushed to `origin/main`.
  Branch `main` tracks `origin/main`. History: `06f6cea` M1, `11d1843` M2,
  `95e07c5` M3.
- **Status:** `npm run typecheck` clean (server + client tsconfigs) · `npm run
  build` works (lib/ incl. the client bundle `lib/client.js`) · `npm test`
  green (35 vitest tests: 17 in `tests/smoke.spec.ts`, 18 in `tests/paste.spec.ts`).
- **`node_modules/` and `lib/` are gitignored** — a fresh checkout needs
  `npm install` + `npm run build`.
- Dev deps installed from npm (`@deepseek-ai/*@0.1.0-rc.6` published; client
  packages `dsh-client-runtime/ui-slots/ui-tool/ui-settings/locale` +
  `dsh-host-webserver` added for M3). Runtime deps: `sharp` +
  `@img/sharp-wasm32` (host Termux uses the wasm32 variant; the DSH install
  at dsh-global already ships it).
- **Web profile install (official `dsh plugin`):** the `web` profile declares
  `"dsh-vision": "file:/data/data/com.termux/files/home/workspace/dsh-vision"` in
  `~/.dsh/profiles/web/package.json` dependencies + `dsh-vision` in
  `dsh.profile.bundles`, and was materialized with
  `dsh plugin --profile web install` (pnpm install + the dsh bundle reconcile) —
  `node_modules/dsh-vision` is now a pnpm-managed link into the store and
  `pnpm-lock.yaml` exists. The file: dep is a LIVE link to the source dir, so
  rebuilds in the repo are picked up. Composed tree verified via
  `dsh --profile web --dump-config` (row `- id: vision, name: dsh-vision`).
  **The running GUI still needs a restart to load it** (client bundles only
  refresh via the loader; the web patch disables client-hmr).

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
     (`{agent, messages, turn, step, signal}` → `PreStepDecision`; the ENTER branch
     messages are what the loop durably logs as `user/message` and sends to the
     model — rewriting them with the same message id is the correct paste seam).
   - `dsh-llm` — `LlmModelInfo.inputModalities` (absent=unknown, `[]`=negative),
     `resolveModelInfo(provider, model)`, `listProviders()`, `listModels(provider)`,
     `stream(GenerateOptions)`, `BlockAssembler`, `createUserMessage`, `freezeMessage`,
     `ImageBlock`.
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
   - **Client contract (M3):** `dsh.client = {platform, inject[]}` scanned by
     `dsh-client-modules`; bundle at `exports["./client"]` served as
     `/plugins/<id>/client.js`; bundle registers
     `window.__ModuleLoader__.load({id, factory})`; browser half exports
     `inject` (service names: `slots`, `locale`, `settingsScope`) + `apply(ctx)`;
     `ctx.slots.inject(name, cb)` + `ctx.slots.register` (keyed toolview
     `{name:'tool.call.toolview', key:'describe_image'}`; list settings section
     `{name:'settings.section', id, order, label}`); `ctx.locale.register(ns, {en, zh})`
     + `bind`; settings form via `ctx.settingsScope.bind({namespace:'vision'})`
     (`SettingsScope.getSnapshot/subscribe/set/unset` — NO `load`).
3. **Studied the working reference plugin**
   `~/workspace/dsh-vision-toolkit-ref` (cloned from Anionex/dsh-vision-toolkit):
   bundle patch + `dsh.bundle.patch`, agent-scoped progressive exposure via
   `agent.ctx.tools.register`/`restrict` (its `VisionToolExposure` class is the
   template for our gate), credentials, settings, Web client structure (tsconfig.client.json,
   scripts/build-client.mjs, web.ts host routes via `ctx.inject(['webServer'], …)`).
4. **Wrote the implementation spec** → `SPEC.md` (17+1 sections; later moved into the
   repo). §18 added on request: **high token-cache-rate rules** (byte-stable schema
   registered once, rare/idempotent visibility flips, zero dynamic prompt
   contribution, suffix-only paste rewrites, stable delegation request shape,
   verification via `cacheReadTokens`/`cacheWriteTokens`).
5. **Created the repo**: `gh repo create dsh-vision --private` (gitawego), cloned to
   `~/workspace/dsh-vision`.
6. **Implemented M1** (all in `src/`, typecheck-clean, tested):
   `config.ts`, `errors.ts`, `capability.ts`, `image.ts`, `marker.ts`, `batch.ts`,
   `cache.ts`, `audit.ts`, `transport.ts` (http + native), `delegate.ts` (the full
   pipeline), `exposure.ts` (`VisionGate`), `tool.ts` (`describe_image`), `defaults.ts`
   (data-driven auto-detect), `commands.ts` (`/vision`), `index.ts` (apply()),
   `tests/smoke.spec.ts` (17 tests).
7. **Implemented M2 — paste UX** (commit `11d1843`):
   - `src/paste.ts` — `createPasteHook(deps)` registered on `agent/pre-step`:
     detects image path tokens in user-sourced messages, rewrites them to
     `[Image-#N]` markers, and branches: multimodal primary → attach ImageBlocks
     via `ctx.attachments.saveImage` (markers positional); text-only primary →
     `textOnlyPasteMode` hint (markers + path list nudging describe_image) / auto
     (delegate through the shared pipeline, bounded concurrency, batch timeout,
     hint fallback) / off (markers only). Identity-preserving rewrite via
     `freezeMessage({...msg, content})`. Never throws (falls back to the original
     decision). KV-cache: adds text only for messages with resolvable image tokens.
   - `src/marker.ts` additions: `renderMarkersResolved` (token→index map,
     right-to-left longest-match), `buildPasteHintLine`, `buildDescriptionsBlock`.
   - `src/index.ts`: `delegateDepsFor(workspace, signal)` shared entry point;
     paste hook wired.
   - `tests/paste.spec.ts` — 18 tests (token extraction, marker rendering,
     hook transforms with injected fakes: multimodal attach, hint, off, auto,
     all-fail→hint, localOnly short-circuit, disabled→markers-only, plugin-source
     untouched, reject passthrough, timeout→hint).
8. **Implemented M3 — Web client plugin** (commit `95e07c5`):
   - `src/web.ts` — optional host route `/_dsh/vision/models` (GET) returning a
     **data-driven** catalog: all registered providers + image-capable models from
     the live LLM registry, the currently configured provider/model, and the
     detected default (catalog-scan preference, primary-provider first). **No
     provider/model ids are hardcoded anywhere.** Installed via
     `ctx.inject(['webServer'], …)` (web profile only).
   - `src/client/index.tsx` — browser plugin: en/zh locale (ns `vision`),
     `describe_image` tool card (`tool.call.toolview`, keyed), Vision settings
     section (`settings.section`, id `vision`): provider/model inputs with
     datalist suggestions from the live catalog, detected default preselected
     when unset and marked "(detected)", plus delegation/paste/limits/behavior
     fields; writes through `ctx.settingsScope.bind({namespace:'vision'})`
     (`set`/`unset` per field; http written as the whole nested object).
   - `tsconfig.client.json` (CJS + react-jsx + `paths` mapping every client
     subpath to its `lib/types` — required because `moduleResolution: node`
     ignores package exports), `scripts/build-client.mjs` (wraps the compiled
     CJS in `window.__ModuleLoader__.load({id:'dsh-vision', …})` → `lib/client.js`).
   - `package.json`: `exports["./client"]`, `dsh.client {platform:'web',
     inject:[runtime, ui-tool, ui-settings, locale]}`, build script = server +
     client tsc + wrap; client packages added as devDeps + peers.
9. **Installed into the web profile via the official command** (see "Web profile
   install" above): `dsh plugin --profile web install` (pnpm install + reconcile)
   against a manifest-declared `file:` dependency — because pnpm 12 rc rejects
   path specs on `dsh plugin add <path>` ("should have a @scope", proven with a
   minimal probe package). Composed tree verified; runtime load requires a GUI
   restart.

## What is NOT done (next milestones)

- **Restart `dsh web` and verify manually** (the running GUI predates the install):
  `/vision show`, describe an image (check audit tail + cache stats), confirm the
  Vision settings section and describe_image card render, check the
  `/_dsh/vision/models` catalog and the detected default, KV-cache per SPEC §18.9.
- **Native-transport e2e** against a real pi-ai vision route is untested; **auto-detect**
  untested with a live pi-ai provider (both need a configured image-capable route).
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
- **Session workspace quirk:** the agent session workspace IS `~/workspace/dsh-vision`.
  The `write` tool fails with EACCES (its atomic-rename link step is denied) but
  the `edit` tool WORKS — prefer `edit` for targeted changes; use bash heredocs
  (one file per call, quoted `<<'EOF'`) for new files.

## Tooling pitfalls (learned the hard way — do not repeat)

1. **run_code + template literals:** every backtick in a bash-command template literal
   MUST be escaped `\``, and `${...}` must be `\${...}`, or the code fails to parse
   ("Expected ',', got 'ident'"). A `\n` inside a template literal is a REAL newline
   (write `\\n` for a literal backslash-n, e.g. inside single-quoted heredocs the
   content must keep `\n` as two characters).
2. **Heredocs:** write ONE file per bash call (multiple heredocs in one template
   literal have intermittently failed to parse). Use `<<'EOF'` (quoted delimiter) so
   `$`, backticks, and backslashes in the content are preserved literally. `mkdir -p`
   parent dirs first (e.g. `src/client`, `scripts`).
3. **Shell quoting of argv:** do NOT pass TS/JS code with single quotes or regexes
   through bash single-quoted args, and do NOT rely on sed for multi-line inserts
   (GNU sed on this host rejects `\n` replacements and `\b` word boundaries).
   Prefer the `edit` tool for small changes and a node patch script (heredoc'd to a
   file, run, deleted) for anything structural. In node patch scripts use template
   literals (backticks) for multi-line anchors — real newlines in the file are fine,
   but a `\n` written into a double-quoted JS string becomes a real newline and
   breaks the literal.
4. **npm:** esbuild's postinstall was skipped by npm's allowScripts gate; vitest still
   ran fine. If a future install breaks esbuild, run
   `npm install-scripts approve esbuild && npm rebuild esbuild`.
5. **The `write` tool is unusable here** (EACCES on the atomic-link step even in the
   session workspace) — but the `edit` tool works; bash heredocs are the reliable
   path for whole-file writes.
6. **pnpm 12 rc (used by `dsh plugin`)** rejects local path specs on
   `dsh plugin add <path>` ("Package name … is invalid, it should have a @scope";
   registry adds work, every `file:`/`link:`/relative form fails — proven with a
   probe package). The official sequence that WORKS: declare the dependency in the
   profile `package.json` as `"<name>": "file:</abs/path>"` (exactly what pnpm add
   would have written), then run `dsh plugin --profile web install` — pnpm install
   materializes it as a proper store link and the dsh reconcile step adds it to
   `dsh.profile.bundles`. file: deps stay live-linked to the source dir.

## Useful reference paths

- pi-vision source: `~/workspace/pi-vision` (extensions/ + lib/)
- reference DSH plugin: `~/workspace/dsh-vision-toolkit-ref` (src/ + cordis.patch.yml,
  client build + web.ts patterns)
- DSH API docs: `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/<pkg>/README.md`
- SPEC (this project's design + KV-cache rules): `SPEC.md`

## Resume checklist

1. `cd ~/workspace/dsh-vision && npm install && npm run build && npm test` — expect all
   green (typecheck + 35 tests).
2. Restart `dsh web` (user action) and verify the plugin end-to-end (list above).
3. Native-transport e2e + auto-detect against a live pi-ai vision route.
4. M4 polish; commit + push each milestone.

