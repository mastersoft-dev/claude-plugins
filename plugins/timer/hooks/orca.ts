import type { Task } from '../types'
import type { Runner } from './git'

const ORCA_TIMEOUT_MS = 5_000
const SOURCE = 'orca'
const AUTOMATIC_NAME = 'automatic'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * The task an Orca worktree stands for, from `orca worktree current --json`:
 * the worktree as the group, its linked issue or work item as the title (else
 * a display name the person gave it), and the issue's link. Undefined for
 * anything else, so a changed or failed answer only loses the context.
 */
export const parseOrcaWorktree = (stdout: string): Task | undefined => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(stdout)
    } catch {
      return undefined
    }
  })()
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) return undefined
  const worktree = parsed.result.worktree
  if (!isRecord(worktree) || textOf(worktree.id) === undefined) return undefined
  const item = isRecord(worktree.linkedWorkItem) ? worktree.linkedWorkItem : undefined
  const itemTitle = textOf(item?.title)
  const issue =
    itemTitle === undefined ? undefined : typeof item?.number === 'number' ? `#${item.number} ${itemTitle}` : itemTitle
  const named = worktree.displayNameMode === AUTOMATIC_NAME ? undefined : textOf(worktree.displayName)
  const title = issue ?? named
  const url = issue === undefined ? undefined : textOf(item?.url)
  return {
    source: SOURCE,
    group: textOf(worktree.id) as string,
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
  }
}

/**
 * Asks Orca which task the session's folder belongs to. Undefined outside
 * Orca (no `orca` command, Orca not running, a folder it doesn't manage): the
 * timer then names the work from git alone.
 */
export const orcaTaskOf = async (run: Runner): Promise<Task | undefined> => {
  const result = await run(['orca', 'worktree', 'current', '--json'], { timeoutMs: ORCA_TIMEOUT_MS }).catch(
    () => undefined,
  )
  return result === undefined || result.exitCode !== 0 ? undefined : parseOrcaWorktree(result.stdout)
}
