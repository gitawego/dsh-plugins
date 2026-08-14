# dsh-vision

Capability-aware vision + paste extension for **DeepSeek Harness**, ported 1:1 from
[`@gitawego/pi-vision`](https://github.com/gitawego/pi-vision). Published on npm as
**[`@gitawego/dsh-vision`](https://www.npmjs.com/package/@gitawego/dsh-vision)**.

- `describe_image` tool (single + batch `image_paths`) — hidden on multimodal primaries
  (native pass-through), visible on text-only primaries (delegation with cache/retry/fallback).
- Paste UX: `[Image-#N]` markers, hint/auto/off modes.
- Cache, audit log, local-only mode, batch concurrency, auto-detect, `/vision` command,
  Web Settings (data-driven, no hardcoded provider/model ids).

## Installation

Install the plugin into a **profile** (the harness composes plugins per profile; the
`web` profile backs the Web GUI). Pick one:

### 1. npm registry (recommended)

The package is published; add it from the registry and let the harness reconcile the
bundle list:

```bash
dsh plugin --profile <name> add @gitawego/dsh-vision
dsh plugin --profile <name> install
```

Verify it composed, then restart the harness so the plugin (and its Web client) load:

```bash
dsh --profile <name> --dump-config   # expect a row for @gitawego/dsh-vision
dsh --profile <name>                 # restart, e.g. dsh web
```

### 2. Direct install (local path / no registry)

Useful for development or offline hosts: depend on a local checkout with a `file:`
spec (exactly what pnpm would write for `pnpm add file:...`) and list the package in the
profile's bundles, then run the official install command:

1. Edit `~/.dsh/profiles/<name>/package.json`:

```json
{
  "dependencies": {
    "@gitawego/dsh-vision": "file:/absolute/path/to/dsh-vision"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@gitawego/dsh-vision"
      ]
    }
  }
}
```

2. Install + verify + restart:

```bash
dsh plugin --profile <name> install
dsh --profile <name> --dump-config   # expect a row for @gitawego/dsh-vision
dsh --profile <name>                 # restart
```

> Note: after rebuilding a local checkout, re-run `dsh plugin --profile <name> install`
> (pnpm copies `file:` dependencies into its store — not a live link).

## Configuration

Configure the vision provider/model and behavior in the **Settings → Vision** page, or
with the `/vision` command (`/vision show`, `/vision config provider <id>`, ...).

- **provider / model** — an image-capable model from the live harness catalog
  (data-driven; auto-detect offers a default). Used by the native sub-agent delegation.
- **delegation** — `auto` (native sub-agent with the vision model; falls back to the
  direct `http` endpoint when the harness cannot deliver images natively),
  `native` (sub-agent only), `http` (plugin-owned direct endpoint call).
- **http block** — `baseUrl`, `credential` (a DSH credential-ref *name*), `model`,
  `protocol` (openai | anthropic).

Example http configuration (any OpenAI-compatible vision endpoint):

```bash
/vision config delegation http
/vision config http.baseUrl https://api.example.com/v1
/vision config http.model vision-model
/vision config http.credential VISION_API_KEY   # a DSH credential ref
```

> **Android/Termux note:** the harness attachment store cannot write under `/data/data`
> (its durability walk hits EACCES — a raw Android permission), so the native
> sub-agent path cannot deliver images there. Use `delegation=http` with the
> `http` block on Termux; `auto` falls back to http automatically when the store
> is unavailable.

## Platform support

The harness loads client bundles only for `platform: "web"` (dsh-client-modules
skips every other platform), so the plugin's **Web client** is available only in the
`web` profile:

| Surface                | web  | tui / headless |
|------------------------|------|----------------|
| `describe_image` tool     | ✓    | ✓ (host tool)  |
| `/vision` command         | ✓    | ✓ (host command)|
| Paste markers / auto      | ✓    | ✓ (agent/pre-step hook) |
| Delegation (subagent/http)| ✓    | ✓              |
| Settings page (Vision)    | ✓    | — (web-only slot) |
| Tool call card            | ✓    | — (web-only slot) |

For `tui` / `headless` profiles, configure everything with the `/vision` command
(`/vision show`, `/vision config ...`) or by editing `vision:` in
`~/.dsh/settings.yaml` — the settings page is a Web-only convenience, not a
requirement.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build      # server + client bundles (lib/ incl. lib/client.js)
```

Publishing is automated via GitHub Actions: tag `v*` to run typecheck/tests/build and
publish `@gitawego/dsh-vision` to npm with provenance (OIDC trusted publishing), plus a
GitHub Release.

## Docs

- [SPEC.md](SPEC.md) — full implementation spec (feature parity, architecture, KV-cache requirements).
- [AGENTS.md](AGENTS.md) — project architecture and design rules.
- [LESSONS.md](LESSONS.md) — session history, debugging deep-dives, tooling pitfalls.

