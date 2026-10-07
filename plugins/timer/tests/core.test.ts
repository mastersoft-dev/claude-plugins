import { describe, expect, test } from 'claude-code/testing'

import type { Entry, Link, Project } from '../types'
import {
  branchLabel,
  canonicalRemote,
  closeStale,
  dayOf,
  fileUrl,
  minutesByDay,
  parseEntry,
  pauseEntry,
  planBooking,
  resumeEntry,
  roundToStep,
  startEntry,
  stateOf,
  stopEntry,
  titleOf,
  toCsv,
  todayRows,
} from '../hooks/core'

const MINUTE = 60_000
const T0 = Date.parse('2026-10-06T07:00:00Z')
const PROJECT: Project = { id: 42, label: '(Acme) - [ACM01] Sito' }
const LINKED: Link = { kind: 'project', project: PROJECT }

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
  test('matches GEWEB for https remotes', () => {
    expect(canonicalRemote('https://GitLab.Sermix.com/mastersoft/acme.git/')).toBe('gitlab.sermix.com/mastersoft/acme')
  })

  test('matches GEWEB for scp-style ssh remotes', () => {
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
    const [row] = todayRows([running], '2026-10-06', T0, () => ({ where: '' }))
    expect([row?.from, row?.to, row?.minutes]).toEqual(['00:00', 'now', 9 * 60])
  })
})

describe('days and rounding', () => {
  test('days are counted in Europe/Rome', () => {
    expect(dayOf(Date.parse('2026-10-05T22:30:00Z'))).toBe('2026-10-06')
  })

  test('minutes round up to the 5-minute step', () => {
    expect([roundToStep(0.2), roundToStep(61), roundToStep(65)]).toEqual([0, 65, 65])
  })
})

describe('planBooking', () => {
  test('drafts a stopped entry rounded up, starting at its first hour in Rome', () => {
    const { drafts, needsProject } = planBooking([entry()], () => LINKED)
    expect(needsProject).toEqual([])
    expect(drafts).toEqual([
      { entryId: 'e1', day: '2026-10-06', startHour: 9, minutes: 65, project: PROJECT, descrizione: 'fix login' },
    ])
  })

  test('leaves out running entries and days already booked', () => {
    const running = entry({ id: 'e2', segments: [{ start: T0 }], stoppedAt: undefined })
    const booked = entry({ id: 'e3', booked: { '2026-10-06': 7 } })
    expect(planBooking([running, booked], () => LINKED).drafts).toEqual([])
  })

  test('asks for a project when the repo belongs to a customer without one', () => {
    const { drafts, needsProject } = planBooking([entry(), entry({ id: 'e4' })], () => ({
      kind: 'customer',
      customers: ['Acme', 'Beta'],
    }))
    expect(drafts).toEqual([])
    expect(needsProject).toEqual(['2 entries in acme (Acme, Beta): no project, run /timer project <search> there'])
  })

  test('ignores entries of repos that belong to no customer', () => {
    expect(planBooking([entry()], () => ({ kind: 'none' }))).toEqual({ drafts: [], needsProject: [], ignored: 1 })
  })
})

describe('toCsv', () => {
  test('writes one row per segment and quotes cells that need it', () => {
    const csv = toCsv([entry({ note: 'login, "SSO"' })], () => PROJECT, T0 + 90 * MINUTE)
    expect(csv).toBe(
      'entry,session,repo,project,note,day,start,end,minutes,state,activity\r\n' +
        'e1,s1,acme,(Acme) - [ACM01] Sito,"login, ""SSO""",2026-10-06,09:00,10:03,63,stopped,\r\n',
    )
  })

  test('defuses notes that a spreadsheet would run as a formula', () => {
    const csv = toCsv([entry({ note: '=HYPERLINK("x")' })], () => PROJECT, T0)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
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

describe('parseEntry', () => {
  test('refuses an entry with a malformed segment', () => {
    expect(parseEntry({ ...entry(), segments: [{ start: 'x' }] })).toBe(undefined)
  })

  test('accepts an entry this version wrote', () => {
    expect(parseEntry(entry())).toEqual(entry())
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

  test('books a timer with no note under its branch', () => {
    const { drafts } = planBooking([entry({ note: '', branch: 'feat/login-sso' })], () => LINKED)
    expect(drafts.map(d => d.descrizione)).toEqual(['login sso'])
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
  test('lists the day\'s timers oldest first, with their span, minutes and place', () => {
    const yesterday = entry({ id: 'y', segments: [{ start: T0 - 24 * 60 * MINUTE, end: T0 - 23 * 60 * MINUTE }] })
    const morning = entry({
      id: 'm',
      segments: [
        { start: T0, end: T0 + 30 * MINUTE },
        { start: T0 + 60 * MINUTE, end: T0 + 90 * MINUTE },
      ],
    })
    const running = entry({ id: 'r', note: '', segments: [{ start: T0 + 120 * MINUTE }], stoppedAt: undefined })
    const rows = todayRows([running, yesterday, morning], '2026-10-06', T0 + 150 * MINUTE, e => ({ where: `at ${e.id}` }))
    expect(rows).toEqual([
      { id: 'm', sessionId: 's1', from: '09:00', to: '10:30', minutes: 60, state: 'stopped', note: 'fix login', name: 'fix login', where: 'at m', isBooked: false },
      { id: 'r', sessionId: 's1', from: '11:00', to: 'now', minutes: 30, state: 'running', note: '', name: 'acme', where: 'at r', isBooked: false },
    ])
  })
})
