/** Domain-level helpers for the LSP settings patch — input validation,
 *  normalization, and the schema-level rescue so the client form can
 *  submit a single flat patch. Extracted from the rc.6 bespoke HTTP
 *  route so the same logic powers both the host-side /lsp command
 *  and the rc.7 client-side settings.widget via ctx.settingsScope.bind.
 *  Not HTTP-coupled. */
import type { Context } from '@deepseek-ai/cordis'
import type { LspSettings, ResolvedLspConfig } from './config.js'
import { mergeConfig, resolveConfig } from './config.js'

export interface LspSettingsLike {
  get(): LspSettings
  update(patch: Record<string, unknown>): Promise<void>
  mutate(ops: Array<{ op: 'set'; path: string | string[]; value?: unknown } | { op: 'unset'; path: string | string[] }>): Promise<void>
}

export interface LspSettingsSnapshot {
  writable: boolean
  value: ResolvedLspConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate + apply one form submission through the settings seam. The
 *  patch carries the editable fields (timeout, binDir, progressive,
 *  servers). Empty optional strings are cleared via mutate. Validation
 *  mirrors mergeConfig / resolveConfig so a bad form is rejected before
 *  any write. */
export async function applySettingsPatch(
  ctx: { settings: { writable: boolean } },
  settings: LspSettingsLike,
  patch: unknown,
): Promise<LspSettingsSnapshot> {
  if (!isRecord(patch)) throw new TypeError('settings value must be an object')
  if (!ctx.settings.writable) throw new Error('settings provider is read-only')
  const resolved = resolveConfig(mergeConfig(patch)) // throws on invalid input

  // The settings scope's path-based mutate lets us write the whole servers
  // map in one op and skip no-op per-field updates.
  const ops: Array<{ op: 'set'; path: string | string[]; value?: unknown } | { op: 'unset'; path: string | string[] }> = []
  ops.push({ op: 'set', path: 'timeout', value: resolved.timeout })
  ops.push({ op: 'set', path: 'binDir', value: resolved.binDir })
  ops.push({ op: 'set', path: 'progressive', value: resolved.progressive })
  ops.push({ op: 'set', path: 'servers', value: patch.servers ?? {} })
  await settings.mutate(ops)
  return buildSettingsSnapshot(ctx, settings)
}

/** Read the current config for the form. */
export function buildSettingsSnapshot(
  ctx: { settings: { writable: boolean } },
  settings: LspSettingsLike,
): LspSettingsSnapshot {
  return {
    writable: ctx.settings.writable === true,
    value: settings.get() as ResolvedLspConfig,
  }
}
