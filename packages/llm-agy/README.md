# @gitawego/dsh-llm-agy

The **Antigravity (`agy`) ACP** provider for DeepSeek Harness. It registers the
`agy` route at the `ctx.llm` adapter seam and drives `agy acp` over
newline-delimited JSON-RPC, so an existing Google/Antigravity login can serve
Gemini models without a `GEMINI_API_KEY`.

```yaml
# profile patch
- id: llm-agy
  name: '@gitawego/dsh-llm-agy'
  config:
    defaultModel: ''         # empty = the model ACP currently has selected
    models: []               # empty = discover from agy acp
    imageInput: true         # declare image input and send ACP image blocks
    agentMode: default       # any mode advertised by agy acp
    permissionMode: ask      # ask | deny
    quotaRefreshMinutes: 5   # settings-card cache for the plan quota

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: agy
    model: gemini-4-argon    # example id; use one from the discovered catalog
    reasoningEffort: medium
```

`agy` must already be signed in. The plugin never stores a credential; it
spawns the CLI and lets it use its own login. If the CLI is not authenticated,
the request fails with `AUTH` and the remediation text tells you to run `agy`
interactively (or `agy acp --login`).

Install into a profile (this only registers the additive `agy` route; select it
as the model provider when you want it):

```bash
bash scripts/install-plugins.sh ~/.dsh/profiles/web llm-agy
```

## Model catalog: discovered, not shipped

There is **no built-in model table**. On demand, the adapter starts one
short-lived `agy acp` session, completes `initialize` + `session/new`, and reads:

- `configOptions.model` — the accepted base model ids and display names;
- `configOptions.thought_level` — the selectable reasoning efforts and the
  current default.

Those values become `listModels()` / `resolveModel()` directly. If `agy` adds or
removes a model, the route’s catalog changes on the next discovery; no package
release is needed. The catalog is cached for `discoveryMinutes` (default 10).

ACP does **not** disclose a context window, output cap, or per-model effort map,
so the adapter omits those fields rather than guessing them. If you know the
capacities, declare them explicitly in config:

```yaml
- id: llm-agy
  name: '@gitawego/dsh-llm-agy'
  config:
    models:
      # values are examples; use capacities you have actually verified
      - id: gemini-4-argon
        name: Gemini 4 Argon
        contextWindow: 1048576
        maxTokens: 32768
        efforts: [low, medium, high]
        defaultEffort: medium
```

A non-empty `models` list is the **complete** catalog override: nothing is
merged from ACP. Every field other than `id` is optional; omitted capacity and
effort fields stay unknown.

ACP also advertises effort-baked display ids such as `gemini-4-argon-high`;
selection is driven through the base `model` option plus `thought_level`, which
is the documented request surface and matches DSH’s separate reasoning-effort
dimension.

## Agent-delegate semantics

This is an **agent provider**, not a raw model proxy. `agy` runs its own tools
in the session's working directory. The adapter therefore:

- ignores `GenerateOptions.tools` — DSH tool schemas are never sent;
- drops ACP `tool_call` / `tool_call_update` events, because `agy` already ran
  those tools and re-emitting them as DSH tool calls would execute them twice;
- streams only `agent_message_chunk` text and `agent_thought_chunk` reasoning;
- bridges `session/request_permission` into `ctx.approval.request`, so the
  normal DSH approval UI decides `agy`'s tool use. `permissionMode: deny`
  cancels every request without asking. No approval service means the request
  is cancelled (fail closed).

Practical consequences:

- DSH's own tool cards/permissions do not describe `agy`'s work; the agent's
  final text and reasoning are the visible result.
- `agy` may edit files and run commands, subject to the approval bridge and the
  selected ACP mode.
- With `imageInput: true` (the default), image attachments are resolved through
  `ctx.attachments` and sent as ACP `image` content blocks; Gemini models are
  therefore advertised as `text+image`. Set `imageInput: false` for a text-only
  route.
- ACP has no per-request `temperature`, `maxTokens`, or `stop` field. Those
  `GenerateOptions` fields are ignored; the model's own defaults apply.

## Sessions and streaming

One ACP process is kept per DSH session id and serialized one prompt at a time.
The adapter tracks delivered message ids, sends only the new turn, and replays
existing history as a transcript on the first call. An idle session is closed
after `idleSessionMinutes`; a failed or aborted turn drops its process so the
next turn starts clean. Auxiliary purposes (for example title generation) use a
short-lived session that is closed after the turn.

The DSH system prompt is passed natively through
`_meta.antigravity.systemPrompt.append` on `session/new`. If it changes later in
the same ACP session, the next prompt is prefixed with an explicit
`[Updated system instructions]` block.

ACP's experimental `PromptResponse.usage` maps to DSH token accounting:
cache reads/writes are subtracted from the reported input total, and thought
tokens are recorded as `reasoningTokens` (already included in `outputTokens`).

## Plan quota

Settings → **Antigravity** shows the same grouped allowance the
Antigravity UI reports for the signed-in account: Gemini, Claude/GPT, and
Gemini 4 Argon, each with its weekly and five-hour buckets, percent remaining,
and reset countdown.

The source is `agy --print /usage --output-format json`, which returns the
`retrieveUserQuotaSummary` payload (group names, bucket ids, `window`,
`remaining_fraction`, `reset_time`). The host reads it at most once per
`quotaRefreshMinutes` (default 5) and the card's **Refresh** button forces a
fresh read. Override the command for a wrapper or a different CLI build:

```yaml
- id: llm-agy
  name: '@gitawego/dsh-llm-agy'
  config:
    quotaCommand: [agy, --print, /usage, --output-format, json]
```

The browser cannot spawn the CLI, so the card reads a guarded loopback-only
route owned by this plugin (`/llm-agy/quota`). The route exposes aggregate
percentages, bucket labels, and reset times only — no prompts, session data, or
credentials. Like the host `/api` bridge it accepts `GET` only, requires a
loopback `Host`, refuses `Sec-Fetch-Site: cross-site`, and refuses an `Origin`
that disagrees with `Host`. A headless composition without a web server simply
does not mount the route.

## Development

```bash
pnpm --filter @gitawego/dsh-llm-agy typecheck
pnpm --filter @gitawego/dsh-llm-agy test
pnpm --filter @gitawego/dsh-llm-agy build
```

The test suite includes a scriptable fake ACP agent (`tests/fixtures/fake-agy.mjs`)
that exercises the real child-process transport, model/effort selection,
persistent-session deltas, the approval bridge, cancellation, auth failures, and
empty responses.

A build is not a deploy: install the package into the target profile and verify
the copied `lib/index.js` checksum.
