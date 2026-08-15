# dsh-vision — Implementation Spec

> Capability-aware vision + paste extension for **DeepSeek Harness (DSH)**, ported 1:1 from
> [`@gitawego/pi-vision`](https://github.com/gitawego/pi-vision) (v0.6.0). This document is the
> decision-complete plan; implementation follows it without further design work.

**Status:** proposed — review before implementation.
**Target dir:** `~/workspace/dsh-vision` (this file lives in the current workspace until the project dir is created).
**Architecture references studied:** DSH source at `/data/data/com.termux/files/home/dsh-global/node_modules/@deepseek-ai/*`
and the working reference plugin `~/workspace/dsh-vision-toolkit-ref` (agent-scoped tool exposure,
bundle packaging, credentials, settings, Web client slots).

---

## 1. Goal

Give DSH agents image analysis that is **aware of the active primary model's input modalities**,
exactly like pi-vision:

- **Multimodal primary** → images pass through natively (DSH already has durable `ImageBlock`
  content, a capability gate, and a Web composer attachment rail). The `describe_image` tool is
  hidden from that agent → a wasted delegation call is **structurally impossible**.
- **Text-only primary** → `describe_image` is visible and delegates to a configured vision model
  through the v0.2.x–v0.5.x resilience pipeline: cache, retry + fallback, custom system prompt,
  audit log, local-only mode, batch, and auto-detect.

All pi-vision features map onto DSH extension points; the TUI-only surfaces (pi-tui settings panel,
Kitty/iTerm2 preview) map onto DSH's Web client (Settings section + tool cards) plus a
`/vision` slash command.

## 2. Feature parity matrix

| pi-vision feature | dsh-vision equivalent | DSH extension point |
|---|---|---|
| `describe_image` tool (single + `image_paths` batch) | same name + semantics | `ctx.tools.register(defineTool(...))` |
| Mechanism A: hide tool on multimodal primary | per-agent deny mask / scoped registration | `agent.ctx.tools.restrict` + `agent.ctx.tools.register` (proven in dsh-vision-toolkit-ref) |
| Capability check | `ctx.llm.resolveModelInfo(provider, model).inputModalities` includes `'image'` | `dsh-llm` model vocabulary |
| Delegation to vision model | native `ctx.llm.stream` w/ `ImageBlock`, or raw HTTP OpenAI/Anthropic | `ctx.llm` + `ctx.attachments`; `ctx.credentials.resolve` |
| Content-addressed cache (mem + disk LRU) | same key; disk under `$DSH_HOME/cache/dsh-vision` | plain files (or `ctx.storage`) |
| Retry w/ exponential backoff, abort-aware | `ctx.llm.stream` → `dsh-llm-retry`; raw HTTP → own `withRetry` | `exec.signal` |
| Fallback vision model | same (config fields) | — |
| Custom system prompt | same | — |
| Paste UX: `[Image-#N]` markers, path detection | `agent/pre-step` waterfall rewrites user messages | `agent/pre-step` (enter branch) |
| Paste modes hint/auto/off | same config semantics | — |
| Compose-time auto-preview | Web composer attachment rail already renders pasted images; path-preview via client slot | `dsh-client-ui-attachment` (exists) |
| `/vision preview <path>` | `/vision preview` command + client tool card/lightbox | `ctx.commands.register` |
| Batch + `batchConcurrency` (1–20, cap 50) | same | — |
| Audit log (JSONL, on by default) | same fields; default `$DSH_HOME/vision-audit.log` | plain append |
| Local-only mode (bytes never leave machine) | same structural gate | — |
| `/vision` panel + typed subcommands | `/vision` command + Web Settings section | `ctx.commands.register` + `ctx.settings.register` + client `settings.section` slot |
| Auto-detect vision model | from `ctx.llm.listProviders`/`listModels` (inputModalities) | `dsh-llm` |
| ctrl+shift+i inline model picker | dropped (Web has native model picker); optional `/vision model` quick-pick | — |
| Config at `~/.pi/agent/vision.json` | DSH Settings document (`$DSH_HOME/settings.yaml`, `vision` namespace) | `ctx.settings` |

## 3. Packaging & install (same as dsh-vision-toolkit-ref / dsh-mcp-adapter)

- npm package `dsh-vision` (private), `type: module`, `main: lib/index.js`.
- **Bundle patch** `cordis.patch.yml`:

  ```yaml
  - insert:
      - id: vision
        name: 'dsh-vision'
  ```

- `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...], "platform": "web" } }` and exports `./client` (built browser bundle, committed as `lib/client.js` like the reference) — so Web discovers the browser half at host startup.
- Install: `dsh plugin --profile web add ~/workspace/dsh-vision` (+ `--profile headless` for headless parity), then restart the Web profile.
- Peer deps: `cordis`, `@deepseek-ai/dsh-tools`, `dsh-llm`, `dsh-agent`, `dsh-settings`, `dsh-credentials`, `dsh-attachment`, `dsh-commands`, `dsh-skill` (optional), `dsh-host-webserver` (optional, for preview routes), `schemastery`.
- Runtime dep: `sharp` (image decode/resize; on this Termux host the `@img/sharp-wasm32` variant — the DSH host already ships it). Graceful fallback to "send original bytes" if sharp is unavailable, mirroring pi-vision's "degrade gracefully".

## 4. Services injected (`export const inject`)

`['tools', 'agents', 'llm', 'credentials', 'attachments', 'settings', 'commands']` — all mounted by `dsh-base` in Web and Headless profiles.

## 5. Configuration

### 5.1 Settings namespace

Register `ctx.settings.register(settingsNamespace('vision'), Config, { base: config, applies: 'live', validate })`
with a schemastery schema carrying **every pi-vision field** (defaults from `DEFAULT_CONFIG`):

- `provider`, `model` (string, optional), `enabled` (true)
- `maxDimension` (1568), `jpegQuality` (85), `defaultReasoningEffort` ('off'|'minimal'|'low'|'medium'|'high'|'xhigh')
- `systemPrompt` (optional), `cacheEnabled` (true), `cachePersist` (false), `cacheMaxEntries` (256)
- `retryAttempts` (2), `retryBackoffMs` (500), `fallbackProvider`/`fallbackModel` (optional)
- `markerStyle` ('code'|'bold'|'plain'), `textOnlyPasteMode` ('hint'|'auto'|'off'), `autoDelegatePrompt` (default text), `autoDelegateTimeoutMs` (30000)
- `composePreview` (true), `previewMaxWidthCells` (80 → Web: max preview height, interpreted for CSS)
- `batchConcurrency` (5, 1–20), `localOnly` (false), `auditLog` (true), `auditLogPath` (optional)
- `autoDetectVisionModel` (true)
- **DSH-only additions:** `delegation` ('auto'|'native'|'http', default 'auto' — see §7), and when `delegation: http`: `providerBaseUrl`, `providerCredential` (a `credentialRef` name, never a secret), `providerModel`.

Validation mirrors pi-vision's `mergeConfig` clamps; `credentialRef()` is validated at registration so a bad reference fails loud at load.

### 5.2 `/vision` command

`ctx.commands.register({ name: 'vision', description, handler(invocation) })` — `invocation.agent` + `rawInput` + `signal`.
Subcommand grammar identical to pi-vision: bare `/vision` → summary + pointer to Settings; `show`, `on`, `off`,
`provider <p>`, `model [<id>]`, `max-dim <px>`, `quality <n>`, `reasoning-effort <lvl>`, `system-prompt [text|clear]`,
`cache <clear|show>`, `fallback [<p/m>|clear]`, `clear`, `paste-mode [hint|auto|off]`, `marker-style [s]`,
`auto-prompt [text|clear]`, `preview <path>`, `batch-concurrency [n]`, `local-only [on|off]`,
`audit <clear|show|path|on|off>`, `audit-path [path|clear]`, `auto-detect [on|off]`.
Handler returns `CommandResult` text; mutating subcommands write through `ctx.settings.update(ns, patch)` (revision-guarded).

### 5.3 Web Settings section (client plugin)

Register a `settings.section` slot (`id: 'vision'`, label "Vision") rendering a form over the settings namespace
(via `ctx.settingsScope.bind`) + a health/credential status card. Host route `/_dsh/vision/settings` (optional, only when
`ctx.hostWebserver` present) for credential-configured/source facts and `/vision preview` image bytes — mirroring
dsh-vision-toolkit-ref's `web.ts` + `src/client/index.tsx` structure, including locale (`en`/`zh`) and `tool.call.toolview`
cards for `describe_image` results (delegated text + cached/fallback badges + batch table).

## 6. Module layout (mirrors pi-vision's lib/ split, DSH-flavored)

```
src/
  index.ts          # apply(): settings ns, gate install, tool registration, /vision, web backend
  capability.ts     # isMultimodal via ctx.llm.resolveModelInfo; per-agent model tracking + gate
  exposure.ts       # agent/created + agent/request listeners; per-agent deny mask for describe_image
  tool.ts           # describe_image ToolDefinition (defineTool)
  delegate.ts       # delegation pipeline: cache → local-only gate → compress → retry+fallback → audit
  transport.ts      # native ctx.llm.stream (ImageBlock) + raw HTTP OpenAI/Anthropic bodies (pi-vision parity)
  image.ts          # load (file/data:/base64), hash, sharp compress (graceful fallback)
  cache.ts          # content-addressed LRU, memory + optional disk ($DSH_HOME/cache/dsh-vision)
  audit.ts          # JSONL append; fields identical to pi-vision
  paste.ts          # agent/pre-step hook: path tokens → [Image-#N] markers, attach/hint/auto
  marker.ts         # marker render styles, hint line, batch result block builder
  batch.ts          # mapWithConcurrency (bounded, abort-aware)
  defaults.ts       # auto-detect vision model from ctx.llm catalogs
  web.ts            # optional HTTP routes (settings facts, preview bytes)
  client/index.tsx  # browser plugin: settings.section, tool.call.toolview, locale, styles
cordis.patch.yml
tests/*.spec.ts     # vitest, pure seams (capability, marker, cache, audit, batch, config, transport, paste)
```

## 7. Delegation transport — the one real design decision

pi-vision always did raw HTTP through pi's model registry. DSH offers two native options; we ship **`delegation: auto`**
(default) and pick per call:

1. **native** — `ctx.llm.stream({ provider, model, messages, system, reasoningEffort, temperature, maxTokens, signal })`:
   save bytes via `ctx.attachments.saveImage({ data, mediaType, name })` → build a user message with
   `ImageBlock { type: 'image', attachment: ref }` + text prompt (`createUserMessage`) → assemble the response with
   `BlockAssembler`. Works when the vision provider is a **registered adapter route with image modality** —
   the pi-ai adapter already resolves durable refs (`resolveAttachments: () => ctx.get('attachments')`, verified in
   `dsh-llm-pi-ai/lib/index.js`) and the harness refuses image content on models whose `inputModalities` omit it.
   Bonus: `dsh-llm-retry` (llm/stream wrapper), token-meter, adapter retry policy, provider-neutral tool calls.
2. **http** — exact pi-vision port: `fetch(`${baseUrl}/chat/completions`)` with `image_url` data-URL parts, or
   `/v1/messages` for Anthropic-Messages endpoints; `Authorization: Bearer` from `ctx.credentials.resolve(ref)`;
   `reasoning_effort` when the endpoint is OpenAI-compatible and effort ≠ off. Works for **any** OpenAI-compatible
   vision endpoint (incl. one-off gateways) without adapter registration.

**Selection rule (auto):** if `ctx.llm.resolveModelInfo(provider, model)` reports `inputModalities` containing
`'image'` for the configured vision provider/model → native; otherwise → http. The tool records which transport ran
in `details.transport` for the audit log. Rationale: exact pi-vision parity guaranteed (http) while native paths get
retry/metering for free when the Models page already registered the vision route.

## 8. Capability-aware exposure (Mechanism A)

- **Model capability source:** `ctx.llm.resolveModelInfo(provider, model).inputModalities` — `'image'` ⇒ multimodal.
  Unknown/absent ⇒ text-only (safe default, matching pi-vision).
- **Per-agent current model tracking:** a module-level `Map<AgentId, { provider, model, multimodal }>` maintained by
  listeners on:
  - `agent/created` (seed from `agent.options`),
  - `agent/request` waterfall — the **authoritative per-request model** is the proposed `LlmCallConfig.provider/model`
    (verified signature), which also catches mid-session model switches from the Web picker,
  - `settings/updated` for the model namespace.
- **Gate:** `describe_image` is registered **globally once**. For each live agent:
  - multimodal or disabled → `agent.ctx.tools.restrict({ deny: ['describe_image'] })` (dispose + re-apply on flip);
  - text-only + enabled → no deny mask.
  This is the same `agent.ctx.tools.restrict` / `agent.ctx.tools.register` pattern dsh-vision-toolkit-ref uses for
  progressive exposure (its `VisionToolExposure` class is the template).
- **Defense-in-depth in `execute`:** if the invoking agent's primary is multimodal (race window), return the
  pi-vision-style redirect: *"the active primary model can process images natively — reference the image path and
  respond directly"* (no delegation).
- **No wasted schema:** multimodal agents never see the tool ⇒ zero schema tokens for it, same claim as pi.

## 9. `describe_image` tool

Registered via `defineTool`:

- **Parameters** (identical to pi-vision): `image_path` (string?, single), `image_paths` (string[]?, ≤ 50),
  `prompt` (string, required), `compress` (boolean?, default true), `reasoning` (enum?, default from config).
  Accepts file paths, `data:` URLs, raw base64; normalizes string-or-array with the same coercion as pi-vision
  (`normalizeImagePaths` port).
- **Output contract:** canonical value `{ text: string, details: { mode: 'delegate'|'delegate-batch'|'passthrough_redirect', transport, model, cached?, fallback?, error?, batch?: [...] } }`; `render` → text block; `presentCall` →
  `{ card: 'generic', title, kind: 'read', locations: paths }`.
  - success: return value (isError false);
  - all images failed / not configured / disabled / local-only miss: **throw** `new Error(message)` ⇒ registry
    converts to `isError: true` with the message (same model-visible semantics as pi's `isError`);
  - partial batch failure: return success value whose text embeds `[error: …]` sections per failed image
    (pi-vision `buildBatchToolResult` port) — matches pi exactly.
- `isConcurrencySafe: () => true` (delegation calls are independent reads).
- `timeoutMs`: from config (default 60 s), plus `AbortSignal.any([exec.signal, lifecycleSignal])`.
- Batch: parallel via `mapWithConcurrency(paths, batchConcurrency, fn)`; per-image resilience (cache/retry/fallback)
  independent; cap 50 (`MAX_BATCH_IMAGES`); `details.batch` per-image `{ index, path, ok, cached, fallback, errorCode }`.

## 10. Delegation pipeline (`delegate.ts`, pi-vision §"Resilience")

Order, ported exactly from `delegateToVisionModel`:

1. preflight: `enabled`, configured (provider+model), transport resolved; `http` → resolve credential per call
   (`ctx.credentials.resolve` — never cached, never logged).
2. **load + hash only** (`image.ts`): read bytes (cap 64 MB), sniff MIME (png/jpeg/gif/webp; bmp accepted for input),
   sha-256 → `sourceHash`. **No compression yet** (F12: cache hit never pays for a resize).
3. **cache check** — key = `sourceHash + compress + maxDimension + jpegQuality + prompt + provider/model + reasoning + systemPrompt`.
   Hit ⇒ 0 network calls, audit `cached: true`, return.
4. **local-only gate** — miss + `localOnly` ⇒ refuse with the pi-vision message (cache-only mode), audit
   `local_only: true`, NO network path entered (structural).
5. **compress on miss** (sharp; resize to `maxDimension` long edge, JPEG re-encode `jpegQuality`; graceful fallback to
   original bytes) — only when `compress` true.
6. **network call with retry + fallback**:
   - native: `ctx.llm.stream` (retry/backoff via `dsh-llm-retry`; abort-aware by construction);
   - http: own `withRetry` (attempts = `retryAttempts`+1, backoff `min(backoffMs·2^n, 8000)`, 5xx/429/network only,
     `exec.signal` aborts immediately), then **fallback model once** on non-retryable/exhausted;
   - classify auth (401/403) → `auth_failed` message; abort → `aborted`.
7. **cache store on success** — never cache fallback results (F10).
8. **audit** — one JSONL line per outcome: `{ ts, provider, model, image_path (truncated for data:/base64), source_hash, cached, fallback, fallback_model, ok, error_code, latency_ms, local_only, transport }` to
   `auditLogPath ?? $DSH_HOME/vision-audit.log`. On by default; `audit` subcommand controls.

Cache implementation: memory LRU (Map + insertion order) always; disk LRU (`cachePersist`) as
`$DSH_HOME/cache/dsh-vision/` with atomic writes (tmp+rename) + index; `/vision cache clear|show` wipes/reports both.

## 11. Paste UX (`paste.ts`, `agent/pre-step`)

A waterfall listener on `agent/pre-step` (payload `{ agent, messages: UserMessage[], turn, step, signal }`, enter
branch returns the replaced batch — verified signature). Per user message:

1. **Detect** image-path tokens (port pi-vision's `PATH_TOKEN_RE`: POSIX absolute/`~/`/`./`/`../`, Windows
   `C:\…`/`C:/…`, escaped-space drag-drop; resolve against `session.header.cwd`; `existsSync` + extension filter).
2. **Rewrite** the message content: replace tokens with `[Image-#N]` markers (sequential, deduped by resolved path
   and by content hash) using `markerStyle`.
3. **Multimodal primary** → additionally **attach** the image as a native `ImageBlock` (via
   `ctx.attachments.saveImage`); zero delegation.
4. **Text-only primary**, by `textOnlyPasteMode`:
   - `hint` (default): append a zero-token hint line naming the paths + the `image_paths` batch affordance
     (pi-vision v0.4.0 improvement) — no delegation, the model decides;
   - `auto`: run the §10 pipeline per image with own `AbortController` (budget `autoDelegateTimeoutMs`), append
     the descriptions block; on timeout/failure fall back to hint; parallel bounded by `batchConcurrency`;
   - `off`: markers only.
   Never attach ImageBlocks for text-only primaries (the harness would refuse them).
5. Local-only + auto ⇒ skip delegation, go straight to hint (pi v0.5.0).

Compose-time preview: the Web composer already renders pasted/attached images via `dsh-client-ui-attachment`'s
`AttachmentRail`. Path-referenced compose preview (pi's WhatsApp-style box) is a **client-only enhancement**: a
composer slot that resolves the last typed image path and shows a thumbnail; shipped behind `composePreview` config.
(Optional milestone M4 — see §15.)

## 12. `/vision preview <path>` + result preview

- `/vision preview` command → validate path, read via `image.ts`, return a `CommandResult` whose text shows
  metadata (filename, MIME, WxH, bytes, protocol); on Web, the client renders the actual image (lightbox/slot).
- Tool results: `describe_image` gets a `tool.call.toolview` card (delegated text, cached/fallback badges, batch
  rows); the Web client renders artifact previews through the same slot mechanism as the reference toolkit.

## 13. Auto-detect (`defaults.ts`) — data-driven discovery

pi-vision read `~/.pi/agent/models.json` (`modelRegistry.getAvailable().filter(m => m.input.includes('image'))`).
DSH's analog is the **LLM adapter registry + per-adapter model catalogs** — richer, and still fully data-driven
(no hardcoded provider/model ids anywhere). Verified seams (`@deepseek-ai/dsh-llm` + `dsh-llm-pi-ai`):

### Tier 1 — live catalog scan (silent, zero-config, primary path)

```ts
const vision: Array<{ provider: string; model: string; name: string }> = []
for (const { id } of ctx.llm.listProviders()) {            // sync; registered routes only
  for (const m of await ctx.llm.listModels(id)) {          // per-adapter catalog
    if (m.inputModalities?.includes('image')) vision.push({ provider: id, model: m.id, name: m.name })
  }
}
```

This reads exactly what the user configured (Web Models page → `llm-pi-ai:` settings → pi-ai adapter catalog):
`listModels` materializes `inputModalities` from the pi-ai catalog entry `input` → installed pi-ai catalog →
route `defaultInput` (verified in `dsh-llm-pi-ai/lib/index.js`: `declaredInput(entry.input) ?? base?.input ??
[...request.defaultInput]`). A route declaring `defaultInput: [text, image]` marks every undescribed model on that
route image-capable — the data-driven escape hatch for image-capable gateways. The DeepSeek adapter reports
`inputModalities: ['text']` (its models are text-only), so it never appears as a vision candidate.

### Tier 2 — exact-model resolution for unknown entries

Catalog entries with **absent** `inputModalities` mean *unknown* (explicit `[]` = negative). For those, call
`ctx.llm.resolveModelInfo(provider, model)` — `LlmResolvedModelInfo extends LlmModelInfo` and the pi-ai adapter
resolves exact-model modalities (dynamic/unlisted models fall back to the route `defaultInput`). Absent after
resolution ⇒ treat as text-only (safe default, mirrors pi-vision).

### Tier 3 — dormant routes (declared but not live)

`ctx.llm.listConfigurableProviders()` returns pi-ai provider routes present in settings but not yet registered as
adapters (e.g. profile added, route dormant). Their catalogs are unreachable until live; they are surfaced as
"configure this route" candidates, never silently selected. Interactive endpoint interrogation (the Models page
path) is `ctx.llm.discoverModels('llm-pi-ai', { provider|baseURL, protocol, credential })` — requires a
credential, so it is an explicit action (mirroring the reference toolkit's "Test connection"), NOT silent auto-detect.

### Selection rule (config-driven preference, never hardcoded ids)

1. Prefer the **active primary's provider** first — filter that provider's catalog for image models; the active
   route comes from `agent/request`'s proposed `LlmCallConfig` (authoritative per request) or `agent.options` at
   session start.
2. Else the first vision-capable model across live providers in registration order.
3. Persist once into the `vision` settings namespace; user override wins; `/vision clear` re-triggers;
   `auto-detect off` disables. Partial config (one of provider/model set) is never overwritten.

### Reactivity

`ctx.on('llm/adapters-updated', () => re-run Tier-1 scan)` — payload-free event, re-read catalogs — so adding a
vision provider via the Models page is picked up without a restart; also re-run on `settings/updated` for the
`vision` and `llm-pi-ai` namespaces.

## 14. Security & privacy

- Secrets: only `credentialRef` names in settings; values via `ctx.credentials` (per-call resolve); never logged,
  never in settings responses (use `describe({ redactSecrets: true })` on the wire).
- Audit: routing facts only — source_hash fingerprint, truncated paths, never bytes/prompts.
- Local-only: structural gate before any network path (native path guarded by checking `localOnly` before
  `attachments.saveImage`/`llm.stream`).
- Path handling: workspace-relative resolution; `allowedDirs`-style containment only if we add one (v1 keeps
  pi-vision's resolve-against-cwd behavior; explicit `allowedDirs` is a v2 hardening option).
- Image safety: 64 MB source cap, MIME sniff, sharp decode for dimension validation on compress path.

## 15. Milestones

- **M1 (core, parity-critical):** packaging, config, capability gate, `describe_image` (single + batch), http
  transport (pi-parity), cache/retry/fallback/audit/local-only, `/vision` command, vitest seams.
- **M2 (paste UX):** `agent/pre-step` hook — markers, hint/auto/off, auto-delegate, marker styles.
- **M3 (native + Web):** native transport (ImageBlock/`llm.stream`), auto-detect, client plugin
  (settings.section, tool card, preview route, locale).
- **M4 (polish):** compose preview slot, Web `/vision preview`, headless profile verification, README/AGENTS.md.

## 16. Open decisions (defaults chosen above)

1. **Delegation transport:** hybrid auto (native-first, http fallback) — vs HTTP-only for byte-exact pi parity.
2. **Disk cache backend:** plain atomic files vs `ctx.storage` (dsh-storage-json is mounted in base).
3. **Compose preview:** client slot enhancement (M4) vs skip.
4. **`allowedDirs` hardening:** v1 keeps pi-vision behavior; add realpath containment in v2.

## 17. Verification

- `tsc --noEmit` + vitest on pure seams (capability gate, marker builder, cache LRU, audit, batch, transport body
  builders, config clamps, paste tokenizer).
- Manual: `dsh --profile web --dump-config | grep vision`, restart, `/vision show`, describe a screenshot with a
  text-only primary and a multimodal primary; batch 3 images; local-only refusal; audit tail.

## 18. High token-cache rate (KV-cache) requirements

DSH's prefix cache invalidates from the first changed token, and every contributing surface
documents its own "KV Cache effect" (dsh-tools: *"Prefix-stable while visible definitions and their
order are unchanged. Registration, disposal, or scoped restriction may invalidate reuse from the
first changed schema token"*; dsh-llm: *"a consumer that folds a settings value into the request
prefix owns that effect"*). The plugin's rules for keeping cache hits high:

1. **One byte-stable tool schema, registered exactly once.** `describe_image` is a compile-time
   constant: name, description, parameter schema, output schema, and render/present callbacks are
   static literals — **no dynamic content anywhere in the schema** (no provider/model ids, config
   values, timestamps, locale strings, counters). Registered once at plugin apply; config/settings
   changes **never** rebuild or re-register the definition — the execute closure reads live config
   per call. Re-registration only happens on plugin reload.
2. **Deterministic registration order.** One global tool; any later tool is appended in a fixed
   declared order so the assembled schema text is byte-identical across agents and boots.
3. **Visibility flips are rare, idempotent, and user-initiated.** The per-agent deny mask
   (`agent.ctx.tools.restrict({ deny: ['describe_image'] })`) changes only on (a) primary-model
   switch, (b) enable/disable toggle. The gate is a strict no-op when the desired state already
   holds (pi-vision's `syncToolAvailability` pattern); never dispose/re-apply per step. A flip
   invalidates the prefix from the changed token — inherent to Mechanism A, acceptable because it
   is user-initiated and rare.
4. **Zero dynamic prompt contribution.** v1 registers no system-prompt section (the tool
   description carries the guidance). A future guidance section must be byte-constant with a fixed
   order. Never fold settings values (provider/model, cache stats, audit counts) into the request
   prefix.
5. **Stable delegation request shape (native transport).** Repeated `describe_image` calls to the
   same vision provider should share provider-side prefix cache: fixed system-prompt bytes
   (`config.systemPrompt`, stable until the user edits it), fixed message order
   (system → user [image + prompt]), stable reasoning effort (config default), fixed `temperature`
   (0) and a stable `maxTokens` derivation (model ceiling). `dsh-llm-retry` resends the identical
   payload, so retries stay cache-warm.
6. **Paste-hook rewrites are suffix-only.** Markers/hints/auto-delegate descriptions modify
   user-message content (request suffix), never the system prefix; they do not invalidate prefix
   cache. The `agent/pre-step` listener is a strict pass-through (returns the same batch) when the
   message contains no image-path tokens.
7. **Auto-detect persists once, never in the prefix.** Detection writes the chosen provider/model
   to settings only; the primary conversation's request shape is untouched. The `agent/request`
   model-tracking listener is read-only (returns the proposed config unchanged).
8. **No mid-session tool-set churn from external events.** `llm/adapters-updated` and
   `settings/updated` re-run detection / refresh internal state but never re-register tools or flip
   masks.
9. **Verification.** DSH reports disjoint usage counts (`inputTokens` uncached vs
   `cacheReadTokens`/`cacheWriteTokens` — dsh-llm types). Assert in the session log:
   - two consecutive turns with an unchanged tool set → the second turn shows a high
     `cacheReadTokens` share (near-total prefix reuse);
   - a model switch → one expected drop, then recovery on the following turn;
   - after `/vision` config edits and cache/audit churn → **no** drop (config never enters the
     prefix);
   - multimodal agents → no `describe_image` schema tokens at all, leaner requests.
