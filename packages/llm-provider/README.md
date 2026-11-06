# @gitawego/dsh-llm-provider

The OpenCode Go dashboard for DeepSeek Harness: which models the provider serves
beside which models the harness catalog describes, and how much of the
subscription is left.

**This package serves no model route.** Endpoint, protocol, model catalog,
streaming, tool-call parsing, retries, and the `x-opencode-session` routing
header all belong to the host's `dsh-llm-pi-ai` adapter, which resolves them from
the installed pi-ai build (1.5.0: OpenCode Go's current
`https://opencode.ai/inference/go/openai/v1`, with the session header stamped by
`withOpenCodeSessionHeader`). The plugin only reports.

```yaml
# profile patch: the route is the host adapter's, configured like any provider
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_CUSTOM_API_KEY
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: high }

# this plugin: four monitoring fields, no secrets
- id: llm-provider
  name: "@gitawego/dsh-llm-provider"
  config:
    route: opencode-go
    apiKeyEnv: OPENCODE_GO_CUSTOM_API_KEY
    refreshMinutes: 15
```

## What it contributes

| surface | what it shows |
| --- | --- |
| `/llm-provider models` | both lists, the ids the catalog cannot offer, and the `models:` block to paste into `llm-pi-ai.providers.<route>` |
| `/llm-provider quota` | the rolling 5-hour, weekly, and monthly windows with reset times |
| `/llm-provider refresh` | re-reads both from the provider |
| `llm_quota` tool | the same allowance, mid-task |
| Settings → LLM providers | the dashboard: credential state, model comparison, gauges |
| `GET /llm-provider/status`, `GET /llm-provider/quota` | the card's two guarded loopback reads |

Two read-only calls back all of it, both unauthenticated-conversation metadata:

```bash
$ curl -sS https://opencode.ai/inference/go/v1/models -H "authorization: Bearer $KEY" | head -c 120
{"object":"list","data":[{"id":"deepseek-v4.1-flash",…

$ curl -sS https://opencode.ai/inference/go/v1/usage -H "authorization: Bearer $KEY" | head -c 120
{"usage":{"rolling":{"status":"ok","percent":5,"resetsAt":"…
```

## Why the comparison is the feature

pi-ai's catalog ships with the host. A model the gateway starts serving *after*
that build is invisible to the model picker even though the endpoint accepts it,
and the fix is a `models:` entry — which **replaces** the route catalog rather
than extending it. So the snippet prints every id, with the capacities models.dev
discloses, ready to paste.

## Subscribe/install

```bash
pnpm --filter @gitawego/dsh-llm-provider build
cd ~/.dsh/profiles/web && rm -rf node_modules/@gitawego/dsh-llm-provider && pnpm install --offline
```

The profile is hoisted: a rebuild in this workspace is not a deploy until the
profile's copy is replaced and verified with `md5sum`.
