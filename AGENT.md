# AGENT.md

Project conventions for AI agents working in this repo.

## TDD is mandatory

Every behavior change — feature, bug fix, or refactor — MUST be written
test-first (red → green → refactor) with a unit test that fails before the
change and passes after. Do not skip tests on "small" fixes; the fix cost is
the same, the regression risk is not.

Use the repo's test runner (`vitest run` in each package). Tests live in
`packages/<name>/tests/`.

### Why (real incident, 2026-08-16)

`packages/lsp` broke `dsh web` at boot: `lib/manager.js` does
`import { createClient } from './client.js'`, but the build pipeline compiled
the browser UI (`src/client/index.tsx`) through `scripts/build-client.mjs`
into the SAME output path `lib/client.js`, clobbering the server-side LSP
client module (`src/client.ts`) that exports `createClient`. The runtime
error surfaced only when the harness loaded the plugin:

```
SyntaxError: The requested module './client.js' does not provide an export named 'createClient'
```

A unit test asserting that `lib/manager.js`'s import graph resolves (or,
better, a test importing `createClient` from the built server module and
exercising it) would have caught the collision at build time instead of at
boot.

### Practical guardrails

- Build-output collisions: when a package builds both server modules and a
  browser bundle, assert in a test that each built entry exports the symbols
  its importers require (e.g. `manager.js` → `createClient`).
- Import-graph tests are cheap and fast; prefer them over waiting for
  integration/boot failures.
- Any test that touches build artifacts MUST run against a freshly built
  output (`npm run build` first), never a stale `lib/`.
