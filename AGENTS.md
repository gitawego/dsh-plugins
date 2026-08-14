# AGENTS.md — dsh-vision (architecture)

Read this first. This file records the **project architecture and the
non-negotiable design rules**. It is deliberately NOT a lessons recorder:
session history, debugging deep-dives, tooling pitfalls, and host/environment
facts live in [LESSONS.md](LESSONS.md). Full design: [SPEC.md](SPEC.md)
(feature-parity matrix, architecture, KV-cache requirements §18, milestones §15).

## What this project is

`dsh-vision` — a capability-aware vision + paste extension for **DeepSeek
Harness (DSH)**, ported 1:1 from `@gitawego/pi-vision` (v0.6.0). Private repo:
**gitawego/dsh-vision** (clone: `~/workspace/dsh-vision`).

Core idea: multimodal primary models see images natively (`describe_image` is
hidden — delegation is structurally impossible); text-only primaries get a
visible `describe_image` tool that delegates through a
cache/retry/fallback pipeline.

## Design rule — how describe_image must delegate (NON-NEGOTIABLE)

The vision plugin must NEVER delegate to another agent tool, and must NOT depend
on the harness attachment store or any adapter/pi-ai internals to carry the
image. Delegation uses ONLY DSH public APIs:

1. Find the vision-capable model from DSH's own registry: ctx.llm.listProviders()
   / listModels() filtered on inputModalities including 'image' (data-driven,
   never hardcoded; auto-detect implements this).
2. Spawn a DSH subagent with that model as its primary:
   ctx.agents.create({ agentOptions: { provider, model: <vision model> } }).
3. Send the subagent the image by FILEPATH (a normal message with the path) — the
   subagent reads the image and returns its description. NO base64 in the
   message, NO ctx.attachments.saveImage / ImageBlock transport, NO digging into
   pi-ai/adapter internals, NO llm.stream with an ImageBlock for delegation.
4. Return the subagent's text content to the caller; dispose the subagent.

Rationale: the old native transport (ImageBlock -> ctx.attachments.saveImage ->
ctx.llm.stream) is BROKEN on Android/Termux (the attachment store's durability
walk opens /data/data -> EACCES) and is conceptually wrong — it routes through
the harness's generic agent/tool machinery instead of driving the vision model
as a subagent, mirroring pi-vision for the pi agent (user directive). See
LESSONS.md for the full diagnosis.

**Native-first delivery (user directive, "use the native way as much as
possible, avoid base64 as much as possible"):** the sub-agent path IS the
native path (the image rides DSH's own ImageBlock machinery). `delegate.ts`
probes once per process whether the attachment store can write
(`DelegateDeps.canDeliverImage`, memoized 1x1-PNG `ctx.attachments.saveImage`
probe wired in index.ts/tool.ts). When it cannot — Android/Termux: the store's
durability walk syncs every ancestor of DSH_HOME up to `/` and `/data/data`
is O_RDONLY-EACCES for any Termux uid, so the store can NEVER write there —
then:
  - `delegation=auto` falls back to the plugin's own http endpoint call
    (base64 image — unavoidable: the OpenAI/Anthropic inline-image formats ARE
    base64 by protocol), if http.baseUrl/credential/model are set, else returns
    not_configured with guidance;
  - `delegation=native` refuses loudly with `image_delivery_unavailable`
    (never a silent "no image" subagent reply);
  - `delegation=http` is the explicit base64 path.
Cache/retry/fallback/audit layers are orthogonal to the transport choice.

## Architecture

### Runtime surface — `src/index.ts` (apply)
- Registers the `vision` settings namespace (applies 'live'), installs the
  gate, wires the tool / command / paste hook / web routes, and returns a full
  LIFO teardown (gate, auto-detect, settings watch, paste hook, command, tool).
- `delegateDepsFor(workspace, signal)`: the single `DelegateDeps` factory
  shared by the tool and paste auto-delegation — live config, home, workspace,
  resolveCredential (ctx.credentials), `createSubagent` (ctx.agents via
  src/subagent.ts), `canDeliverImage` (memoized store probe).

### Delegation pipeline — `src/delegate.ts`
Flow: enabled → configured → **normalizeImagePath** (Termux storage translation
once — the translated path is what loading, the sub-agent message, details, and
audit all carry) → `resolveTransport` (native-first) → loadImage → cache hit →
local-only gate → compress on miss → `withRetry(callTransport)` → fallback →
cache store (never a fallback result) → audit entry.
- `DelegateDeps` seams (all injectable for tests): config, home, workspace,
  resolveCredential, createSubagent, canDeliverImage?, signal?, cache?.
- `resolveTransport`: http → plugin endpoint; auto/native → subagent when
  canDeliverImage; auto falls back to http; native refuses with
  `image_delivery_unavailable`.
- Result: `DelegateResult {ok, text, details{model, image_path, transport:
  'subagent'|'http', cached, fallback}}`.

### Transports
- **Sub-agent (native)** — `src/subagent.ts`: `createVisionSubagent` over
  `ctx.agents.create` (public API): sessionId `SessionId('vision-'+uuid)`,
  meta {cwd, origin:'subagent'}, agentOptions {provider, model}; wraps
  followup / whenIdle / `lastAssistantText(session.deriveMessages())` /
  dispose into the `SubagentHandle` seam. The image rides a normal
  user-sourced message; the subagent's OWN pre-step paste hook attaches it
  natively (ImageBlock) for its multimodal primary. `AgentsLike` is a
  structural subset of ctx.agents so tests fake the registry.
- **http (base64, fallback/explicit)** — `src/transport.ts`: the plugin's own
  direct endpoint call (OpenAI-compatible `/chat/completions` or Anthropic
  `/v1/messages`) with a base64 data-URL image — the pi-vision reference
  mechanism. Config-driven (http block), no agent, no store.

### Capability gate + tool — `src/exposure.ts`, `src/tool.ts`, `src/capability.ts`
- `VisionGate`: per-agent deny mask hiding `describe_image` while the
  primary model is multimodal (seeds on agent/created, resyncs on
  agent/request, idempotent — stable request prefixes for KV-cache, SPEC §18).
- `describe_image`: constant schema (registered once), passthrough redirect
  for multimodal primaries, batch path (≤50 images, bounded concurrency,
  per-image resilience).

### Paste UX — `src/paste.ts` + `src/marker.ts` + `src/paths.ts`
- `agent/pre-step` hook: user messages containing image path tokens are
  rewritten to `[Image-#N]` markers; multimodal primary → native ImageBlock
  attachments (markers positional); text-only primary → hint line (default) /
  auto-delegate through the shared pipeline (bounded concurrency, batch
  timeout, hint fallback) / off. Never throws.
- `src/paths.ts`: Termux-only storage-path translation
  (`/storage/emulated/0|/sdcard/<Top>/...` → `<home>/storage/<mapped>/...`),
  strictly gated on Termux (env markers or canonical home), used by
  image.ts/paste.ts and now by delegate.ts's normalizeImagePath.

### Web client — `src/web.ts` + `src/client/index.tsx`
- Host routes (web profile only): `/_dsh/vision/models` (data-driven catalog:
  providers + image-capable models from the live ctx.llm registry + detected
  default — nothing hardcoded) and `/_dsh/vision/settings` (GET snapshot +
  same-origin POST save through the settings seam). The route exists because
  the harness settings proxy allowlists namespaces and plugin namespaces are
  NOT exposed (see LESSONS.md).
- Browser plugin: settings section (provider/model selects fed by the live
  catalog, detected default, delegation/paste/limits fields), `describe_image`
  tool card, en/zh locale (ns `vision`).

### Config surface — `src/config.ts`
- provider/model (sub-agent path) · delegation (auto/native/http) ·
  http{baseUrl, credential (a DSH credential-ref NAME), model, protocol} ·
  localOnly · cache{Enabled, Persist, MaxEntries} ·
  retry{Attempts, BackoffMs} · fallback{Provider, Model} ·
  textOnlyPasteMode (hint/auto/off) · markerStyle (code/bold/plain) ·
  systemPrompt · autoDelegatePrompt/TimeoutMs · batchConcurrency ·
  autoDetectVisionModel (data-driven) · auditLog/auditLogPath · limits
  (maxDimension, jpegQuality, previewMaxWidthCells).

### Key data flows
- **describe_image**: tool execute → gate (multimodal? redirect) →
  delegateToVisionModel → normalizeImagePath → resolveTransport → loadImage →
  cache/retry/fallback → http | subagent → audit. Every failure returns a
  structured, actionable error.
- **Paste**: user message with image path → pre-step hook → markers (+
  attachments | hint | auto-delegated descriptions).

## Repo state (brief)

- Branch `main` tracks `origin/main`; current HEAD `a152381` (Termux path
  translation). Commits by milestone are listed in LESSONS.md.
- `npm run typecheck` clean (server + client) · `npm run build` works
  (lib/ incl. `lib/client.js`) · `npm test` green (**95 tests**: smoke 18,
  paste 18, web 9, paths 9, delegate 13, subagent 8, transport 10,
  client-controller 10). TDD is required: failing test first, then implement.
- `node_modules/` and `lib/` are gitignored — fresh checkout needs
  `npm install` + `npm run build` (package.json `prepare` runs it).
- **Web profile install**: `dsh-vision` is a `file:` dep of the `web`
  profile (pnpm 12 rc COPIES it into its store — NOT a live link), so re-run
  `dsh plugin --profile web install` after every rebuild. The running GUI
  needs a restart to load new builds (client bundles only refresh via the
  loader; client-hmr is disabled in the web patch).

## Next milestones

- **Restart `dsh web`** (user action) and verify end-to-end (on this host
  describe_image already works via delegation=http — see LESSONS.md).
- **M4 — polish**: compose preview slot, headless profile verification, README
  expansion, CHANGELOG.
- Sub-agent live e2e + auto-detect still need a host with a working attachment
  store.
- `allowedDirs` hardening (SPEC §16.4) is deferred to v2.

## References

- **LESSONS.md** — session history (commits), debugging deep-dives, tooling
  pitfalls, environment facts, host-specific vision config.
- **SPEC.md** — full design + KV-cache rules (§18).
- pi-vision source: `~/workspace/pi-vision`; reference DSH plugin:
  `~/workspace/dsh-vision-toolkit-ref`; DSH API docs:
  `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/<pkg>/README.md`.

## Resume checklist

1. `cd ~/workspace/dsh-vision && npm install && npm run build && npm test` —
   expect all green (typecheck + 95 tests).
2. Restart `dsh web` (user action) to load the latest build.
3. Sub-agent e2e + auto-detect need a store-capable host; on this host
   delegation=http is configured and describe_image works.
4. M4 polish; commit + push each milestone.

