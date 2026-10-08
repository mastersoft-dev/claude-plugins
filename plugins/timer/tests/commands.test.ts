import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'

const SECOND = 1_000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const dayOfT = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const T0 = Date.parse('2026-10-06T07:00:00Z')
const REMOTE = 'git@gitlab.sermix.com:mastersoft/acme-site.git'
const PANE = {
  plugin: 'timer',
  component: 'Pane',
  requestId: 'timer',
  props: {
    title: 'Timer',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const gitAnswer = (head: string | null) => ({
  exitCode: head === null ? 128 : 0,
  stdout: head ?? '',
  stderr: head === null ? 'fatal: not a git repository' : '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const orcaAnswer = (worktree: Record<string, unknown> | null) => ({
  exitCode: worktree === null ? 1 : 0,
  stdout: worktree === null ? '' : JSON.stringify({ id: 'r1', ok: true, result: { worktree } }),
  stderr: worktree === null ? 'Orca is not running' : '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const world = (on: On, stored: Record<string, unknown> = {}, head: string | null = 'C:/repos/acme-site\nmaster\n') => {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map(Object.entries(stored))
  const reads: string[] = []
  const hold = { entryReads: -1 }
  on('store.get', async ($, e) => {
    reads.push(e.key)
    const value = store.get(e.key)
    if (e.key.startsWith('entry:') && hold.entryReads >= 0 && hold.entryReads-- === 0) await clock.sleep(SECOND)
    return { value }
  })
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const files: Record<string, string> = {}
  const session = { id: 's1' }
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: 'C:/repos/acme-site' }))
  on('session.repo', () => ({ value: { root: 'C:/repos/acme-site', remote: REMOTE, internal: false, name: null } }))
  const orca = { worktree: null as Record<string, unknown> | null }
  const git = { head, email: 'caruso@mastersoft.it\n' as string | null }
  const commands: { argv: readonly string[]; cwd?: string }[] = []
  on('process.run', ($, e) => {
    commands.push({ argv: e.argv, ...(e.init?.cwd === undefined ? {} : { cwd: e.init.cwd }) })
    if (e.argv[0] === 'orca') return { value: orcaAnswer(orca.worktree) }
    if (e.argv[1] === 'config') return { value: gitAnswer(git.email) }
    if (e.argv[1] === 'log') return { value: gitAnswer('a1b2c3d\tfix: refresh the SSO token\n9f8e7d6\tfeat: add the SSO login\n') }
    return { value: gitAnswer(git.head) }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as never)
  const tools: string[] = []
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__timer__${e.name}` } } as never
  })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const panes = new Set<string>()
  on('ui.open', ($, e) => {
    panes.add(e.id)
    return { value: undefined } as never
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id })) }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('prompt.edit', ($, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  const usage = { usd: 0 }
  on('session.usage', () => ({ value: { startedAt: T0, rateLimits: [], cost: { usd: usage.usd } } }) as never)
  return { clock, files, store, toasts, panes, session, hold, tools, orca, reads, git, commands, usage }
}

const timer = async ($: Engine, args: string) => (await $.command.run({ command: 'timer', args } as never)).text ?? ''

type Line = {
  entryId: string
  day: string
  start: string
  minutes: number
  title: string
  state: string
  booked?: string
  agentMinutes?: number
}

const call = async ($: Engine, tool: 'entries' | 'mark_booked' | 'add_entry' | 'edit_entry', input: Record<string, unknown>) =>
  (await $.tool.call({ tool: `mcp__timer__${tool}`, input } as never)) as { result?: unknown; deny?: string }

const lines = async ($: Engine, input: Record<string, unknown> = {}) =>
  ((await call($, 'entries', input)).result as { lines: Line[] }).lines

const trackAndStop = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await timer($, 'start fix login')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
}

const startSession = async ($: Engine, on: On) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/repos/acme-site' } as never)
}

const entryOf = (store: Map<string, unknown>) => [...store].find(([key]) => key.startsWith('entry:'))?.[1]

test('bare /timer shows the status', async ($, on) => {
  world(on)
  expect(await timer($, '')).toContain('No timer in this session.')
})

test('the session registers the entries and mark_booked tools', async ($, on) => {
  const { tools } = world(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/repos/acme-site' } as never)
  expect(tools).toEqual(['entries', 'mark_booked', 'add_entry', 'edit_entry'])
})

test('the entries tool lists each timer and day with its minutes, start and title', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  expect(await lines($)).toEqual([
    {
      entryId: expect.any(String),
      day: '2026-10-06',
      start: '09:00',
      minutes: 63,
      title: 'fix login',
      note: 'fix login',
      repo: 'acme-site',
      remote: 'gitlab.sermix.com/mastersoft/acme-site',
      branch: 'master',
      folder: 'C:/repos/acme-site',
      state: 'stopped',
    },
  ])
})

test('with roundTo set, the entries tool rounds each line and keeps the exact minutes', { options: { roundTo: 15 } }, async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  expect((await lines($)).map(l => [l.minutes, (l as { exactMinutes?: number }).exactMinutes])).toEqual([[60, 63]])
})

test('with includeCommits, each line lists the person\'s commits in its folder while the timer ran', async ($, on) => {
  const { clock, commands } = world(on)
  await trackAndStop($, clock)
  const [line] = await lines($, { includeCommits: true })
  expect((line as { commits?: unknown }).commits).toEqual([
    { hash: 'a1b2c3d', subject: 'fix: refresh the SSO token' },
    { hash: '9f8e7d6', subject: 'feat: add the SSO login' },
  ])
  const log = commands.find(c => c.argv[1] === 'log')
  expect(log?.cwd).toBe('C:/repos/acme-site')
  expect(log?.argv).toContain(`--since=@${T0 / 1000}`)
  expect(log?.argv).toContain(`--until=@${(T0 + 63 * MINUTE) / 1000}`)
  expect(log?.argv).toContain('--author=caruso@mastersoft.it')
  expect(log?.argv).toContain('--fixed-strings')
  expect((await lines($)).map(l => (l as { commits?: unknown }).commits)).toEqual([undefined])
})

test('with no git user.email, a line\'s commits are null rather than everyone\'s', async ($, on) => {
  const { clock, git, commands } = world(on)
  git.email = null
  await trackAndStop($, clock)
  expect((await lines($, { includeCommits: true })).map(l => (l as { commits?: unknown }).commits)).toEqual([null])
  expect(commands.some(c => c.argv[1] === 'log')).toBe(false)
})

test('what the session costs while the timer runs is put on it, listed and shown in the panel', async ($, on) => {
  const { clock, usage } = world(on)
  await startSession($, on)
  await timer($, 'start fix login')
  usage.usd = 0.4
  await clock.advance(30 * SECOND)
  await timer($, 'pause')
  usage.usd = 1.4
  await clock.advance(30 * SECOND)
  await timer($, 'resume')
  usage.usd = 1.65
  await clock.advance(30 * SECOND)
  usage.usd = 1.75
  await timer($, 'stop')
  usage.usd = 2
  await clock.advance(30 * SECOND)
  expect((await lines($)).map(l => (l as { costUsd?: number }).costUsd)).toEqual([0.75])
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\$0\.75/ })).toBeDefined()
  await ui.unmount()
})

test('mark_booked takes a day out of the entries tool and the band hint', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  const [line] = await lines($)
  const marked = await call($, 'mark_booked', { entryId: line?.entryId, day: line?.day, reference: '900' })
  expect(marked.result).toEqual({ entryId: line?.entryId, day: '2026-10-06', booked: '900' })
  expect(await lines($)).toEqual([])
  expect((await lines($, { includeBooked: true })).map(l => l.booked)).toEqual(['900'])
  expect(await timer($, 'status')).not.toContain('not booked')
})

test('add_entry adds a stopped timer for time worked with no timer running, overlaps named', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  const added = (await call($, 'add_entry', { day: '2026-10-06', start: '08:00', end: '09:30', note: 'call with Beta', tags: ['meeting'] })) as {
    result?: { lines: (Line & { overlaps?: unknown[]; tags?: string[] })[] }
  }
  expect(added.result?.lines.map(l => [l.start, l.minutes, l.title, l.tags, l.overlaps?.length])).toEqual([['08:00', 90, 'call with Beta', ['meeting'], 1]])
  expect((await call($, 'add_entry', { day: '2026-10-06', start: '11:00', end: '12:00' })).deny).toContain('still to come')
})

test('edit_entry moves a timer\'s start and renames it, but keeps a booked day\'s times', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  const [line] = await lines($)
  const edited = (await call($, 'edit_entry', { entryId: line?.entryId, day: line?.day, start: '09:30', note: 'fix login SSO' })) as {
    result?: { lines: Line[] }
  }
  expect(edited.result?.lines.map(l => [l.start, l.minutes, l.title])).toEqual([['09:30', 33, 'fix login SSO']])
  await call($, 'mark_booked', { entryId: line?.entryId, day: line?.day, reference: '900' })
  expect((await call($, 'edit_entry', { entryId: line?.entryId, day: line?.day, end: '10:00' })).deny).toContain('already booked (900)')
  expect((await call($, 'edit_entry', { entryId: line?.entryId, day: line?.day, tags: ['review'] })).result).toBeDefined()
})

test('edit_entry refuses a start still to come and a day the timer has no time on', async ($, on) => {
  const { clock } = world(on)
  await timer($, 'start fix login')
  await clock.advance(10 * MINUTE)
  await timer($, 'pause')
  const [line] = await lines($)
  expect((await call($, 'edit_entry', { entryId: line?.entryId, day: '2026-10-06', start: '09:30' })).deny).toContain('already passed')
  expect((await call($, 'edit_entry', { entryId: line?.entryId, day: '2026-10-05', note: 'x' })).deny).toContain('no time on 2026-10-05')
  expect((await call($, 'edit_entry', { entryId: line?.entryId, day: '2026-10-06', note: 'fix login SSO' })).result).toBeDefined()
})

test('mark_booked refuses an unknown timer, a day with no time and a missing reference', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  const [line] = await lines($)
  expect((await call($, 'mark_booked', { entryId: 'nope', day: '2026-10-06', reference: '1' })).deny).toContain('No timer nope')
  expect((await call($, 'mark_booked', { entryId: line?.entryId, day: '2026-10-05', reference: '1' })).deny).toContain(
    'no time on 2026-10-05',
  )
  expect((await call($, 'mark_booked', { entryId: line?.entryId, day: '2026-10-06', reference: ' ' })).deny).toContain(
    'reference',
  )
})

test('the entries tool refuses a day that is not YYYY-MM-DD', async ($, on) => {
  world(on)
  expect((await call($, 'entries', { from: 'yesterday' })).deny).toContain('from must be a day')
})

test('the entries tool stops and lists a timer left running by a closed session', async ($, on) => {
  const { clock } = world(on, {
    'entry:old': {
      id: 'old',
      sessionId: 's0',
      repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
      repoName: 'acme-site',
      note: 'fix login',
      segments: [{ start: T0 - 80 * MINUTE }],
      lastSeen: T0 - 20 * MINUTE,
    },
  })
  await startSession($, on)
  await clock.advance(MINUTE)
  expect((await lines($)).map(l => [l.minutes, l.state])).toEqual([[60, 'stopped']])
})

test('a timer left running by a crashed session stops at its last heartbeat', async ($, on) => {
  const lastSeen = T0 - 20 * MINUTE
  const crashed = {
    id: 'old',
    sessionId: 's0',
    repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
    repoName: 'acme-site',
    note: '',
    segments: [{ start: T0 - 60 * MINUTE }],
    lastSeen,
  }
  const { clock, store } = world(on, { 'entry:old': crashed })
  await startSession($, on)
  await clock.advance(MINUTE)
  await timer($, 'start')
  expect((store.get('entry:old') as { stoppedAt?: number }).stoppedAt).toBe(lastSeen)
})

test("a session started right after waking from sleep leaves the other sessions' timers running", async ($, on) => {
  const asleep = {
    id: 'other',
    sessionId: 's0',
    repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
    repoName: 'acme-site',
    note: '',
    segments: [{ start: T0 - 60 * MINUTE }],
    lastSeen: T0 - 20 * MINUTE,
  }
  const { clock, store } = world(on, { 'entry:other': asleep })
  await startSession($, on)
  expect(await timer($, 'start')).toContain('Also running in another session')
  await clock.advance(20 * SECOND)
  store.set('seen:other', T0 + 20 * SECOND)
  await clock.advance(2 * MINUTE)
  expect((store.get('entry:other') as { stoppedAt?: number }).stoppedAt).toBe(undefined)
})

test('a timer left paused by a closed session stops on a later heartbeat', async ($, on) => {
  const { clock, store } = world(on)
  await startSession($, on)
  store.set('entry:old', {
    id: 'old',
    sessionId: 's0',
    repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
    repoName: 'acme-site',
    note: '',
    segments: [{ start: T0 - 60 * MINUTE, end: T0 - 5 * MINUTE }],
    lastSeen: T0,
  })
  store.set('seen:old', T0)
  await clock.advance(MINUTE)
  expect((store.get('entry:old') as { stoppedAt?: number }).stoppedAt).toBe(undefined)
  await clock.advance(5 * MINUTE)
  expect((store.get('entry:old') as { stoppedAt?: number }).stoppedAt).toBe(T0)
})

test('the 30-second refresh reads only the open timers, not every stopped one', async ($, on) => {
  const stopped = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `entry:done${i}`,
      { ...otherSession, id: `done${i}`, segments: [{ start: T0 - DAY, end: T0 - DAY + MINUTE }], stoppedAt: T0 - DAY + MINUTE },
    ]),
  )
  const { clock, reads } = world(on, stopped)
  await startSession($, on)
  await timer($, 'start fix login')
  await clock.advance(30 * SECOND)
  reads.length = 0
  await clock.advance(2 * MINUTE)
  expect(reads.filter(k => k.startsWith('entry:done'))).toEqual([])
})

test('a new session drops the agent time and cost of timers no longer kept', async ($, on) => {
  const { store } = world(on, { 'agents:gone': { '2026-10-06': MINUTE }, 'cost:gone': { '2026-10-06': 1 } })
  await startSession($, on)
  expect([...store.keys()].filter(k => k.endsWith(':gone'))).toEqual([])
})

test('a new session drops heartbeat keys no open timer owns', async ($, on) => {
  const { store } = world(on, { 'seen:gone': T0 - DAY, 'entry:other': otherSession, 'seen:other': T0 - DAY })
  await startSession($, on)
  expect([...store.keys()].filter(k => k.startsWith('seen:'))).toEqual([])
})

test('a new session takes up its own open timer that 1.0.0 left with no heartbeat key', async ($, on) => {
  world(on, { 'entry:mine': { ...otherSession, id: 'mine', sessionId: 's1', segments: [{ start: T0 - 30 * MINUTE, end: T0 - 10 * MINUTE }], stoppedAt: undefined } })
  await startSession($, on)
  expect(await timer($, 'status')).toContain('This session: paused')
})

test('a new session drops booked timers past the retention and past reminders, keeping unbooked time', async ($, on) => {
  const old = {
    repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
    repoName: 'acme-site',
    note: '',
    segments: [{ start: T0 - 40 * DAY, end: T0 - 40 * DAY + 30 * MINUTE }],
    stoppedAt: T0 - 40 * DAY + 30 * MINUTE,
  }
  const { store } = world(on, {
    'entry:booked': { ...old, id: 'booked', sessionId: 's0', booked: { [dayOfT(T0 - 40 * DAY)]: 'a1' } },
    'entry:unbooked': { ...old, id: 'unbooked', sessionId: 's0' },
    'reminded:2026-10-05': T0 - DAY,
    'reminded:2026-10-06': T0,
  })
  await startSession($, on)
  expect([...store.keys()].sort()).toEqual(['entry:booked', 'entry:unbooked', 'reminded:2026-10-06'])
})

test('a shorter retention drops booked timers sooner', { options: { retentionDays: 30 } }, async ($, on) => {
  const { store } = world(on, {
    'entry:booked': {
      id: 'booked',
      sessionId: 's0',
      repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
      repoName: 'acme-site',
      note: '',
      segments: [{ start: T0 - 40 * DAY, end: T0 - 40 * DAY + 30 * MINUTE }],
      stoppedAt: T0 - 40 * DAY + 30 * MINUTE,
      booked: { [dayOfT(T0 - 40 * DAY)]: 'a1' },
    },
  })
  await startSession($, on)
  expect([...store.keys()]).toEqual([])
})

const subagentDone = ($: Engine, agentId: string, durationMs: number) =>
  $.turn.complete({
    turnId: agentId,
    agentId,
    answer: '',
    durationMs,
    isAborted: false,
    reason: 'end_turn',
    category: null,
    explanation: null,
    text: '',
  } as never)

const trackWithSubagents = async ($: Engine, on: On, clock: { advance: (ms: number) => Promise<void> }) => {
  on('turn.complete', ($, e) => ({ text: '', turnId: e.turnId }) as never)
  await timer($, 'start fix login')
  await clock.advance(30 * MINUTE)
  await Promise.all([subagentDone($, 'a1', 20 * MINUTE), subagentDone($, 'a2', 20 * MINUTE)])
  await clock.advance(33 * MINUTE)
  await timer($, 'stop')
  await subagentDone($, 'a3', 10 * MINUTE)
}

test('subagents running while the timer runs are listed apart, out of the wall-clock minutes', async ($, on) => {
  const { clock } = world(on)
  await trackWithSubagents($, on, clock)
  expect((await lines($)).map(l => [l.minutes, l.agentMinutes])).toEqual([[63, 40]])
})

test('with agent time summed, every subagent run adds to the minutes', { options: { agentTime: 'summed' } }, async ($, on) => {
  const { clock } = world(on)
  await trackWithSubagents($, on, clock)
  expect((await lines($)).map(l => [l.minutes, l.agentMinutes])).toEqual([[103, 40]])
  expect(await timer($, 'status')).toContain('1h 43m')
})

test('ending the session stops its timer', async ($, on) => {
  const { clock, store } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await timer($, 'start')
  await clock.advance(10 * MINUTE)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  expect((entryOf(store) as { stoppedAt?: number }).stoppedAt).toBe(T0 + 10 * MINUTE)
})

test('pauses are left out of the worked time', async ($, on) => {
  const { clock } = world(on)
  await timer($, 'start fix login')
  await clock.advance(30 * MINUTE)
  await timer($, 'pause')
  await clock.advance(10 * MINUTE)
  await timer($, 'resume')
  await clock.advance(33 * MINUTE)
  expect(await timer($, 'stop')).toContain('1h 03m')
})

test('/timer tag labels the running timer, listed with its time and in the export', async ($, on) => {
  const { clock, files } = world(on)
  await timer($, 'start fix login')
  expect(await timer($, 'tag #review meeting')).toBe('Tags set: #review #meeting')
  await clock.advance(20 * MINUTE)
  await timer($, 'stop')
  expect((await lines($)).map(l => (l as { tags?: string[] }).tags)).toEqual([['review', 'meeting']])
  await timer($, 'export out.csv')
  expect(Object.entries(files).find(([path]) => path.endsWith('out.csv'))?.[1]).toContain(',stopped,,review meeting\r\n')
})

test('the panel sets a selected timer\'s tags', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const [row] = await ui.findAll({ type: 'Button', text: /fix login/ })
  await ui.press({ key: row?.key ?? '' })
  await ui.input({ key: 'seltags', text: 'support' })
  expect(await ui.find({ type: 'Button', text: /fix login #support/ })).toBeDefined()
  await ui.unmount()
})

test('export writes every entry as CSV', async ($, on) => {
  const { clock, files } = world(on)
  await timer($, 'start fix login')
  await clock.advance(20 * MINUTE)
  await timer($, 'stop')
  expect(await timer($, 'export out.csv')).toContain('1 entry from 1 session')
  const written = Object.entries(files).find(([path]) => path.endsWith('out.csv'))?.[1]
  expect(written).toContain('acme-site,fix login,2026-10-06,09:00,09:20,20,stopped,')
})

const BAND = {
  plugin: 'timer',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const clearWith = async ($: Engine, on: On, answer: 'keepafterclear' | 'stopafterclear') => {
  const { clock, store, session } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await timer($, 'start fix login')
  await clock.advance(10 * MINUTE)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  session.id = 's2'
  await timer($, 'status')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /cleared/ }))?.text).toContain('keep the timer running?')
  await clock.advance(5 * MINUTE)
  await ui.press({ key: answer })
  expect(await ui.find({ key: 'keepafterclear' })).toBe(undefined)
  await ui.unmount()
  return entryOf(store) as { sessionId: string; stoppedAt?: number }
}

test('after /clear the band asks, and Keep running carries the timer into the new conversation', async ($, on) => {
  const entry = await clearWith($, on, 'keepafterclear')
  expect(entry.stoppedAt).toBe(undefined)
  expect(entry.sessionId).toBe('s2')
})

test('after /clear the band asks, and Stop ends the timer there', async ($, on) => {
  const entry = await clearWith($, on, 'stopafterclear')
  expect(entry.stoppedAt).toBe(T0 + 15 * MINUTE)
})

test('the ☰ button opens the panel and a second press closes it', async ($, on) => {
  const { panes } = world(on)
  await timer($, 'start')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'today' })
  expect(panes.has('timer')).toBe(true)
  await ui.press({ key: 'today' })
  expect(panes.has('timer')).toBe(false)
  await ui.press({ key: 'today' })
  expect(panes.has('timer')).toBe(true)
  await ui.unmount()
})

test('the band above the prompt starts, pauses and stops the timer on every surface', async ($, on) => {
  const { clock } = world(on)
  await timer($, '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'start' })
    await clock.advance(5 * MINUTE)
    await timer($, 'status')
    expect((await ui.find({ type: 'Text', text: /0h 05m/ }))?.text).toContain('0h 05m')
    await ui.press({ key: 'pause' })
    expect(await ui.find({ key: 'resume' })).toBeDefined()
    await ui.press({ key: 'stop' })
    expect(await ui.find({ key: 'start' })).toBeDefined()
    await ui.unmount()
  }
})

test('auto mode counts only the time Claude is working', async ($, on) => {
  const { clock } = world(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: '', turnId: e.turnId }) as never)
  await timer($, 'start background job')
  expect(await timer($, 'auto')).toContain('Auto mode on')
  await clock.advance(30 * MINUTE)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10 * MINUTE)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 0, isAborted: false, reason: 'end_turn', category: null, explanation: null, text: '' } as never)
  await clock.advance(20 * MINUTE)
  expect(await timer($, 'stop')).toContain('0h 10m')
})

test('a heartbeat in flight never undoes the pause auto mode makes when a turn ends', async ($, on) => {
  const { clock, store, hold } = world(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: '', turnId: e.turnId }) as never)
  await $.session.start({ cwd: 'C:/repos/acme-site' } as never)
  await timer($, 'start background job')
  await timer($, 'auto')
  await $.turn.start({ text: 'go', turnId: 't1' })
  hold.entryReads = 0
  await clock.advance(30 * SECOND)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 0, isAborted: false, reason: 'end_turn', category: null, explanation: null, text: '' } as never)
  await clock.advance(SECOND)
  expect((entryOf(store) as { segments: { end?: number }[] }).segments.at(-1)?.end).toBe(T0 + 30 * SECOND)
})

type PromptEditCall = { edit: (e: PromptEditInput) => Promise<PromptEditResult> }

const typeKey = ($: Engine) =>
  ($.prompt as unknown as PromptEditCall).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'x' })

const awayHalfHour = async ($: Engine, on: On) => {
  const world_ = world(on)
  await startSession($, on)
  await timer($, 'start fix login')
  await world_.clock.advance(10 * MINUTE)
  await typeKey($)
  await world_.clock.advance(30 * MINUTE)
  await typeKey($)
  return world_
}

const awayQuestion = /^Away/

test('back from 30 minutes away, the band asks, and Leave out takes the time out of the timer', async ($, on) => {
  const { clock } = await awayHalfHour($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: awayQuestion }))?.text).toBe('Away 09:10–09:40 (0h 30m) while the timer ran:')
  await ui.press({ key: 'awaydiscard' })
  expect(await ui.find({ type: 'Text', text: awayQuestion })).toBe(undefined)
  await ui.unmount()
  await clock.advance(5 * MINUTE)
  expect(await timer($, 'stop')).toContain('0h 15m')
})

test('Own timer moves the away time to a stopped timer of its own', async ($, on) => {
  const { clock } = await awayHalfHour($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'awaysplit' })
  await ui.unmount()
  await clock.advance(5 * MINUTE)
  await timer($, 'stop')
  expect((await lines($)).map(l => [l.start, l.minutes, l.title])).toEqual([
    ['09:00', 15, 'fix login'],
    ['09:10', 30, 'acme-site'],
  ])
})

test('leaving out the whole time of a timer deletes it', async ($, on) => {
  const { clock } = world(on)
  await startSession($, on)
  await timer($, 'start fix login')
  await clock.advance(20 * MINUTE)
  await timer($, 'stop')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: awayQuestion }))?.text).toBe('Away 09:00–09:20 (0h 20m) while the timer ran:')
  await ui.press({ key: 'awaydiscard' })
  await ui.unmount()
  expect(await lines($, { includeBooked: true })).toEqual([])
})

test('Keep leaves the away time in the timer', async ($, on) => {
  const { clock } = await awayHalfHour($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'awaykeep' })
  await ui.unmount()
  await clock.advance(5 * MINUTE)
  expect(await timer($, 'stop')).toContain('0h 45m')
})

test('with away time discarded, coming back leaves it out at once and says so', { options: { awayTime: 'discard' } }, async ($, on) => {
  const { clock, toasts } = await awayHalfHour($, on)
  expect(toasts).toContain('Away time left out: 09:10–09:40 (0h 30m)')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: awayQuestion })).toBe(undefined)
  await ui.unmount()
  await clock.advance(5 * MINUTE)
  expect(await timer($, 'stop')).toContain('0h 15m')
})

test('with away time kept, nothing is asked and the timer counts it', { options: { awayTime: 'keep' } }, async ($, on) => {
  const { clock } = await awayHalfHour($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: awayQuestion })).toBe(undefined)
  await ui.unmount()
  await clock.advance(5 * MINUTE)
  expect(await timer($, 'stop')).toContain('0h 45m')
})

test('a session closed while the person is still away stops its timer when they left', async ($, on) => {
  const { clock, store } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await startSession($, on)
  await timer($, 'start fix login')
  await clock.advance(10 * MINUTE)
  await typeKey($)
  await clock.advance(30 * MINUTE)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  expect((entryOf(store) as { segments: { end?: number }[] }).segments).toEqual([{ start: T0, end: T0 + 10 * MINUTE }])
})

test('Claude working on a long turn is not time away', async ($, on) => {
  const { clock } = world(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: '', turnId: e.turnId }) as never)
  await startSession($, on)
  await timer($, 'start fix login')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(30 * MINUTE)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 0, isAborted: false, reason: 'end_turn', category: null, explanation: null, text: '' } as never)
  await clock.advance(10 * MINUTE)
  await typeKey($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: awayQuestion })).toBe(undefined)
  await ui.unmount()
  expect(await timer($, 'stop')).toContain('0h 40m')
})

test('with idleMinutes 0 an hour with no activity is not time away', { options: { idleMinutes: 0 } }, async ($, on) => {
  const { clock } = world(on)
  await startSession($, on)
  await timer($, 'start fix login')
  await clock.advance(60 * MINUTE)
  await typeKey($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: awayQuestion })).toBe(undefined)
  await ui.unmount()
  expect(await timer($, 'stop')).toContain('1h 00m')
})

const switchBranchMidway = async ($: Engine, on: On) => {
  const { clock, git, toasts } = world(on)
  await timer($, 'start fix login')
  await clock.advance(20 * MINUTE)
  git.head = 'C:/repos/acme-site\nfeat/login-sso\n'
  await $.prompt.submit({ text: 'go on' } as never)
  await clock.advance(10 * MINUTE)
  await timer($, 'stop')
  return toasts
}

test('with branchChange split, moving to another branch starts a timer for it', { options: { branchChange: 'split' } }, async ($, on) => {
  const toasts = await switchBranchMidway($, on)
  expect(toasts).toContain('Now on feat/login-sso: a new timer runs for it')
  expect((await lines($)).map(l => [l.minutes, l.title])).toEqual([
    [20, 'fix login'],
    [10, 'login sso'],
  ])
})

test('by default a branch change keeps counting on the same timer', async ($, on) => {
  await switchBranchMidway($, on)
  expect((await lines($)).map(l => [l.minutes, l.title])).toEqual([[30, 'fix login']])
})

test('from the reminder time the band says what to book and reminds once', async ($, on) => {
  const { clock, toasts } = world(on)
  await trackAndStop($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /to book/ })).toBe(undefined)
  await clock.advance(8 * 60 * MINUTE)
  await timer($, 'status')
  await timer($, 'status')
  expect((await ui.find({ type: 'Text', text: /to book/ }))?.text).toBe('1 to book: ask Claude')
  expect(toasts.filter(t => t.includes('not booked yet'))).toEqual(['1 timer not booked yet: ask Claude to book them'])
  await ui.unmount()
})

test('the band note box starts the timer with a note and renames it later', async ($, on) => {
  const { clock } = world(on)
  await timer($, '')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.input({ key: 'note', text: 'fix login' })
  expect(await timer($, 'status')).toContain('fix login')
  await clock.advance(MINUTE)
  await ui.input({ key: 'note', text: 'fix login and SSO' })
  expect(await timer($, 'status')).toContain('fix login and SSO')
  await ui.unmount()
})

test('the Today pane lists every timer of the day by name, its repo a link to its folder', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  await timer($, 'start')
  await clock.advance(10 * MINUTE)
  expect(await timer($, 'open')).toContain('Timer panel opened')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toContain('1h 13m in 2 timers')
  expect(await ui.find({ type: 'Button', text: /09:00–10:03 1h 03m {2}fix login/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /10:03–now {3}0h 10m {2}acme-site/ })).toBeDefined()
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => [l.children, l.props.href])).toEqual([
    [['acme-site'], 'file:///C:/repos/acme-site'],
    [['acme-site'], 'file:///C:/repos/acme-site'],
  ])
  await ui.unmount()
})

test('a timer in a worktree is named by its branch and linked to the worktree', async ($, on) => {
  const { clock, store } = world(on, {}, 'C:/repos/acme-site-login\nfeat/login-sso\n')
  await timer($, 'start')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
  expect((entryOf(store) as { location?: string }).location).toBe('C:/repos/acme-site-login')
  expect((await lines($)).map(l => l.title)).toEqual(['login sso'])
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /login sso/ })).toBeDefined()
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('file:///C:/repos/acme-site-login')
  await ui.unmount()
})

test('a timer in an Orca worktree is named by its linked issue and lists the worktree as its task', async ($, on) => {
  const { clock, orca } = world(on, {}, 'C:/repos/acme-site-login\nfeat/login-sso\n')
  orca.worktree = {
    id: 'repo1::C:/repos/acme-site-login',
    displayName: 'feat/login-sso',
    displayNameMode: 'automatic',
    linkedWorkItem: { provider: 'gitlab', type: 'issue', number: 131, title: 'SSO login', url: 'https://gitlab.sermix.com/mastersoft/acme-site/-/issues/131' },
  }
  await timer($, 'start')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
  const [line] = await lines($)
  expect(line?.title).toBe('#131 SSO login')
  expect((line as { task?: unknown }).task).toEqual({
    source: 'orca',
    group: 'repo1::C:/repos/acme-site-login',
    title: '#131 SSO login',
    url: 'https://gitlab.sermix.com/mastersoft/acme-site/-/issues/131',
  })
})

test('a timer outside git falls back to the session folder and the repo name', async ($, on) => {
  world(on, {}, null)
  await timer($, 'start')
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /acme-site/ })).toBeDefined()
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('file:///C:/repos/acme-site')
  await ui.unmount()
})

test('selecting a timer in the panel changes its note and continues it', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  await timer($, 'start review')
  await clock.advance(10 * MINUTE)
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const [first] = await ui.findAll({ type: 'Button', text: /fix login/ })
  await ui.press({ key: first?.key ?? '' })
  await ui.input({ key: 'selnote', text: 'fix login SSO' })
  await ui.press({ key: 'continue' })
  const text = await timer($, 'status')
  expect(text).toContain('This session: running')
  expect(text).toContain('fix login SSO')
  await clock.advance(5 * MINUTE)
  expect(await timer($, 'stop')).toContain('1h 08m')
  await ui.unmount()
})

const otherSession = {
  id: 'other',
  sessionId: 's0',
  repoKey: 'gitlab.sermix.com/mastersoft/acme-site',
  repoName: 'acme-site',
  note: 'call with Beta',
  segments: [{ start: T0 - 30 * MINUTE, end: T0 - 10 * MINUTE }],
  stoppedAt: T0 - 10 * MINUTE,
}

const alongside = { ...otherSession, segments: [{ start: T0, end: T0 + 30 * MINUTE }], stoppedAt: T0 + 30 * MINUTE }

test("today's total counts timers run at once in two sessions once", async ($, on) => {
  const { clock } = world(on, { 'entry:other': alongside })
  await trackAndStop($, clock)
  expect(await timer($, 'status')).toContain('Today, every session: 1h 03m')
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'taball' })
  expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toContain('1h 03m in 2 timers')
  await ui.unmount()
})

test("with parallel time summed, today's total adds every timer", { options: { parallelTime: 'summed' } }, async ($, on) => {
  const { clock } = world(on, { 'entry:other': alongside })
  await trackAndStop($, clock)
  expect(await timer($, 'status')).toContain('Today, every session: 1h 33m')
})

test('the All tab shows timers of other sessions but only this session\'s can be selected', async ($, on) => {
  const { clock } = world(on, { 'entry:other': otherSession })
  await trackAndStop($, clock)
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /call with Beta/ })).toBe(undefined)
  await ui.press({ key: 'taball' })
  expect(await ui.find({ type: 'Text', text: /call with Beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /call with Beta/ })).toBe(undefined)
  expect(await ui.find({ type: 'Button', text: /fix login/ })).toBeDefined()
  await ui.unmount()
})

test('the To book tab lists the stopped timers of every day not booked yet', async ($, on) => {
  const yesterday = { ...otherSession, id: 'y', note: 'release notes', segments: [{ start: T0 - DAY, end: T0 - DAY + 45 * MINUTE }], stoppedAt: T0 - DAY + 45 * MINUTE }
  const booked = { ...yesterday, id: 'b', note: 'call with Beta', booked: { [dayOfT(T0 - DAY)]: 'a1' } }
  const { clock } = world(on, { 'entry:y': yesterday, 'entry:b': booked })
  await trackAndStop($, clock)
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'tabbook' }))?.text).toBe('To book (2)')
  await ui.press({ key: 'tabbook' })
  expect((await ui.find({ type: 'Text', text: /^To book/ }))?.text).toContain('1h 48m in 2 days')
  expect(await ui.find({ type: 'Text', text: /2026-10-05 09:00 0h 45m {2}release notes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2026-10-06 09:00 1h 03m {2}fix login/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /call with Beta/ })).toBe(undefined)
  await ui.unmount()
})

test('a timer is deleted only on the second press of Delete', async ($, on) => {
  const { clock, store } = world(on)
  await trackAndStop($, clock)
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const [row] = await ui.findAll({ type: 'Button', text: /fix login/ })
  await ui.press({ key: row?.key ?? '' })
  await ui.press({ key: 'delete' })
  expect([...store.keys()].filter(k => k.startsWith('entry:'))).toHaveLength(1)
  await ui.press({ key: 'delete' })
  expect([...store.keys()].filter(k => k.startsWith('entry:'))).toEqual([])
  expect(await lines($)).toEqual([])
  await ui.unmount()
})
