# dsh-plugins

Monorepo of DeepSeek Harness (DSH) plugins.

## Packages

- [packages/web-search](packages/web-search/) — enhanced web search provider: works
  without any API key (free Parallel / Exa MCP backends) and optionally uses the
  opencode Go provider when a credential is configured, with transparent chained
  fallback.
