# @gitawego/dsh-llm-provider

The OpenCode Go dashboard for DeepSeek Harness: which models the provider serves,
which of them this route has enabled, and how much of the subscription is left.

**This package serves no model route.** Endpoint, protocol, model catalog,
streaming, tool-call parsing, retries, and the `x-opencode-session` routing
header all belong to the host's `dsh-llm-pi-ai` adapter, which resolves them from
the installed pi-ai build (1.5.0: OpenCode Go's current
`https://opencode.ai/inference/go/openai/v1`, with the session header stamped by
`withOpenCodeSessionHeader`). The plugin reports those facts and edits one host
field: the route's enabled-model allowlist
(`llm-pi-ai.providers.<route>.models`).

```yaml
# profile patch: the route is the host adapter's, configured like any provider
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_CUSTOM_API_KEY
        models:            # optional: the enabled subset; omit to serve the whole catalog
          - id: deepseek-v4.1-flash
          - id: muse-spark-1.3-contributor
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
| Settings → LLM providers | the dashboard: only the enabled models, a “Choose models” picker over the served list, credential state, and gauges |
| `GET /llm-provider/status`, `GET /llm-provider/quota` | the card's two guarded loopback reads |

Two read-only calls back all of it, both unauthenticated-conversation metadata:

```bash
$ curl -sS https://opencode.ai/inference/go/v1/models -H "authorization: Bearer $KEY" | head -c 120
{"object":"list","data":[{"id":"deepseek-v4.1-flash",…

$ curl -sS https://opencode.ai/inference/go/v1/usage -H "authorization: Bearer $KEY" | head -c 120
{"usage":{"rolling":{"status":"ok","percent":5,"resetsAt":"…
```

## Enabling a subset

The card shows only the models this route has enabled. Click **Choose models** to
open the served catalog: the checked ids are the enabled set, and **Apply** writes
them to `llm-pi-ai.providers.<route>.models` through the shared settings form.
Writing an entry with `contextWindow`, `maxTokens`, or `input` carries the
capacity the dashboard read from models.dev; the id alone is enough for a model
the installed catalog already describes.

If the host provider has no `models` list, the whole catalog is enabled and the
card says “all N enabled”. **All** in the picker selects every served model;
**None** clears the list. A declared list replaces the route catalog rather than
extending it, so the card and the model picker agree on the same subset.

## Why the comparison is still useful

pi-ai's catalog ships with the host. A model the gateway starts serving *after*
that build is invisible to the model picker even though the endpoint accepts it.
The dashboard’s `/llm-provider models` command prints the ids and capacities
models.dev discloses, so an id that needs a full declaration is visible before it
is enabled in the card.

## Subscribe/install

```bash
pnpm --filter @gitawego/dsh-llm-provider build
cd ~/.dsh/profiles/web && rm -rf node_modules/@gitawego/dsh-llm-provider && pnpm install --offline
```

The profile is hoisted: a rebuild in this workspace is not a deploy until the
profile's copy is replaced and verified with `md5sum`.
