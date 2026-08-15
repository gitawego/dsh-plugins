# @gitawego/dsh-web-search

Enhanced web search provider for DeepSeek Harness (DSH). Registers a
`WebSearchProvider` (id `opencode-enhanced`) into `ctx.web` with **chained
fallback**:

1. **opencode Go** — model-native Anthropic `web_search_20250305` on the opencode
   Go endpoint (`deepseek-v4-flash`), used only when a credential is configured.
2. **Parallel** — free MCP endpoint (`search.parallel.ai/mcp`), **no API key**,
   structured url/title/publish_date/excerpts.
3. **Exa** — free MCP endpoint (`mcp.exa.ai/mcp`), **no API key**, fallback.

It works **without any API key** via the free backends, and returns richer
snippets on the free path than the stock opencode-Go result (which yields only
url + title). It never modifies DSH source or the stock
`dsh-web-search-deepseek` plugin.

## Install

Add to a DSH profile (e.g. web) via `dsh plugin`, or add the package to the
profile's `dsh.profile.bundles`.

## Config (settings namespace `web-search-enhanced`)

```yaml
web-search-enhanced:
  go:
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

## Make it the active search provider

The seam auto-selects when exactly one provider is usable; otherwise set the
configured id:

```yaml
web:
  searchProvider: opencode-enhanced
```

or `export DSH_WEB_SEARCH_PROVIDER=opencode-enhanced`.

Switch back to the stock provider anytime with `searchProvider: deepseek-official`.

## Development

```
pnpm install
pnpm test        # vitest (17 tests)
pnpm build       # tsc -> lib/
pnpm typecheck
```
