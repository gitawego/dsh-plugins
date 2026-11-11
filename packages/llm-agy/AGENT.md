# @gitawego/dsh-llm-agy — agent notes

**Scope: one provider route, `agy`, over `agy acp`.** This package is additive:
it does not modify `dsh-llm-pi-ai`, does not wrap the native `google` route, and
does not store credentials.

## Why this route exists

The harness already serves Gemini through `dsh-llm-pi-ai`'s `google` and
`google-vertex` catalog routes. This package exists for the other authentication
model: an Antigravity subscription whose Google login lives in `agy`. There is
no API key to resolve, so an `LlmAdapter` that can spawn and drive `agy acp` is
the only way to put that subscription behind `ctx.llm`.

## Non-negotiable boundaries

1. **Do not map ACP tool events to DSH tool calls.** `agy` executes its own
   tools and reports status. A DSH `tool-call` chunk would be executed by the
   DSH agent loop a second time. Drop `tool_call`/`tool_call_update`; keep the
   approval bridge.
2. **Do not auto-approve by default.** `permissionMode: ask` calls
   `ctx.approval.request` with the live agent. Missing service, missing agent,
   `cancelled`, or `unavailable` all cancel the ACP permission request.
3. **Do not add a credential field.** Auth is the CLI's own login. `AUTH`
   failures must tell the user to run `agy` / `agy acp --login`.
4. **Do not send DSH tools.** The route is an agent-delegate. Ignoring
   `GenerateOptions.tools` is intentional, not an omission.
5. **Do not claim ACP supports `temperature`, `maxTokens`, or `stop`.** It does
   not; those request fields are ignored.
6. **Keep the ACP client local.** The host ships
   `@agentclientprotocol/sdk@1.4.0`, but the plugin owns the small ndjson
   JSON-RPC subset it needs. That avoids a second SDK copy and makes the
   transport testable without the host.
7. **Never ship a model catalog.** Model ids, names, effort vocabularies, and
   defaults come from `session/new`'s `configOptions` or from the profile's
   explicit `models` list. Context windows and output caps are omitted unless
   the profile declares them; ACP does not disclose those values. A code change
   must not be required when `agy` adds or removes a model.

## Session invariants

- A persistent entry is keyed by `sessionId` plus `purpose`; only ordinary chat
  entries are pooled. `purpose` calls are transient.
- `AcpSession` serializes prompts; never run two `session/prompt` requests on one
  ACP session.
- Delivery is tracked by message id. The first call may replay history; later
  calls send only fresh user/tool messages and skip fresh assistant messages
  (the agent already has its own answer).
- A changed system prompt cannot be edited into a live ACP session; prefix the
  next prompt with `[Updated system instructions]`.
- Idle expiry closes the process; a failed/aborted/cancelled turn drops it.
  Dead processes are never reused.

## Invariants worth a test

- exact `StreamChunk` order for reasoning + text + usage + finish;
- `EMPTY_RESPONSE` on a normal stop with no content;
- cache tokens subtracted from the ACP input total;
- permission response nests `{ outcome: { outcome, optionId } }`;
- a rejected deny path never calls `ctx.approval`;
- persistent second turn sends only the new user message;
- a different DSH session opens a different ACP process;
- `AUTH` classification adds the `agy acp --login` remediation;
- `apply` registers exactly `['agy']` and unregisters on disposal;
- `listModels` returns only ACP-discovered or config-declared entries;
- a discovered model carries no fabricated context/max tokens;
- a configured catalog suppresses ACP discovery entirely;
- built `lib/index.js` is ESM and exports `apply`, `inject`, `Config`.

## Known traps measured against `agy` 1.5.6

- `initialize` returns duplicate camelCase/snake_case capability keys; only the
  fields actually used are typed.
- `configOptions.model` uses base ids; `models.availableModels` uses
  effort-baked display ids. Drive `model` + `thought_level`, not the display
  list. The adapter derives its catalog from `configOptions`, never from a
  checked-in list.
- ACP does not disclose context windows or output caps. Do not infer them from
  a model name or copy them from another provider’s catalog; require an explicit
  `models` config entry.
- `session/new` emits `available_commands_update` notifications before its
  response; they must not crash the handshake.
- `session/load` replays history as `user_message_chunk`/`agent_message_chunk`.
  This adapter does not call `session/load`; a lost ACP session is recreated and
  replayed from the DSH transcript.
- ACP permission responses are nested: `{ outcome: { outcome: 'selected',
  optionId } }` or `{ outcome: { outcome: 'cancelled' } }`.
- `agy` startup is ~1 s and a simple prompt ~2–4 s; the first run after a CLI
  update can be much slower.

## Commands

```bash
pnpm --filter @gitawego/dsh-llm-agy typecheck
pnpm --filter @gitawego/dsh-llm-agy test
pnpm --filter @gitawego/dsh-llm-agy build
```

Real-CLI smoke checks are manual and require an authenticated `agy`. The unit
and integration suite uses `tests/fixtures/fake-agy.mjs`, which speaks the same
ndjson JSON-RPC over a real child process.
