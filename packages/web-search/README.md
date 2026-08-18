# @gitawego/dsh-web-search

Enhanced web search provider for DeepSeek Harness (DSH) 0.1.0-rc.7+.
Registers a `WebSearchProvider` (id `opencode-enhanced`) into `ctx.web` with
**chained fallback** in order:

1. **Custom LLM** — whatever you typed in **LLM endpoint / model / credential**
   on the card (Anthropic `web_search_20250305` server tool or OpenAI-compatible
   web-search). Tried first when **Enable the LLM backend** is on.
2. **opencode Go default** — hardcoded `https://opencode.ai/zen/go/v1` with
   `deepseek-v4-flash` and the `OPENCODE_GO_API_KEY` credential-ref name.
   Always attempted as the next step; silently skipped when the credential is
   not configured.
3. **Parallel** — free MCP endpoint (`search.parallel.ai/mcp`), **no API key**,
   structured url/title/publish_date/excerpts.
4. **Exa** — free MCP endpoint (`mcp.exa.ai/mcp`), **no API key**, fallback.

The chain only stops when one stage returns non-empty results. It works
**without any API key** via the free backends (steps 3-4), and the opencode-Go
step is the cheapest paid fallback (~$0.14/$0.28 per 1M tokens, same price
as DeepSeek V4 Flash on the Vercel gateway). It never modifies DSH source or
the shipped `dsh-web-search-deepseek` plugin.

It works **without any API key** via the free backends, and returns richer
snippets on the free path than the stock opencode-Go result (which yields only
url + title). It never modifies DSH source or the stock
`dsh-web-search-deepseek` plugin.

## Install / Uninstall contract (the `cordis.patch.yml`)

Adding this package to a profile's `dsh.profile.bundles` (via `dsh plugin`)
applies the bundle's `cordis.patch.yml` as one profile layer. The patch does
**two things** — together these are the install contract, and removing them
on uninstall is automatic:

1. `insert` the plugin into the loader tree. At boot, `apply()` runs and
   registers the `opencode-enhanced` provider into `ctx.web` plus the
   `web-search-enhanced` settings namespace and the `/_dsh/web-search/...` host
   routes (when the profile has a `webServer`).
2. Override the `id: web` row's `config.searchProvider` so the seam routes
   `web_search` calls to this provider instead of `deepseek-official`.

On **uninstall**, pnpm removes the package, the reconciler drops the entry
from `dsh.profile.bundles`, and the next boot composes the tree **without**
this bundle layer — so:
- this plugin no longer inserts and `apply()` never runs (its provider,
  the settings namespace, and the host routes are gone);
- the `id: web` row's `config.searchProvider` reverts to whatever the
  next-lower layer wrote, defaulting back to `deepseek-official`.

A user override on the profile's own `cordis.patch.yml` (a later layer in
the same composition) or the `$DSH_WEB_SEARCH_PROVIDER` env var outranks this
layer, so a deployment that prefers a different provider can still pin it
after installing this bundle.

## Config (settings namespace `web-search-enhanced`)

```yaml
web-search-enhanced:
  llm:
    enabled: false
    protocol: anthropic            # anthropic | openai
    baseUrl: https://opencode.ai/zen/go/v1   # "" or omitted disables Go
    credential: OPENCODE_GO_API_KEY          # DSH credential-ref NAME
    model: deepseek-v4-flash
    timeoutMs: 20000
  free:
    parallelUrl: https://search.parallel.ai/mcp
    exaUrl: https://mcp.exa.ai/mcp
    timeoutMs: 15000
    snippetMaxChars: 300
    maxResults: 8
```

Read/written through the standard DSH settings seam (no plugin-owned HTTP
route).

### Choosing the LLM-backend model

The LLM backend speaks Anthropic's `web_search_20250305` server tool (or the
OpenAI-compatible web-search shape when `protocol: openai`). The model
must (a) be on a route that supports the chosen protocol and (b) have a
gateway implementation that actually executes the web-search tool. The
shipped `dsh-web-search-deepseek` validates (b) for `deepseek-v4-flash` on
DeepSeek's Anthropic Messages endpoint — that's the default and the
safest pick.

If you want to try other Anthropic-format routes, things like
`xiaomi/mimo-v2.5` (same $0.14/$0.28 input price on the
vercel-ai-gateway catalog), `zai/glm-4.7-flash` ($0.07/$0.40), or
`poolside/laguna-s-2.1-free` (free tier) may work — but only if the
gateway you've pointed `baseUrl` at actually implements the tool. A
failed call falls through to the free Parallel/Exa backends, so it's safe
to try.

## Browser-side settings UI

The Web bundle ships a `settings.plugin.item` card keyed by
`web-search-enhanced`. The **Plugins → Plugin configuration** tab
(`dsh-client-ui-settings-plugins`) pairs the card with the namespace the host
serves, so the card lives in the standard settings surface — no bespoke
section, no plugin-owned HTTP route.

The card stages edits and saves them through the standard settings scope, so
every write is revision-fenced, dirty-tracking is automatic, and the saved
values ride the same wire every other plugin uses.

## Make it the active search provider

By default, installing this bundle already sets
`web.searchProvider: opencode-enhanced` (the patch above). Switch back to the
stock provider anytime with `searchProvider: deepseek-official` in your
profile's own `cordis.patch.yml` (which outranks the bundle's layer) or
`export DSH_WEB_SEARCH_PROVIDER=deepseek-official`.

## Development

```
pnpm install
pnpm test        # vitest
pnpm build       # tsc -> lib/
pnpm typecheck
```