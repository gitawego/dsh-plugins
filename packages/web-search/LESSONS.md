# LESSONS.md — dsh-web-search session history, pitfalls, and environment

The project's running history, the lessons learned the hard way, and the
host-specific facts a resuming session needs. **AGENTS.md holds the
architecture and design rules; this file is the lessons recorder.**

## Session history (what was done, in order)

1. **Studied the shipped `dsh-web-search-deepseek`** in `dsh-global`: the
   `WebSearchProvider` contract, `ctx.web.registerSearchProvider`, the
   `web_search_20250305` server tool, the `deepseek-official` provider id.
2. **Studied the rc.7 `dsh-app-boot`** patch loader: bundle layers apply in
   `dsh.profile.bundles` order; a `cordis.patch.yml` is the install contract;
   the next-lower layer wins on uninstall.
3. **Installed via `pnpm add` from the monorepo** with
   `"@gitawego/dsh-web-search@file:..."` because `dsh plugin add <path>`
   fails on pnpm 12.0.0-rc.3 (the script's `anchorPathSpec` regex only
   rewrites `.` / `..` paths; pnpm 12 rejects bare-path specs).
4. **Iterated on the card UI** through six fixes:
   - **v1 — bespoke HTTP route** (`/_dsh/web-search/settings`): wired
     through `ctx.webServer.register({ kind: 'prefix', path: ... })`. Worked
     but reintroduced a custom surface that rc.7's Settings Card mechanism
     already replaces.
   - **v2 — read-only fields on render**: card opens in `loading` state;
     `raw.writable` is `false` initially and only updates when describe
     RPC completes. Naive `writable: raw.writable === true` disables every
     input. Fixed via `writable: raw.status === 'ready' ? raw.writable === true : true`.
   - **v3 — hidden checkbox with `pointer-events: none`**: broke the
     `<label htmlFor>` click-forwarding on mobile. Removed the rule.
   - **v4 — `<button role="switch">` with native onClick**: click handlers
     fire correctly, but the State change still doesn't propagate.
   - **v5 — collapsed card by default**: the user couldn't see the toggle
     until they tapped the chevron. Changed `useState(false)` to
     `useState(true)`.
   - **v6 — snapshot store cached stale value**: `publish()` was
     iterating listeners but never updating the cached `last`, so React's
     `useSyncExternalStore` re-rendered with the same snapshot every
     time. Fixed by making `publish()` call `this.store.set(this.computeSnapshot())`
     BEFORE emitting listeners. This is the actual root cause of the
     "click does nothing" report.
5. **Verified end-to-end via headless Chrome over the Chrome DevTools
   Protocol** (CDP on port 9222, launched via `chrome-mcp/cdp-lifecycle.sh`):
   clicked Settings → Plugins → clicked the toggle → confirmed `ariaChecked`
   flipped from `"false"` to `"true"`, `data-checked` from `null` to `"true"`,
   className gained `wsc-toggle-row-on`.

## Diagnoses that shaped the design (deep-dives)

### The "click does nothing" bug

**Symptom**: Tapping the toggle row on the card visibly does nothing. The
pill stays gray, `aria-checked` stays `"false"`, the staged draft never
appears.

**Mis-diagnoses I tried first** (each wasted ~10 minutes):

1. **"Mobile CSS tap target"**: I made the row 44px tall, hid a native
   checkbox, added `:active` feedback. None of it mattered — the click
   was reaching the handler, but the handler was a no-op for the state.
2. **"`disabled=true` at runtime"**: I loosened `writable: raw.writable !== false`
   (was `=== true`). Still no toggle. The probe showed `disabled: false`
   and `readOnlyBanner: false` after my fix, yet the state didn't update.
3. **"Browser cache"**: I assumed the deployed bundle was stale. The
   probe showed `toggleCount: 1` and the new `role="switch"` markup, so
   the cache was fine.

**Actual root cause** (found by adding a `console.log` to `WebSearchCard`
and observing the render with two consecutive log lines both showing
`llmEnabled.text = false`):

`makeSnapshotStore` returned a cached `last` value that was only set at
construction. When the controller's `edit()` called `publish()` to notify
listeners, the cache was never updated. React's `useSyncExternalStore`
re-rendered but kept reading the same stale value. The fix:

```ts
private publish(): void {
  this.store.set(this.computeSnapshot())  // update `last` first, then emit
}
```

`set()` updates the cached `last`, then emits the listeners. React's hook
reads the new value on re-render.

**Why I kept guessing**: I didn't have a way to observe `useSyncExternalStore`
behavior from console. Headless Chrome + CDP was the only realistic
debug surface. Once I drove a real click via CDP and saw the render was
called but `computeSnapshot()` returned the same value, the bug was
obvious.

### The "SettingsScopeController.writable is false during loading" gotcha

`dsh-client-ui-settings/lib/client.js` line 47:

```js
this.store = createSnapshotStore({
  status: persistence === "host" ? "loading" : "unavailable",
  ...
  writable: false,  // <-- initial value
  ...
})
```

The `accept()` method only updates `draft.writable` if
`writable !== undefined`. So during loading (or while the websocket is
reconnecting), `raw.writable === false` even when the host is genuinely
writable. The naive `writable: raw.writable === true` makes the entire
card read-only on first render.

**Fix**: only treat `raw.writable` as authoritative when `status === 'ready'`:

```ts
writable: raw.status === 'ready' ? raw.writable === true : true,
```

This means: while loading, the user CAN stage drafts (toggle works, Save
attempts the write). If the host is genuinely read-only (memory mode),
`status === 'ready'` will eventually be true and `raw.writable === false`
will disable the form.

### The "this is two cards" confusion

The shipped `dsh-web-search-deepseek` registers a card with title
"Web search" (id `deepseek-official`). My plugin registers a card with
title "Web Search (enhanced)" (id `opencode-enhanced`). Both render in
the Plugins → Plugin configuration tab under the SAME list. The user
initially was clicking the shipped card, which has no toggle (its fields
are `baseURL`, `maxUses`, and a `SecretField` for the key). Once I
confirmed via the headless Chrome probe that "Web search" and "Web Search
(enhanced)" are two distinct cards, the user needed to scroll to the
right one.

**Lesson**: when adding a sibling plugin that ships adjacent to existing
DSH parts, make the title obviously distinguishable. The rc.7 shipped
cards don't follow any naming convention, so I had to pick a clear
suffix.

## Environment facts a resuming session needs

- **DSH base**: `/data/data/com.termux/files/home/dsh-global` (rc.7).
- **DSH user home**: `/data/data/com.termux/files/home/.dsh` (settings in
  `settings.yaml`, mode `600`, provisioned by `setup-dsh-termux.sh`).
- **Headless Chrome for CDP**: `/data/data/com.termux/files/home/.omp/puppeteer/chrome/linux_arm-150.0.7871.24/chrome-linux64/chrome`
  (Termux native, glibc-via-runner). Launched via
  `bash /data/data/com.termux/files/home/workspace/agent-skills/skills/chrome-devtools-mcp-pi/scripts/start-cdp.sh`.
- **Live GUI**: `http://127.0.0.1:3080` (running, PID changes per session).
- **WebCDP debug port**: `9222`.
- **Default agent model**: `minimax-cn / MiniMax-M3` (`/MiniMax-M3`,
  $0.30/$1.20 per 1M tokens).
- **Cheapest Anthropic-format model with confirmed `web_search_20250305`
  support**: `deepseek-v4-flash` ($0.14/$0.28). `xiaomi/mimo-v2.5` is
  the same price but the gateway implementation is unclear.
- **Plugin registration**: `dsh.plugin add <bare-path>` fails on pnpm
  12.0.0-rc.3 (the `anchorPathSpec` regex only matches `.` / `..` paths).
  Workaround: `pnpm add "name@file:path"` directly in the profile dir,
  then manually append the bundle to `dsh.profile.bundles`.

## Tooling pitfalls (learned the hard way — do not repeat)

- **Don't kill dsh from this session.** `pgrep -f "dsh.*bin.js.*web" |
  xargs -r kill` followed by `nohup dsh --profile web > log 2>&1 &` is
  fragile on Termux: the `pgrep` may match the kill itself, the nohup
  child often dies with the parent shell, and the GPU/zygote children
  leak. The browser's `client.js` is loaded FRESH on each new tab via
  the `__DSH_BOOT__` script's URL, so a rebuilt bundle is picked up by
  opening a new tab — **no dsh restart needed**. If dsh is genuinely wedged,
  the user restarts it in their interactive shell.

- **Don't write a bespoke HTTP route for the settings surface.** The
  rc.7 Settings Card mechanism (`settings.plugin.item` slot + the
  `settingsScope` service) replaces the v0.1.0-rc.6 pattern of
  `ctx.webServer.register({ kind: 'prefix', path: '/_dsh/<plugin>/settings' })`
  with a native settings card. The plugin should ship a slot entry, not
  an HTTP handler.

- **Don't hide a native checkbox with `pointer-events: none`.** When the
  input is hidden via `opacity: 0; pointer-events: none`, the
  `<label htmlFor>` click-forwarding silently breaks on mobile browsers —
  the input's pointer-events say "don't interact with me" and the
  browser agrees. Use a `<button role="switch">` with a native `onClick`
  instead.

- **Don't trust `raw.writable` during `status === 'loading'`.** The scope
  controller initializes `writable: false` and only updates on describe
  RPC completion. Treat the writable flag as opt-in: only consider the
  host read-only when `status === 'ready' AND raw.writable === false`.

- **Don't skip the snapshot store's `set()` call on `publish()`.** The
  controller's `edit()` puts the new value in `this.drafts` and then
  notifies listeners. If `publish()` only iterates listeners without
  first updating the cached snapshot, React's `useSyncExternalStore` sees
  the same reference and doesn't re-render. The fix is
  `this.store.set(this.computeSnapshot())` before the listener loop.

- **Don't collapse the card by default on mobile.** Collapsed cards hide
  the toggle behind a chevron tap that users often don't realize they
  need to make. The card in this plugin starts with `useState(true)`.

- **Don't use `window.alert` or `setTimeout(() => location.reload(), 1000)`
  in plugin code.** Both break the browser's back/forward stack and
  interfere with adjacent DSH surfaces. If you need to refresh the
  plugin card after a settings save, save through the standard scope
  and let the scope's `subscribe` propagate the change.

## Useful reference paths

- DSH `web` runtime: `dsh-global/node_modules/@deepseek-ai/dsh-web/lib/`
- DSH `tool-web`: `dsh-global/node_modules/@deepseek-ai/dsh-tool-web/lib/`
- DSH shipped `web-search-deepseek`: `dsh-global/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/`
- DSH settings scope: `dsh-global/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/`
- DSH settings-plugins (the tab): `dsh-global/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-settings-plugins@*/`
- DSH app-boot (bundle loader): `dsh-global/node_modules/@deepseek-ai/dsh-app-boot/lib/`
- DSH web-app (the loader that runs `__ModuleLoader__`): `dsh-global/node_modules/@deepseek-ai/dsh-web-app/lib/`
- DSH CLI (`dsh plugin`): `dsh-global/node_modules/@deepseek-ai/dsh/lib/plugin-9h8shc4d.js`
- DSH agent-skills scripts (CDP launcher): `workspace/agent-skills/skills/chrome-devtools-mcp-pi/scripts/`
- Vision sister plugin (the LESSONS.md convention): `packages/vision/`
