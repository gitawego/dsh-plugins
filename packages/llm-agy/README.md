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
    accountsFile: ''         # empty = $DSH_HOME/llm-agy/accounts.json

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: agy
    model: gemini-4-argon    # example id; use one from the discovered catalog
    reasoningEffort: medium
```

`agy` must be signed in. The CLI owns its Google login; the plugin spawns the
CLI and lets it use that login. If the CLI is not authenticated, the request
fails with `AUTH` and the remediation text tells you to run `agy` interactively
(or `agy acp --login`). The optional multi-account store described below keeps
refresh tokens under the DSH home, never in this configuration.

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

## Multiple accounts

Settings → **Antigravity** lists the accounts this plugin knows about and makes
switching one click. The currently active CLI login is imported automatically.
**Add account** starts a Google OAuth flow on an ephemeral `127.0.0.1` port,
opens the consent page in a new tab, and saves the account when Google redirects
back to the local callback. There is no authorization code to paste.

**Re-auth** on an account row starts the same flow with a `login_hint` for that
email, so a revoked or expired refresh token can be replaced in place. The
dialog can be cancelled at any point; cancelling closes the loopback listener.

Each row also shows that account's Gemini weekly and five-hour quota. Those
numbers are read directly with the account's own access token through
`retrieveUserQuotaSummary`, so viewing them never switches the active account.
The full grouped quota below the list still follows the active CLI account.

The plugin is self-contained: it reads only the Antigravity keyring
(`service=gemini`, `username=antigravity`) and its own store at
`$DSH_HOME/llm-agy/accounts.json` (mode 0600). On Linux the keyring is the
Secret Service and `secret-tool` must be installed and unlocked; when it is not
available, the CLI token file
(`~/.gemini/antigravity-cli/antigravity-oauth-token`) is used instead. It does
not read another app's account directory, and it sends tokens only to Google's
authorization, token, and userinfo endpoints.

The OAuth callback asks the OS for a free ephemeral port (`listen(0)` on
`127.0.0.1`), so a fixed port cannot already be taken. The listener accepts one
state-checked callback and closes immediately; cancelling the dialog closes it
too.

### OAuth client secret

The repository does not contain Antigravity's OAuth client secret. It is a
property of the installed CLI, not of this plugin, and keeping it out of source
keeps GitHub secret scanning meaningful. Configure it once, either:

```bash
# Extract and test the candidates from the installed agy binary
pnpm --filter @gitawego/dsh-llm-agy oauth-secret
```

or set `ANTIGRAVITY_OAUTH_CLIENT_SECRET`. The extractor writes
`$DSH_HOME/llm-agy/oauth-client.json` with mode 0600; token refresh and OAuth
sign-in read it automatically. While the active CLI login is present, the
extractor can verify the candidate by refreshing that login; it never prints
the secret.

Switching:

1. refreshes the target account's access token with its refresh token
   (Antigravity's public installed-app OAuth client);
2. writes the fresh token to the keyring, with the CLI token file as a fallback;
3. bumps an account epoch so the next prompt starts a new `agy acp` server,
   rather than continuing on the previous account's authenticated transport.

Running ACP sessions finish on their current account; the restart happens on
the next prompt. Quota reads are invalidated on every switch.

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
