# @gitawego/dsh-llm-provider — agent notes

**Scope: reporting only.** This plugin serves no model route. It does not build a
request, parse a tool call, retry a stream, or stamp an HTTP header.

## Why that boundary is not negotiable

Earlier revisions of this package *were* an adapter: they registered a private
route (`opencode-go-session`), spoke the wire through pi-ai themselves, and
compensated for whatever that path lacked — a per-conversation header, a live
model catalog, a retry classification, even a parser for the model's native tool
syntax leaking through as text.

Every one of those bugs was a property of the duplicate, not of the provider.
The measurements that ended the argument:

| build | `x-opencode-session` from `sessionId` | `opencode-go` endpoint | knows `deepseek-v4.1-flash` |
| --- | --- | --- | --- |
| pi-ai `0.85.1` (this package's old pin) | absent | `zen/go` (saturated: 0/8 served) | no |
| pi-ai `1.5.0` (**what the host ships**) | `opencode-headers.js`, wraps all four APIs | `inference/go/openai/v1` | yes |

`dsh-llm-pi-ai` depends on `@earendil-works/pi-ai: ^1.3.0`. Its adapter
forwards `GenerateOptions.sessionId` to pi-ai, and pi-ai turns it into the
header. Serving the same model through the host route produced
`["thinking","text","toolCall","toolCall"]` and no markup, while the private
route produced `429`s and DSML. The plugin was fixing a stale dependency with a
parallel stack.

## What this package may contain

- **Reads.** `GET {endpoint}/models` and `GET {endpoint}/usage`, with the
  credential from `ctx.credentials`. Both are metadata; neither is a
  conversation, so neither carries a session header.
- **A comparison.** `ctx.llm.listModels(route)` (what the harness catalog
  describes) minus the gateway's list (what the endpoint actually serves). The
  difference is the set a user declares in `llm-pi-ai.providers.<route>.models`,
  and `modelsSnippet()` prints that block.
- **Presentation.** `/llm-provider models|quota|refresh`, the `llm_quota` tool,
  two guarded loopback routes (`/llm-provider/quota`, `/llm-provider/status`) for
  the browser card, and one settings section.
- **Four settings fields.** `route`, `baseURL`, `apiKeyEnv`, `refreshMinutes`.
  No secrets: the key stays in the credential store and the profile only holds
  its reference name.

## What this package must never contain again

Do not add an adapter, a transport, a `stream()`, a session-header helper, a
request assembler, an image converter, a retry policy, or a parser for provider
output. If a route does not work, the answer is the host adapter's profile or
the installed pi-ai build — never a second wire in here. A symptom that looks
like "the model emitted markup instead of a tool call" is a *routing* fact: check
`llm-pi-ai.providers.<route>` and the pi-ai version before writing a line of
code.

## Invariants worth a test

- the settings profile has exactly four fields, and `apiKeyEnv: ''` is
  meaningful ("report unauthenticated"), not a fallback trigger;
- `composeStatus` sorts known ids first and never invents a capacity it was not
  given;
- `modelsSnippet` lists **every** id, because a declared `models` list replaces
  the route catalog instead of extending it;
- the dashboard's snapshot keeps its identity between reads
  (`useSyncExternalStore` compares by reference; a per-call rebuild is React
  error #185, which this card has already shipped once);
- both HTTP routes share one trust guard, and neither reads a credential on a
  refused request;
- client CSS uses the current host aliases (`--dsw-alias-label-*`,
  `--dsw-alias-border-l2`, `--dsw-alias-bg-layer-*`, `--dsh-font-family-code`);
  the built-bundle test rejects the pre-0.2.2 `fg-*`, `border-tertiary`,
  `bg-primary`, `bg-secondary`, `fill-tertiary`, and `font-mono` aliases;
- nothing in the client reads a Remote namespace, and nothing in the package
  imports `@earendil-works/pi-ai`.

## Commands

```bash
pnpm --filter @gitawego/dsh-llm-provider test     # vitest run
pnpm --filter @gitawego/dsh-llm-provider build    # tsc x2 + esbuild client bundle
```

A build is not a deploy: the web profile is hoisted, so copy through
`rm -rf node_modules/@gitawego/dsh-llm-provider && pnpm install --offline` and
verify with `md5sum`.
