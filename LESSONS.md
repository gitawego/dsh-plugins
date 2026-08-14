# LESSONS.md — dsh-vision session history, pitfalls, and environment

The project's running history, the lessons learned the hard way, and the
host-specific facts a resuming session needs. **AGENTS.md holds the
architecture and design rules; this file is the lessons recorder.**

## Session history (what was done, in order)

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
     `inputModalities` from entry input → catalog → route `defaultInput`.
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
     + `bind`.
     **IMPORTANT: plugin settings namespaces are NOT exposed to the web client's
     settings proxy by default** — `dsh-host-apiproxy` filters `settings.describe`
     through an explicit allowlist (`modelProviderNamespaces()` + hardcoded
     `WEB_SETTINGS_NAMESPACES`/`PRODUCT_SETTINGS_NAMESPACES`; a plugin opt-in is
     "deferred work"). `ctx.settingsScope.bind({namespace})` therefore resolves to
     `unavailable` for plugin namespaces and the form renders empty. The
     established pattern (reference plugin + ours): the plugin serves its own
     same-origin route over the settings seam (ours: `/_dsh/vision/settings`)
     and the client fetches/POSTs it. Keep `import type {} from
     '@deepseek-ai/dsh-client-ui-settings/client'` in the client — it carries the
     `settings.section` SlotMap declaration.
3. **Studied the working reference plugin**
   `~/workspace/dsh-vision-toolkit-ref` (cloned from Anionex/dsh-vision-toolkit):
   bundle patch + `dsh.bundle.patch`, agent-scoped progressive exposure via
   `agent.ctx.tools.register`/`restrict`, credentials, settings, Web client
   structure (tsconfig.client.json, scripts/build-client.mjs, web.ts host routes
   via `ctx.inject(['webServer'], …)`).
4. **Wrote the implementation spec** → `SPEC.md` (17+1 sections). §18 added on
   request: **high token-cache-rate rules** (byte-stable schema registered once,
   rare/idempotent visibility flips, zero dynamic prompt contribution,
   suffix-only paste rewrites, stable delegation request shape, verification via
   `cacheReadTokens`/`cacheWriteTokens`).
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
   - `src/index.ts`: `delegateDepsFor(workspace, signal)` shared entry point.
   - `tests/paste.spec.ts` — 18 tests.
8. **Implemented M3 — Web client plugin** (commit `95e07c5`):
   - `src/web.ts` — optional host route `/_dsh/vision/models` (GET) returning a
     **data-driven** catalog: all registered providers + image-capable models from
     the live LLM registry, the currently configured provider/model, and the
     detected default. **No provider/model ids are hardcoded anywhere.**
     Installed via `ctx.inject(['webServer'], …)` (web profile only).
   - `src/client/index.tsx` — browser plugin: en/zh locale (ns `vision`),
     `describe_image` tool card, Vision settings section with datalist
     suggestions from the live catalog, detected default preselected.
   - `tsconfig.client.json` (CJS + react-jsx + `paths` mapping every client
     subpath to its `lib/types` — required because `moduleResolution: node`
     ignores package exports), `scripts/build-client.mjs` (wraps the compiled
     CJS in `window.__ModuleLoader__.load({id:'dsh-vision', …})` → `lib/client.js`).
   - `package.json`: `exports["./client"]`, `dsh.client {platform:'web',
     inject:[runtime, ui-tool, ui-settings, locale]}`, build script = server +
     client tsc + wrap.
9. **Installed into the web profile via the official command**: `dsh plugin
   --profile web install` against a manifest-declared `file:` dependency —
   because pnpm 12 rc rejects path specs on `dsh plugin add <path>`. Composed
   tree verified; runtime load requires a GUI restart.
10. **Post-restart debugging + settings-route fix** (commits `761217b`, `0ca7f16`):
    - /vision (bare) worked but subcommands fell through to chat: the web client
      only intercepts args-bearing command lines when the command declares an
      `input` hint (matchEnter in dsh-client-ui-commands) → added `input:
      {hint}` to the /vision definition.
    - The Vision settings page rendered EMPTY (namespace proxy allowlist, see
      §2) → routed the form through the plugin's own /_dsh/vision/settings route
      (GET snapshot + same-origin POST save, validated via
      resolveConfig(mergeConfig(...))), client switched to a fetch-based
      SettingsController.
    - Full lifecycle teardown: apply() captures and calls EVERY disposer LIFO.
      Persisted user settings are intentionally NOT wiped on unload.
    - TDD is required: new logic ships with tests first.
11. **Reimplemented delegation as subagent-based (DESIGN RULE)** (commit "subagent
    delegation"): the native transport (ImageBlock -> ctx.attachments.saveImage ->
    ctx.llm.stream) is REMOVED from src/transport.ts (now http-only) and
    src/delegate.ts drives the vision model as a DSH subagent:
    - `src/subagent.ts` (new) — `createVisionSubagent(agentsLike, {provider,
      model, cwd})`: ctx.agents.create with `sessionId: SessionId('vision-'+uuid)`,
      `meta {cwd, origin:'subagent'}`, `agentOptions {provider, model}`; wraps
      `agent.followup(msg)` / `agent.whenIdle()` / `lastAssistantText(
      session.deriveMessages())` / `handle.dispose()` into the `SubagentHandle`
      seam. `AgentsLike` is a structural subset of ctx.agents so tests fake the
      registry.
    - `src/delegate.ts` — `DelegateDeps.createSubagent` replaces the old
      llm/attachments deps; `delegateToSubagent()` sends the prompt via
      `createUserMessage({source:{kind:'user'}})` — a NORMAL user-sourced message
      so the subagent's own pre-step paste hook turns the filepath into markers +
      a native ImageBlock for its multimodal primary. Audit `transport` literal
      is now 'subagent' | 'http'.
    - `src/index.ts`/`src/tool.ts` — wire `createSubagent: (opts) =>
      createVisionSubagent(ctx.agents, opts)`.
    - TDD: `tests/delegate.spec.ts` (8), `tests/subagent.spec.ts` (8),
      `tests/transport.spec.ts` rewritten http-only (10).
12. **Native-first delivery + http fallback (user directive: "use the native way
    as much as possible, avoid base64 as much as possible"; on this host the
    sub-agent path could NOT see pasted images — the model answered "I don't
    see an image" because the sub-agent's own paste hook attaches via
    ctx.attachments.saveImage and the store can NEVER write under /data/data)**:
    - Verified end-to-end: the durability walk (`ensureDurableHome` ->
      `syncDirectory` on every ancestor of DSH_HOME up to `/`) opens
      `/data/data` O_RDONLY -> EACCES for this uid (reproduced in node:
      `open('/data/data','r')` fails even with DSH_PERMISSION_MODE=full), so
      the store is unusable for ANY caller on Android/Termux;
      `~/.dsh/attachments/v1` contains no objects. Termux path translation
      was NOT the problem (both spellings exist and resolve).
    - `DelegateDeps.canDeliverImage` (memoized 1x1-PNG `ctx.attachments.
      saveImage` probe wired in index.ts/tool.ts) decides: `auto` uses the
      sub-agent (native) when available, else falls back to the plugin's own
      http endpoint call when http.baseUrl/credential/model are set, else
      not_configured with guidance; `native` refuses loudly with the new
      `image_delivery_unavailable` code; `http` is the explicit base64 path.
      Tests/delegate.spec.ts +4 — 94 tests green.
13. **Termux path translation at the delegation choke point (user directive:
    "describe_image should be able to translate the path adapted to termux")**:
    `resolveInputPath` already translated for LOADING, but the RAW
    /storage/emulated/0 spelling was what reached the sub-agent message, the
    details, and the audit log. `delegateToVisionModel` now normalizes ONCE at
    the top (`normalizeImagePath` = `resolveInputPath`; `normalized` params
    threaded through loadImage/cache-key/audits/callTransport/runFallback/
    details). TDD: `tests/delegate.spec.ts` +1 platform-gated
    (`describe.runIf(isTermux(process.env, homedir()))`) — 95 tests green.
14. **describe_image VERIFIED WORKING on this host via delegation=http**:
    applied `delegation=http, http.baseUrl=https://opencode.ai/zen/go/v1,
    http.credential=OPENCODE_GO_API_KEY (resolves from ~/.dsh/.credentials.yaml,
    no new credential needed), http.model=minimax-m3` through the plugin's own
    /_dsh/vision/settings route (live). describe_image with the raw
    /storage/emulated/0/... path returned a full screenshot description.
15. **CI/CD + publishable package name (user directive: "make sure the GitHub
    action works as intended, package has correct name, npm token correctly
    setup")**:
    - The unscoped `dsh-vision` is ALREADY TAKEN on the npm registry (owner
      danilky666, v0.2.0) — publishing under it fails. Renamed the package to
      `@gitawego/dsh-vision` (matches the owner account and the NPM_TOKEN
      scope, same pattern as `@gitawego/pi-vision`); removed `"private":
      true` and added `publishConfig.access: public`. The DSH plugin
      identity stays `dsh-vision` (cordis name, logs, cache dir, CSS);
      only the client entry id follows the package name (the host keys the
      boot graph by package name — `scripts/build-client.mjs` now derives
      the `__ModuleLoader__.load({id})` from package.json instead of
      hardcoding it). Web profile dep key + bundles entry updated to
      `@gitawego/dsh-vision`; re-installed and verified via `--dump-config`
      (row still `id: vision, name: dsh-vision`).
    - Added `.github/workflows/ci.yml` (npm ci → typecheck → test → build
      on push/PR) and `.github/workflows/release.yml` (tag `v*` → same
      gates → idempotent skip-if-published → `npm publish --access public`
      with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` → GitHub Release),
      modeled on pi-vision's pnpm workflows but npm-based (this repo ships
      package-lock.json).
    - **NPM_TOKEN is per-repo on GitHub** (no cross-repo secret sharing for
      user accounts): pi-vision's Actions page has the token; the same VALUE
      must be set as dsh-vision's `NPM_TOKEN` secret
      (`gh secret set NPM_TOKEN`). Not set yet — one manual step.

## Diagnoses that shaped the design (deep-dives)

- **Android /data/data EACCES** — the DSH attachment store's durability walk
  (`ensureDurableHome` in dsh-attachment-local) syncs EVERY ancestor of DSH_HOME
  up to `/`; `open('/data/data', O_RDONLY)` fails for any Termux uid (raw
  Android permission, sandbox-independent). Consequence: the attachment store can
  never write on Termux, so BOTH the old native transport AND the sub-agent's
  paste-hook image delivery are impossible there, AND any user paste into a
  multimodal session silently degrades to markers. The plugin therefore probes
  store writability once per process and falls back to its own http endpoint
  call (the pi-vision reference mechanism).
- **Web settings page empty** — `dsh-host-apiproxy` allowlists settings
  namespaces; plugin namespaces are invisible to `ctx.settingsScope.bind`.
  Fix: the plugin serves its own same-origin route (/_dsh/vision/settings).
- **/vision subcommands ignored** — the web client only intercepts args-bearing
  command lines when the command declares `input: {hint}`.
- **pnpm 12 rc copies file: deps** — after every `npm run build`, re-run
  `dsh plugin --profile web install` to refresh the profile copy.

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
- **This host (Termux) vision config:** `delegation=http`,
  `http.baseUrl=https://opencode.ai/zen/go/v1` (OpenCode Zen Go — the pi-ai
  catalog endpoint behind DSH's `opencode-go` route), `http.model=minimax-m3`,
  `http.credential=OPENCODE_GO_API_KEY` (stored in `~/.dsh/.credentials.yaml`;
  refs are env-var names, no new credential needed). The sub-agent path cannot
  deliver images here (see the EACCES deep-dive).

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
   file, run, deleted) for anything structural.
4. **npm:** esbuild's postinstall was skipped by npm's allowScripts gate; vitest still
   ran fine. If a future install breaks esbuild, run
   `npm install-scripts approve esbuild && npm rebuild esbuild`.
5. **The `write` tool is unusable here** (EACCES on the atomic-link step even in the
   session workspace) — but the `edit` tool works; bash heredocs are the reliable
   path for whole-file writes.
6. **pnpm 12 rc (used by `dsh plugin`)** rejects local path specs on
   `dsh plugin add <path>` ("Package name … is invalid, it should have a @scope").
   The official sequence that WORKS: declare the dependency in the
   profile `package.json` as `"<name>": "file:</abs/path>"`, then run
   `dsh plugin --profile web install`. pnpm 12 rc COPIES file: deps into the
   store (no live link) — re-run the install after every repo rebuild.
   **Git-URL installs** were probed and are NOT used (decision recorded): pnpm 12 rc
   rewrites every github git-spec to an https fetch (this host has ssh-only github
   auth), AND it blocks dependency build scripts via an `allowBuilds` allowlist.
   **npm is not part of the official flow**: `dsh plugin` is a pnpm forwarder by
   design (runs `pnpm <args>` in the profile dir, then reconciles bundles).

## Useful reference paths

- pi-vision source: `~/workspace/pi-vision` (extensions/ + lib/)
- reference DSH plugin: `~/workspace/dsh-vision-toolkit-ref` (src/ + cordis.patch.yml,
  client build + web.ts patterns)
- DSH API docs: `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/<pkg>/README.md`
- SPEC (this project's design + KV-cache rules): `SPEC.md`

