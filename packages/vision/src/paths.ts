/** Termux storage-path translation for the vision plugin. Android shared
 *  storage (/storage/emulated/0/... and /sdcard/...) is only reachable by the
 *  app through Termux's ~/storage symlink tree (<home>/storage/<dir>), so
 *  image paths from the user must be translated to that spelling before
 *  filesystem access. Pure and host-aware: non-storage paths and non-Termux
 *  hosts are never touched. */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Known shared-storage top-level dirs → Termux ~/storage symlink names. */
const STORAGE_TOP_MAP: Record<string, string> = {
  DCIM: 'dcim',
  Download: 'downloads',
  Movies: 'movies',
  Music: 'music',
  Pictures: 'pictures',
  Podcasts: 'podcasts',
  Ringtones: 'ringtones',
  Alarms: 'alarms',
  Notifications: 'notifications',
  Android: 'shared/Android',
  shared: 'shared',
}

const STORAGE_PATH_RE = /^\/(?:storage\/emulated\/0|sdcard)\/([^/]+)(?:\/(.*))?$/

/** Pure translation of an Android shared-storage spelling to the Termux
 *  app-accessible path under <home>/storage/. Unknown top-level dirs fall
 *  back to shared/<Top>. Non-storage paths return unchanged. */
export function termuxStoragePath(input: string, home: string): string {
  const match = STORAGE_PATH_RE.exec(input)
  if (match === null) return input
  const top = match[1] ?? ''
  const rest = match[2] ?? ''
  const mapped = STORAGE_TOP_MAP[top] ?? `shared/${top}`
  const translated = join(home, 'storage', mapped, rest)
  return translated === input ? input : translated
}

/** Whether this process runs inside Termux (Android). Scoped STRICTLY to
 *  Termux so no other platform ever gets path translation: env markers
 *  (TERMUX_VERSION / PREFIX) or the canonical Termux home path. */
export function isTermux(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
  if (Boolean(env.TERMUX_VERSION) || Boolean(env.PREFIX)) return true
  return home === '/data/data/com.termux/files/home' || home.startsWith('/data/data/com.termux/')
}

/** Resolve one input path for this host: on Termux, prefer the translated
 *  app-accessible storage spelling when it exists, else the original. The
 *  exists probe is injectable for tests. */
export function resolveInputPath(
  input: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (!isTermux(env, home)) return input
  const translated = termuxStoragePath(input, home)
  if (translated === input) return input
  return exists(translated) ? translated : input
}

