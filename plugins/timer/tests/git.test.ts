import { describe, expect, test } from 'claude-code/testing'

import { parseCommits } from '../hooks/git'

describe('parseCommits', () => {
  test('reads one commit per line, a tab in the subject kept', () => {
    expect(parseCommits('a1b2c3d\tfix: one\r\n9f8e7d6\tfeat: two\tthree\n\n')).toEqual([
      { hash: 'a1b2c3d', subject: 'fix: one' },
      { hash: '9f8e7d6', subject: 'feat: two\tthree' },
    ])
  })
})
