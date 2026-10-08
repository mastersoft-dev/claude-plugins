import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, Register, Timer } from 'claude-code'

import type { Away, BookingLine, Entry, TodayTab } from '../types'
import type { EntryEdit, NewEntry } from './core'
import {
  CLOCK,
  PATH_KEY_PREFIX,
  addAgentRun,
  awayOf,
  barOf,
  bookingLines,
  canonicalRemote,
  closeStale,
  cutRange,
  dayMinutes,
  daySpan,
  dayOf,
  errorText,
  fileUrl,
  formatDuration,
  hasTimeIn,
  instantOf,
  isExpired,
  markBooked,
  nextMidnight,
  parseByDay,
  parseBookingRange,
  parseEntry,
  parseEntryEdit,
  parseMark,
  parseNewEntry,
  parseTags,
  pauseEntry,
  pendingDays,
  recentDays,
  reopenEntry,
  reshapeDay,
  resumeEntry,
  segmentsWithin,
  startEntry,
  stateOf,
  stopEntry,
  timeOf,
  titleOf,
  toCsv,
  todayRows,
  weekOf,
  workedMs,
} from './core'
import { authorOf, commitsBetween, worktreeOf } from './git'
import type { Runner } from './git'
import { orcaTaskOf } from './orca'

const COMMAND = 'timer'
const RELAY = 'relay'
const PANE = 'timer'
const MS_PER_MINUTE = 60_000
const TICK_MS = 30_000
const STALE_MS = 5 * TICK_MS
const UNBOOKED_REFRESH_MS = 10 * TICK_MS
const ENTRY_PREFIX = 'entry:'
const SEEN_PREFIX = 'seen:'
const AGENTS_PREFIX = 'agents:'
const COST_PREFIX = 'cost:'
const SUMMED = 'summed'
const AWAY_MODES = ['ask', 'discard', 'keep'] as const
const DEFAULT_IDLE_MINUTES = 15
const SPLIT = 'split'
const DEFAULT_TARGET_HOURS = 8
const MAX_TARGET_HOURS = 24
const AUTO_STARTS = ['off', 'session', 'prompt'] as const
const MAX_ROUND_TO = 60
const REMINDED_PREFIX = 'reminded:'
const DEFAULT_REMINDER = '17:30'
const DEFAULT_RETENTION_DAYS = 90
const EXPORT_PREFIX = 'timer-export-'
const EXPORT_SUFFIX = '.csv'
const TODAY_TITLE = 'Timer'
const PANEL_CHROME_ROWS = 9
const PANEL_MAX_ROWS = 30
const ENTRIES_TOOL = 'entries'
const MARK_TOOL = 'mark_booked'
const ADD_TOOL = 'add_entry'
const EDIT_TOOL = 'edit_entry'
const ASK_TO_BOOK = 'ask Claude to book them'
const BOOK_PROMPT = 'Book my unbooked timers'
const SUMMARY_TIMEOUT_MS = 60_000
const CHIME = 'sounds/chime.wav'
const SUMMARY_CHARS = 400
const SUMMARY_REQUEST =
  'For a timesheet entry, describe the work done in this conversation in one or two plain sentences, in the language the person writes in: what was built, fixed or reviewed, and for what. No preamble, no lists, no markdown.'
const SUGGESTED_PREFIX = 'suggested:'
const USAGE = 'Usage: /timer [status] | start [note] | pause | resume | stop | auto | tag [tags] | open | export [file.csv]'

const activeId = atom({ plugin: 'timer', key: 'activeId' } as const, null)
const view = atom({ plugin: 'timer', key: 'view' } as const, null)
const band = atom({ plugin: 'timer', key: 'band' } as const, null)
const askAfterClear = atom({ plugin: 'timer', key: 'askAfterClear' } as const, null)
const awayAtom = atom({ plugin: 'timer', key: 'away' } as const, null)

type Repo = { key: string; name: string; root: string }

const runnerOf =
  ($: EngineInterface): Runner =>
  (argv: readonly string[], init: ProcessRunInit) =>
    $.process.run(argv, init)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Joins an entry with its subagents' time and its cost, which live under keys of their own. */
const withByDay = async (
  $: EngineInterface,
  entry: Entry | undefined,
  has: { agents: boolean; cost: boolean },
): Promise<Entry | undefined> => {
  if (entry === undefined) return entry
  return {
    ...entry,
    ...(has.agents ? { agentMs: parseByDay(await $.store.get(AGENTS_PREFIX + entry.id)) } : {}),
    ...(has.cost ? { costUsd: parseByDay(await $.store.get(COST_PREFIX + entry.id)) } : {}),
  }
}

const loadEntry = async ($: EngineInterface, id: string): Promise<Entry | undefined> =>
  withByDay($, parseEntry(await $.store.get(ENTRY_PREFIX + id)), { agents: true, cost: true })

const idsUnder = (keys: readonly string[], prefix: string) =>
  new Set(keys.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)))

const loadEntries = async ($: EngineInterface): Promise<Entry[]> => {
  const keys = await $.store.keys()
  const withAgents = idsUnder(keys, AGENTS_PREFIX)
  const withCost = idsUnder(keys, COST_PREFIX)
  const entries = await Promise.all(
    keys
      .filter(k => k.startsWith(ENTRY_PREFIX))
      .map(async k => {
        const id = k.slice(ENTRY_PREFIX.length)
        return withByDay($, parseEntry(await $.store.get(k)), { agents: withAgents.has(id), cost: withCost.has(id) })
      }),
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
 * Writes an entry, without its agent time and cost. An open one keeps a heartbeat key,
 * which is how the refresh finds the open entries; a stopped one no longer
 * beats, so its key goes.
 */
const saveEntry = async ($: EngineInterface, entry: Entry) => {
  const { agentMs: _agentMs, costUsd: _costUsd, ...stored } = entry
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
  await $.store.delete(COST_PREFIX + id)
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
let awayMode: (typeof AWAY_MODES)[number] = 'ask'
let idleMs = DEFAULT_IDLE_MINUTES * MS_PER_MINUTE
let splitsOnBranch = false
let roundTo = 0
let autoStartOn: (typeof AUTO_STARTS)[number] = 'off'
let graceMs = 0
let tellsClaude = true
let hasSound = false
let targetMinutes = DEFAULT_TARGET_HOURS * 60
let turnEndedAt: number | undefined

/**
 * Drops booked timers older than the retention, the reminders of days gone by
 * and the agent time and cost of timers no longer kept, and keeps a heartbeat
 * key for exactly the open timers: one for each
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
  const ids = idsUnder(keys, ENTRY_PREFIX)
  for (const key of keys) {
    for (const prefix of [AGENTS_PREFIX, COST_PREFIX]) {
      if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) await $.store.delete(key)
    }
    for (const prefix of [REMINDED_PREFIX, SUGGESTED_PREFIX]) {
      if (key.startsWith(prefix) && key.slice(prefix.length) < today) await $.store.delete(key)
    }
    if (key.startsWith(SEEN_PREFIX) && !open.has(key.slice(SEEN_PREFIX.length))) await $.store.delete(key)
  }
}

const isBookTime = (now: number) => timeOf(now) >= reminderAt

/**
 * Plays the timer's chime when the person's `sound` setting is on; where the
 * engine has no player (a Windows or Linux terminal) it plays nothing, and a
 * clip that can't play only logs it.
 */
const chime = async ($: EngineInterface) => {
  if (!hasSound) return
  await $.audio
    .play({ asset: CHIME })
    .catch((error: unknown) => $.ui.log(`timer: chime not played: ${errorText(error)}`, { to: 'debug' }))
}

/** Reminds once a day, from the reminder time, with a fresh count: the band's may be minutes old. */
const remindOnce = async ($: EngineInterface, now: number, unbooked: number) => {
  if (unbooked === 0 || !isBookTime(now)) return
  const key = REMINDED_PREFIX + dayOf(now)
  if ((await $.store.get(key)) !== undefined) return
  const fresh = countUnbooked(await loadEntries($))
  if (fresh === 0) return
  await $.store.set(key, now)
  $.ui.toast(`${plural(fresh, 'timer', 'timers')} not booked yet: ${ASK_TO_BOOK}`)
  await chime($)
}

/**
 * From the reminder time, offers the prompt that books the timers in the
 * empty prompt box, for Tab to take; tried again on each refresh until the
 * box could show it (it can't while it holds text or a turn runs), then not
 * again that day.
 */
const suggestBooking = async ($: EngineInterface, now: number, unbooked: number) => {
  if (unbooked === 0 || !isBookTime(now)) return
  const key = SUGGESTED_PREFIX + dayOf(now)
  if ((await $.store.get(key)) !== undefined) return
  const shown = await $.prompt.suggest({ text: BOOK_PROMPT }).catch((error: unknown) => {
    $.ui.log(`timer: booking prompt not offered: ${errorText(error)}`, { to: 'debug' })
    return { isShown: false }
  })
  if (shown.isShown) await $.store.set(key, now)
}

const describe = (entry: Entry, now: number): string =>
  `${formatDuration(workedMs(entry, now, countsAgents))}${titleOf(entry) === entry.repoName ? '' : ` · ${titleOf(entry)}`} (${entry.repoName})`

let lastCostUsd: number | undefined
let costWrites: Promise<void> = Promise.resolve()

/**
 * Puts what the session cost since the last mark on the timer running now, by
 * day: called on every refresh and before every start, pause and stop, so the
 * cost lands on the timer that ran through it. A cost that went down (a /clear
 * starts it over) only sets the mark again. One at a time, so no increase is
 * counted twice.
 */
const creditCost = ($: EngineInterface): Promise<void> => {
  costWrites = costWrites
    .then(async () => {
      const usd = (await $.session.usage()).cost?.usd
      const previous = lastCostUsd
      lastCostUsd = usd
      if (usd === undefined || previous === undefined || usd <= previous) return
      const entry = await loadActive($)
      if (entry === undefined || stateOf(entry) !== 'running') return
      const key = COST_PREFIX + entry.id
      const byDay = parseByDay(await $.store.get(key))
      const day = dayOf(await $.clock.now())
      await $.store.set(key, { ...byDay, [day]: (byDay[day] ?? 0) + usd - previous })
    })
    .catch((error: unknown) => $.ui.log(`timer: cost not recorded: ${errorText(error)}`, { to: 'debug' }))
  return costWrites
}

const beat = async ($: EngineInterface) => {
  const entry = await loadActive($)
  const now = await $.clock.now()
  await creditCost($)
  const unbooked = await unbookedOf($, now)
  const bookTime = isBookTime(now)
  await remindOnce($, now, unbooked)
  await suggestBooking($, now, unbooked)
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
  await noteActivity($)
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

/**
 * One line on the timer for Claude, beside each prompt the person sends: how
 * long the session's timer has run and on what, and how many timers wait to
 * be booked. From the band's values, so it reads nothing more; undefined when
 * there is nothing to say. Beside the prompt, not in the system prompt, so
 * the prompt cache keeps the conversation before it.
 */
const timerContext = async ($: EngineInterface): Promise<string | undefined> => {
  const info = await read($, band)
  if (info === null) return undefined
  const title = info.note || info.defaultTitle
  const parts = [
    info.state === 'idle'
      ? ''
      : `The work timer of this session is ${info.state} at ${info.worked}${title === '' ? '' : ` on "${title}"`}${info.auto ? ', in auto mode' : ''}.`,
    info.unbooked > 0
      ? `${plural(info.unbooked, 'stopped timer waits', 'stopped timers wait')} to be booked (the mcp__timer__entries tool lists them).`
      : '',
  ].filter(Boolean)
  return parts.length === 0 ? undefined : `[timer plugin] ${parts.join(' ')}`
}

/**
 * After a /clear that the relay plugin ran to continue the work in a fresh
 * conversation, keeps the timer running there with no question: the open
 * timer becomes the new conversation's, as Keep running would make it.
 */
const carryOverRelay = async ($: EngineInterface) => {
  const asked = await read($, askAfterClear)
  await update($, askAfterClear, () => null)
  const entry = asked === null ? undefined : await loadEntry($, asked)
  if (entry === undefined || stateOf(entry) === 'stopped') return
  await saveEntry($, { ...entry, sessionId: await $.session.id() })
  await beat($)
  $.ui.toast(`Timer carried over to the relayed conversation: ${describe(entry, await $.clock.now())}`)
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

/** Replaces an entry's tags with the ones typed; none clears them. */
const setTags = async ($: EngineInterface, entryId: string, text: string): Promise<string> => {
  const entry = await loadEntry($, entryId)
  if (entry === undefined) return 'That entry is gone.'
  const tags = parseTags(text)
  await saveEntry($, { ...entry, tags })
  return tags.length === 0 ? 'Tags cleared.' : `Tags set: ${tags.map(tag => `#${tag}`).join(' ')}`
}

const tagActive = async ($: EngineInterface, text: string): Promise<string> => {
  const entry = await loadActive($)
  return entry === undefined ? 'No timer in this session: /timer start [note].' : setTags($, entry.id, text)
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
      await $.store.set(key, addAgentRun(parseByDay(await $.store.get(key)), await $.clock.now(), durationMs))
    })
    .catch((error: unknown) => $.ui.log(`timer: subagent time not recorded: ${errorText(error)}`, { to: 'debug' }))
  return agentWrites
}

/** Saves an entry with the span from `from` to `to` taken out, or forgets it when nothing of it is left. */
const saveCut = async ($: EngineInterface, entry: Entry, from: number, to: number) => {
  const cut = cutRange(entry, from, to)
  if (cut.segments.length > 0) return saveEntry($, cut)
  if ((await read($, activeId)) === entry.id) await update($, activeId, () => null)
  await forgetEntry($, entry.id)
}

const awaySpan = (away: Away, to: number) =>
  `${timeOf(away.from)}–${timeOf(to)} (${formatDuration(to - away.from)})`

/**
 * Settles the away time the person is back from: kept as it is, left out of
 * its timer, or moved out to a stopped timer of its own, in the same place and
 * with no note, to be renamed in the panel.
 */
const settleAway = async ($: EngineInterface, choice: 'keep' | 'discard' | 'split'): Promise<string> => {
  const away = await read($, awayAtom)
  await update($, awayAtom, () => null)
  if (away === null || away.to === null) return 'No away time to settle.'
  const span = awaySpan(away, away.to)
  if (choice === 'keep') return `Away time kept: ${span}`
  const entry = await loadEntry($, away.entryId)
  if (entry === undefined) return 'That timer is gone.'
  const part = segmentsWithin(entry, away.from, away.to)
  const isSplit = choice === 'split' && part.length > 0
  if (isSplit) {
    await saveEntry($, {
      id: crypto.randomUUID(),
      sessionId: entry.sessionId,
      repoKey: entry.repoKey,
      repoName: entry.repoName,
      note: '',
      segments: part,
      stoppedAt: away.to,
      location: entry.location,
      branch: entry.branch,
      task: entry.task,
      tags: entry.tags,
    })
  }
  await saveCut($, entry, away.from, away.to)
  return isSplit ? `Away time ${span} moved to a timer of its own: rename it in the panel.` : `Away time left out: ${span}`
}

let lastActiveAt: number | undefined
let activityWrites: Promise<void> = Promise.resolve()

/**
 * Records that the person is at the keyboard (a keystroke, a prompt, a command,
 * a press), which ends any away time waiting for them: left out at once under
 * `awayTime: discard`, asked about on the band under `ask`. One at a time, so
 * a burst of keys ends it once; never rejects, since it runs on every key.
 */
const noteActivity = ($: EngineInterface): Promise<void> => {
  activityWrites = activityWrites
    .then(async () => {
      const now = await $.clock.now()
      lastActiveAt = now
      const away = await read($, awayAtom)
      if (away === null || away.to !== null) return
      await update($, awayAtom, () => (awayMode === 'keep' ? null : { ...away, to: now }))
      if (awayMode === 'ask') await chime($)
      if (awayMode !== 'discard') return
      $.ui.toast(await settleAway($, 'discard'))
      await beat($)
    })
    .catch((error: unknown) => $.ui.log(`timer: activity not recorded: ${errorText(error)}`, { to: 'debug' }))
  return activityWrites
}

/**
 * Finds away time while the active timer runs: no activity for `idleMinutes`,
 * or a computer that slept. Under `awayTime: keep` nothing is looked for.
 */
const detectAway = async ($: EngineInterface, lastTick: number | undefined, now: number) => {
  if (awayMode === 'keep' || (await read($, awayAtom)) !== null) return
  const entry = await loadActive($)
  const runningSince = entry?.segments.at(-1)?.start
  if (entry === undefined || stateOf(entry) !== 'running' || runningSince === undefined) return
  lastActiveAt ??= now
  const away = awayOf({ now, lastActive: lastActiveAt, lastTick, isClaudeWorking, runningSince, idleMs, sleepMs: STALE_MS })
  if (away === undefined) return
  await update($, awayAtom, () => ({ entryId: entry.id, ...away }))
  if (away.to !== null && awayMode === 'ask') await chime($)
  if (away.to !== null && awayMode === 'discard') $.ui.toast(await settleAway($, 'discard'))
}

let branchChecks: Promise<void> = Promise.resolve()

/**
 * Under `branchChange: split`, stops the running timer when its worktree has
 * moved to another branch and starts one for the new branch, with no note, so
 * each branch's time is booked apart. One check at a time; never rejects.
 */
const followBranch = ($: EngineInterface): Promise<void> => {
  if (!splitsOnBranch) return branchChecks
  branchChecks = branchChecks
    .then(async () => {
      const entry = await loadActive($)
      if (entry === undefined || stateOf(entry) !== 'running' || entry.branch === undefined) return
      const worktree = await worktreeOf(runnerOf($))
      if (worktree === undefined || worktree.root !== entry.location || worktree.branch === entry.branch) return
      const now = await $.clock.now()
      await saveEntry($, stopEntry(entry, now) as Entry)
      const fresh = startEntry(
        {
          id: crypto.randomUUID(),
          sessionId: entry.sessionId,
          repoKey: entry.repoKey,
          repoName: entry.repoName,
          note: '',
          location: worktree.root,
          branch: worktree.branch,
          ...(entry.task === undefined ? {} : { task: entry.task }),
          ...(entry.auto === undefined ? {} : { auto: entry.auto }),
          ...(entry.tags === undefined ? {} : { tags: entry.tags }),
        },
        now,
      )
      await saveEntry($, { ...fresh, lastSeen: now })
      await update($, activeId, () => fresh.id)
      $.ui.toast(`Now on ${worktree.branch}: a new timer runs for it`)
      await beat($)
    })
    .catch((error: unknown) => $.ui.log(`timer: branch not followed: ${errorText(error)}`, { to: 'debug' }))
  return branchChecks
}

/**
 * Runs the active auto-mode timer while Claude works on a turn, and for the
 * person's `autoGraceMinutes` after it ends (reading the answer, typing the
 * next prompt): a turn started within them leaves no gap, and past them the
 * timer pauses as they ran out, which the refresh notices (or the next turn,
 * which leaves out the time between). A timer resumed by hand after they ran
 * out keeps running until the next turn ends.
 */
const followClaude = async ($: EngineInterface) => {
  const entry = await loadActive($)
  if (entry?.auto !== true) return
  const now = await $.clock.now()
  await creditCost($)
  if (!isClaudeWorking) turnEndedAt ??= now
  const graceEnd = (turnEndedAt ?? now) + graceMs
  const lastStart = entry.segments.at(-1)?.start ?? now
  const isRunning = stateOf(entry) === 'running'
  if (!isClaudeWorking && (now < graceEnd || (isRunning && lastStart > graceEnd))) return
  const isLapsed = isClaudeWorking && turnEndedAt !== undefined && isRunning && graceMs > 0 && lastStart < graceEnd && graceEnd < now
  const lapsed = isLapsed ? pauseEntry(entry, graceEnd) : entry
  const changed = isClaudeWorking
    ? resumeEntry(typeof lapsed === 'string' ? entry : lapsed, now)
    : pauseEntry(entry, Math.max(lastStart, Math.min(now, graceEnd)))
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
  if (!isClaudeWorking) turnEndedAt = await $.clock.now()
  await followClaude($)
  return graceMs > 0
    ? `Auto mode on: the timer runs while Claude is working and ${formatDuration(graceMs)} after.`
    : 'Auto mode on: the timer runs only while Claude is working.'
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
  await detectAway($, previous, lastTickAt)
  if (graceMs > 0) await followClaude($)
  await beat($)
}

const transition = async (
  $: EngineInterface,
  change: (entry: Entry, now: number) => Entry | string,
  verb: string,
): Promise<string> => {
  await creditCost($)
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
  await creditCost($)
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

/**
 * Starts a timer with no note when this session has none open, for the
 * person's `autoStart` setting: as the session starts, or at each prompt.
 */
const autoStart = async ($: EngineInterface) => {
  try {
    const held = await loadActive($)
    if (held !== undefined && stateOf(held) !== 'stopped') return
    $.ui.toast(`${(await start($, '')).split('\n')[0]} (autoStart)`)
    await beat($)
  } catch (error: unknown) {
    $.ui.log(`timer: autoStart failed: ${errorText(error)}`, { to: 'debug' })
  }
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
  await update($, view, () => ({
    kind: 'today' as const,
    tab: 'session' as const,
    selectedId: null,
    selectedDay: null,
    confirmDeleteId: null,
    isAdding: false,
  }))
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
    current?.kind === 'today' ? { ...current, tab, selectedId: null, selectedDay: null, confirmDeleteId: null } : current,
  )

/** Selects a row to edit, or unselects it when it is the one selected; `day` names a To book row's day. */
const selectRow = ($: EngineInterface, id: string, day: string | null = null) =>
  update($, view, current => {
    if (current?.kind !== 'today') return current
    const isSelected = current.selectedId === id && current.selectedDay === day
    return { ...current, selectedId: isSelected ? null : id, selectedDay: isSelected ? null : day, confirmDeleteId: null }
  })

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
  const own = await read($, activeId)
  if (entry !== undefined && stateOf(entry) !== 'stopped' && entry.id !== own && entry.sessionId !== (await $.session.id())) {
    $.ui.toast('That timer is open in another session: stop it there first.')
    return
  }
  if (own === id) await update($, activeId, () => null)
  await forgetEntry($, id)
  await update($, awayAtom, away => (away?.entryId === id ? null : away))
  await update($, view, v => (v?.kind === 'today' ? { ...v, selectedId: null, selectedDay: null, confirmDeleteId: null } : v))
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

/**
 * Adds to each line the person's commits in its folder while its timer ran
 * that day, null where git can't say (no repository, no user.email). One git
 * call at a time, and the author asked once per folder.
 */
const withCommits = async ($: EngineInterface, entries: readonly Entry[], lines: BookingLine[]): Promise<BookingLine[]> => {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const authors = new Map<string, string | undefined>()
  const out: BookingLine[] = []
  for (const line of lines) {
    const entry = byId.get(line.entryId)
    const span = entry === undefined ? undefined : daySpan(entry, line.day)
    if (line.folder === undefined || span === undefined) {
      out.push(line)
      continue
    }
    if (!authors.has(line.folder)) authors.set(line.folder, await authorOf(runnerOf($), line.folder))
    const author = authors.get(line.folder)
    const commits = author === undefined ? undefined : await commitsBetween(runnerOf($), line.folder, author, span)
    out.push(commits === undefined ? { ...line, commits: null } : commits.length === 0 ? line : { ...line, commits })
  }
  return out
}

/**
 * What this session did, for the booking's description: one question over the
 * session's own transcript, served from Claude's prompt cache, given a minute.
 * Undefined when there is nothing to ask about yet or no answer came.
 */
const sessionSummary = async ($: EngineInterface): Promise<string | undefined> => {
  let timer: Timer | undefined
  const expired = new Promise<undefined>(resolve => {
    timer = $.clock.after(SUMMARY_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const forked = await Promise.race([$.model.fork({ prompt: SUMMARY_REQUEST }), expired])
    if (forked === undefined || !forked.isAnswered) {
      $.ui.log(`timer: no session summary (${forked === undefined ? 'timed out' : forked.reason})`, { to: 'debug' })
      return undefined
    }
    return forked.text.trim().slice(0, SUMMARY_CHARS)
  } finally {
    timer?.cancel()
  }
}

/** Adds the session's summary to the lines of this session's timers. */
const withSummary = async ($: EngineInterface, entries: readonly Entry[], lines: BookingLine[]): Promise<BookingLine[]> => {
  const sessionId = await $.session.id()
  const own = new Set(entries.filter(entry => entry.sessionId === sessionId).map(entry => entry.id))
  if (!lines.some(line => own.has(line.entryId))) return lines
  const summary = await sessionSummary($)
  return summary === undefined ? lines : lines.map(line => (own.has(line.entryId) ? { ...line, summary } : line))
}

/** The entries tool's lines of one timer on one day, booked or not, as the add and edit tools answer. */
const linesOf = async ($: EngineInterface, entryId: string, day: string) =>
  bookingLines(await loadEntries($), { from: day, to: day, includeBooked: true }, countsAgents, roundTo).filter(
    line => line.entryId === entryId,
  )

/**
 * Adds a stopped timer for time worked with no timer running, in this
 * session's repo and folder, for the add tool and the panel alike: the timer
 * as saved, or why it is refused.
 */
const addTimer = async ($: EngineInterface, added: NewEntry): Promise<Entry | string> => {
  if (added.end > (await $.clock.now())) return 'end is still to come: add only time already worked.'
  const repo = await repoOf($)
  const worktree = await worktreeOf(runnerOf($))
  const entry: Entry = {
    id: crypto.randomUUID(),
    sessionId: await $.session.id(),
    repoKey: repo.key,
    repoName: repo.name,
    note: added.note,
    ...(added.tags.length === 0 ? {} : { tags: added.tags }),
    segments: [{ start: added.start, end: added.end }],
    stoppedAt: added.end,
    location: worktree?.root ?? repo.root,
    ...(worktree === undefined ? {} : { branch: worktree.branch }),
  }
  await saveEntry($, entry)
  await beat($)
  return entry
}

const addEntry = async ($: EngineInterface, input: unknown) => {
  const added = parseNewEntry(input)
  if (typeof added === 'string') return { deny: added }
  const saved = await addTimer($, added)
  if (typeof saved === 'string') return { deny: saved }
  return { result: { lines: await linesOf($, saved.id, added.day) } }
}

type AddDraft = { day: string; from: string; to: string; note: string; tags: string }

const EMPTY_DRAFT: AddDraft = { day: '', from: '', to: '', note: '', tags: '' }

let addDraft = EMPTY_DRAFT

const setDraft = (field: keyof AddDraft, value: string) => {
  addDraft = { ...addDraft, [field]: value }
}

/** Opens or closes the panel's Add form, which starts empty each time. */
const toggleAdding = async ($: EngineInterface) => {
  addDraft = EMPTY_DRAFT
  await update($, view, v => (v?.kind === 'today' ? { ...v, isAdding: !v.isAdding, selectedId: null } : v))
}

/** Adds the time the panel's Add form holds, and closes the form once it is added. */
const addFromPanel = async ($: EngineInterface): Promise<string> => {
  const now = await $.clock.now()
  const added = parseNewEntry({
    day: addDraft.day || dayOf(now),
    start: addDraft.from.trim(),
    end: addDraft.to.trim(),
    note: addDraft.note,
    tags: parseTags(addDraft.tags),
  })
  if (typeof added === 'string') return added
  const saved = await addTimer($, added)
  if (typeof saved === 'string') return saved
  addDraft = EMPTY_DRAFT
  await update($, view, v => (v?.kind === 'today' ? { ...v, isAdding: false } : v))
  return `Added ${timeOf(added.start)}–${timeOf(added.end)} on ${added.day}: ${titleOf(saved)}`
}

/**
 * Changes one timer's day, its start or end (Italian time) and its note or
 * tags, for the edit tool and the panel alike: the timer as saved, or why the
 * change is refused.
 */
const applyEdit = async ($: EngineInterface, change: EntryEdit): Promise<Entry | string> => {
  const entry = await loadEntry($, change.entryId)
  if (entry === undefined) return `No timer ${change.entryId}: list them with the entries tool.`
  const isRetimed = change.start !== undefined || change.end !== undefined
  const booked = entry.booked?.[change.day]
  if (isRetimed && booked !== undefined) {
    return `${change.day} of that timer is already booked (${String(booked)}): change the booking first.`
  }
  const dayStart = instantOf(change.day, '00:00')
  if (dayStart === undefined || !hasTimeIn(entry, dayStart, nextMidnight(dayStart))) {
    return `Timer ${entry.id} has no time on ${change.day}.`
  }
  const now = await $.clock.now()
  if ((change.start ?? 0) > now || (change.end ?? 0) > now) return 'start and end must be times already passed.'
  const reshaped = isRetimed
    ? reshapeDay(entry, change.day, { dayStart, dayEnd: nextMidnight(dayStart), start: change.start, end: change.end })
    : entry
  if (typeof reshaped === 'string') return reshaped
  const edited = {
    ...reshaped,
    ...(change.note === undefined ? {} : { note: change.note }),
    ...(change.tags === undefined ? {} : { tags: change.tags }),
  }
  await saveEntry($, edited)
  await beat($)
  return edited
}

const editEntry = async ($: EngineInterface, input: unknown) => {
  const change = parseEntryEdit(input)
  if (typeof change === 'string') return { deny: change }
  const edited = await applyEdit($, change)
  if (typeof edited === 'string') return { deny: edited }
  return { result: { lines: await linesOf($, edited.id, change.day) } }
}

/** Moves a timer's start or end on `day`, from the From and To boxes of the panel. */
const retime = async ($: EngineInterface, entryId: string, day: string, edge: 'start' | 'end', time: string): Promise<string> => {
  const now = await $.clock.now()
  const change = parseEntryEdit({ entryId, day, [edge]: time.trim() })
  if (typeof change === 'string') return change
  const edited = await applyEdit($, change)
  if (typeof edited === 'string') return edited
  const [row] = todayRows([edited], day, now)
  return row === undefined ? 'Timer changed.' : `Timer now ${row.from}–${row.to}, ${formatDuration(row.minutes * MS_PER_MINUTE)}`
}

const closePane = async ($: EngineInterface) => {
  await update($, view, () => null)
  await $.ui.close({ id: PANE })
}

let ticker: Timer | undefined

export const register: Register = (on, options) => {
  const configured = String(options.reminderTime ?? '')
  reminderAt = CLOCK.test(configured) ? configured : DEFAULT_REMINDER
  const retention = Number(options.retentionDays)
  retentionDays = Number.isInteger(retention) && retention > 0 ? retention : DEFAULT_RETENTION_DAYS
  countsAgents = options.agentTime === SUMMED
  isWallClock = options.parallelTime !== SUMMED
  awayMode = AWAY_MODES.find(mode => mode === options.awayTime) ?? 'ask'
  splitsOnBranch = options.branchChange === SPLIT
  autoStartOn = AUTO_STARTS.find(mode => mode === options.autoStart) ?? 'off'
  tellsClaude = options.tellClaude !== 'off'
  hasSound = options.sound === 'on'
  const target = Number(options.targetHours)
  targetMinutes = (Number.isFinite(target) && target >= 0 && target <= MAX_TARGET_HOURS ? target : DEFAULT_TARGET_HOURS) * 60
  const step = Number(options.roundTo)
  roundTo = Number.isInteger(step) && step > 0 && step <= MAX_ROUND_TO ? step : 0
  const grace = Number(options.autoGraceMinutes)
  graceMs = (Number.isFinite(grace) && grace > 0 ? grace : 0) * MS_PER_MINUTE
  const idleMinutes = Number(options.idleMinutes)
  idleMs = (Number.isFinite(idleMinutes) && idleMinutes >= 0 ? idleMinutes : DEFAULT_IDLE_MINUTES) * MS_PER_MINUTE

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Track work time: start, pause, resume, stop, auto, tag, open (panel), status, export',
      argumentHint: '[status] | start [note] | pause | resume | stop | auto | tag [tags] | open | export [file]',
      immediate: true,
    })
    await $.tool.register({
      name: ENTRIES_TOOL,
      description:
        "Lists the work time the timer tracked, to book it on a timesheet: one line per timer and day (Italian time) with whole minutes (wall-clock, or with the subagents' runs added when the person's agentTime setting is summed; agentMinutes, when present, is the subagents' share; rounded to the nearest multiple of the person's roundTo setting, never below one, with exactMinutes then the minutes before rounding), the time it started, its title (the person's note, else the orchestrator's task, else the git branch's words, else the repo), the person's tags, the repo, its git remote as host/path, branch, folder, the orchestrator's task when one started it (its group, such as an Orca worktree, its title and the issue's link), state, costUsd (what Claude's work cost while the timer ran that day, US dollars), for a day already booked the booking's reference, and overlaps: the other timers that ran at the same time that day, with the minutes shared, so the same hours are not booked twice without the person choosing to. Only closed time counts: a running or paused timer lists what it has done so far. Days already booked are left out unless includeBooked is true. With includeCommits, each line also lists the person's commits on the local branches of its folder while the timer ran that day (hash and subject, at most twenty; null when git could not say, such as with no user.email), to write the booking's description from. With includeSummary, the lines of this session's timers also carry summary: what this session did, written from its transcript by one extra model call. Read-only.",
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'First day to list, YYYY-MM-DD' },
          to: { type: 'string', description: 'Last day to list, YYYY-MM-DD' },
          includeBooked: { type: 'boolean', description: 'Also list days already booked' },
          includeCommits: { type: 'boolean', description: "Also list the person's commits made while each timer ran" },
          includeSummary: { type: 'boolean', description: "Also describe this session's work from its transcript, for this session's lines" },
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
    await $.tool.register({
      name: ADD_TOOL,
      description:
        'Adds a timer for time the person worked with no timer running (they forgot to start it): one stretch of one day, Italian time, stopped, in this session\'s repo and folder, with a note and tags. Use it only when the person says what they worked on and when. Answers the new timer as the entries tool lists it, overlaps with other timers included.',
      inputSchema: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'The day, YYYY-MM-DD' },
          start: { type: 'string', description: 'When the work began, HH:mm Italian time' },
          end: { type: 'string', description: 'When it ended, HH:mm Italian time, the same day and not later than now' },
          note: { type: 'string', description: 'What the work was; it names the timer when booked' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Labels such as review or meeting' },
        },
        required: ['day', 'start', 'end'],
        additionalProperties: false,
      },
    })
    await $.tool.register({
      name: EDIT_TOOL,
      description:
        "Changes one timer's day, as the person asks: when its time that day begins or ends (Italian time; earlier widens it, later cuts the time before or after away), and its note or tags. A day already booked keeps its times. Answers the timer's line for that day as the entries tool lists it.",
      inputSchema: {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: 'The line’s entryId from the entries tool' },
          day: { type: 'string', description: 'The line’s day, YYYY-MM-DD' },
          start: { type: 'string', description: 'The new start that day, HH:mm Italian time' },
          end: { type: 'string', description: 'The new end that day, HH:mm Italian time' },
          note: { type: 'string', description: 'The new note; empty names the timer after its branch or repo' },
          tags: { type: 'array', items: { type: 'string' }, description: 'The new tags, replacing the old; empty clears them' },
        },
        required: ['entryId', 'day'],
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
    lastActiveAt = await $.clock.now()
    if (autoStartOn === 'session') await autoStart($)
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
    const entries = await loadEntries($)
    const found = bookingLines(entries, range, countsAgents, roundTo)
    const withGit = range.includeCommits === true ? await withCommits($, entries, found) : found
    return { result: { lines: range.includeSummary === true ? await withSummary($, entries, withGit) : withGit } }
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

  on('tool.call', { tool: 'mcp__timer__add_entry' }, ($, e) => addEntry($, e.input))

  on('tool.call', { tool: 'mcp__timer__edit_entry' }, ($, e) => editEntry($, e.input))

  on('prompt.edit', async ($, e, next) => {
    const edited = await next(e)
    await noteActivity($)
    return edited
  })

  on('prompt.submit', async ($, e, next) => {
    const isCommand = e.text.trimStart().startsWith('/')
    const context = tellsClaude && !isCommand ? await timerContext($) : undefined
    const submitted = await next(context === undefined ? e : { ...e, context: [...(e.context ?? []), context] })
    await noteActivity($)
    await followBranch($)
    if (autoStartOn === 'prompt' && !isCommand) await autoStart($)
    return submitted
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    isClaudeWorking = true
    await followClaude($)
    turnEndedAt = undefined
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) {
      isClaudeWorking = false
      lastActiveAt = await $.clock.now()
      turnEndedAt = lastActiveAt
      await followBranch($)
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
    const now = await $.clock.now()
    const away = await read($, awayAtom)
    await update($, awayAtom, () => null)
    const isAway = entry !== undefined && away?.entryId === entry.id && away.to === null && stateOf(entry) === 'running'
    const stopped = entry === undefined ? undefined : stopEntry(entry, isAway && away !== null ? away.from : now)
    if (stopped !== undefined && typeof stopped !== 'string') await saveEntry($, stopped)
    await update($, activeId, () => null)
    return next(e)
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const cleared = await next(e)
    if (e.origin.kind === 'plugin' && e.origin.name === RELAY) await carryOverRelay($)
    return cleared
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    await noteActivity($)
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
        case 'tag':
          return tagActive($, arg)
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
    const today = <Button key="today" label="☰" hotkey="o" onPress={() => toggleToday($)} />
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
          <Button key="keepafterclear" label="Keep running" hotkey="k" onPress={() => fromBand($, () => answerAfterClear($, true))} />
          <Button key="stopafterclear" label="Stop" hotkey="x" onPress={() => fromBand($, () => answerAfterClear($, false))} />
        </Box>
      )
    }

    const away = await read($, awayAtom)
    if (awayMode === 'ask' && away !== null && away.to !== null) {
      return (
        <Box key="timer-band" width={e.props.bodyColumns} justifyContent="flex-end" gap={1}>
          <Text>Away {awaySpan(away, away.to)} while the timer ran:</Text>
          <Button key="awaykeep" label="Keep" hotkey="k" onPress={() => fromBand($, () => settleAway($, 'keep'))} />
          <Button key="awaydiscard" label="Leave out" hotkey="l" onPress={() => fromBand($, () => settleAway($, 'discard'))} />
          <Button key="awaysplit" label="Own timer" hotkey="t" onPress={() => fromBand($, () => settleAway($, 'split'))} />
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
              <Button key="start" label="Start" hotkey="s" onPress={() => startFromBand($, '')} />
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
              hotkey="a"
              label={info.auto ? 'Auto ●' : 'Auto ○'}
              variant={info.auto ? 'primary' : 'secondary'}
              onPress={() => fromBand($, () => toggleAuto($))}
            />
            {isRunning ? (
              <Button key="pause" label="Pause" hotkey="p" onPress={() => fromBand($, () => transition($, pauseEntry, 'paused'))} />
            ) : (
              <Button key="resume" label="Resume" hotkey="p" onPress={() => fromBand($, () => transition($, resumeEntry, 'resumed'))} />
            )}
            <Button key="stop" label="Stop" hotkey="x" onPress={() => fromBand($, () => transition($, stopEntry, 'stopped'))} />
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
    const Select = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Select
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
    const toBook = bookingLines(entries.filter(entry => stateOf(entry) === 'stopped'), {}, countsAgents, roundTo)
    const selected = current.selectedDay === null ? rows.find(r => r.id === current.selectedId) : undefined
    const mark = { running: '⏱', paused: '⏸', stopped: '■' } as const
    const editor = (target: {
      id: string
      day: string
      note: string
      tags: readonly string[]
      from: string
      to: string | null
      state: 'running' | 'paused' | 'stopped'
      sessionId: string
    }) => {
      const isRunningHere = target.id === own && target.state === 'running'
      const isElsewhere = target.state !== 'stopped' && target.id !== own && target.sessionId !== sessionId
      return (
        <Box key="selected" flexDirection="column" borderStyle="round" paddingX={1}>
          {Input !== undefined && (
            <Input
              key="selnote"
              label="Note"
              value={target.note}
              placeholder="(no note)"
              submitLabel="Set note"
              onSubmit={(value: string) => fromBand($, () => setNote($, target.id, value))}
            />
          )}
          {Input !== undefined && (
            <Input
              key="seltags"
              label="Tags"
              value={target.tags.join(' ')}
              placeholder="review meeting"
              submitLabel="Set tags"
              onSubmit={(value: string) => fromBand($, () => setTags($, target.id, value))}
            />
          )}
          {Input !== undefined && (
            <Box gap={1}>
              <Input
                key="selfrom"
                label="From"
                value={target.from}
                placeholder="HH:mm"
                submitLabel="Move start"
                onSubmit={(value: string) => fromBand($, () => retime($, target.id, target.day, 'start', value))}
              />
              <Input
                key="selto"
                label="To"
                value={target.to ?? ''}
                placeholder={target.to === null ? 'running' : 'HH:mm'}
                submitLabel="Move end"
                onSubmit={(value: string) => fromBand($, () => retime($, target.id, target.day, 'end', value))}
              />
            </Box>
          )}
          {isElsewhere && <Text dimColor>Open in another session: pause, stop or delete it there.</Text>}
          <Box gap={1}>
            {!isRunningHere && !isElsewhere && (
              <Button
                key="continue"
                label="Continue this timer"
                variant="primary"
                onPress={() => fromBand($, () => continueEntry($, target.id))}
              />
            )}
            {isRunningHere && (
              <Button key="pausesel" label="Pause" hotkey="p" onPress={() => fromBand($, () => transition($, pauseEntry, 'paused'))} />
            )}
            {target.id === own && target.state !== 'stopped' && (
              <Button key="stopsel" label="Stop" hotkey="x" onPress={() => fromBand($, () => transition($, stopEntry, 'stopped'))} />
            )}
            {!isElsewhere && (
              <Button
                key="delete"
                label={current.confirmDeleteId === target.id ? 'Press again to delete' : 'Delete'}
                onPress={() => deleteEntry($, target.id)}
              />
            )}
          </Box>
        </Box>
      )
    }
    const tabs = (
      <Box gap={1}>
        <Button
          key="tabsession"
          hotkey="1"
          label={`This session (${allRows.filter(r => r.sessionId === sessionId).length})`}
          variant={current.tab === 'session' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'session')}
        />
        <Button
          key="taball"
          hotkey="2"
          label={`All (${allRows.length})`}
          variant={current.tab === 'all' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'all')}
        />
        <Button
          key="tabbook"
          hotkey="3"
          label={`To book (${toBook.length})`}
          variant={current.tab === 'book' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'book')}
        />
        <Button
          key="tabweek"
          hotkey="4"
          label="Week"
          variant={current.tab === 'week' ? 'primary' : 'secondary'}
          onPress={() => selectTab($, 'week')}
        />
      </Box>
    )
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => closePane($)} />
    if (current.tab === 'week') {
      const week = weekOf(entries, now, { withAgents: countsAgents, wallClock: isWallClock })
      const weekTotal = week.days.reduce((sum, d) => sum + d.minutes, 0)
      return (
        <Box flexDirection="column">
          {tabs}
          <Text bold>
            Last 7 days · {formatDuration(weekTotal * MS_PER_MINUTE)}
            {targetMinutes > 0 ? ` · target ${formatDuration(targetMinutes * MS_PER_MINUTE)} a day` : ''}
          </Text>
          {week.days.map(d => (
            <Box key={`w${d.day}`} gap={1}>
              <Text>
                {d.weekday} {d.day.slice(5)} {barOf(d.minutes, targetMinutes)} {formatDuration(d.minutes * MS_PER_MINUTE)}
              </Text>
              {d.toBook > 0 && <Text color="yellow">{plural(d.toBook, 'timer', 'timers')} to book</Text>}
            </Box>
          ))}
          {week.byRepo.length > 0 && <Text bold>By repo</Text>}
          {week.byRepo.map(r => (
            <Text key={`r${r.name}`}>
              {formatDuration(r.minutes * MS_PER_MINUTE)}  {r.name}
            </Text>
          ))}
          {week.byTag.length > 0 && <Text bold>By tag</Text>}
          {week.byTag.map(t => (
            <Text key={`g${t.name}`}>
              {formatDuration(t.minutes * MS_PER_MINUTE)}  #{t.name}
            </Text>
          ))}
          {(week.byRepo.length > 0 || week.byTag.length > 0) && (
            <Text dimColor>By repo and tag add up each timer's own time, so time two timers shared counts in both.</Text>
          )}
          {close}
        </Box>
      )
    }
    if (current.tab === 'book') {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text bold>
            To book · {formatDuration(toBook.reduce((sum, l) => sum + l.minutes, 0) * MS_PER_MINUTE)} in{' '}
            {plural(new Set(toBook.map(l => l.day)).size, 'day', 'days')}
            {roundTo > 0 ? ` · rounded to ${roundTo} min` : ''}
          </Text>
          <Text dimColor>
            {toBook.length === 0
              ? 'Every stopped timer is booked.'
              : `Stopped timers not booked yet: ${ASK_TO_BOOK}. Select one to change it.`}
          </Text>
          {toBook.map(l => {
            const exact = l.exactMinutes === undefined ? '' : ` (${formatDuration(l.exactMinutes * MS_PER_MINUTE)} tracked)`
            const isSelected = l.entryId === current.selectedId && l.day === current.selectedDay
            return (
              <Box key={`b${l.entryId}${l.day}`} gap={1}>
                <Button
                  key={`book${l.entryId}${l.day}`}
                  label={`${l.day} ${l.start} ${formatDuration(l.minutes * MS_PER_MINUTE)}${exact}  ${l.title}${(l.tags ?? []).map(tag => ` #${tag}`).join('')}`}
                  variant={isSelected ? 'primary' : 'secondary'}
                  onPress={() => selectRow($, l.entryId, l.day)}
                />
                <Text dimColor wrap="truncate-end">
                  {l.folder === undefined ? l.repo : <Link href={fileUrl(l.folder)}>{l.repo}</Link>}
                </Text>
              </Box>
            )
          })}
          {(() => {
            const line = toBook.find(l => l.entryId === current.selectedId && l.day === current.selectedDay)
            const entry = line === undefined ? undefined : entries.find(candidate => candidate.id === line.entryId)
            const span = line === undefined || entry === undefined ? undefined : daySpan(entry, line.day)
            return line === undefined || entry === undefined || span === undefined
              ? null
              : editor({
                  id: entry.id,
                  day: line.day,
                  note: entry.note,
                  tags: entry.tags ?? [],
                  from: timeOf(span.since),
                  to: timeOf(span.until),
                  state: stateOf(entry),
                  sessionId: entry.sessionId,
                })
          })()}
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
        {rows.length > 0 && <Text dimColor>Select a timer to change its note, tags or times, continue or delete it.</Text>}
        {rows.map(r => {
          const summary = `${mark[r.state]} ${r.from}–${r.to.padEnd(5)} ${formatDuration(r.minutes * MS_PER_MINUTE)}  ${r.name}${r.tags.map(tag => ` #${tag}`).join('')}`
          return (
            <Box key={`t${r.id}`} gap={1}>
              <Button
                key={`row${r.id}`}
                label={summary}
                variant={r.id === current.selectedId ? 'primary' : 'secondary'}
                onPress={() => selectRow($, r.id)}
              />
              <Text dimColor wrap="truncate-end">
                {r.repo.path === undefined ? r.repo.name : <Link href={fileUrl(r.repo.path)}>{r.repo.name}</Link>}
                {r.costUsd === undefined ? '' : ` · $${r.costUsd.toFixed(2)}`}
                {r.id === own ? ' · running here' : r.sessionId === sessionId ? '' : ' · other session'}
                {r.isBooked ? ' · booked' : ''}
              </Text>
              {r.overlapMinutes > 0 && <Text color="yellow">⚠ {formatDuration(r.overlapMinutes * MS_PER_MINUTE)} alongside other timers</Text>}
            </Box>
          )
        })}
        {selected !== undefined &&
          editor({
            id: selected.id,
            day: dayOf(now),
            note: selected.note,
            tags: selected.tags,
            from: selected.from,
            to: selected.to === 'now' ? null : selected.to,
            state: selected.state,
            sessionId: selected.sessionId,
          })}
        {Input !== undefined && Select !== undefined && !current.isAdding && (
          <Button key="addtime" label="+ Add time" hotkey="n" onPress={() => toggleAdding($)} />
        )}
        {Input !== undefined && Select !== undefined && current.isAdding && (
          <Box key="adding" flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>Add time worked with no timer running</Text>
            <Select
              key="addday"
              label="Day"
              value={addDraft.day || dayOf(now)}
              options={recentDays(now).map((day, i) => ({
                value: day,
                label: i === 0 ? `today, ${day}` : i === 1 ? `yesterday, ${day}` : day,
              }))}
              onSelect={(value: string) => setDraft('day', value)}
            />
            <Box gap={1}>
              <Input
                key="addfrom"
                label="From"
                value={addDraft.from}
                placeholder="HH:mm"
                submitLabel="Set"
                onInput={(value: string) => setDraft('from', value)}
                onSubmit={(value: string) => setDraft('from', value)}
              />
              <Input
                key="addto"
                label="To"
                value={addDraft.to}
                placeholder="HH:mm"
                submitLabel="Set"
                onInput={(value: string) => setDraft('to', value)}
                onSubmit={(value: string) => setDraft('to', value)}
              />
            </Box>
            <Input
              key="addnote"
              label="Note"
              value={addDraft.note}
              placeholder="what was it?"
              submitLabel="Set"
              onInput={(value: string) => setDraft('note', value)}
              onSubmit={(value: string) => setDraft('note', value)}
            />
            <Input
              key="addtags"
              label="Tags"
              value={addDraft.tags}
              placeholder="meeting"
              submitLabel="Set"
              onInput={(value: string) => setDraft('tags', value)}
              onSubmit={(value: string) => setDraft('tags', value)}
            />
            <Box gap={1}>
              <Button key="addsave" label="Add" variant="primary" onPress={() => fromBand($, () => addFromPanel($))} />
              <Button key="addcancel" label="Cancel" onPress={() => toggleAdding($)} />
            </Box>
          </Box>
        )}
        {close}
      </Box>
    )
  })
}
