import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, Register, Timer } from 'claude-code'

import type { Entry, TodayTab } from '../types'
import {
  PATH_KEY_PREFIX,
  addAgentRun,
  bookingLines,
  canonicalRemote,
  closeStale,
  dayMinutes,
  dayOf,
  errorText,
  fileUrl,
  formatDuration,
  isExpired,
  markBooked,
  parseAgentMs,
  parseBookingRange,
  parseEntry,
  parseMark,
  pauseEntry,
  pendingDays,
  reopenEntry,
  resumeEntry,
  startEntry,
  stateOf,
  stopEntry,
  timeOf,
  titleOf,
  toCsv,
  todayRows,
  workedMs,
} from './core'
import { worktreeOf } from './git'
import type { Runner } from './git'
import { orcaTaskOf } from './orca'

const COMMAND = 'timer'
const PANE = 'timer'
const MS_PER_MINUTE = 60_000
const TICK_MS = 30_000
const STALE_MS = 5 * TICK_MS
const UNBOOKED_REFRESH_MS = 10 * TICK_MS
const ENTRY_PREFIX = 'entry:'
const SEEN_PREFIX = 'seen:'
const AGENTS_PREFIX = 'agents:'
const SUMMED = 'summed'
const REMINDED_PREFIX = 'reminded:'
const DEFAULT_REMINDER = '17:30'
const DEFAULT_RETENTION_DAYS = 90
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const EXPORT_PREFIX = 'timer-export-'
const EXPORT_SUFFIX = '.csv'
const TODAY_TITLE = 'Timer'
const PANEL_CHROME_ROWS = 9
const PANEL_MAX_ROWS = 30
const ENTRIES_TOOL = 'entries'
const MARK_TOOL = 'mark_booked'
const ASK_TO_BOOK = 'ask Claude to book them'
const USAGE = 'Usage: /timer [status] | start [note] | pause | resume | stop | auto | open | export [file.csv]'

const activeId = atom({ plugin: 'timer', key: 'activeId' } as const, null)
const view = atom({ plugin: 'timer', key: 'view' } as const, null)
const band = atom({ plugin: 'timer', key: 'band' } as const, null)
const askAfterClear = atom({ plugin: 'timer', key: 'askAfterClear' } as const, null)

type Repo = { key: string; name: string; root: string }

const runnerOf =
  ($: EngineInterface): Runner =>
  (argv: readonly string[], init: ProcessRunInit) =>
    $.process.run(argv, init)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Joins an entry with its subagents' time, which lives under its own key. */
const withAgentMs = async ($: EngineInterface, entry: Entry | undefined, hasAgents: boolean): Promise<Entry | undefined> => {
  if (entry === undefined || !hasAgents) return entry
  return { ...entry, agentMs: parseAgentMs(await $.store.get(AGENTS_PREFIX + entry.id)) }
}

const loadEntry = async ($: EngineInterface, id: string): Promise<Entry | undefined> =>
  withAgentMs($, parseEntry(await $.store.get(ENTRY_PREFIX + id)), true)

const loadEntries = async ($: EngineInterface): Promise<Entry[]> => {
  const keys = await $.store.keys()
  const withAgents = new Set(keys.filter(k => k.startsWith(AGENTS_PREFIX)).map(k => k.slice(AGENTS_PREFIX.length)))
  const entries = await Promise.all(
    keys
      .filter(k => k.startsWith(ENTRY_PREFIX))
      .map(async k => withAgentMs($, parseEntry(await $.store.get(k)), withAgents.has(k.slice(ENTRY_PREFIX.length)))),
  )
  return entries.filter((e): e is Entry => e !== undefined)
}

/**
 * Gives an open entry a heartbeat key when it has none, so that the refresh
 * finds it among the open ones; one it already has is never moved back.
 */
const ensureSeen = async ($: EngineInterface, entry: Entry) => {
  if ((await $.store.get(SEEN_PREFIX + entry.id)) !== undefined) return
  await $.store.set(SEEN_PREFIX + entry.id, Math.max(entry.lastSeen ?? 0, entry.segments.at(-1)?.start ?? 0))
}

/**
 * Writes an entry, without its agent time. An open one keeps a heartbeat key,
 * which is how the refresh finds the open entries; a stopped one no longer
 * beats, so its key goes.
 */
const saveEntry = async ($: EngineInterface, entry: Entry) => {
  const { agentMs: _, ...stored } = entry
  await $.store.set(ENTRY_PREFIX + entry.id, stored)
  invalidateUnbooked()
  if (stateOf(entry) === 'stopped') await $.store.delete(SEEN_PREFIX + entry.id)
  else await ensureSeen($, entry)
}

/** The running and paused entries of every session, found by their heartbeat keys alone. */
const loadOpenEntries = async ($: EngineInterface): Promise<Entry[]> => {
  const ids = (await $.store.keys()).filter(k => k.startsWith(SEEN_PREFIX)).map(k => k.slice(SEEN_PREFIX.length))
  const entries = await Promise.all(ids.map(id => loadEntry($, id)))
  return entries.filter((e): e is Entry => e !== undefined && stateOf(e) !== 'stopped')
}

const forgetEntry = async ($: EngineInterface, id: string) => {
  invalidateUnbooked()
  await $.store.delete(ENTRY_PREFIX + id)
  await $.store.delete(SEEN_PREFIX + id)
  await $.store.delete(AGENTS_PREFIX + id)
}

/**
 * When an entry's session was last seen alive. The heartbeat lives under its
 * own key so that a tick never rewrites the entry a pause or a stop just saved.
 */
const lastSeenOf = async ($: EngineInterface, entry: Entry): Promise<Entry> => {
  const seen = await $.store.get(SEEN_PREFIX + entry.id)
  return typeof seen === 'number' ? { ...entry, lastSeen: Math.max(entry.lastSeen ?? 0, seen) } : entry
}

const loadActive = async ($: EngineInterface): Promise<Entry | undefined> => {
  const id = await read($, activeId)
  return id === null ? undefined : loadEntry($, id)
}

const repoOf = async ($: EngineInterface): Promise<Repo> => {
  const repo = await $.session.repo()
  const canonical = repo?.remote ? canonicalRemote(repo.remote) : null
  const root = repo?.root ?? (await $.session.cwd())
  const name = canonical?.split('/').at(-1) ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
  return { key: canonical ?? `${PATH_KEY_PREFIX}${root}`, name, root }
}

/** Stopped timers with a day still to book. */
const countUnbooked = (entries: readonly Entry[]): number => entries.filter(e => pendingDays(e).length > 0).length

let unbookedCount = 0
let unbookedAt: number | undefined
let unbookedVersion = 0

const invalidateUnbooked = () => {
  unbookedAt = undefined
  unbookedVersion += 1
}

/**
 * The stopped timers still to book, from a read of the whole store at most
 * every few minutes, or after this session changed one: the band's count
 * needs no fresher, and the store holds every timer of the retention. A read
 * overtaken by a change of this session is not kept.
 */
const unbookedOf = async ($: EngineInterface, now: number): Promise<number> => {
  if (unbookedAt !== undefined && now - unbookedAt < UNBOOKED_REFRESH_MS) return unbookedCount
  const version = unbookedVersion
  const count = countUnbooked(await loadEntries($))
  if (version === unbookedVersion) {
    unbookedCount = count
    unbookedAt = now
  }
  return count
}

let reminderAt = DEFAULT_REMINDER
let retentionDays = DEFAULT_RETENTION_DAYS
let countsAgents = false
let isWallClock = true

/**
 * Drops booked timers older than the retention and the reminders of days gone
 * by, and keeps a heartbeat key for exactly the open timers: one for each
 * (1.0.0 kept one only for a session's active timer), none left behind by a
 * stop or a delete that raced a refresh. The keys are listed before the
 * entries are read, so a timer started meanwhile keeps its key.
 */
const prune = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const keys = await $.store.keys()
  const open = new Set<string>()
  for (const entry of await loadEntries($)) {
    if (isExpired(entry, now, retentionDays)) await forgetEntry($, entry.id)
    else if (stateOf(entry) !== 'stopped') {
      open.add(entry.id)
      await ensureSeen($, entry)
    }
  }
  const today = dayOf(now)
  for (const key of keys) {
    if (key.startsWith(REMINDED_PREFIX) && key.slice(REMINDED_PREFIX.length) < today) await $.store.delete(key)
    if (key.startsWith(SEEN_PREFIX) && !open.has(key.slice(SEEN_PREFIX.length))) await $.store.delete(key)
  }
}

const isBookTime = (now: number) => timeOf(now) >= reminderAt

/** Reminds once a day, from the reminder time, with a fresh count: the band's may be minutes old. */
const remindOnce = async ($: EngineInterface, now: number, unbooked: number) => {
  if (unbooked === 0 || !isBookTime(now)) return
  const key = REMINDED_PREFIX + dayOf(now)
  if ((await $.store.get(key)) !== undefined) return
  const fresh = countUnbooked(await loadEntries($))
  if (fresh === 0) return
  await $.store.set(key, now)
  $.ui.toast(`${plural(fresh, 'timer', 'timers')} not booked yet: ${ASK_TO_BOOK}`)
}

const describe = (entry: Entry, now: number): string =>
  `${formatDuration(workedMs(entry, now, countsAgents))}${titleOf(entry) === entry.repoName ? '' : ` · ${titleOf(entry)}`} (${entry.repoName})`

const beat = async ($: EngineInterface) => {
  const entry = await loadActive($)
  const now = await $.clock.now()
  const unbooked = await unbookedOf($, now)
  const bookTime = isBookTime(now)
  await remindOnce($, now, unbooked)
  if (entry === undefined || stateOf(entry) === 'stopped') {
    $.ui.status(undefined)
    await update($, band, () => ({
      state: 'idle',
      worked: '',
      note: '',
      defaultTitle: '',
      unbooked,
      auto: false,
      isBookTime: bookTime,
    }))
    return
  }
  const state = stateOf(entry) === 'running' ? 'running' : 'paused'
  const worked = formatDuration(workedMs(entry, now, countsAgents))
  const auto = entry.auto === true
  await $.store.set(SEEN_PREFIX + entry.id, now)
  $.ui.status(`${state === 'running' ? '⏱' : '⏸ paused'} ${worked}${auto ? ' auto' : ''}`)
  await update($, band, () => ({
    state,
    worked,
    note: entry.note,
    defaultTitle: titleOf({ ...entry, note: '' }),
    unbooked,
    auto,
    isBookTime: bookTime,
  }))
}

const fromBand = async ($: EngineInterface, action: () => Promise<string>) => {
  const text = await action()
  await beat($)
  $.ui.toast(text.replace(/\n/g, ' · '))
}

/**
 * The band's answer after a /clear: keep the timer, now this conversation's
 * (a /clear goes on under a new session id), or stop it there.
 */
const answerAfterClear = async ($: EngineInterface, isKept: boolean): Promise<string> => {
  await update($, askAfterClear, () => null)
  if (!isKept) return transition($, stopEntry, 'stopped')
  const entry = await loadActive($)
  if (entry === undefined) return 'No timer in this session: /timer start [note].'
  await saveEntry($, { ...entry, sessionId: await $.session.id() })
  return `Timer kept: ${describe(entry, await $.clock.now())}`
}

let draftNote = ''

const rememberNote = (value: string) => {
  draftNote = value
}

const startFromBand = async ($: EngineInterface, value: string) => {
  const note = value.trim() || draftNote.trim()
  draftNote = ''
  await fromBand($, () => start($, note))
}

/** Changes an entry's note, which names it in the panel and when its time is booked. */
const setNote = async ($: EngineInterface, entryId: string, note: string): Promise<string> => {
  const entry = await loadEntry($, entryId)
  if (entry === undefined) return 'That entry is gone.'
  const trimmed = note.trim()
  await saveEntry($, { ...entry, note: trimmed })
  return `Note set: ${trimmed || `(none, named ${titleOf({ ...entry, note: '' })})`}`
}

const setActiveNote = async ($: EngineInterface, note: string) => {
  const entry = await loadActive($)
  if (entry === undefined) return
  await fromBand($, () => setNote($, entry.id, note))
}

let isClaudeWorking = false
let agentWrites: Promise<void> = Promise.resolve()

/**
 * Adds a subagent's run to the timer when it ends while the timer runs. The
 * writes go one at a time, so parallel subagents ending together all count.
 */
const creditAgentRun = ($: EngineInterface, durationMs: number): Promise<void> => {
  agentWrites = agentWrites
    .then(async () => {
      const entry = await loadActive($)
      if (entry === undefined || stateOf(entry) !== 'running') return
      const key = AGENTS_PREFIX + entry.id
      await $.store.set(key, addAgentRun(parseAgentMs(await $.store.get(key)), await $.clock.now(), durationMs))
    })
    .catch((error: unknown) => $.ui.log(`timer: subagent time not recorded: ${errorText(error)}`, { to: 'debug' }))
  return agentWrites
}

/** Runs the active auto-mode timer exactly while Claude works on a turn. */
const followClaude = async ($: EngineInterface) => {
  const entry = await loadActive($)
  if (entry?.auto !== true) return
  const now = await $.clock.now()
  const changed = isClaudeWorking ? resumeEntry(entry, now) : pauseEntry(entry, now)
  if (typeof changed === 'string') return
  await saveEntry($, changed)
  await beat($)
}

const toggleAuto = async ($: EngineInterface): Promise<string> => {
  const entry = await loadActive($)
  if (entry === undefined) return 'No timer in this session: /timer start [note].'
  const auto = entry.auto !== true
  await saveEntry($, { ...entry, auto })
  if (!auto) return 'Auto mode off: the timer stays as it is until you pause or stop it.'
  await followClaude($)
  return 'Auto mode on: the timer runs only while Claude is working.'
}

/**
 * Stops the timers of sessions that closed without ending (a closed window, a
 * crash), judged against a heartbeat of this session: waking from sleep stalls
 * every session at once and so stops nothing, and a session that has not beaten
 * yet can't tell a crash from a sleep, so it stops nothing either.
 */
const recoverStale = async ($: EngineInterface, since: number | undefined): Promise<void> => {
  if (since === undefined) return
  const staleBefore = since - STALE_MS
  const own = await read($, activeId)
  let recovered = 0
  for (const entry of await loadOpenEntries($)) {
    if (entry.id === own) continue
    const closed = closeStale(await lastSeenOf($, entry), staleBefore)
    if (closed === undefined) continue
    await saveEntry($, closed)
    recovered += 1
  }
  if (recovered > 0) $.ui.toast(`Stopped ${plural(recovered, 'timer', 'timers')} left open by a closed session`)
}

let lastTickAt: number | undefined

const tick = async ($: EngineInterface) => {
  const previous = lastTickAt
  lastTickAt = await $.clock.now()
  await recoverStale($, previous)
  await beat($)
}

const transition = async (
  $: EngineInterface,
  change: (entry: Entry, now: number) => Entry | string,
  verb: string,
): Promise<string> => {
  const entry = await loadActive($)
  if (entry === undefined) return 'No timer in this session: /timer start [note].'
  const now = await $.clock.now()
  const changed = change(entry, now)
  if (typeof changed === 'string') return changed
  await saveEntry($, changed)
  if (stateOf(changed) === 'stopped') await update($, activeId, () => null)
  return `Timer ${verb}: ${describe(changed, now)}`
}

const start = async ($: EngineInterface, note: string): Promise<string> => {
  const held = await loadActive($)
  const now = await $.clock.now()
  if (held !== undefined && stateOf(held) !== 'stopped') {
    return `A timer is already ${stateOf(held)}: ${describe(held, now)}. /timer stop first.`
  }
  await recoverStale($, lastTickAt)
  const others = (await loadOpenEntries($)).filter(e => stateOf(e) === 'running')
  const repo = await repoOf($)
  const [worktree, task] = await Promise.all([worktreeOf(runnerOf($)), orcaTaskOf(runnerOf($))])
  const entry = startEntry(
    {
      id: crypto.randomUUID(),
      sessionId: await $.session.id(),
      repoKey: repo.key,
      repoName: repo.name,
      note,
      location: worktree?.root ?? repo.root,
      branch: worktree?.branch,
      ...(task === undefined ? {} : { task }),
    },
    now,
  )
  await saveEntry($, { ...entry, lastSeen: now })
  await update($, activeId, () => entry.id)
  const overlap = others.map(o => `Also running in another session: ${describe(o, now)}`)
  return [`Timer started in ${repo.name}.`, ...overlap].join('\n')
}

const status = async ($: EngineInterface): Promise<string> => {
  const now = await $.clock.now()
  const entries = await loadEntries($)
  const active = await loadActive($)
  const today = dayOf(now)
  const todayMs = dayMinutes(entries, today, now, { withAgents: countsAgents, wallClock: isWallClock }) * MS_PER_MINUTE
  const unbooked = countUnbooked(entries)
  return [
    active === undefined ? 'No timer in this session.' : `This session: ${stateOf(active)} ${describe(active, now)}`,
    `Today, every session: ${formatDuration(todayMs)}`,
    unbooked > 0 ? `${plural(unbooked, 'stopped timer', 'stopped timers')} not booked yet: ${ASK_TO_BOOK}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const exportCsv = async ($: EngineInterface, path: string): Promise<string> => {
  const now = await $.clock.now()
  const entries = await loadEntries($)
  if (entries.length === 0) return 'Nothing tracked yet.'
  const target = path || `${EXPORT_PREFIX}${dayOf(now)}${EXPORT_SUFFIX}`
  await $.fs.write(target, toCsv(entries, now))
  const sessions = new Set(entries.map(e => e.sessionId)).size
  return `Exported ${plural(entries.length, 'entry', 'entries')} from ${plural(sessions, 'session', 'sessions')} to ${target}`
}

const openToday = async ($: EngineInterface): Promise<string> => {
  const now = await $.clock.now()
  const count = todayRows(await loadEntries($), dayOf(now), now).length
  await update($, view, () => ({ kind: 'today' as const, tab: 'session' as const, selectedId: null, confirmDeleteId: null }))
  await $.ui.open({
    id: PANE,
    title: TODAY_TITLE,
    focus: true,
    closeOnEscape: true,
    rows: Math.min(PANEL_MAX_ROWS, PANEL_CHROME_ROWS + 2 * Math.max(count, 1)),
  })
  return 'Timer panel opened.'
}

/** The band's ☰: opens the Today panel, or closes it when it is the one showing. */
const toggleToday = async ($: EngineInterface) => {
  const isShowing = (await read($, view))?.kind === 'today' && (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isShowing) await closePane($)
  else await openToday($)
}

const selectTab = ($: EngineInterface, tab: TodayTab) =>
  update($, view, current =>
    current?.kind === 'today' ? { ...current, tab, selectedId: null, confirmDeleteId: null } : current,
  )

const selectRow = ($: EngineInterface, id: string) =>
  update($, view, current =>
    current?.kind === 'today'
      ? { ...current, selectedId: current.selectedId === id ? null : id, confirmDeleteId: null }
      : current,
  )

/**
 * Deletes a timer of the day once its Delete was pressed twice. Its time is
 * gone from the export and from booking; a booking already made stays.
 */
const deleteEntry = async ($: EngineInterface, id: string) => {
  const current = await read($, view)
  if (current?.kind !== 'today') return
  if (current.confirmDeleteId !== id) {
    await update($, view, v => (v?.kind === 'today' ? { ...v, confirmDeleteId: id } : v))
    return
  }
  const entry = await loadEntry($, id)
  if ((await read($, activeId)) === id) await update($, activeId, () => null)
  await forgetEntry($, id)
  await update($, view, v => (v?.kind === 'today' ? { ...v, selectedId: null, confirmDeleteId: null } : v))
  await beat($)
  const references = Object.values(entry?.booked ?? {}).map(String)
  $.ui.toast(
    references.length === 0
      ? 'Timer deleted.'
      : `Timer deleted. It was already booked (${references.join(', ')}): remove it there too.`,
  )
}

/**
 * Makes the chosen timer this session's running one, stopping the current one
 * first. A timer whose day is already booked starts afresh with the same note
 * and place, so the new time is booked too.
 */
const continueEntry = async ($: EngineInterface, id: string): Promise<string> => {
  const entry = await loadEntry($, id)
  if (entry === undefined) return 'That timer is gone.'
  const sessionId = await $.session.id()
  const own = await read($, activeId)
  if (entry.id === own && stateOf(entry) === 'running') return 'That timer is already running here.'
  if (entry.id !== own && stateOf(entry) !== 'stopped' && entry.sessionId !== sessionId) {
    return `That timer is ${stateOf(entry)} in another session: stop it there first.`
  }
  if (own !== null && own !== entry.id) await transition($, stopEntry, 'stopped')
  const now = await $.clock.now()
  if (entry.booked?.[dayOf(now)] !== undefined) {
    const fresh = startEntry(
      { id: crypto.randomUUID(), sessionId, repoKey: entry.repoKey, repoName: entry.repoName, note: entry.note },
      now,
    )
    await saveEntry($, { ...fresh, location: entry.location, branch: entry.branch, task: entry.task, lastSeen: now })
    await update($, activeId, () => fresh.id)
    return `Started a new timer for "${titleOf(entry)}": today's time on it is already booked.`
  }
  const reopened = reopenEntry(entry, sessionId, now)
  if (typeof reopened === 'string') return reopened
  await saveEntry($, reopened)
  await update($, activeId, () => reopened.id)
  return `Continuing: ${describe(reopened, now)}`
}

const closePane = async ($: EngineInterface) => {
  await update($, view, () => null)
  await $.ui.close({ id: PANE })
}

let ticker: Timer | undefined

export const register: Register = (on, options) => {
  const configured = String(options.reminderTime ?? '')
  reminderAt = CLOCK_TIME.test(configured) ? configured : DEFAULT_REMINDER
  const retention = Number(options.retentionDays)
  retentionDays = Number.isInteger(retention) && retention > 0 ? retention : DEFAULT_RETENTION_DAYS
  countsAgents = options.agentTime === SUMMED
  isWallClock = options.parallelTime !== SUMMED

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Track work time: start, pause, resume, stop, auto, open (panel), status, export',
      argumentHint: '[status] | start [note] | pause | resume | stop | auto | open | export [file]',
      immediate: true,
    })
    await $.tool.register({
      name: ENTRIES_TOOL,
      description:
        "Lists the work time the timer tracked, to book it on a timesheet: one line per timer and day (Italian time) with whole minutes (wall-clock, or with the subagents' runs added when the person's agentTime setting is summed; agentMinutes, when present, is the subagents' share), the time it started, its title (the person's note, else the orchestrator's task, else the git branch's words, else the repo), the repo, its git remote as host/path, branch, folder, the orchestrator's task when one started it (its group, such as an Orca worktree, its title and the issue's link), state, for a day already booked the booking's reference, and overlaps: the other timers that ran at the same time that day, with the minutes shared, so the same hours are not booked twice without the person choosing to. Only closed time counts: a running or paused timer lists what it has done so far. Days already booked are left out unless includeBooked is true. Read-only.",
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'First day to list, YYYY-MM-DD' },
          to: { type: 'string', description: 'Last day to list, YYYY-MM-DD' },
          includeBooked: { type: 'boolean', description: 'Also list days already booked' },
        },
        additionalProperties: false,
      },
    })
    await $.tool.register({
      name: MARK_TOOL,
      description:
        "Records that one timer's day was booked, with the booking's reference (such as the timesheet activity's id), so the timer stops offering it. Call it once per line, only after that line's booking succeeded.",
      inputSchema: {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: 'The line’s entryId from the entries tool' },
          day: { type: 'string', description: 'The line’s day, YYYY-MM-DD' },
          reference: { type: 'string', description: 'Where the time was booked, e.g. the activity id' },
        },
        required: ['entryId', 'day', 'reference'],
        additionalProperties: false,
      },
    })
    await prune($)
    if ((await read($, activeId)) === null) {
      const sessionId = await $.session.id()
      const open = (await loadOpenEntries($))
        .filter(entry => entry.sessionId === sessionId)
        .sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0))
        .at(-1)
      if (open !== undefined) await update($, activeId, () => open.id)
    }
    lastTickAt = undefined
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      tick($).catch((error: unknown) => $.ui.log(`timer: status refresh failed: ${errorText(error)}`, { to: 'debug' }))
    })
    await beat($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__timer__entries' }, async ($, e) => {
    const range = parseBookingRange(e.input)
    if (typeof range === 'string') return { deny: range }
    await recoverStale($, lastTickAt)
    return { result: { lines: bookingLines(await loadEntries($), range, countsAgents) } }
  })

  on('tool.call', { tool: 'mcp__timer__mark_booked' }, async ($, e) => {
    const mark = parseMark(e.input)
    if (typeof mark === 'string') return { deny: mark }
    const entry = await loadEntry($, mark.entryId)
    if (entry === undefined) return { deny: `No timer ${mark.entryId}: list them with the entries tool.` }
    const marked = markBooked(entry, mark.day, mark.reference)
    if (typeof marked === 'string') return { deny: marked }
    await saveEntry($, marked)
    await beat($)
    return { result: { entryId: mark.entryId, day: mark.day, booked: mark.reference } }
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    isClaudeWorking = true
    await followClaude($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) {
      isClaudeWorking = false
      await followClaude($)
    } else {
      await creditAgentRun($, e.durationMs)
    }
    return completed
  })

  on('session.end', async ($, e, next) => {
    const entry = await loadActive($)
    if (e.reason === 'clear') {
      if (entry !== undefined && stateOf(entry) !== 'stopped') await update($, askAfterClear, () => entry.id)
      return next(e)
    }
    ticker?.cancel()
    ticker = undefined
    const stopped = entry === undefined ? undefined : stopEntry(entry, await $.clock.now())
    if (stopped !== undefined && typeof stopped !== 'string') await saveEntry($, stopped)
    await update($, activeId, () => null)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    const text = await (async () => {
      switch (verb) {
        case 'start':
          return start($, arg)
        case 'pause':
          return transition($, pauseEntry, 'paused')
        case 'resume':
          return transition($, resumeEntry, 'resumed')
        case 'stop':
          return transition($, stopEntry, 'stopped')
        case 'status':
          return status($)
        case 'export':
          return exportCsv($, arg)
        case 'auto':
          return toggleAuto($)
        case 'open':
        case 'today':
          return openToday($)
        default:
          return USAGE
      }
    })()
    await beat($)
    return { text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, band)
    if (e.props.hasSurvey || info === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const today = <Button key="today" label="☰" onPress={() => toggleToday($)} />
    const toBook = info.isBookTime && info.unbooked > 0 && (
      <Text color="yellow">
        {info.unbooked} to book: ask Claude
      </Text>
    )

    const asked = await read($, askAfterClear)
    if (info.state !== 'idle' && asked !== null && asked === (await read($, activeId))) {
      return (
        <Box key="timer-band" width={e.props.bodyColumns} justifyContent="flex-end" gap={1}>
          <Text>Conversation cleared: keep the timer running?</Text>
          <Button key="keepafterclear" label="Keep running" onPress={() => fromBand($, () => answerAfterClear($, true))} />
          <Button key="stopafterclear" label="Stop" onPress={() => fromBand($, () => answerAfterClear($, false))} />
        </Box>
      )
    }

    if (info.state === 'idle') {
      return (
        <Box key="timer-band" width={e.props.bodyColumns} justifyContent="flex-end">
          <Box flexDirection="column">
            {Input !== undefined && (
              <Input
                key="note"
                placeholder="what are you working on?"
                submitLabel="Start"
                onInput={(value: string) => rememberNote(value)}
                onSubmit={(value: string) => startFromBand($, value)}
              />
            )}
            <Box gap={1}>
              <Text dimColor>⏱ no timer</Text>
              <Button key="start" label="Start" onPress={() => startFromBand($, '')} />
              {today}
              {toBook}
            </Box>
          </Box>
        </Box>
      )
    }

    const isRunning = info.state === 'running'
    return (
      <Box key="timer-band" width={e.props.bodyColumns} justifyContent="flex-end">
        <Box flexDirection="column">
          {Input === undefined ? (
            <Text dimColor wrap="truncate-end">
              {info.note || info.defaultTitle}
            </Text>
          ) : (
            <Input
              key="note"
              label="Note"
              value={info.note}
              placeholder={info.defaultTitle}
              submitLabel="Set note"
              onSubmit={(value: string) => setActiveNote($, value)}
            />
          )}
          <Box gap={1}>
            <Text color={isRunning ? 'green' : 'yellow'}>
              {isRunning ? '⏱' : '⏸'} {info.worked}
            </Text>
            <Button
              key="auto"
              label={info.auto ? 'Auto ●' : 'Auto ○'}
              variant={info.auto ? 'primary' : 'secondary'}
              onPress={() => fromBand($, () => toggleAuto($))}
            />
            {isRunning ? (
              <Button key="pause" label="Pause" onPress={() => fromBand($, () => transition($, pauseEntry, 'paused'))} />
            ) : (
              <Button key="resume" label="Resume" onPress={() => fromBand($, () => transition($, resumeEntry, 'resumed'))} />
            )}
            <Button key="stop" label="Stop" onPress={() => fromBand($, () => transition($, stopEntry, 'stopped'))} />
            {today}
            {toBook}
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const current = await read($, view)
    if (current === null) return <Text dimColor>Nothing to show.</Text>

    await read($, band)
    const now = await $.clock.now()
    const own = await read($, activeId)
    const sessionId = await $.session.id()
    const entries = await loadEntries($)
    const allRows = todayRows(entries, dayOf(now), now, countsAgents)
    const rows = current.tab === 'all' ? allRows : allRows.filter(r => r.sessionId === sessionId)
    const shown = current.tab === 'all' ? entries : entries.filter(entry => entry.sessionId === sessionId)
    const total = dayMinutes(shown, dayOf(now), now, { withAgents: countsAgents, wallClock: isWallClock })
    const toBook = bookingLines(entries.filter(entry => stateOf(entry) === 'stopped'), {}, countsAgents)
    const selected = rows.find(r => r.id === current.selectedId && r.sessionId === sessionId)
    const mark = { running: '⏱', paused: '⏸', stopped: '■' } as const
    const tabs = (
      <Box gap={1}>
        <Button
          key="tabsession"
          label={`This session (${allRows.filter(r => r.sessionId === sessionId).length})`}
          variant={current.tab === 'session' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'session')}
        />
        <Button
          key="taball"
          label={`All (${allRows.length})`}
          variant={current.tab === 'all' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'all')}
        />
        <Button
          key="tabbook"
          label={`To book (${toBook.length})`}
          variant={current.tab === 'book' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'book')}
        />
      </Box>
    )
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => closePane($)} />
    if (current.tab === 'book') {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text bold>
            To book · {formatDuration(toBook.reduce((sum, l) => sum + l.minutes, 0) * MS_PER_MINUTE)} in{' '}
            {plural(new Set(toBook.map(l => l.day)).size, 'day', 'days')}
          </Text>
          <Text dimColor>{toBook.length === 0 ? 'Every stopped timer is booked.' : `Stopped timers not booked yet: ${ASK_TO_BOOK}.`}</Text>
          {toBook.map(l => (
            <Box key={`b${l.entryId}${l.day}`} gap={1}>
              <Text>
                {l.day} {l.start} {formatDuration(l.minutes * MS_PER_MINUTE)}  {l.title}
              </Text>
              <Text dimColor wrap="truncate-end">
                {l.folder === undefined ? l.repo : <Link href={fileUrl(l.folder)}>{l.repo}</Link>}
              </Text>
            </Box>
          ))}
          {close}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {tabs}
        <Text bold>
          Today {dayOf(now)} · {formatDuration(total * MS_PER_MINUTE)} in {plural(rows.length, 'timer', 'timers')}
        </Text>
        {rows.length === 0 && (
          <Text dimColor>{current.tab === 'all' ? 'No timer today yet.' : 'No timer in this session today: see All.'}</Text>
        )}
        {rows.length > 0 && <Text dimColor>Select a timer of this session to change its note, continue or delete it.</Text>}
        {rows.map(r => {
          const summary = `${mark[r.state]} ${r.from}–${r.to.padEnd(5)} ${formatDuration(r.minutes * MS_PER_MINUTE)}  ${r.name}`
          return (
            <Box key={`t${r.id}`} gap={1}>
              {r.sessionId === sessionId ? (
                <Button
                  key={`row${r.id}`}
                  label={summary}
                  variant={r.id === current.selectedId ? 'primary' : 'secondary'}
                  onPress={() => selectRow($, r.id)}
                />
              ) : (
                <Text dimColor>  {summary}  </Text>
              )}
              <Text dimColor wrap="truncate-end">
                {r.repo.path === undefined ? r.repo.name : <Link href={fileUrl(r.repo.path)}>{r.repo.name}</Link>}
                {r.id === own ? ' · running here' : r.sessionId === sessionId ? '' : ' · other session'}
                {r.isBooked ? ' · booked' : ''}
              </Text>
            </Box>
          )
        })}
        {selected !== undefined && (
          <Box key="selected" flexDirection="column" borderStyle="round" paddingX={1}>
            {Input !== undefined && (
              <Input
                key="selnote"
                label="Note"
                value={selected.note}
                placeholder="(no note)"
                submitLabel="Set note"
                onSubmit={(value: string) => fromBand($, () => setNote($, selected.id, value))}
              />
            )}
            <Box gap={1}>
              {!(selected.id === own && selected.state === 'running') && (
                <Button
                  key="continue"
                  label="Continue this timer"
                  variant="primary"
                  onPress={() => fromBand($, () => continueEntry($, selected.id))}
                />
              )}
              {selected.id === own && selected.state === 'running' && (
                <Button key="pausesel" label="Pause" onPress={() => fromBand($, () => transition($, pauseEntry, 'paused'))} />
              )}
              {selected.id === own && selected.state !== 'stopped' && (
                <Button key="stopsel" label="Stop" onPress={() => fromBand($, () => transition($, stopEntry, 'stopped'))} />
              )}
              <Button
                key="delete"
                label={current.confirmDeleteId === selected.id ? 'Press again to delete' : 'Delete'}
                onPress={() => deleteEntry($, selected.id)}
              />
            </Box>
          </Box>
        )}
        {close}
      </Box>
    )
  })
}
