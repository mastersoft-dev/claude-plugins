import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

const GIT_TIMEOUT_MS = 5_000

/** Runs a host command by argv, as `$.process.run` does. */
export type Runner = (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>

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

const COMMIT_LIMIT = 20
const SECOND_MS = 1_000

/** A commit as the entries tool lists it: its short hash and subject. */
export type Commit = { hash: string; subject: string }

/** The commits of `git log --format=%h%x09%s` output, one per line. */
export const parseCommits = (stdout: string): Commit[] =>
  stdout
    .split(/\r?\n/)
    .map(line => line.split('\t'))
    .filter(([hash, subject]) => hash && subject)
    .map(([hash = '', ...subject]) => ({ hash, subject: subject.join('\t') }))

/** The person git commits as in `folder` (its `user.email`); undefined when git has none or can't say. */
export const authorOf = async (run: Runner, folder: string): Promise<string | undefined> => {
  const result = await run(['git', 'config', 'user.email'], { cwd: folder, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
  const email = result?.exitCode === 0 ? result.stdout.trim() : ''
  return email === '' ? undefined : email
}

/**
 * The commits `author` made in `folder` between `since` and `until`, on its
 * local branches, newest first and at most twenty: what the time went into,
 * for the booking's description. Undefined when git can't say.
 */
export const commitsBetween = async (
  run: Runner,
  folder: string,
  author: string,
  { since, until }: { since: number; until: number },
): Promise<Commit[] | undefined> => {
  const result = await run(
    [
      'git',
      'log',
      '--branches',
      '--no-merges',
      '--fixed-strings',
      '--regexp-ignore-case',
      `--author=${author}`,
      `--since=@${Math.floor(since / SECOND_MS)}`,
      `--until=@${Math.ceil(until / SECOND_MS)}`,
      `--max-count=${COMMIT_LIMIT}`,
      '--format=%h%x09%s',
    ],
    { cwd: folder, timeoutMs: GIT_TIMEOUT_MS },
  ).catch(() => undefined)
  return result === undefined || result.exitCode !== 0 ? undefined : parseCommits(result.stdout)
}
