import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const T0 = Date.parse('2026-10-06T07:00:00Z')
const REMOTE = 'git@gitlab.sermix.com:mastersoft/acme-site.git'
const PANE = {
  plugin: 'timer',
  component: 'Pane',
  requestId: 'timer',
  props: {
    title: 'Book on GEWEB',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type Call = { argv: readonly string[]; stdin?: string }

const ok = (body: unknown) => ({
  exitCode: 0,
  stdout: JSON.stringify(body),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const geweb = (argv: readonly string[]) => {
  const path = argv[4] ?? ''
  if (path === 'api/autocomplete/hr/GitRepo/') {
    return ok({ results: [{ id: 3, text: 'gitlab.sermix.com/mastersoft/acme-site', note: '(Acme) - [ACM01] Sito' }] })
  }
  if (path === 'api/autocomplete/hr/Progetto/') return ok({ results: [{ id: 42, text: '(Acme) - [ACM01] Sito' }] })
  if (path === 'api/hr/attivita-temporale/') return ok({ id: 900 })
  return ok({})
}

const world = (
  on: On,
  answer: (argv: readonly string[]) => ReturnType<typeof ok> = geweb,
  stored: Record<string, unknown> = {},
) => {
  const clock = mock.clock(on, { now: T0 })
  const store = new Map(Object.entries(stored))
  const claims: { day?: string } = {}
  on('store.get', ($, e) => {
    const value = store.get(e.key)
    const isClaimed = claims.day !== undefined && e.key.startsWith('entry:') && typeof value === 'object'
    return { value: isClaimed ? { ...value, booked: { [claims.day ?? '']: 0 } } : value }
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
  const calls: Call[] = []
  const files: Record<string, string> = {}
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: 'C:/repos/acme-site' }))
  on('session.repo', () => ({ value: { root: 'C:/repos/acme-site', remote: REMOTE, internal: false, name: null } }))
  on('process.run', ($, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: answer(e.argv) }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as never)
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
  return { clock, calls, files, store, claims, toasts, panes }
}

const timer = async ($: Engine, args: string) => (await $.command.run({ command: 'timer', args } as never)).text ?? ''

const posts = (calls: Call[]) => calls.filter(c => c.argv[3] === 'POST').map(c => c.argv[4])

const trackAndStop = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }) => {
  await timer($, 'start fix login')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
}

test('bare /timer shows the status', async ($, on) => {
  world(on)
  expect(await timer($, '')).toContain('No timer in this session.')
})

test('pressing Confirm twice books once', async ($, on) => {
  const { clock, calls } = world(on)
  await trackAndStop($, clock)
  await timer($, 'book')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await Promise.allSettled([ui.press({ key: 'confirm' }), ui.press({ key: 'confirm' })])
  expect(posts(calls).filter(p => p === 'api/hr/attivita-temporale/')).toEqual(['api/hr/attivita-temporale/'])
  await ui.unmount()
})

test('a day another session already claimed is not booked again', async ($, on) => {
  const { clock, calls, claims } = world(on)
  await trackAndStop($, clock)
  await timer($, 'book')
  claims.day = '2026-10-06'
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'confirm' })
  expect(posts(calls)).toEqual([])
  await ui.unmount()
})

test('a failed create releases the claim so the next book retries it', async ($, on) => {
  let isDown = true
  const { clock, calls } = world(on, argv =>
    isDown && argv[3] === 'POST' ? { ...ok({}), exitCode: 1, stderr: 'error: POST returned HTTP 500' } : geweb(argv),
  )
  await trackAndStop($, clock)
  await timer($, 'book')
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await first.press({ key: 'confirm' })
  await first.unmount()
  isDown = false
  expect(await timer($, 'book')).toContain('1 slot ready')
  const second = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await second.press({ key: 'confirm' })
  expect(posts(calls).filter(p => p === 'api/hr/attivita-temporale/')).toHaveLength(2)
  expect(await timer($, 'book')).toContain('Nothing to book')
  await second.unmount()
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
  const { store } = world(on, geweb, { 'entry:old': crashed })
  await timer($, 'start')
  expect((store.get('entry:old') as { stoppedAt?: number }).stoppedAt).toBe(lastSeen)
})

test('book stops and offers a timer left running by a closed session', async ($, on) => {
  world(on, geweb, {
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
  expect(await timer($, 'book')).toContain('1 slot ready')
})

test('a timer left paused by a closed session stops on a later heartbeat', async ($, on) => {
  const { clock, store } = world(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:/repos/acme-site' } as never)
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
  const [, entry] = [...store].find(([key]) => key.startsWith('entry:')) ?? []
  expect((entry as { stoppedAt?: number }).stoppedAt).toBe(T0 + 10 * MINUTE)
})

test('start finds the customer project linked to the repo', async ($, on) => {
  world(on)
  const text = await timer($, 'start fix login')
  expect(text).toContain('GEWEB project: (Acme) - [ACM01] Sito')
})

test('an expired GEWEB token still starts the timer and says how to log in', async ($, on) => {
  world(on, () => ({ ...ok({}), exitCode: 1, stderr: 'error: GET ... returned HTTP 401' }))
  const text = await timer($, 'start')
  expect(text).toContain('Timer started')
  expect(text).toContain('! ms login')
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

test('book writes the slot on the live timesheet only after Confirm, and only once', async ($, on) => {
  const { clock, calls } = world(on)
  await timer($, 'start fix login')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
  expect(await timer($, 'book')).toContain('1 slot ready')

  const writesBefore = calls.filter(c => c.argv[3] === 'POST')
  expect(writesBefore).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'confirm' })
  const writes = calls.filter(c => c.argv[3] === 'POST')
  expect(writes.map(c => [c.argv[4], JSON.parse(c.stdin ?? '{}')])).toEqual([
    ['api/hr/attivita-temporale/', { descrizione: 'fix login', progetto: 42, data: '2026-10-06', ora: 9 }],
    ['api/hr/attivita-temporale/900/aggiungi_tempo/', { minuti: 65, data: '2026-10-06' }],
    ['api/hr/attivita-temporale/900/set_stato/', { stato: 'completata' }],
  ])
  await ui.unmount()

  expect(await timer($, 'book')).toContain('Nothing to book')
})

test('export writes every entry as CSV', async ($, on) => {
  const { clock, files } = world(on)
  await timer($, 'start fix login')
  await clock.advance(20 * MINUTE)
  await timer($, 'stop')
  expect(await timer($, 'export out.csv')).toContain('1 entry from 1 session')
  const written = Object.entries(files).find(([path]) => path.endsWith('out.csv'))?.[1]
  expect(written).toContain('acme-site,(Acme) - [ACM01] Sito,fix login,2026-10-06,09:00,09:20,20,stopped,')
})

const BAND = {
  plugin: 'timer',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

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

const unlinked = (installs: { id: number; text: string }[]) => (argv: readonly string[]) => {
  const path = argv[4] ?? ''
  if (path === 'api/autocomplete/hr/GitRepo/') return ok({ results: [] })
  if (path === 'api/autocomplete/hr/Istanza/') return ok({ results: installs })
  return geweb(argv)
}

test('a repo installed at a customer but with no project is listed to fix, not booked', async ($, on) => {
  const { clock, calls } = world(on, unlinked([{ id: 1, text: '(Mastersoft) - [PRS] Presente @ Acme Spa' }]))
  expect(await timer($, 'start')).toContain('Customer Acme Spa, no project linked')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
  expect(await timer($, 'book')).toContain('0 slots ready')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Needs a project/ }))?.text).toContain('acme-site (Acme Spa)')
  expect(posts(calls)).toEqual([])
  await ui.unmount()
})

test('a repo with no customer is never booked nor counted', async ($, on) => {
  const { clock } = world(on, unlinked([]))
  expect(await timer($, 'start')).toContain('never booked')
  await clock.advance(63 * MINUTE)
  await timer($, 'stop')
  expect(await timer($, 'status')).not.toContain('not booked')
  expect(await timer($, 'book')).toContain('Nothing to book')
})

test('Book all shows up and reminds once only from the reminder time', async ($, on) => {
  const { clock, toasts } = world(on)
  await trackAndStop($, clock)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'book' })).toBe(undefined)
  await clock.advance(8 * 60 * MINUTE)
  await timer($, 'status')
  await timer($, 'status')
  expect(await ui.find({ key: 'book' })).toBeDefined()
  expect(toasts.filter(t => t.includes('ready for GEWEB'))).toEqual(['1 entry ready for GEWEB: /timer book'])
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

test('descriptions and minutes edited in the Book pane are what GEWEB receives, skipped lines are left out', async ($, on) => {
  const { clock, calls } = world(on)
  await trackAndStop($, clock)
  await timer($, 'start second task')
  await clock.advance(20 * MINUTE)
  await timer($, 'stop')
  expect(await timer($, 'book')).toContain('2 slots ready')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'desc0', text: 'Login SSO per Acme' })
  await ui.input({ key: 'min0', text: '90' })
  await ui.press({ key: 'skip1' })
  await ui.press({ key: 'confirm' })
  const bodies = calls.filter(c => c.argv[3] === 'POST').map(c => JSON.parse(c.stdin ?? '{}'))
  expect(bodies).toEqual([
    { descrizione: 'Login SSO per Acme', progetto: 42, data: '2026-10-06', ora: 9 },
    { minuti: 90, data: '2026-10-06' },
    { stato: 'completata' },
  ])
  await ui.unmount()
  expect(await timer($, 'book')).toContain('1 slot ready')
})

test('the Today pane lists every timer of the day with its project', async ($, on) => {
  const { clock } = world(on)
  await trackAndStop($, clock)
  await timer($, 'start review')
  await clock.advance(10 * MINUTE)
  expect(await timer($, 'open')).toContain('Timer panel opened')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toContain('1h 13m in 2 timers')
  expect((await ui.findAll({ type: 'Text', text: /\(Acme\) - \[ACM01\] Sito/ })).length).toBe(2)
  expect(await ui.find({ type: 'Button', text: /10:03–now/ })).toBeDefined()
  await ui.unmount()
})

test('the Today pane names a timer with no note by its repo, never by its path', async ($, on) => {
  world(on, unlinked([{ id: 1, text: '(Mastersoft) - [PRS] Presente @ Acme Spa' }]))
  await timer($, 'start')
  await timer($, 'open')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /acme-site/ })).toBeDefined()
  const where = await ui.find({ type: 'Text', text: /no project/ })
  expect(where?.children.filter(c => typeof c === 'string').join('')).toBe('Acme Spa, no project ·  · running here')
  const link = await ui.find({ type: 'Link' })
  expect(link?.children).toEqual(['acme-site'])
  expect(link?.props.href).toBe('file:///C:/repos/acme-site')
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
  const { clock } = world(on, geweb, { 'entry:other': otherSession })
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
  expect(await timer($, 'book')).toContain('Nothing to book')
  await ui.unmount()
})
