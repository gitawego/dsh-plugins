# AGENT.md — dsh-llm-provider (architecture)

The non-negotiable design rules for `@gitawego/dsh-llm-provider`. Session
history and debugging deep-dives belong in `LESSONS.md`.

## What this project is

A `ctx.llm` **adapter plugin**: it registers provider routes the harness did
not ship an adapter for, backed by pi-ai's installed catalogs and wire
protocols. The first (and currently only) route is **OpenCode Go**.

Its reason to exist is one header:

```text
400 {"type":"error","error":{"type":"MissingSessionID","message":
  "Request is missing x-opencode-session and cannot be routed efficiently."}}
```

`opencode.ai/zen/go` pins a conversation to a backend lane by
`x-opencode-session`. The harness already knows the value — it stamps
`GenerateOptions.sessionId` on every loop-built request — but pi-ai 0.85.1 (the
build `dsh-llm-pi-ai` depends on) only *forwards* the session id; it never turns
it into a header. Upstream pi-ai 1.0.x wraps its built-in `opencode-go` provider
with `withOpenCodeSessionHeader`; 0.85.1 predates it. An adapter is the only
seam that sees the session id, so this plugin owns one.

## Design rule — the header is per-conversation, so it cannot be configuration (NON-NEGOTIABLE)

`dsh-llm-pi-ai` accepts static `headers` per provider profile. That is the right
tool for a deployment fact (a proxy's routing key, a tenant header) and the
wrong tool for this one: a single value shared by every conversation would
defeat the gateway's routing and its prompt-cache affinity.

Do not "simplify" this plugin by deleting the adapter and shipping a
`settings.yaml` snippet with a fixed header. Verify with the live gateway before
changing anything here: `tests/wire.spec.ts` asserts the header on the outgoing
HTTP request through pi-ai's own pipeline, and `README.md` records the observed
`400`/`200` pair.

Consequences that follow from it:

- The adapter must forward `options.sessionId` to pi-ai **and** the transport
  must turn it into the header; a test that only checks the pi-ai options object
  proves half the path.
- The header is never invented. A request with no session id (a hand-built
  one-shot) sends no header rather than a random one, because a random value
  would silently create routing lanes that do not correspond to anything.

## Design rule — attribution headers on every dispatch (NON-NEGOTIABLE)

Every request carries `attributionHeaders()` merged **last**, dropping any
caller header that collides case-insensitively. This is `dsh-llm-pi-ai`'s
precedence, and it is what keeps a profile from replacing the harness's
`user-agent`. The transport owns it in one place (`withAttribution`) so no route
can forget it.

## Design rule — reuse pi-ai, never re-implement the wire

The plugin does not speak HTTP. pi-ai owns request bodies, compat switches,
SSE parsing, and provider error text; this plugin owns the harness vocabulary
conversion (`context.ts`, `stream.ts`), catalog/profile resolution, and policy
(`adapter.ts`). If a gateway needs a protocol pi-ai does not implement, that is
a pi-ai gap, not a reason to grow an HTTP client here.

Two corollaries:

- **No replay state.** The adapter keeps none, so assistant history is rebuilt
  from durable content exactly as `dsh-llm-pi-ai` rebuilds a foreign message.
  Unsigned reasoning therefore travels as thinking, which pi-ai's Anthropic
  converter downgrades to text rather than sending a block the API would reject.
  Adding replay is a real feature (native ids and signatures survive
  compaction); it is not a refactor.
- **pi-ai retries are disabled** (`maxRetries: 0`). The seam's retry policy
  belongs to `dsh-llm-retry`, and two retry loops stacked behind one request
  multiply attempts.

## Design rule — pi-ai is a peer resolved from the host (NON-NEGOTIABLE)

`@earendil-works/pi-ai` is pinned to `0.85.1` and declared as a
**peerDependency**, never a regular dependency:

- The version must match the one `dsh-llm-pi-ai` uses, because this adapter is
  written against its `Model`/`Provider`/`AssistantMessageEvent` contracts.
- It resolves from the host installation's dependency closure:
  `dsh-app-boot` links the installation closure into
  `$DSH_HOME/profiles/node_modules`, which Node's parent-walk reaches from any
  profile plugin. Installing a profile-local copy would duplicate the module
  (and trip pnpm's build-script gate for pi-ai's `@google/genai`/`protobufjs`
  deps) to gain nothing.

The other peers (`@deepseek-ai/dsh-llm`, `-settings`, `-credentials`,
`-attachment`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`) follow the
monorepo-wide rule in the root `AGENT.md`: peers at the host's exact version,
never profile-local copies.

## Design rule — never claim a route key another plugin owns (NON-NEGOTIABLE)

The route key is a contract with the harness's provider topology, and it is a
single shared namespace. `dsh-llm-pi-ai` declares a configurable-provider entry
for **every** provider in pi-ai's installed catalog, so any route whose key
equals a catalog provider id is already taken:

```text
Error: dsh: plugin tree failed to load: failed to apply loader entry
  llm-provider (@gitawego/dsh-llm-provider):
  configurable provider "opencode-go" is already declared
```

That is why `OPENCODE_GO.id` is `opencode-go-session` while
`OPENCODE_GO.catalogProvider` stays `opencode-go`. The catalog provider id
selects the catalog and the wire implementations; the route key is what requests
name. They are related and must never be assumed equal —
`tests/directory.spec.ts` asserts that no served route key exists in
`CATALOG_PROVIDERS`, so a future gateway cannot reintroduce this.

Two consequences worth keeping:

- **Declaring a directory entry is best-effort.** `declareRoutes()` skips keys
  another registration owns and reports them, because a taken presentation row
  must never be a dead boot. The route still serves requests; only its Models
  page row belongs to the plugin that declared it first.
- **Do not register the adapter for a key pi-ai could activate.** If the user
  configured that pi-ai provider, its adapter would register the same route and
  the seam refuses the second one — a boot failure from a settings edit.

## Design rule — a route never goes dark because of settings

`resolveProfile()` clamps rather than throws: a hand-edited `settings.yaml`
with a typo'd `reasoning`, a non-numeric image budget, or a blank credential
reference degrades that field to the shipped default. The narrow exceptions are
deliberate and documented in code:

- an unknown `api` on a declared model drops that model from the catalog (pi-ai
  has no implementation for it, so advertising it would only produce a confusing
  failure later);
- a model the route does not serve fails the request with `UNKNOWN_MODEL`, and a
  route whose catalog the installed pi-ai does not ship serves nothing.

## Design rule — profile-declared models exist because catalogs go stale (NON-NEGOTIABLE)

The route advertises the installed catalog **plus** `extraModels`. This is not a
convenience: the live configuration runs `deepseek-v4.1-flash`, and pi-ai
0.85.1's catalog ships `deepseek-v4-flash`. A catalog-only route would reject
the model the user is actually running the day it lands.

A declared id the catalog knows is corrected field by field (the catalog stays
the base, so undeclared fields keep their surveyed values); a declared id the
catalog does not know is built from the profile's defaults. The `models`
allowlist narrows the catalog only — declaring a model *is* the decision to
serve it.

## Design rule — one gateway definition, one settings section

`GATEWAYS` in `gateways.ts` is the single source of truth for the served
routes; the config schema is generated from it, so a new gateway cannot ship
without a settings section. Adding a gateway is one entry there plus a catalog
factory in `catalog.ts` — never a new adapter.

## Design rule — the client half is one bundled file (NON-NEGOTIABLE)

`src/client/` is several modules (`controller.ts`, `strings.ts`, `index.tsx`)
because the logic must be testable without a DOM. The **bundle** is not: the
browser module system wraps one entry file in a `factory(require)` whose
`require` answers only the host's externals, so a surviving
`require('./controller.js')` is a boot-time crash. `scripts/build-client.mjs`
therefore bundles with esbuild and treats `react*` as external — bundling React
would hand the card its own React instance and break hooks.

`tests/bundle.spec.ts` asserts the built artifact: self-contained, no relative
requires, only host externals, registered under the package name, and no path
collision with the server's `lib/index.js`. That last claim is the lsp incident
from the root AGENT.md, encoded.

## Design rule — `getSnapshot()` must be referentially stable (NON-NEGOTIABLE)

`useSyncExternalStore` compares snapshots with `Object.is`, so a `getSnapshot()`
that builds a fresh object per call reports "changed" on every render and React
loops until it throws #185 (maximum update depth). The slot renderer catches
that crash and draws **nothing**, so the failure presents as a card that simply
does not exist — no error the user can see, no console line from this package.

This card shipped that way. The controller now caches its snapshot and
invalidates it from `publish()` (every mutation path calls it, as does the
settings-scope subscription), with the namespace revision as a second signal.
Two rules keep it fixed:

- **Invalidation is ours.** Do not depend on the settings scope returning a
  stable reference; that is its documented behaviour, not something this card
  may require. `client-controller.spec.ts` drives one double that rebuilds its
  snapshot every call precisely to prove the card does not rely on stability.
- **Every new read of derived state needs a snapshot-identity test.** Field
  assertions pass happily while the card crashes in a browser.

## Design rule — `ctx.get(name)` probes, `ctx.name` requires the declaration (NON-NEGOTIABLE)

cordis guards the **property** form of service access:

```text
cannot get property "webServer" without inject
```

while `ctx.get(name)` is an unguarded probe that returns the service or
`undefined`. Mixing them is a boot failure with no compile-time signal, and it
has happened here three times:

- the client card probed `ctx.get('remote')` and then read `.llm` (a *scoped*
  service, guarded) — the model list failed at read time;
- the quota route probed `ctx.get('webServer')` and then read `host.webServer` on
  the same undeclared context — the whole plugin tree failed to load;
- the adapter read `ctx.get('attachments')` the same way, which would have failed
  on the first image request.

The rule: use `ctx.inject([...], cb)` and read the service from the **callback's**
context. That both waits for the service and hands back a context that declares
it, and it is how the shipped `dsh-client-modules` registers its web route.
`ctx.get` is for probing only — and if you probe, never touch the property.

## Design rule — this surface is a SECTION, not a plugin card (NON-NEGOTIABLE)

The provider settings live in `settings.section` (id `llm-providers`), one panel
per served route, not in `settings.plugin.item`:

- the surface grows with every gateway the plugin serves, and a plugin-card list
  is not where several providers belong;
- `settings.section` is a **list** slot, so it carries an explicit `order` and
  the position is stable — the keyed plugin slot has no `order` at all, which is
  why the card's position used to move between reloads.

One store for the whole section, projected as `{ providers: [{ route, card }] }`,
with the panels as **pure functions of props**. A slot component gets exactly one
injected hook, and per-panel hooks would mean per-panel stores; the section
snapshot is memoized for the same reason the card's is (identity-compared
snapshots, React #185).

## Design rule — register the section with the boot-time group (NON-NEGOTIABLE)

Registration order still matters, and the exported `inject` still lists only
services that exist at boot.

So the exported `inject` lists only services that exist at boot (`slots`,
`locale`, `settingsScope`). Anything later — the Remote carrier, which arrives
with the socket handshake — is bound in a child fiber with `ctx.inject([...])`.
That keeps the card's registration as stable as this host allows and lets it
appear while the carrier is still connecting.

Do not "simplify" this by listing `remote.*` in the exported `inject`: that
delays registration until the handshake finishes, which is what made the card
move between reloads (and disappear entirely when the carrier was slow).

## Design rule — declare every scoped Remote namespace you read (NON-NEGOTIABLE)

`ctx.remote.llm` and `ctx.remote.credentials` are **services with their own
keys**, not plain properties. Reading one without declaring it throws at read
time:

```text
Could not read the provider: cannot get property "remote.llm" without inject
```

That is how the model list and the API key field both failed. Two rules:

- declare every scoped namespace the client half reads — in the *fiber that reads
  it*, via `ctx.inject(['remote', 'remote.llm', 'remote.credentials'], cb)`, not
  in the exported `inject` (see the ordering rule above);
- read them as `ctx.remote.<ns>`, never through `ctx.get('remote')?.<ns>`. The
  accessor form bypasses the inject declaration and fails at the read, with no
  compile-time signal.

`tests/bundle.spec.ts` materializes the built bundle and asserts the declared
list, so a new Remote read without its declaration fails a test instead of a
user's click.

## Design rule — colour roles come from the host's own meter (NON-NEGOTIABLE)

The allowance gauge shipped ugly in light mode: the track was
`--dsw-alias-bg-layer-3`, which is invisible against a card's own layer, and the
fill was `--dsw-alias-brand-primary`, which in that theme resolves to near-black
— so the meters rendered as small dark stubs floating with no scale.

Copy the shipped progress meter (`dsh-client-ui-attachment`) instead of guessing:

- **track** — `--dsw-alias-fill-tertiary` (translucent neutral; reads on either
  theme). Not a `bg-layer-*`: those are surfaces, not fills, and they disappear
  against a card of the same layer.
- **fill** — `--dsw-alias-state-success-primary`, and the matching
  `state-warn-primary` / `state-error-primary` past the thresholds. `state-*`
  tokens are the design system's semantic inks; `label-*` tokens are text
  colours and read as mud when used as fills.
- **fallbacks** — carry one (`#00000014`, `#2da44e`, `#bf8700`, `#d54941`) as
  every shipped rule does, so a theme older than a token still renders.

The percentage takes the same ink as its bar, so the number and the length cannot
disagree. A sliver keeps `min-width: 2px` so 1% spent is still visible at 8px.

## Design rule — no card that cannot be filled (NON-NEGOTIABLE)

The card shows what the browser can actually read: the settings namespace, and
the live catalog through `remote.llm.discoverModels` — which our own host
discovery answers with provider ids plus models.dev capacities.

It does **not** show the allowance windows. In 0.1.5 a profile plugin cannot
forward its own events (`TypertRemoteEventSelection`'s value lives in the host's
`dsh-api-remotes`) and cannot add a Remote namespace (the host lists those), so
the browser has no path to `GET /usage`. The card states that and points at
`/llm-provider quota` instead of drawing a gauge it cannot fill. If a future host
exposes a client path, the quota belongs here — wire it, don't fake it.

The card also cannot read thinking levels: `LlmDiscoveredModel` carries id, name,
contextWindow, and maxTokens only, and that contract is the host's. Thinking
levels live in the command and are asserted by `tests/surface.spec.ts`.

## Design rule — deployment facts belong in the composition base, user choices above it (NON-NEGOTIABLE)

The settings namespace resolves as schema default → **base** → user document, and
the plugin's own Config *is* the base (`mountSettings`). Two consequences make
this the right home for a deployment's profile (a credential reference, an
endpoint override):

- the Models page reports the credential for the *resolved* profile, so a
  base-supplied profile makes that page truthful without anyone writing a
  settings section first;
- the same page offers Delete only for a profile present in the user layer and
  absent from the base, so composition-supplied defaults do not present as
  removable user choices.

Corollary worth remembering when a user reports "the dot is red but it works":
the page falls back to the derived reference
`<ROUTE_ID_UPPERCASED>_API_KEY` when the profile names none. `opencode-go-session`
therefore derives `OPENCODE_GO_SESSION_API_KEY`, which is *not* the gateway's
documented `OPENCODE_API_KEY` and not whatever a machine happens to store. A red
dot means "the name this page resolved is unset", not "this plugin is
unconfigured" — check which reference is in play before changing code.

## Design rule — the key is stored through the credentials domain, never in settings (NON-NEGOTIABLE)

The card's **API key** field writes the literal with
`remote.credentials.set(apiKeyEnv, value)`; the profile keeps only the reference
name. Two reasons, both load-bearing:

- a settings document is portable — copied between machines, pasted into issues
  — so a literal key in it is a leak waiting to happen, and the host's own
  provider forms route keys through the credentials domain for that reason;
- the reference resolves through the seam's precedence (launch environment →
  `$DSH_HOME/.credentials.yaml` → project `.env` → harness-home `.env`), so the
  same profile works for someone who exports a variable and someone who saves a
  key, without the plugin knowing which.

The field is write-only by construction: a stored secret never rides a response,
so it cannot be seeded, a blank draft writes nothing (blank means "keep the
stored key", never "clear it"), and the control reports only `configured`. Do not
"improve" this into a field that reads the key back — a response that carries a
secret is the failure this design removes.

## Design rule — one guarded route, and only because there is no seam (NON-NEGOTIABLE)

The allowance is the single piece of client-facing state with no seam: the llm
Remote namespace carries no usage call, forwarded events are a host-owned
allowlist, and a browser cannot reach the provider's usage endpoint. So the
plugin serves exactly one route, `GET /llm-provider/quota`
(`src/quota-route.ts`), and it is guarded as strictly as the host guards `/api`:

- `GET` only, loopback `Host` only, `Sec-Fetch-Site: cross-site` refused, and an
  `Origin` whose authority disagrees with `Host` refused. Those headers are
  browser-set and page scripts cannot forge them, which is what makes the guard
  real rather than decorative;
- the payload is aggregate percentages — never key material, prompt content, or
  session data;
- it is read on demand, never on a timer, because each read spends the stored
  credential.

Rules that follow:

- **Do not add a second route.** If new client-facing state is needed, look for a
  seam first: a settings namespace, or a Remote namespace the host already
  exposes. A route is the last resort, and the reasoning belongs in a comment.
- **Do not loosen the guard** to make a call convenient — not by accepting any
  host, not by dropping the origin check, not by allowing a write.
- Keep `QUOTA_ROUTE_PATH` in `quota-path.ts`: the host half imports `node:http`
  and the browser half must not pull Node built-ins in behind a constant.

## Design rule — every live read degrades, never blanks

Boot, refresh, and the discovery handler all reach the network. A failure must
leave the previous answer standing and say what failed:

- the catalog feed keeps the installed pi-ai catalog and records `error`;
- the card keeps the last model list and shows `readFailed` with the reason;
- quota reports an explainable empty snapshot (`usage endpoint answered 429`).

An empty screen is indistinguishable from "this route serves nothing", which is
the one thing these reads must never imply.

## Design rule — the allowlist is a decision, and the card says which one (NON-NEGOTIABLE)

`models: []` means *every* model the provider serves; a non-empty list means
*exactly these*. The card renders the rule in words above the list, and it keeps
a pinned id the provider no longer serves on screen (flagged) so a dead pin can
be removed — `tests/client-controller.spec.ts` pins both behaviours. Do not
"simplify" an empty allowlist into "none selected".

## Testing contract

`vitest run` in this package. The suite is split by the claim each file makes:

| File | Claim |
|---|---|
| `session-header.spec.ts` | the header logic: present, absent, never overridden, never mutating |
| `config.spec.ts` | defaults, clamping, declaration normalization, schema/section agreement |
| `context.spec.ts` | harness→pi-ai conversion: system prompt folding, tool results, refusal of assistant images |
| `stream.spec.ts` | pi-ai→harness chunks, usage, finish reasons, error classification |
| `transport.spec.ts` | catalog/allowlist/endpoint merge, and which options reach a dispatch |
| `adapter.spec.ts` | adapter policy: model/effort resolution, credential lookup, refusals |
| `wire.spec.ts` | **the outgoing HTTP request** — header, attribution, body, and terminal event |
| `models-dev.spec.ts` | the models.dev contract: capacities, effort levels, modalities, and failure degradation |
| `gateway-api.spec.ts` | the gateway contract: id list, quota windows, clamping, and explainable failures |
| `catalog-feed.spec.ts` | the merge: live ∪ installed ∪ declared, protocol and compat resolution, feed snapshots |
| `surface.spec.ts` | what a human and the agent are actually told, for models and quota |
| `client-controller.spec.ts` | card logic with no DOM: catalog reads, allowlist writes, staged edits, rejected saves |
| `bundle.spec.ts` | the built artifacts: self-contained client bundle, ESM server entry, no path collision |

`wire.spec.ts` is the file that would have caught the original bug. Any change to
the header path must keep it green; a change that only updates
`transport.spec.ts` has not proven the fix.

## Process restart policy (NON-NEGOTIABLE)

Same as every package in this monorepo: never `pgrep`/`kill`/`pkill` the `dsh`
process from an agent session. After

```bash
cd ~/.dsh/profiles/web && pnpm install --offline
```

open a new browser tab — the rebuilt bundle is picked up by the `__DSH_BOOT__`
script. If dsh is wedged, ask the user to restart it in their own shell.
