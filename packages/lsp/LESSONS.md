# LESSONS.md — dsh-lsp session history, pitfalls, and environment

The project's running history, the lessons learned the hard way, and the
host-specific facts a resuming session needs. **AGENTS.md holds the
architecture and design rules; this file is the lessons recorder.**

## Session history (what was done, in order)

1. **2026-08-21 — diagnosed `dsh web` returning bare HTTP 400 on `/` after
   the host upgrade to `0.1.1-rc.1`.** Root cause chain:
   - The profile (`~/.dsh/profiles/web`) had a frozen pre-upgrade
     `node_modules` containing `@deepseek-ai/dsh-host-webserver@0.1.0-rc.7`,
     hoisted there because this package declared it as a **regular
     dependency** (nothing in `src/` imports it — dead weight).
   - The cordis loader resolves bare module names **profile-first**
     (loader `baseUrl` = profile dir), so the stale rc.7 copy shadowed the
     upgraded host's rc.1 copy for the `id: webserver` row.
   - rc.1's `dsh-web-app` mounts `frontend-static`, whose fallback calls
     `ctx.webServer.renderIndex()` — a method that only exists on the rc.1
     `WebServer`. Every index request threw; the webserver's catch-all
     handler converts any route/fallback throw into a bare `400`.
   - Static assets bypass `renderIndex` (direct file read), so
     `/assets/*.css` returned 200 while `/` 400ed — the key differential
     that isolated the fault to index rendering.

## Fixes applied

1. Removed the dead `dependencies."@deepseek-ai/dsh-host-webserver"` from
   `package.json`. It stays out of peerDependencies entirely: nothing in
   this plugin's runtime touches the webserver service.
2. Re-pinned every DSH dep to exact `0.1.1-rc.1` (caret ranges are banned:
   semver pre-release tags don't cross rc boundaries, and `^0.1.1-rc.1`
   would drift to a newer published rc than the running host).
3. Clean-reinstalled the profile tree (`rm -rf node_modules pnpm-lock.yaml
   && pnpm install`) so no stale pinned host copy can shadow future host
   upgrades.

## Tooling pitfalls

- **Profile-first module resolution**: anything pnpm hoists into
  `~/.dsh/profiles/web/node_modules/@deepseek-ai/` shadows the maintained
  host copies under `$DSH_HOME/profiles/node_modules` → `dsh-global`.
  Keep regular deps to true runtime needs (here: only `sharp` in vision);
  DSH packages belong in peerDependencies/devDependencies only.
- **`pnpm install --offline` keeps a stale lockfile** for `file:` workspace
  deps — after changing pins, drop `pnpm-lock.yaml` (and ideally
  `node_modules`) before reinstalling, or resolution is skipped silently.
- **Bare 400 with empty body from dsh web** = an exception inside a route
  or fallback handler (`webserver` catch-all), not a client error. Probe
  differential paths (`/assets/<known-asset>` vs `/`) to split "handler
  throws" from "route missing".

## Verification commands

```bash
# Which webserver copy wins from the profile dir?
cd ~/.dsh/profiles/web && node -e \
  "const{createRequire}=require('module');const r=createRequire(process.cwd()+'/probe.js');\
console.log(r.resolve('@deepseek-ai/dsh-host-webserver/package.json'))"
# Must print a dsh-global path at the current host version, never a
# .dsh/profiles/web/node_modules path.
```
