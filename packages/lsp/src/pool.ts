/** Root-keyed handle pool with per-agent reference counts.
 *
 *  One LSP manager is created per resolved project root (an agent's workspace
 *  cwd); agents that share a root reuse the same manager, so LSP sessions are
 *  deduplicated and process count stays bounded. A root's manager is released
 *  (shutdown) only when the last agent referencing it is disposed.
 *
 *  The handler type is generic so tests can use a trivial handle.
 */
export interface RootUser {
  readonly id: unknown
}

export class RootPool<THandle> {
  readonly #create: (root: string) => THandle
  readonly #onRelease: (root: string, handle: THandle) => void
  readonly #handles = new Map<string, THandle>()
  readonly #userToRoot = new Map<string, string>()
  readonly #rootUsers = new Map<string, Set<string>>()

  constructor(create: (root: string) => THandle, onRelease: (root: string, handle: THandle) => void) {
    this.#create = create
    this.#onRelease = onRelease
  }

  private readonly userId = (user: RootUser): string => String(user.id)

  /** Acquire (or reuse) the handle for a user, associating it with `root`. */
  acquire(root: string, user: RootUser): THandle {
    const uid = this.userId(user)
    this.#userToRoot.set(uid, root)
    const users = this.#rootUsers.get(root) ?? new Set<string>()
    users.add(uid)
    this.#rootUsers.set(root, users)
    let handle = this.#handles.get(root)
    if (!handle) {
      handle = this.#create(root)
      this.#handles.set(root, handle)
    }
    return handle
  }

  /** Release a user; when it was the last on its root, release the handle. */
  release(user: RootUser): void {
    const uid = this.userId(user)
    const root = this.#userToRoot.get(uid)
    this.#userToRoot.delete(uid)
    if (root === undefined) return
    const users = this.#rootUsers.get(root)
    if (!users) return
    users.delete(uid)
    if (users.size > 0) return
    this.#rootUsers.delete(root)
    const handle = this.#handles.get(root)
    if (handle) {
      this.#handles.delete(root)
      this.#onRelease(root, handle)
    }
  }

  /** All live handles (for status aggregation). */
  get handles(): THandle[] {
    return [...this.#handles.values()]
  }

  /** Shut down every live handle and clear all bookkeeping. */
  releaseAll(dispose: (root: string, handle: THandle) => void = this.#onRelease): void {
    for (const [root, handle] of this.#handles) dispose(root, handle)
    this.#handles.clear()
    this.#userToRoot.clear()
    this.#rootUsers.clear()
  }
}
