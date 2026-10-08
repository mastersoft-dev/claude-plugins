import { describe, expect, test } from 'claude-code/testing'

import type { Entry } from '../types'
import {
  addAgentRun,
  bookingLines,
  branchLabel,
  canonicalRemote,
  closeStale,
  dayMinutes,
  dayOf,
  fileUrl,
  isExpired,
  markBooked,
  minutesByDay,
  parseBookingRange,
  parseEntry,
  parseMark,
  pauseEntry,
  pendingDays,
  resumeEntry,
  sharedMs,
  startEntry,
  stateOf,
  stopEntry,
  titleOf,
  toCsv,
  todayRows,
} from '../hooks/core'

const MINUTE = 60_000
const T0 = Date.parse('2026-10-06T07:00:00Z')

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 'e1',
  sessionId: 's1',
  repoKey: 'gitlab.sermix.com/mastersoft/acme',
  repoName: 'acme',
  note: 'fix login',
  segments: [{ start: T0, end: T0 + 63 * MINUTE }],
  stoppedAt: T0 + 63 * MINUTE,
  ...over,
})

describe('canonicalRemote', () => {
  test('lowercases the host and drops .git for https remotes', () => {
    expect(canonicalRemote('https://GitLab.Sermix.com/mastersoft/acme.git/')).toBe('gitlab.sermix.com/mastersoft/acme')
  })

  test('reads scp-style ssh remotes the same way', () => {
    expect(canonicalRemote('git@gitlab.sermix.com:mastersoft/acme.git')).toBe('gitlab.sermix.com/mastersoft/acme')
  })

  test('refuses a local path', () => {
    expect(canonicalRemote('C:/repos/acme')).toBe(null)
  })
})

describe('timer transitions', () => {
  test('start, pause, resume and stop move through the states', () => {
    const started = startEntry({ id: 'e', sessionId: 's', repoKey: 'k', repoName: 'r', note: '' }, T0)
    expect(stateOf(started)).toBe('running')
    const paused = pauseEntry(started, T0 + MINUTE) as Entry
    expect(stateOf(paused)).toBe('paused')
    const resumed = resumeEntry(paused, T0 + 2 * MINUTE) as Entry
    expect(stateOf(resumed)).toBe('running')
    const stopped = stopEntry(resumed, T0 + 3 * MINUTE) as Entry
    expect(stateOf(stopped)).toBe('stopped')
    expect(stopped.segments).toEqual([
      { start: T0, end: T0 + MINUTE },
      { start: T0 + 2 * MINUTE, end: T0 + 3 * MINUTE },
    ])
  })

  test('pausing a paused timer is refused', () => {
    const paused = pauseEntry(startEntry({ id: 'e', sessionId: 's', repoKey: 'k', repoName: 'r', note: '' }, T0), T0 + MINUTE) as Entry
    expect(typeof pauseEntry(paused, T0 + 2 * MINUTE)).toBe('string')
  })
})

describe('midnight', () => {
  const minutesOf = (e: Entry) => Object.fromEntries([...minutesByDay(e)].map(([day, { minutes }]) => [day, minutes]))

  test('a segment past midnight counts on each day it ran', () => {
    const night = entry({ segments: [{ start: Date.parse('2026-10-06T20:00:00Z'), end: Date.parse('2026-10-07T06:00:00Z') }] })
    expect(minutesOf(night)).toEqual({ '2026-10-06': 120, '2026-10-07': 480 })
  })

  test('the night the clocks go forward has a 23-hour day', () => {
    const night = entry({ segments: [{ start: Date.parse('2026-03-28T21:00:00Z'), end: Date.parse('2026-03-29T02:00:00Z') }] })
    expect(minutesOf(night)).toEqual({ '2026-03-28': 120, '2026-03-29': 180 })
  })

  test('a timer running since yesterday shows today from midnight', () => {
    const running = entry({ note: 'night job', segments: [{ start: Date.parse('2026-10-05T20:00:00Z') }], stoppedAt: undefined })
    const [row] = todayRows([running], '2026-10-06', T0)
    expect([row?.from, row?.to, row?.minutes]).toEqual(['00:00', 'now', 9 * 60])
  })
})

describe('days', () => {
  test('days are counted in Europe/Rome', () => {
    expect(dayOf(Date.parse('2026-10-05T22:30:00Z'))).toBe('2026-10-06')
  })

  test('a stopped timer has its unbooked days pending, a running one none', () => {
    expect(pendingDays(entry()).map(([day]) => day)).toEqual(['2026-10-06'])
    expect(pendingDays(entry({ booked: { '2026-10-06': '7' } }))).toEqual([])
    expect(pendingDays(entry({ segments: [{ start: T0 }], stoppedAt: undefined }))).toEqual([])
  })
})

describe('bookingLines', () => {
  test('lists whole closed minutes per entry and day, oldest first, with the repo details', () => {
    const later = entry({ id: 'e2', note: '', branch: 'feat/login-sso', location: 'C:/wt', segments: [{ start: T0 + 120 * MINUTE, end: T0 + 150 * MINUTE + 20_000 }] })
    expect(bookingLines([later, entry()], {})).toEqual([
      { entryId: 'e1', day: '2026-10-06', start: '09:00', minutes: 63, title: 'fix login', note: 'fix login', repo: 'acme', remote: 'gitlab.sermix.com/mastersoft/acme', state: 'stopped' },
      { entryId: 'e2', day: '2026-10-06', start: '11:00', minutes: 30, title: 'login sso', note: '', repo: 'acme', remote: 'gitlab.sermix.com/mastersoft/acme', branch: 'feat/login-sso', folder: 'C:/wt', state: 'stopped' },
    ])
  })

  test('counts an open timer\'s closed time only and says it is open', () => {
    const open = entry({ segments: [{ start: T0, end: T0 + 20 * MINUTE }, { start: T0 + 30 * MINUTE }], stoppedAt: undefined })
    expect(bookingLines([open], {}).map(l => [l.minutes, l.state])).toEqual([[20, 'running']])
  })

  test('leaves out booked days unless asked, and days outside the range', () => {
    const booked = entry({ booked: { '2026-10-06': 900 } })
    expect(bookingLines([booked], {})).toEqual([])
    expect(bookingLines([booked], { includeBooked: true }).map(l => l.booked)).toEqual(['900'])
    expect(bookingLines([entry()], { from: '2026-10-07' })).toEqual([])
    expect(bookingLines([entry()], { to: '2026-10-05' })).toEqual([])
  })

  test('gives no remote for a repo known only by its folder', () => {
    expect(bookingLines([entry({ repoKey: 'path:C:/repos/acme' })], {})[0]?.remote).toBe(undefined)
  })

  test('names the timers that ran at the same time, with the minutes shared', () => {
    const parallel = entry({ id: 'e2', note: 'review', segments: [{ start: T0 + 43 * MINUTE, end: T0 + 90 * MINUTE }] })
    const after = entry({ id: 'e3', note: 'docs', segments: [{ start: T0 + 90 * MINUTE, end: T0 + 100 * MINUTE }] })
    expect(bookingLines([entry(), parallel, after], {}).map(l => [l.entryId, l.overlaps])).toEqual([
      ['e1', [{ entryId: 'e2', title: 'review', minutes: 20 }]],
      ['e2', [{ entryId: 'e1', title: 'fix login', minutes: 20 }]],
      ['e3', undefined],
    ])
  })
})

describe('sharedMs', () => {
  test('adds up every stretch two lists of segments run at once', () => {
    const a = [{ start: 0, end: 10 }, { start: 20, end: 30 }]
    expect(sharedMs(a, [{ start: 5, end: 25 }])).toBe(10)
    expect(sharedMs(a, [{ start: 10, end: 20 }])).toBe(0)
  })
})

describe('markBooked', () => {
  test('records the reference for a day the timer has time on', () => {
    expect((markBooked(entry(), '2026-10-06', '900') as Entry).booked).toEqual({ '2026-10-06': '900' })
  })

  test('refuses a day the timer has no time on', () => {
    expect(markBooked(entry(), '2026-10-07', '900')).toBe('Timer e1 has no time on 2026-10-07.')
  })
})

describe('tool input', () => {
  test('a booking range takes optional days and includeBooked', () => {
    expect(parseBookingRange({})).toEqual({})
    expect(parseBookingRange({ from: '2026-10-01', to: '2026-10-06', includeBooked: true })).toEqual({
      from: '2026-10-01',
      to: '2026-10-06',
      includeBooked: true,
    })
    expect(parseBookingRange({ to: '6 Oct' })).toBe('to must be a day, YYYY-MM-DD.')
    expect(parseBookingRange('all')).toBe('The input must be an object.')
  })

  test('a mark needs an entry, a day and a reference', () => {
    expect(parseMark({ entryId: 'e1', day: '2026-10-06', reference: ' 900 ' })).toEqual({ entryId: 'e1', day: '2026-10-06', reference: '900' })
    expect(parseMark({ entryId: 'e1', day: '2026-10-06' })).toBe('reference must say where the time was booked.')
    expect(parseMark({ day: '2026-10-06', reference: '900' })).toBe('entryId must be a line’s entryId from the entries tool.')
  })
})

describe('toCsv', () => {
  test('writes one row per segment and quotes cells that need it', () => {
    const csv = toCsv([entry({ note: 'login, "SSO"', booked: { '2026-10-06': '900' } })], T0 + 90 * MINUTE)
    expect(csv).toBe(
      'entry,session,repo,note,day,start,end,minutes,state,booked\r\n' +
        'e1,s1,acme,"login, ""SSO""",2026-10-06,09:00,10:03,63,stopped,900\r\n',
    )
  })

  test('defuses notes that a spreadsheet would run as a formula', () => {
    const csv = toCsv([entry({ note: '=HYPERLINK("x")' })], T0)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
  })
})

describe('addAgentRun', () => {
  test('adds a run to its day and splits one that crossed midnight', () => {
    const midnight = Date.parse('2026-10-06T22:00:00Z')
    expect(addAgentRun({ '2026-10-06': MINUTE }, midnight + 10 * MINUTE, 30 * MINUTE)).toEqual({
      '2026-10-06': 21 * MINUTE,
      '2026-10-07': 10 * MINUTE,
    })
  })
})

describe('closeStale', () => {
  test('stops a running entry at its last heartbeat once it is stale', () => {
    const running = entry({ segments: [{ start: T0 }], stoppedAt: undefined, lastSeen: T0 + 20 * MINUTE })
    expect(closeStale(running, T0 + 30 * MINUTE)?.segments).toEqual([{ start: T0, end: T0 + 20 * MINUTE }])
    expect(closeStale(running, T0 + 10 * MINUTE)).toBe(undefined)
  })

  test('stops a paused entry at its last heartbeat once it is stale', () => {
    const paused = entry({ segments: [{ start: T0, end: T0 + 20 * MINUTE }], stoppedAt: undefined, lastSeen: T0 + 25 * MINUTE })
    expect(closeStale(paused, T0 + 30 * MINUTE)).toEqual({ ...paused, stoppedAt: T0 + 25 * MINUTE })
    expect(closeStale(paused, T0 + 24 * MINUTE)).toBe(undefined)
  })
})

describe('isExpired', () => {
  const DAY = 24 * 60 * MINUTE
  const booked = entry({ booked: { '2026-10-06': 'a1' } })

  test('lets a booked entry go once it stopped more than the retention ago', () => {
    expect(isExpired(booked, T0 + 63 * MINUTE + 91 * DAY, 90)).toBe(true)
    expect(isExpired(booked, T0 + 63 * MINUTE + 89 * DAY, 90)).toBe(false)
  })

  test('keeps time not yet booked, and open timers, however old', () => {
    expect(isExpired(entry(), T0 + 400 * DAY, 90)).toBe(false)
    expect(isExpired({ ...booked, segments: [{ start: T0 }], stoppedAt: undefined }, T0 + 400 * DAY, 90)).toBe(false)
  })
})

describe('parseEntry', () => {
  test('refuses an entry with a malformed segment', () => {
    expect(parseEntry({ ...entry(), segments: [{ start: 'x' }] })).toBe(undefined)
  })

  test('accepts an entry this version wrote', () => {
    expect(parseEntry(entry())).toEqual(entry())
  })

  test('accepts the numeric booking ids 0.1.0 wrote', () => {
    expect(parseEntry(entry({ booked: { '2026-10-06': 900 } }))?.booked).toEqual({ '2026-10-06': 900 })
  })
})

describe('branchLabel', () => {
  test('turns a work branch into words', () => {
    expect(branchLabel('feat/login-sso')).toBe('login sso')
    expect(branchLabel('123_fix_export')).toBe('123 fix export')
  })

  test('names nothing for a default branch or a detached HEAD', () => {
    for (const branch of ['main', 'master', 'develop', 'dev', 'trunk', 'HEAD', '']) {
      expect(branchLabel(branch)).toBe(undefined)
    }
  })
})

describe('titleOf', () => {
  test('prefers the note, then the branch, then the repo', () => {
    expect(titleOf(entry({ branch: 'feat/login-sso' }))).toBe('fix login')
    expect(titleOf(entry({ note: '', branch: 'feat/login-sso' }))).toBe('login sso')
    expect(titleOf(entry({ note: '', branch: 'main' }))).toBe('acme')
  })
})

describe('fileUrl', () => {
  test('links a Windows folder with the drive kept and the rest encoded', () => {
    expect(fileUrl('C:\\Users\\me\\my repo#2')).toBe('file:///C:/Users/me/my%20repo%232')
  })

  test('links a POSIX folder', () => {
    expect(fileUrl('/home/me/acme')).toBe('file:///home/me/acme')
  })
})

describe('todayRows', () => {
  test('lists the day\'s timers oldest first, with their span, minutes and repo', () => {
    const yesterday = entry({ id: 'y', segments: [{ start: T0 - 24 * 60 * MINUTE, end: T0 - 23 * 60 * MINUTE }] })
    const morning = entry({
      id: 'm',
      location: 'C:/repos/acme',
      segments: [
        { start: T0, end: T0 + 30 * MINUTE },
        { start: T0 + 60 * MINUTE, end: T0 + 90 * MINUTE },
      ],
    })
    const running = entry({ id: 'r', note: '', segments: [{ start: T0 + 120 * MINUTE }], stoppedAt: undefined })
    const rows = todayRows([running, yesterday, morning], '2026-10-06', T0 + 150 * MINUTE)
    expect(rows).toEqual([
      { id: 'm', sessionId: 's1', from: '09:00', to: '10:30', minutes: 60, state: 'stopped', note: 'fix login', name: 'fix login', repo: { name: 'acme', path: 'C:/repos/acme' }, isBooked: false },
      { id: 'r', sessionId: 's1', from: '11:00', to: 'now', minutes: 30, state: 'running', note: '', name: 'acme', repo: { name: 'acme' }, isBooked: false },
    ])
  })
})

describe('dayMinutes', () => {
  const parallel = entry({ id: 'e2', segments: [{ start: T0 + 33 * MINUTE, end: T0 + 93 * MINUTE }], agentMs: { '2026-10-06': 10 * MINUTE } })

  test("summed adds every timer's own minutes", () => {
    expect(dayMinutes([entry(), parallel], '2026-10-06', T0, { withAgents: false, wallClock: false })).toBe(123)
  })

  test('on the wall clock the time timers ran at once counts once, subagents on top when asked', () => {
    expect(dayMinutes([entry(), parallel], '2026-10-06', T0, { withAgents: false, wallClock: true })).toBe(93)
    expect(dayMinutes([entry(), parallel], '2026-10-06', T0, { withAgents: true, wallClock: true })).toBe(103)
  })
})
