# @gitawego/dsh-llm-provider

First-party LLM provider routes for DeepSeek Harness, at the `ctx.llm` adapter
seam. The first route it ships is **OpenCode Go** (`opencode.ai/zen/go`).

> **Route key:** `opencode-go-session`.
>
> Not `opencode-go` — that key belongs to `dsh-llm-pi-ai`, which declares a
> configurable-provider entry for every provider in pi-ai's catalog, and pi-ai
> ships `opencode-go`. Two plugins cannot own one route key, and the collision
> is a hard boot failure (`configurable provider "opencode-go" is already
> declared`). The pi-ai entry stays what it is: the catalog provider that does
> not send the session header. Use `opencode-go-session`.

## Why it exists

OpenCode Go routes a conversation to a backend lane by a header the client must
send:

```bash
# without the header — every turn fails
$ curl -sS https://opencode.ai/zen/go/v1/chat/completions \
    -H "authorization: Bearer $OPENCODE_API_KEY" -H 'content-type: application/json' \
    -d '{"model":"deepseek-v4.1-flash","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
400 {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it"}}

# with it — normal completion
$ curl -sS https://opencode.ai/zen/go/v1/chat/completions \
    -H "authorization: Bearer $OPENCODE_API_KEY" -H 'content-type: application/json' \
    -H 'x-opencode-session: 01a10c8e-0898-77d8-9c28-5ff69e4529a9' \
    -d '{"model":"deepseek-v4.1-flash","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
200 {"id":"...","choices":[{"index":0,"finish_reason":"length","message":{"role":"assistant",...
```

The harness already knows the value: it stamps `GenerateOptions.sessionId` on
every loop-built request. But pi-ai 0.85.1 — the build `dsh-llm-pi-ai` depends
on — forwards the session id to the provider without ever turning it into a
header, so the request that leaves the process is the first one above. (pi-ai
1.0.x added `withOpenCodeSessionHeader` inside its built-in `opencode-go`
provider; the harness's pi-ai predates it.)

Static provider `headers` in `settings.yaml` cannot fix this: the value must
change per conversation, or every conversation lands in one lane and loses
prompt-cache affinity. Only an adapter sees the session id, so this plugin owns
one.

## What it does

| Surface | What you get |
|---|---|
| **Chat** | Every request carries `x-opencode-session`, so turns complete. The route serves **the provider's live catalog** (36 models), not the snapshot pi-ai shipped. |
| **Settings → Models** | The route's row carries a card naming where its settings live and offering the API key field, because the section's own editor cannot configure a plugin-owned provider (see below). |
| **Settings → LLM providers** | A section of its own (like LSP's), with one panel per served route: the live catalog with each model's context window and output cap, the models this route may use, the allowance meters, and the route's configuration. |
| **Models page** | `opencode-go-session` appears as a configurable provider; its draft form lists live models with capacities. |
| **`/llm-provider models\|quota\|refresh`** | The full spec sheet per model (including thinking levels) and the allowance windows. |
| **`llm_quota` tool** | Lets the agent check the 5-hour / weekly / monthly windows before a long job. |

## What the Models page shows for this route

**Settings → Models** lists every provider, and this route appears there. Its
own editor cannot configure it: the shipped section's `layoutOf()` recognises
only `llm-deepseek` and `llm-pi-ai`, so it prints *"Other fields live in
settings.yaml; edit that section directly"* and disables Apply, and it reports
*"Model 1: Model ID is required"* because our `models` is an allowlist of ids
where it expects model objects.

The page therefore renders a card of ours inside that row (the
`settings.models.provider-card` seat, which exists for plugins distributed
outside the harness), containing:

- where the rest lives — **Settings → LLM providers**;
- why the fields on that page stay empty — the model list comes from the
  provider and is chosen in that section;
- the state — *"2 of 36 models allowed · session routing on"*;
- the credential reference in play, and the **API key** field.

**A link that navigates there is not possible.** The settings dialog's open state
and active section are component-local React state in the shell
(`dsh-client-ui-settings-general`: `useState` for both, no store, no service, no
hash route), so no plugin can drive it. Naming the location exactly, and putting
the one control that page exists for right there, is what the host's own
extension seat allows.

## The section

**Settings → LLM providers** — its own entry in the settings sidebar, beside
General, Models, Plugins, Agent presets, and LSP.

It is a section rather than a card in the plugin list for two reasons: the
surface grows with every gateway this plugin learns to serve (one panel per
route), and the plugin list is the wrong home for a configuration surface that
will hold several providers. It also lands in a `list` slot, which carries an
explicit `order`, so its position is stable — the keyed plugin slot has none.


- **Models** — the live catalog, read from the provider endpoint and enriched from
  [models.dev](https://models.dev). Each row shows its context window and output
  cap. **Pin** the models this route may use: nothing pinned means every model the
  provider serves is available; pinning one or more narrows the route to those.
  A pinned model the provider stops serving stays visible and marked, so the pin
  can be removed instead of hiding.
- **Configuration** — credential reference, endpoint, session routing, default
  thinking effort, and the image budgets. One **Save** writes every staged field
  as a path-addressed settings mutation.
- **Allowance** — the 5-hour, weekly, and monthly windows as meters, with the
  share left and a reset countdown. Read on demand (the *Refresh* button, and
  once when the card opens), because each read spends the stored credential on
  one provider request.

## Install

```bash
# from the monorepo root
bash scripts/install-plugins.sh "" llm-provider
```

Then open a new browser tab (no dsh restart needed).

## Select the route

Pick `OpenCode Go` in the model selector, or pin it:

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: opencode-go
  model: deepseek-v4.1-flash
```

## Credential

The profile stores a **reference name**, never the key. `apiKeyEnv` is not an
environment variable in the strict sense — it is a reference the harness
credential seam resolves, in this order:

1. the launch environment (what `dsh` was started with),
2. the credential store, `$DSH_HOME/.credentials.yaml`,
3. the project's `.env`,
4. the harness home's `.env`.

So `apiKeyEnv: OPENCODE_API_KEY` works with either

```bash
export OPENCODE_API_KEY=sk-...          # 1
```
or a store entry

```yaml
# ~/.dsh/.credentials.yaml
refs:
  OPENCODE_API_KEY: sk-...
```

**From the card:** the **API key** field in Configuration stores the literal for
you, through the harness credentials domain
(`remote.credentials.set(apiKeyEnv, value)`) — the same call the Models page
makes for its providers. It is write-only: a stored key never rides a response,
so the field starts blank, reports only whether a reference is configured, and a
blank field writes nothing.

**Never put the key in the profile patch.** That document is portable — it gets
copied between machines and pasted into issues — which is why the host's own
provider forms route keys through the credentials domain and why this plugin
keeps only the reference. `tests/client-controller.spec.ts` asserts a staged key
produces no settings mutation.

If the reference resolves to nothing, the request fails **before dispatch** with
`INVALID_CREDENTIAL` and a message naming the route and the reference. Nothing
downstream can supply the key: pi-ai's ambient lookup is keyed by *its own*
provider id, and this route's id is deliberately not one of those, so pi-ai's
`No API key for provider: opencode-go-session` is not a fallback — it is the
death rattle. The quota card says the same thing instead of relaying the
gateway's bare `401`.

## Configuration

One `llm-provider` section per served route, stored as this plugin's **loader
entry config** in the profile patch layer — the file the Settings UI writes
(`~/.dsh/profiles/<profile>/cordis.patch.yml`). All fields are editable from the
card:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: llm-provider
  name: "@gitawego/dsh-llm-provider"
  config:
    opencode-go-session:
      apiKeyEnv: OPENCODE_API_KEY    # credential reference name
      baseURL: ''                    # '' = each model's catalog endpoint
      models: []                     # allowlist over the catalog; [] = all
      extraModels:                   # models the installed catalog predates
        - id: deepseek-v4.1-flash
          contextWindow: 1000000
          maxTokens: 384000
          reasoning: true
      sessionRouting: true           # send x-opencode-session
      reasoning: ''                  # route-default effort; '' = provider default
      maxRequestImageBytes: 20971520
      requestImagePixelBudget: 4194304
      requestImageMaxBytes: 1048576
```

Upgrading a 0.1.x profile: the one-time `settings.yaml` import only lands
sections the running composition accepts, and a third-party namespace is logged
and left behind in `settings.yaml.imported`. The route then runs on the shipped
`apiKeyEnv` default while your key sits under your own reference — check with
`dsh --profile web --dump-config`, and see `AGENT.md` → "Upgrading an existing
profile".

Every field is optional and clamped: a malformed value degrades to the shipped
default rather than taking the route offline.

### Three layers, and why the Models page behaves the way it does

A field resolves as **schema default → composition base → user document**. The
plugin's own configuration is the base layer, so a deployment can carry a profile
in its profile patch without claiming a user choice:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: llm-provider
  name: '@gitawego/dsh-llm-provider'
  config:
    opencode-go-session:
      apiKeyEnv: OPENCODE_GO_CUSTOM_API_KEY
```

That placement matters on the **Models** page:

- its status dot asks whether the credential named by the *resolved* profile —
  or, when the profile names none, the **derived** name
  `<ROUTE_ID_UPPERCASED>_API_KEY` — is stored. For this route the derived name is
  `OPENCODE_GO_SESSION_API_KEY`. So an empty `llm-provider:` section plus a key
  stored under some other name reads as **red**, even though the plugin works;
- its **Delete** button appears only for a profile that exists in the *user*
  document and nowhere else. A profile supplied by the base layer is composition,
  not a user choice, so Delete is correctly absent — and a route a plugin
  registers at boot cannot be deleted from that page at all: deleting the profile
  removes your settings override, not the provider.

Either name a reference in a layer the page can resolve (`settings.yaml`, or the
base above), or store a key under the derived name. The card's **API key** field
always stores under whatever reference the resolved profile names.

### Where the model list comes from

Three sources, merged in this order of authority:

1. **the provider endpoint** (`GET {baseURL}/models`) — which ids this
   credential can call right now, including models released after this build;
2. **[models.dev](https://models.dev)** — context window, output cap, thinking
   levels, modalities, and cost for those ids;
3. **the installed pi-ai catalog** — the offline baseline, and the source of the
   wire-compat switches (a new `deepseek-*` model inherits its surveyed
   relative's `thinkingFormat: deepseek` rather than guessing).

The read happens at boot and on demand; a failed read leaves the installed
catalog serving, so a provider outage costs freshness, not availability.

`extraModels` is the override of last resort: a model the provider serves but
models.dev does not describe, or one whose capacities you want to correct. A
declared id wins over both other sources, field by field. `models` is the
allowlist (`[]` = everything), which the card writes when you pin models. An
allowlisted id is served even before either source describes it — the gateway's
protocol and the capacity defaults, the same treatment a freshly discovered id
gets — because a pin is a decision to serve, and a profile that pins only
post-catalog models must not go dark when the boot read fails.

## Routes

| Route | Endpoint | Protocols | Session header |
|---|---|---|---|
| `opencode-go-session` | `opencode.ai/zen/go` | openai-completions, openai-responses, anthropic-messages | required |

Adding a gateway is one entry in `src/gateways.ts` plus a catalog factory in
`src/catalog.ts` — the settings schema is generated from the gateway table.

## Where the allowance comes from

The card cannot call the provider itself, and this host version gives a plugin no
seam for it: the llm Remote namespace exposes `listProviders`,
`listConfigurableProviders`, and `discoverModels` only; forwarded events are a
host-owned allowlist a plugin cannot extend; and the usage endpoint is not
reachable from a browser (no key, no CORS). So the plugin serves one route of its
own:

```text
GET /llm-provider/quota?route=opencode-go-session
→ {"route":"…","windows":[{"id":"rolling","label":"5-hour","percentUsed":3,
   "percentRemaining":97,"status":"ok","resetsAt":"…"}],"fetchedAt":…}
```

It is a read of aggregate percentages — no key material, no prompt content, no
session data — and it is guarded the way the host guards its own `/api` bridge:

- `GET` only;
- the `Host` header must be loopback, so a deployment bound to `0.0.0.0` does not
  expose it;
- `Sec-Fetch-Site: cross-site` is refused, and an `Origin` whose host:port
  disagrees with `Host` is refused. Browsers set both and page scripts cannot
  forge them, so another origin cannot read it.

`tests/quota-route.spec.ts` covers the guard case by case. If you would rather
this plugin served no HTTP at all, remove the `registerQuotaRoute` call: the
tool card, the command, and the `llm_quota` tool keep working, and the card
shows the hint instead of the meters.

## What you get on the wire

Every dispatch through this plugin carries:

- `x-opencode-session: <harness session id>` — the fix;
- the harness attribution `user-agent`;
- `authorization: Bearer <resolved credential>`;
- on the DeepSeek models, every replayed assistant turn's own
  `reasoning_content` — the gateway's thinking mode answers a tool-carrying
  request without it with `400 … The reasoning_content in the thinking mode
  must be passed back to the API`, and a turn whose reasoning is missing is a
  turn the model cannot continue from.

`tests/wire.spec.ts` asserts exactly that, against pi-ai's real
OpenAI-completions implementation with an injected `fetch`.

### Leaked tool calls (DeepSeek DSML)

DeepSeek describes a tool call in **DSML** — tags wrapped in a `｜â€¦｜` mark,
**one** fullwidth bar per side — and the serving lane is supposed to parse that
into `tool_calls`.
Intermittently it does not: the markup arrives as ordinary `content` with
`finish_reason: "stop"`, so the turn reads as a completed answer, the tool never
runs, the agent sits idle showing syntax. The token is **one** fullwidth bar
(U+FF5C) on each side of `DSML`:

```text
<\u{FF5C}DSML\u{FF5C} calls>
<\u{FF5C}DSML\u{FF5C} invoke name="bash">
<\u{FF5C}DSML\u{FF5C} parameter name="command" string="true">ls</\u{FF5C}DSML\u{FF5C} parameter>
</\u{FF5C}DSML\u{FF5C} calls>
```

The model writes that template itself when its request arrives without tool
definitions, or the serving lane returns it unparsed. Either way the conversion
belongs to the provider, and this plugin does **not** decode it: a client-side
parser has to invent call ids, guess spacing and encoding, and would turn an
upstream fault into a silent success. An earlier attempt here did exactly that and
never fired, because it matched two bars per side while the lane emits one.

Instead the reply is failed: a text-only response that *begins* with the template
token, when tools were offered, finishes with a retryable `SERVER` failure. The
retry policy re-runs the request — the honest remedy — and a persistent leak
surfaces as an explicit error rather than markup in the transcript.

The evidence for that reading, from one affected session: its `request/header`
shows the request carried all 46 tools, replaying that exact request (46 tools,
`reasoningEffort: high`, `maxTokens: 384000`) returns proper tool calls 4 times
out of 4, and the leaked turn followed four 429 "upstream overloaded" retries with
the model's own reasoning saying *"we have no explicit tool list"* — the
overloaded lane served it without tool definitions.

## Limitations

- **A leaked tool-call template fails the turn instead of being decoded.** When
  the serving lane skips its tool-call parsing, the model's native template
  (`<｜DSML｜ calls>`) arrives as text. The plugin reports that as a retryable
  server failure — the retry policy re-runs the request, and a persistent leak
  shows as an error. Parsing it client-side would invent call ids and hide an
  upstream fault.

- **No replay state.** Native response ids and pi-ai's per-block signatures are
  not stored, so assistant history is rebuilt from durable content. The rebuild
  stamps the route's own identity, which is what lets pi-ai replay reasoning as
  `reasoning_content` for the DeepSeek models; history produced by a different
  model stays provider-neutral and its thinking degrades to text.
- **No `stop` sequences.** The seam's vocabulary supports them; pi-ai's common
  streaming surface cannot guarantee them, so a request with `stop` fails with
  `UNSUPPORTED_OPTION` rather than silently ignoring the field.
- **Catalog staleness is real.** Check `extraModels` when a new model 404s.

## Development

```bash
cd packages/llm-provider
pnpm typecheck && pnpm test && pnpm build
```

See [AGENT.md](./AGENT.md) for the design rules and the testing contract.
