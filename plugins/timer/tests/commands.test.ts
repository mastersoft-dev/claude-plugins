import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SECOND = 1_000
const MINUTE = 60_000
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

const world = (on: On, stored: Record<string, unknown> = {}, head: string | null = 'C:/repos/acme-site\nmaster\n') => {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map(Object.entries(stored))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  const hold = { afterKeys: -1 }
  on('store.keys', async () => {
    if (hold.afterKeys >= 0 && hold.afterKeys-- === 0) await clock.sleep(SECOND)
    return { value: [...store.keys()] }
  })
  const files: Record<string, string> = {}
  const session = { id: 's1' }
  on('session.id', () => ({ value: session.id }))
  on('session.cwd', () => ({ value: 'C:/repos/acme-site' }))
  on('session.repo', () => ({ value: { root: 'C:/repos/acme-site', remote: REMOTE, internal: false, name: null } }))
  on('process.run', () => ({ value: gitAnswer(head) }))
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
  return { clock, files, store, toasts, panes, session, hold, tools }
}

const timer = async ($: Engine, args: string) => (await $.command.run({ command: 'timer', args } as never)).text ?? ''

type Line = { entryId: string; day: string; start: string; minutes: number; title: string; state: string; booked?: string }

const call = async ($: Engine, tool: 'entries' | 'mark_booked', input: Record<string, unknown>) =>
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
  expect(tools).toEqual(['entries', 'mark_booked'])
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
  await clock.advance(MINUTE)
  expect((store.get('entry:old') as { stoppedAt?: number }).stoppedAt).toBe(undefined)
  await clock.advance(5 * MINUTE)
  expect((store.get('entry:old') as { stoppedAt?: number }).stoppedAt).toBe(T0)
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
  hold.afterKeys = 0
  await clock.advance(30 * SECOND)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 0, isAborted: false, reason: 'end_turn', category: null, explanation: null, text: '' } as never)
  await clock.advance(SECOND)
  expect((entryOf(store) as { segments: { end?: number }[] }).segments.at(-1)?.end).toBe(T0 + 30 * SECOND)
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
