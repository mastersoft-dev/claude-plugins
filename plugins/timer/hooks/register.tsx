import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, Register, Timer } from 'claude-code'

import type { Entry, TodayTab } from '../types'
import {
  PATH_KEY_PREFIX,
  bookingLines,
  canonicalRemote,
  closeStale,
  dayOf,
  errorText,
  fileUrl,
  formatDuration,
  markBooked,
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

const COMMAND = 'timer'
const PANE = 'timer'
const MS_PER_MINUTE = 60_000
const TICK_MS = 30_000
const STALE_MS = 5 * TICK_MS
const ENTRY_PREFIX = 'entry:'
const SEEN_PREFIX = 'seen:'
const REMINDED_PREFIX = 'reminded:'
const DEFAULT_REMINDER = '17:30'
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

const loadEntry = async ($: EngineInterface, id: string): Promise<Entry | undefined> =>
  parseEntry(await $.store.get(ENTRY_PREFIX + id))

const loadEntries = async ($: EngineInterface): Promise<Entry[]> => {
  const keys = (await $.store.keys()).filter(k => k.startsWith(ENTRY_PREFIX))
  const values = await Promise.all(keys.map(k => $.store.get(k)))
  return values.map(parseEntry).filter((e): e is Entry => e !== undefined)
}

/** Writes an entry; a stopped one no longer beats, so its heartbeat key goes. */
const saveEntry = async ($: EngineInterface, entry: Entry) => {
  await $.store.set(ENTRY_PREFIX + entry.id, entry)
  if (stateOf(entry) === 'stopped') await $.store.delete(SEEN_PREFIX + entry.id)
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

let reminderAt = DEFAULT_REMINDER

const isBookTime = (now: number) => timeOf(now) >= reminderAt

const remindOnce = async ($: EngineInterface, now: number, unbooked: number) => {
  if (unbooked === 0 || !isBookTime(now)) return
  const key = REMINDED_PREFIX + dayOf(now)
  if ((await $.store.get(key)) !== undefined) return
  await $.store.set(key, now)
  $.ui.toast(`${plural(unbooked, 'timer', 'timers')} not booked yet: ${ASK_TO_BOOK}`)
}

const describe = (entry: Entry, now: number): string =>
  `${formatDuration(workedMs(entry, now))}${titleOf(entry) === entry.repoName ? '' : ` · ${titleOf(entry)}`} (${entry.repoName})`

const beat = async ($: EngineInterface) => {
  const entry = await loadActive($)
  const now = await $.clock.now()
  const unbooked = countUnbooked(await loadEntries($))
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
  const worked = formatDuration(workedMs(entry, now))
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

const recoverStale = async ($: EngineInterface, staleBefore: number): Promise<void> => {
  const own = await read($, activeId)
  let recovered = 0
  for (const entry of await loadEntries($)) {
    if (entry.id === own || stateOf(entry) === 'stopped') continue
    const closed = closeStale(await lastSeenOf($, entry), staleBefore)
    if (closed === undefined) continue
    await saveEntry($, closed)
    recovered += 1
  }
  if (recovered > 0) $.ui.toast(`Stopped ${plural(recovered, 'timer', 'timers')} left open by a closed session`)
}

let lastTickAt = 0

/**
 * Stops the timers of sessions that closed without ending (a closed window, a
 * crash), judged against this session's previous heartbeat: waking from sleep
 * stalls every session at once and so stops nothing.
 */
const tick = async ($: EngineInterface) => {
  const previous = lastTickAt
  lastTickAt = await $.clock.now()
  await recoverStale($, previous - STALE_MS)
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
  await recoverStale($, now - STALE_MS)
  const others = (await loadEntries($)).filter(e => stateOf(e) === 'running')
  const repo = await repoOf($)
  const worktree = await worktreeOf(runnerOf($))
  const entry = startEntry(
    {
      id: crypto.randomUUID(),
      sessionId: await $.session.id(),
      repoKey: repo.key,
      repoName: repo.name,
      note,
      location: worktree?.root ?? repo.root,
      branch: worktree?.branch,
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
  const todayMs = entries
    .flatMap(e => e.segments)
    .filter(s => dayOf(s.start) === today)
    .reduce((sum, s) => sum + (s.end ?? now) - s.start, 0)
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
  await $.store.delete(ENTRY_PREFIX + id)
  await $.store.delete(SEEN_PREFIX + id)
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
    await saveEntry($, { ...fresh, location: entry.location, branch: entry.branch, lastSeen: now })
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
        "Lists the work time the timer tracked, to book it on a timesheet: one line per timer and day (Italian time) with whole minutes, the time it started, its title (the person's note, else the git branch's words, else the repo), the repo, its git remote as host/path, branch, folder, state and, for a day already booked, the booking's reference. Only closed time counts: a running or paused timer lists what it has done so far. Days already booked are left out unless includeBooked is true. Read-only.",
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
    if ((await read($, activeId)) === null) {
      const sessionId = await $.session.id()
      const open = (await loadEntries($))
        .filter(entry => entry.sessionId === sessionId && stateOf(entry) !== 'stopped')
        .sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0))
        .at(-1)
      if (open !== undefined) await update($, activeId, () => open.id)
    }
    lastTickAt = await $.clock.now()
    await recoverStale($, lastTickAt - STALE_MS)
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
    await recoverStale($, (await $.clock.now()) - STALE_MS)
    return { result: { lines: bookingLines(await loadEntries($), range) } }
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
    const allRows = todayRows(await loadEntries($), dayOf(now), now)
    const rows = current.tab === 'all' ? allRows : allRows.filter(r => r.sessionId === sessionId)
    const total = rows.reduce((sum, r) => sum + r.minutes, 0)
    const selected = rows.find(r => r.id === current.selectedId && r.sessionId === sessionId)
    const mark = { running: '⏱', paused: '⏸', stopped: '■' } as const
    return (
      <Box flexDirection="column">
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
        </Box>
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
        <Button key="close" label="Close" role="dismiss" onPress={() => closePane($)} />
      </Box>
    )
  })
}
