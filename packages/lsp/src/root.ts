import { access } from 'node:fs/promises'
import path from 'node:path'

// Project-root detection (ported from OpenCode's NearestRoot / StrictNearestRoot,
// via pi-lsp): walk up from the file's directory toward the project boundary,
// looking for the first directory that contains any marker file. One LSP session
// per (root, server) so monorepos get correct per-package servers.

export interface RootContext {
  /** Project boundary; the walk never goes above this directory. */
  directory: string
}

export type RootFunction = (file: string, ctx: RootContext) => Promise<string | undefined>

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function hasMarker(dir: string, markers: string[]): Promise<string | undefined> {
  for (const marker of markers) {
    if (await exists(path.join(dir, marker))) return marker
  }
  return undefined
}

function walkDirs(file: string, boundary: string): string[] {
  const dirs: string[] = []
  let current = path.dirname(file)
  const boundaryResolved = path.resolve(boundary)
  while (true) {
    dirs.push(current)
    if (path.resolve(current) === boundaryResolved) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

export function nearestRoot(
  markers: string[],
  options: { exclude?: string[] } = {},
): RootFunction {
  const exclude = options.exclude ?? []
  return async (file, ctx) => {
    const dirs = walkDirs(file, ctx.directory)

    for (const dir of dirs) {
      if (await hasMarker(dir, exclude)) return undefined
    }
    for (const dir of dirs) {
      if (await hasMarker(dir, markers)) return dir
    }
    return ctx.directory
  }
}

export function strictNearestRoot(
  markers: string[],
  options: { exclude?: string[] } = {},
): RootFunction {
  const exclude = options.exclude ?? []
  return async (file, ctx) => {
    const dirs = walkDirs(file, ctx.directory)

    for (const dir of dirs) {
      if (await hasMarker(dir, exclude)) return undefined
    }
    for (const dir of dirs) {
      if (await hasMarker(dir, markers)) return dir
    }
    return undefined
  }
}


// Project-boundary helper for the shared (root-keyed) manager pool: resolve an
// agent's workspace cwd to the nearest enclosing project root by marker-file
// detection, so agents whose cwd falls under the same project share one LSP
// manager. Uses the union of catalog root markers plus `.git` as the boundary
// markers; when nothing matches, the resolved cwd is the boundary itself.
export async function projectRootOf(
  cwd: string,
  markers: string[],
  options: { exclude?: string[] } = {},
): Promise<string> {
  const exclude = options.exclude ?? []
  let current = path.resolve(cwd)
  while (true) {
    if (await hasMarker(current, exclude)) return cwd
    const hit = await hasMarker(current, markers)
    if (hit) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}
