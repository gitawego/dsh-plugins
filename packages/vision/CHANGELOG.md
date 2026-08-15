# Changelog

All notable changes to **@gitawego/dsh-vision** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-15

### Added

- **Mid-session model-switch detection at the earliest point of a step** — the
  `VisionGate` now syncs from `system-prompt/assemble` (which fires before the
  paste hook), so the first step after a switch already routes images by the new
  model's capability instead of lagging one step behind (`agent/request` remains
  as a fallback). Both paths stay idempotent — zero mask churn on unchanged models.
- **Image-block paste routing** — `{type:"image"}` blocks on text-only primaries
  are materialized to hash-named temp files under `<DSH_HOME>/tmp/dsh-vision/` and
  flow through the same markers/hint/auto pipeline as path tokens; a raw image
  block never reaches a text-only model's request boundary. Auto mode removes the
  temp file after conversion; hint mode retains it for `describe_image`.
- **Termux native-delivery fallback** — a vision-capable primary on a host whose
  attachment store cannot write (Termux `/data/data` EACCES) is treated as
  effectively text-only: `describe_image` becomes visible and the existing
  `textOnlyPasteMode` governs (hint = on-demand http delegation, auto = automatic,
  off = markers only). Pasted images are never silently dropped as bare markers.
- **`[Image-#N]` marker resolution** — the paste hook records marker → real path
  per agent (`MarkerRegistry`); `describe_image` resolves markers the model passes
  (plain/code/bold spellings) back to the recorded path before delegating.
- **Request-boundary image→text routing for hand-built `llm/stream` calls**
  (compaction, session-title) — image blocks in history are converted to cached
  text descriptions when the target model is known text-only, so compaction of a
  session that contains native ImageBlocks from an earlier multimodal primary no
  longer fails. Loop-built agent requests are never touched (read-only contract).
- **`/vision session-status`** subcommand — reports the tracked vs logged model,
  flags a switch still pending detection, and shows `describe_image` visibility.
- Declared `@deepseek-ai/dsh-system-prompt` peer dependency (type-only import).

### Fixed

- **Hint wording distinguishes capability from delivery** — text-only models get
  "the active model can't process images"; only image-capable models on an
  undeliverable host (Termux) get "native image delivery is unavailable".
- **Termux paths with spaces/parentheses now match** — the paste path-token regex
  is non-greedy to the first image extension, so `…name (1).png` is recognized
  without swallowing prose between two paths.
- **Model-facing paths are translated on Termux** — hints, description labels, and
  the marker registry present the app-readable `<home>/storage/…` spelling rather
  than the raw `/storage/emulated/0/…` the model cannot open. Translation remains
  strictly Termux-gated.
- **Paste hook idempotency** — an already-rewritten message (hint/descriptions
  signature present) is never re-rewritten, so a second pass can't turn the
  hint's own path into another marker.

## [0.1.1] - 2026-08-14

### Fixed

- Repaired the npm packument (release pipeline fixes).
- Client UI: primary-button contrast, field overflow, design-system tokens.
- CI/CD: OIDC trusted publishing for npm, GitHub Actions gates.

## [0.1.0] - 2026-08-14

### Added

- Initial release: `describe_image` tool (single + batch), capability gate,
  paste UX (markers / hint / auto-delegate), cache/retry/fallback pipeline,
  audit log, local-only mode, auto-detect, `/vision` command, Web settings.
