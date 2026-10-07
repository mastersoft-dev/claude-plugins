import { describe, expect, test } from 'claude-code/testing'

import { parseOrcaWorktree } from '../hooks/orca'

const WORKTREE_ID = '15d6ba45-9ed6-45ef-8939-99f57959defb::C:/Users/master/source/repos/mastersoft-cli'

const answer = (worktree: Record<string, unknown>, ok = true) =>
  JSON.stringify({ id: 'r1', ok, result: { worktree: { id: WORKTREE_ID, ...worktree } } })

describe('parseOrcaWorktree', () => {
  test('a worktree with an automatic name and no issue gives only its group', () => {
    expect(parseOrcaWorktree(answer({ displayName: 'feat/skill-book-timer', displayNameMode: 'automatic', linkedWorkItem: null }))).toEqual({
      source: 'orca',
      group: WORKTREE_ID,
    })
  })

  test('a linked work item names the task, with its number and link', () => {
    const item = { provider: 'github', type: 'issue', number: 7, title: 'Fix the login', url: 'https://github.com/a/b/issues/7' }
    expect(parseOrcaWorktree(answer({ displayNameMode: 'automatic', linkedWorkItem: item }))).toEqual({
      source: 'orca',
      group: WORKTREE_ID,
      title: '#7 Fix the login',
      url: 'https://github.com/a/b/issues/7',
    })
  })

  test('a name the person gave the worktree names the task when no issue is linked', () => {
    expect(parseOrcaWorktree(answer({ displayName: ' Customer export ', displayNameMode: 'manual' }))?.title).toBe(
      'Customer export',
    )
  })

  test('a failed or malformed answer gives nothing', () => {
    expect(parseOrcaWorktree(answer({}, false))).toBe(undefined)
    expect(parseOrcaWorktree('not json')).toBe(undefined)
    expect(parseOrcaWorktree(JSON.stringify({ ok: true, result: {} }))).toBe(undefined)
  })
})
