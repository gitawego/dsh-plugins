/** Append-only JSONL audit log. Routing facts only — image bytes and full
 *  prompts are never logged (privacy stance, mirrors pi-vision). */
import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface AuditEntry {
  ts: string
  provider: string
  model: string
  image_path: string
  source_hash: string
  cached: boolean
  fallback: boolean
  fallback_model: string | undefined
  ok: boolean
  error_code: string | undefined
  latency_ms: number
  local_only: boolean
  transport?: 'subagent' | 'http'
}

/** Resolve the audit log path: custom path (with ~ expansion) or the default
 *  under the DSH home. */
export function resolveAuditPath(custom: string | undefined, home: string): string {
  if (custom === undefined || custom.trim().length === 0) return join(home, 'vision-audit.log')
  const trimmed = custom.trim()
  return trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : resolve(trimmed)
}

/** Truncate data:/base64 image paths for the log (privacy): first 64 chars + size suffix. */
export function truncateImagePathForLog(path: string): string {
  if (path.startsWith('data:')) {
    return path.slice(0, 64) + `…(${path.length} chars)`
  }
  // Raw base64 has no path separators and no known extension
  if (!path.includes('/') && !path.includes('\\') && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(path) && path.length > 120) {
    return path.slice(0, 64) + `…(${path.length} chars)`
  }
  return path
}

export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
}

/** Tail the last n entries (best-effort; malformed lines are skipped). */
export async function tailAuditLog(path: string, n: number): Promise<AuditEntry[]> {
  try {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    return lines.slice(-n).flatMap((line) => {
      try {
        const entry = JSON.parse(line) as AuditEntry
        return typeof entry.ts === 'string' ? [entry] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export async function countAuditLog(path: string): Promise<number> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.split('\n').filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

export async function clearAuditLog(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await truncate(path, 0)
}
