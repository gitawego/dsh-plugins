# @gitawego/dsh-llm-provider

First-party LLM provider routes for DeepSeek Harness, at the `ctx.llm` adapter
seam. The first route it ships is **OpenCode Go** (`opencode.ai/zen/go`).

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

The route resolves `OPENCODE_API_KEY` through the harness credential seam
(`ctx.credentials`), so the key can live in the credential store, a `.env`
line, or the shell environment. Nothing is stored by this plugin. If the
reference resolves to nothing, pi-ai's own ambient provider auth is tried.

## Configuration

Settings namespace `llm-provider`, one section per served route:

```yaml
llm-provider:
  opencode-go:
    apiKeyEnv: OPENCODE_API_KEY      # credential reference name
    baseURL: ''                      # '' = each model's catalog endpoint
    models: []                       # allowlist over the catalog; [] = all
    extraModels:                     # models the installed catalog predates
      - id: deepseek-v4.1-flash
        contextWindow: 1000000
        maxTokens: 384000
        reasoning: true
    sessionRouting: true             # send x-opencode-session
    reasoning: ''                    # route-default effort; '' = provider default
    maxRequestImageBytes: 20971520
    requestImagePixelBudget: 4194304
    requestImageMaxBytes: 1048576
```

Every field is optional and clamped: a malformed value degrades to the shipped
default rather than taking the route offline.

### Declared models

The catalog goes stale between pi-ai releases. `extraModels` is how a route
serves a model released after the installed build — `deepseek-v4.1-flash` above
is exactly that case. A declared id the catalog knows is corrected field by
field; an unknown id is built from the profile's defaults. `models` narrows the
catalog only: declaring a model is itself the decision to serve it.

## Routes

| Route | Endpoint | Protocols | Session header |
|---|---|---|---|
| `opencode-go` | `opencode.ai/zen/go` | openai-completions, openai-responses, anthropic-messages | required |

Adding a gateway is one entry in `src/gateways.ts` plus a catalog factory in
`src/catalog.ts` — the settings schema is generated from the gateway table.

## What you get on the wire

Every dispatch through this plugin carries:

- `x-opencode-session: <harness session id>` — the fix;
- the harness attribution `user-agent`;
- `authorization: Bearer <resolved credential>` (or pi-ai's ambient auth).

`tests/wire.spec.ts` asserts exactly that, against pi-ai's real
OpenAI-completions implementation with an injected `fetch`.

## Limitations

- **No replay state.** Native response ids and thinking signatures are not
  preserved across turns; assistant history is rebuilt from durable content.
  Reasoning blocks travel unsigned and pi-ai's Anthropic converter downgrades
  them to text.
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
