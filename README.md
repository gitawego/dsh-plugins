# dsh-vision

Capability-aware vision + paste extension for **DeepSeek Harness**, ported 1:1 from
[`@gitawego/pi-vision`](https://github.com/gitawego/pi-vision).

- `describe_image` tool (single + batch `image_paths`) — hidden on multimodal primaries
  (native pass-through), visible on text-only primaries (delegation with cache/retry/fallback).
- Paste UX: `[Image-#N]` markers, hint/auto/off modes.
- Cache, audit log, local-only mode, batch concurrency, auto-detect, `/vision` command,
  Web Settings.

See [SPEC.md](SPEC.md) for the full implementation spec (feature parity, architecture,
KV-cache requirements, milestones).
