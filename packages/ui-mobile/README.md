# @gitawego/dsh-ui-mobile

Mobile-responsive Web UI experience for **DeepSeek Harness (DSH)** that keeps
**every function of the default `dsh web`** but presents it properly on phones.
It rides the existing web build — **no recompile, no edits to the published
packages** — as a small client-only plugin.

## What it does

The default shell renders a 3-column `AppFrame` whose column widths are written
inline on every resize. On a phone that layout is broken: a 56px **sidebar
rail** and, when opened, the **details column** crowd out the chat, plugin pills
overflow, and there is no usable navigation. This plugin turns the same panels
into **mobile drawers** instead of forcing the desktop columns:

- **Single-column chat.** On viewports `<= 900px` the AppFrame grid is forced
  to `0 minmax(0, 1fr) 0`, so the chat + composer get the whole phone width.
- **Sidebar drawer.** A phone action bar (top-left hamburger) opens the *real*
  shell sidebar as a full-width drawer — **New Session, session/workspace
  list, search, and Settings all stay fully usable**. It drives the shell's own
  `layout.toggleSidebar()`; a scrim closes it.
- **Details drawer.** A ⚙ button opens the shell's details panel as a drawer
  (`layout.openDetails()` / `closeDetails()`), so session details and
  deliverables stay reachable on phone.
- **Light mobile CSS** — `overflow-x: hidden`, `text-size-adjust: 100%`,
  tap-highlight cleanup, and safe-area (`env()`)/overscroll padding.

**Desktop is untouched.** Everything is keyed on the narrow-media state and
only ever sets grid columns / DOM that belong to this plugin.

> Inspiration: the community `dsh-web-ui` plugin family
> ([zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)) uses
> the same DOM-level, `ctx.effect`-based client-plugin techniques (see
> `packages/dsh-web-ui-all`'s compat shim and the `skins/*` bundles). This
> package follows that shape.

## How it works

- Declares `dsh.bundle.patch` → a profile bundle layer.
- Ships `cordis.patch.yml` → inserts the `ui-mobile` row.
- Declares `dsh.client.platform=web` with `inject: ["layout"]` → the browser
  roster scans it, the loader waits for the shell's `layout` service, and the
  browser kernel loads `lib/client.js`.
- `apply(ctx)` injects CSS and a DOM action bar/scrim, then keeps a narrow
  viewport marker and forces the grid via `!important` inline override,
  re-applied through a reschedule-coalesced `MutationObserver` (the same
  pattern `dsh-web-ui-all` uses). On dispose everything the plugin wrote is
  removed.

Selectors target stable hooks (`data-sidebar-collapsed` /
`data-details-collapsed`, `[class*="sidebarCol"]`, the inline grid style), never
build-version-specific hashed class names, so it survives dsh updates.

## Install

From this monorepo root:

```sh
# add as a file: dependency + bundle layer
dsh plugin --profile web add file:./packages/ui-mobile
# (or a dedicated profile:)
dsh plugin --profile mobile add file:./packages/ui-mobile
```

Then boot the web surface and open it on the phone:

```sh
dsh web                      # alias of --profile web
# or, for a dedicated profile:
dsh --profile mobile
```

Open `http://127.0.0.1:3080`. On portrait/landscape phone the chat fills the
screen; the top-left hamburger opens the sidebar drawer, ⚙ opens the details
drawer, and a tap on the scrim closes them.

Remove anytime:

```sh
dsh plugin --profile web remove @gitawego/dsh-ui-mobile
```

### Dedicated mobile profile

`dsh plugin --profile mobile add ...` auto-creates `$DSH_HOME/profiles/mobile`
with only `@deepseek-ai/dsh-base` (not the web app), so add the web layer too:

```
$DSH_HOME/profiles/mobile/package.json
  "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@gitawego/dsh-ui-mobile"
  ] } }
```

Then `dsh --profile mobile`.

## Development

```
pnpm install
pnpm test        # vitest (asserts the bundle id, layout-service contract,
                 # single-column fallback, sidebar/details drawer columns)
pnpm typecheck   # tsc --noEmit
pnpm build       # emits lib/index.js + lib/client.js
```

## Tuning

- **Breakpoint / drawer width** — edit `BREAKPOINT` and `drawerColumns()` in
  `src/client/index.js` (defaults: 900px, `min(300px, 88vw)`).
- **Mobile CSS** — `responsiveCss()` in the same file.

## Known limits / upstream

A fully custom mobile shell (dedicated chat/sessions screens) is a larger
piece — see `packages/dsh-remote-web-ui` in `zhu1090093659/dsh-web-ui` for a
separate mobile-surface approach. This plugin deliberately reuses the shell's
own panels as drawers so every default feature keeps working with minimal
risk.
