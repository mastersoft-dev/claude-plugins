import type { Runner } from './geweb'

const GIT_TIMEOUT_MS = 5_000

/** The git working tree a session runs in: its own folder (a linked worktree's, not the main one) and its branch. */
export type Worktree = { root: string; branch: string }

/**
 * Asks git for the session's working tree. Undefined outside a repository, in
 * one with no commit yet, or when git is missing: the timer then keeps what
 * the session itself knows, so it works with no orchestrator and no git.
 */
export const worktreeOf = async (run: Runner): Promise<Worktree | undefined> => {
  const result = await run(['git', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], {
    timeoutMs: GIT_TIMEOUT_MS,
  }).catch(() => undefined)
  if (result === undefined || result.exitCode !== 0) return undefined
  const [root, branch] = result.stdout.split(/\r?\n/).map(line => line.trim())
  return root && branch !== undefined ? { root, branch } : undefined
}
