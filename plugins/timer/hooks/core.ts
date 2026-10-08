import type { BookingLine, Entry, Segment, TodayRow } from '../types'

export const TIME_ZONE = 'Europe/Rome'
export const PATH_KEY_PREFIX = 'path:'
const MS_PER_MINUTE = 60_000
const CENTS = 100
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'HEAD', ''])

export type EntryState = 'running' | 'paused' | 'stopped'

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** The calendar day of `ms` in the timer's time zone (Italian time), as YYYY-MM-DD. */
export const dayOf = (ms: number): string => dayFormat.format(ms)

/** The wall-clock time of `ms` in the timer's time zone, as HH:mm. */
export const timeOf = (ms: number): string => timeFormat.format(ms)

/** The message of a rejection, without the `Error:` prefix. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const DAY = /^\d{4}-\d{2}-\d{2}$/

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/**
 * The first instant of the day after `ms`'s, in the timer's time zone. A day of a
 * clock change is 23 or 25 hours long, so the guess a day on from this one's
 * midnight is corrected an hour at a time.
 */
export const nextMidnight = (ms: number): number => {
  const [hours = 0, minutes = 0, seconds = 0] = clockFormat.format(ms).split(':').map(Number)
  const day = dayOf(ms)
  let midnight = ms - (ms % 1000) - ((hours * 60 + minutes) * 60 + seconds) * 1000 + DAY_MS
  while (dayOf(midnight) === day) midnight += HOUR_MS
  while (dayOf(midnight - HOUR_MS) !== day) midnight -= HOUR_MS
  return midnight
}

/** A wall-clock time of day, HH:mm. */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

const isAt = (t: number, day: string, time: string) => dayOf(t) === day && timeOf(t) === time

/**
 * The instant a wall-clock `time` (HH:mm) on `day` stands for in the timer's
 * time zone; undefined for a malformed one, a day the calendar lacks, or a
 * time the clock skipped when it moved forward. Of a time the clock passed
 * twice, as it moved back, the first.
 */
export const instantOf = (day: string, time: string): number | undefined => {
  if (!DAY.test(day) || !CLOCK.test(time)) return undefined
  const target = Date.parse(`${day}T${time}:00Z`)
  if (Number.isNaN(target)) return undefined
  let t = target
  for (let i = 0; i < 3; i++) t += target - Date.parse(`${dayOf(t)}T${clockFormat.format(t)}Z`)
  if (!isAt(t, day, time)) return undefined
  return isAt(t - HOUR_MS, day, time) ? t - HOUR_MS : t
}

const RECENT_DAYS = 7

/** The day of `now` and the six before it, newest first, as the panel's Add form offers them. */
export const recentDays = (now: number): string[] => {
  const noon = instantOf(dayOf(now), '12:00') ?? now
  return Array.from({ length: RECENT_DAYS }, (_, i) => dayOf(noon - i * DAY_MS))
}

/** Whether an entry has time, closed or still running, between `dayStart` and `dayEnd`. */
export const hasTimeIn = (entry: Entry, dayStart: number, dayEnd: number): boolean =>
  entry.segments.some(s => (s.end ?? Infinity) > dayStart && s.start < dayEnd)

/** A segment cut at every midnight it spans, so that each piece lies in one day; an open one stays open. */
export const splitAtMidnight = (segment: Segment, now: number): Segment[] => {
  const end = segment.end ?? now
  const pieces: Segment[] = []
  let start = segment.start
  for (let cut = nextMidnight(start); cut < end; cut = nextMidnight(cut)) {
    pieces.push({ start, end: cut })
    start = cut
  }
  pieces.push(segment.end === undefined ? { start } : { start, end })
  return pieces
}

export const stateOf = (entry: Entry): EntryState => {
  if (entry.stoppedAt !== undefined) return 'stopped'
  return entry.segments.at(-1)?.end === undefined ? 'running' : 'paused'
}

/** The timer's wall-clock time, plus every subagent's run while it ran when `withAgents`. */
export const workedMs = (entry: Entry, now: number, withAgents = false): number =>
  entry.segments.reduce((sum, s) => sum + ((s.end ?? now) - s.start), 0) +
  (withAgents ? Object.values(entry.agentMs ?? {}).reduce((sum, ms) => sum + ms, 0) : 0)

/** Adds a subagent's run that ended at `end` to the per-day agent time, split at midnight. */
export const addAgentRun = (byDay: Record<string, number>, end: number, durationMs: number): Record<string, number> => {
  const added = { ...byDay }
  for (const s of splitAtMidnight({ start: end - Math.max(0, durationMs), end }, end)) {
    const day = dayOf(s.start)
    added[day] = (added[day] ?? 0) + ((s.end ?? end) - s.start)
  }
  return added
}

/** A per-day amount a store value holds (agent time, cost); anything malformed reads as none. */
export const parseByDay = (value: unknown): Record<string, number> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(
        Object.entries(value).filter(([, amount]) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0),
      )
    : {}

export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / MS_PER_MINUTE)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export const startEntry = (
  init: Omit<Entry, 'segments' | 'stoppedAt' | 'booked'>,
  now: number,
): Entry => ({ ...init, segments: [{ start: now }] })

export const pauseEntry = (entry: Entry, now: number): Entry | string => {
  if (stateOf(entry) !== 'running') return 'The timer is not running.'
  return { ...entry, segments: closeLast(entry.segments, now) }
}

export const resumeEntry = (entry: Entry, now: number): Entry | string => {
  if (stateOf(entry) !== 'paused') return 'The timer is not paused.'
  return { ...entry, segments: [...entry.segments, { start: now }] }
}

export const stopEntry = (entry: Entry, now: number): Entry | string => {
  if (stateOf(entry) === 'stopped') return 'The timer is already stopped.'
  return { ...entry, segments: closeLast(entry.segments, now), stoppedAt: now }
}

const closeLast = (segments: Entry['segments'], now: number) =>
  segments.map((s, i) => (i === segments.length - 1 && s.end === undefined ? { ...s, end: now } : s))

/** The entry with the time from `from` to `to` taken out of its segments; an open one stays open from `to`. */
export const cutRange = (entry: Entry, from: number, to: number): Entry => ({
  ...entry,
  segments: entry.segments.flatMap(s => {
    const end = s.end ?? Infinity
    if (end <= from || s.start >= to) return [s]
    const before = s.start < from ? [{ start: s.start, end: from }] : []
    const after = end > to ? [s.end === undefined ? { start: to } : { start: to, end: s.end }] : []
    return [...before, ...after]
  }),
})

/** The pieces of an entry's segments that lie between `from` and `to`, all closed. */
export const segmentsWithin = (entry: Entry, from: number, to: number): Segment[] =>
  entry.segments
    .map(s => ({ start: Math.max(s.start, from), end: Math.min(s.end ?? to, to) }))
    .filter(s => s.end > s.start)

/** What the timer knows of the person's presence when its refresh runs. */
export type Presence = {
  now: number
  /** The person's last keystroke, prompt, command or press, or the end of Claude's last turn. */
  lastActive: number
  /** The refresh before this one; a long gap since means the computer slept. */
  lastTick: number | undefined
  isClaudeWorking: boolean
  /** When the running timer's open segment began: nothing before it is cut. */
  runningSince: number
  /** No activity for this long is away time; 0 never calls idle time away. */
  idleMs: number
  /** A gap between refreshes this long means the computer slept. */
  sleepMs: number
}

/**
 * The away time a refresh finds, or undefined. Idle time runs from the last
 * activity until the person is back (`to` null); a sleep alone ends as the
 * computer wakes. Claude working is not idle time; nothing before the running
 * segment counts.
 */
export const awayOf = (p: Presence): { from: number; to: number | null } | undefined => {
  const isIdle = p.idleMs > 0 && !p.isClaudeWorking && p.now - p.lastActive >= p.idleMs
  const sleptFrom =
    p.lastTick !== undefined && p.now - p.lastTick >= Math.max(p.sleepMs, p.idleMs) ? p.lastTick : undefined
  if (isIdle) return { from: Math.max(Math.min(p.lastActive, sleptFrom ?? Infinity), p.runningSince), to: null }
  return sleptFrom === undefined ? undefined : { from: Math.max(sleptFrom, p.runningSince), to: p.now }
}

/**
 * Stops a running or paused entry whose session stopped beating before
 * `staleBefore` (a closed window, a crash), at the last moment it was seen alive.
 */
export const closeStale = (entry: Entry, staleBefore: number): Entry | undefined => {
  if (stateOf(entry) === 'stopped') return undefined
  const last = entry.segments.at(-1)
  const lastSeen = Math.max(entry.lastSeen ?? 0, last?.end ?? last?.start ?? staleBefore)
  return lastSeen < staleBefore ? (stopEntry(entry, lastSeen) as Entry) : undefined
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isSegment = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  isNumber((value as Segment).start) &&
  ((value as Segment).end === undefined || isNumber((value as Segment).end))

/** An entry read back from the store, or undefined when it is not one this version wrote. */
export const parseEntry = (value: unknown): Entry | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const e = value as Entry
  const isValid =
    typeof e.id === 'string' &&
    typeof e.sessionId === 'string' &&
    typeof e.repoKey === 'string' &&
    typeof e.repoName === 'string' &&
    typeof e.note === 'string' &&
    Array.isArray(e.segments) &&
    e.segments.length > 0 &&
    e.segments.every(isSegment) &&
    (e.stoppedAt === undefined || isNumber(e.stoppedAt)) &&
    (e.lastSeen === undefined || isNumber(e.lastSeen)) &&
    (e.auto === undefined || typeof e.auto === 'boolean') &&
    (e.location === undefined || typeof e.location === 'string') &&
    (e.branch === undefined || typeof e.branch === 'string') &&
    (e.tags === undefined || (Array.isArray(e.tags) && e.tags.every(tag => typeof tag === 'string'))) &&
    (e.task === undefined ||
      (typeof e.task === 'object' &&
        e.task !== null &&
        typeof e.task.source === 'string' &&
        typeof e.task.group === 'string' &&
        (e.task.title === undefined || typeof e.task.title === 'string') &&
        (e.task.url === undefined || typeof e.task.url === 'string'))) &&
    (e.booked === undefined ||
      (typeof e.booked === 'object' && Object.values(e.booked).every(v => isNumber(v) || typeof v === 'string')))
  return isValid ? e : undefined
}

/**
 * A git remote in its canonical `host/path` form, lowercase host and no
 * `.git`, the same for its SSH and HTTPS spellings (GEWEB keys repos so).
 */
export const canonicalRemote = (url: string): string | null => {
  const trimmed = url.trim()
  let host: string
  let path: string
  if (trimmed.includes('://')) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    host = parsed.hostname.toLowerCase()
    path = parsed.pathname
  } else {
    const at = trimmed.indexOf('@')
    const colon = trimmed.indexOf(':')
    if (at === -1 || colon === -1 || at > colon) return null
    host = trimmed.slice(at + 1, colon).trim().toLowerCase()
    path = trimmed.slice(colon + 1).trim()
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  return host && path ? `${host}/${path}` : null
}

/** Minutes worked per day, closed segments cut at midnight so that each day holds only its own time. */
export const minutesByDay = (entry: Entry, withAgents = false): Map<string, { minutes: number; firstStart: number }> => {
  const days = new Map<string, { minutes: number; firstStart: number }>()
  for (const s of entry.segments.flatMap(closed => (closed.end === undefined ? [] : splitAtMidnight(closed, closed.end)))) {
    if (s.end === undefined) continue
    const day = dayOf(s.start)
    const held = days.get(day) ?? { minutes: 0, firstStart: s.start }
    days.set(day, {
      minutes: held.minutes + (s.end - s.start) / MS_PER_MINUTE,
      firstStart: Math.min(held.firstStart, s.start),
    })
  }
  if (!withAgents) return days
  for (const [day, ms] of Object.entries(entry.agentMs ?? {})) {
    const held = days.get(day)
    if (held !== undefined) days.set(day, { ...held, minutes: held.minutes + ms / MS_PER_MINUTE })
  }
  return days
}

/** The days of a stopped entry still to book: at least a whole minute, and nothing recorded under `booked`. */
export const pendingDays = (entry: Entry): [string, { minutes: number; firstStart: number }][] =>
  stateOf(entry) === 'stopped'
    ? [...minutesByDay(entry)].filter(([day, { minutes }]) => entry.booked?.[day] === undefined && Math.round(minutes) > 0)
    : []

/**
 * Whether a stopped entry with nothing left to book stopped more than
 * `retentionDays` before `now`, so it can go. Time not yet booked is kept,
 * however old.
 */
export const isExpired = (entry: Entry, now: number, retentionDays: number): boolean => {
  if (stateOf(entry) !== 'stopped' || pendingDays(entry).length > 0) return false
  const stoppedAt = entry.stoppedAt ?? entry.segments.at(-1)?.end ?? now
  return stoppedAt < now - retentionDays * DAY_MS
}

/** The span of an entry's closed time on `day`, from its first start to its last end; undefined with none. */
export const daySpan = (entry: Entry, day: string): { since: number; until: number } | undefined => {
  const pieces = closedPiecesByDay(entry).get(day) ?? []
  const first = pieces[0]
  return first === undefined
    ? undefined
    : { since: Math.min(...pieces.map(s => s.start)), until: Math.max(...pieces.map(s => s.end ?? s.start)) }
}

/**
 * Minutes rounded for booking to the nearest multiple of `step`, never below
 * one step for time worked; a `step` of 0 leaves them whole.
 */
export const roundMinutes = (minutes: number, step: number): number => {
  const whole = Math.round(minutes)
  return step > 0 && whole > 0 ? Math.max(step, Math.round(whole / step) * step) : whole
}

/** An entry's closed time cut at midnight, the pieces of each day apart. */
const closedPiecesByDay = (entry: Entry): Map<string, Segment[]> => {
  const days = new Map<string, Segment[]>()
  for (const s of entry.segments.flatMap(closed => (closed.end === undefined ? [] : splitAtMidnight(closed, closed.end)))) {
    const day = dayOf(s.start)
    days.set(day, [...(days.get(day) ?? []), s])
  }
  return days
}

/** The milliseconds two lists of closed segments run at the same time. */
export const sharedMs = (a: readonly Segment[], b: readonly Segment[]): number =>
  a.reduce(
    (sum, x) =>
      sum + b.reduce((inner, y) => inner + Math.max(0, Math.min(x.end ?? x.start, y.end ?? y.start) - Math.max(x.start, y.start)), 0),
    0,
  )

/**
 * One line per entry and day, oldest first, for whoever books the time (Claude,
 * through the timer's `entries` tool): whole minutes, the closed time only, so
 * a timer still open counts what it has done so far and says it is open. With
 * `withAgents` the minutes add the subagents' runs, always listed apart too.
 * A line names the other timers that ran at the same time that day, so the
 * same hours are not booked twice unseen. With `roundTo` the minutes are
 * rounded for booking, and `exactMinutes` keeps the whole ones.
 */
export const bookingLines = (
  entries: readonly Entry[],
  range: { from?: string; to?: string; includeBooked?: boolean },
  withAgents = false,
  roundTo = 0,
): BookingLine[] => {
  const pieces = new Map(entries.map(entry => [entry.id, closedPiecesByDay(entry)]))
  const onDay = new Map<string, Entry[]>()
  for (const entry of entries) {
    for (const day of pieces.get(entry.id)?.keys() ?? []) onDay.set(day, [...(onDay.get(day) ?? []), entry])
  }
  const overlapsOf = (entry: Entry, day: string) =>
    (onDay.get(day) ?? [])
      .filter(other => other.id !== entry.id)
      .map(other => ({
        entryId: other.id,
        title: titleOf(other),
        minutes: Math.round(
          sharedMs(pieces.get(entry.id)?.get(day) ?? [], pieces.get(other.id)?.get(day) ?? []) / MS_PER_MINUTE,
        ),
      }))
      .filter(overlap => overlap.minutes > 0)
  return entries
    .flatMap(entry =>
      [...minutesByDay(entry, withAgents)].map(([day, { minutes, firstStart }]) => {
        const booked = entry.booked?.[day]
        const agentMinutes = Math.round((entry.agentMs?.[day] ?? 0) / MS_PER_MINUTE)
        const overlaps = overlapsOf(entry, day)
        const rounded = roundMinutes(minutes, roundTo)
        const costUsd = Math.round((entry.costUsd?.[day] ?? 0) * CENTS) / CENTS
        return {
          firstStart,
          line: {
            entryId: entry.id,
            day,
            start: timeOf(firstStart),
            minutes: rounded,
            ...(rounded === Math.round(minutes) ? {} : { exactMinutes: Math.round(minutes) }),
            title: titleOf(entry),
            note: entry.note,
            ...(entry.tags === undefined || entry.tags.length === 0 ? {} : { tags: entry.tags }),
            repo: entry.repoName,
            ...(entry.repoKey.startsWith(PATH_KEY_PREFIX) ? {} : { remote: entry.repoKey }),
            ...(entry.branch === undefined ? {} : { branch: entry.branch }),
            ...(entry.location === undefined ? {} : { folder: entry.location }),
            ...(entry.task === undefined ? {} : { task: entry.task }),
            state: stateOf(entry),
            ...(booked === undefined ? {} : { booked: String(booked) }),
            ...(agentMinutes > 0 ? { agentMinutes } : {}),
            ...(overlaps.length > 0 ? { overlaps } : {}),
            ...(costUsd > 0 ? { costUsd } : {}),
          },
        }
      }),
    )
    .filter(
      ({ line }) =>
        line.minutes > 0 &&
        (range.from === undefined || line.day >= range.from) &&
        (range.to === undefined || line.day <= range.to) &&
        (range.includeBooked === true || line.booked === undefined),
    )
    .sort((a, b) => a.firstStart - b.firstStart)
    .map(({ line }) => line)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** What the `entries` tool takes: the days to list, and whether to add booked days and commits. */
export type BookingRange = { from?: string; to?: string; includeBooked?: boolean; includeCommits?: boolean }

/** The `entries` tool's input, or why it is refused. */
export const parseBookingRange = (input: unknown): BookingRange | string => {
  if (!isRecord(input)) return 'The input must be an object.'
  const { from, to, includeBooked, includeCommits } = input
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !DAY.test(value))) return `${name} must be a day, YYYY-MM-DD.`
  }
  if (includeBooked !== undefined && typeof includeBooked !== 'boolean') return 'includeBooked must be true or false.'
  if (includeCommits !== undefined && typeof includeCommits !== 'boolean') return 'includeCommits must be true or false.'
  return {
    ...(includeCommits === undefined ? {} : { includeCommits }),
    ...(from === undefined ? {} : { from: from as string }),
    ...(to === undefined ? {} : { to: to as string }),
    ...(includeBooked === undefined ? {} : { includeBooked }),
  }
}

/** The `mark_booked` tool's input, or why it is refused. */
export const parseMark = (input: unknown): { entryId: string; day: string; reference: string } | string => {
  if (!isRecord(input)) return 'The input must be an object.'
  const { entryId, day, reference } = input
  if (typeof entryId !== 'string' || entryId === '') return 'entryId must be a line’s entryId from the entries tool.'
  if (typeof day !== 'string' || !DAY.test(day)) return 'day must be a day, YYYY-MM-DD.'
  if (typeof reference !== 'string' || reference.trim() === '') return 'reference must say where the time was booked.'
  return { entryId, day, reference: reference.trim() }
}

/** What the `add_entry` tool takes: a stretch of one day, Italian time, and what it was. */
export type NewEntry = { day: string; start: number; end: number; note: string; tags: string[] }

/** What the `edit_entry` tool takes: one timer's day, and what to change of it. */
export type EntryEdit = { entryId: string; day: string; start?: number; end?: number; note?: string; tags?: string[] }

const optionalText = (value: unknown, name: string): string | undefined | Error =>
  value === undefined || typeof value === 'string' ? value : new Error(`${name} must be text.`)

const optionalTags = (value: unknown): string[] | undefined | Error => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(tag => typeof tag === 'string')) return new Error('tags must be a list of words.')
  return parseTags(value.join(' '))
}

const optionalTime = (day: string, value: unknown, name: string): number | undefined | Error => {
  if (value === undefined) return undefined
  const instant = typeof value === 'string' ? instantOf(day, value) : undefined
  return instant ?? new Error(`${name} must be a time of ${day}, HH:mm Italian time.`)
}

/** The `add_entry` tool's input, or why it is refused. */
export const parseNewEntry = (input: unknown): NewEntry | string => {
  if (!isRecord(input)) return 'The input must be an object.'
  const { day, note, tags } = input
  if (typeof day !== 'string' || !DAY.test(day)) return 'day must be a day, YYYY-MM-DD.'
  const start = optionalTime(day, input.start, 'start')
  const end = optionalTime(day, input.end, 'end')
  const text = optionalText(note, 'note')
  const labels = optionalTags(tags)
  for (const value of [start, end, text, labels]) if (value instanceof Error) return value.message
  if (start === undefined || end === undefined) return 'start and end are both needed, HH:mm Italian time.'
  if (end <= start) return 'end must come after start; time past midnight goes on the next day.'
  return { day, start: start as number, end: end as number, note: ((text as string | undefined) ?? '').trim(), tags: (labels as string[] | undefined) ?? [] }
}

/** The `edit_entry` tool's input, or why it is refused. */
export const parseEntryEdit = (input: unknown): EntryEdit | string => {
  if (!isRecord(input)) return 'The input must be an object.'
  const { entryId, day, note, tags } = input
  if (typeof entryId !== 'string' || entryId === '') return 'entryId must be a line’s entryId from the entries tool.'
  if (typeof day !== 'string' || !DAY.test(day)) return 'day must be a day, YYYY-MM-DD.'
  const start = optionalTime(day, input.start, 'start')
  const end = optionalTime(day, input.end, 'end')
  const text = optionalText(note, 'note')
  const labels = optionalTags(tags)
  for (const value of [start, end, text, labels]) if (value instanceof Error) return value.message
  if ([start, end, text, labels].every(value => value === undefined)) return 'Say what to change: start, end, note or tags.'
  if (typeof start === 'number' && typeof end === 'number' && end <= start) return 'end must come after start.'
  return {
    entryId,
    day,
    ...(start === undefined ? {} : { start: start as number }),
    ...(end === undefined ? {} : { end: end as number }),
    ...(text === undefined ? {} : { note: (text as string).trim() }),
    ...(labels === undefined ? {} : { tags: labels as string[] }),
  }
}

/** Segments in order, those that touch or overlap joined into one. */
const joined = (segments: readonly Segment[]): Segment[] =>
  [...segments]
    .sort((a, b) => a.start - b.start)
    .reduce<Segment[]>((out, s) => {
      const last = out.at(-1)
      if (last === undefined || (last.end !== undefined && last.end < s.start)) return [...out, s]
      const end = last.end === undefined || s.end === undefined ? undefined : Math.max(last.end, s.end)
      return [...out.slice(0, -1), end === undefined ? { start: last.start } : { start: last.start, end }]
    }, [])

/**
 * An entry with its time on `day` (from `dayStart` to `dayEnd`) made to begin
 * at `start` and to end at `end`, either left as it is when absent: earlier
 * than its first start, or later than its last end, widens the day's first or
 * last segment; inside them, cuts the time before or after away. Refused when
 * the entry has no time that day, when it would have none left, and for the
 * end of a timer still running.
 */
export const reshapeDay = (
  entry: Entry,
  day: string,
  { dayStart, dayEnd, start, end }: { dayStart: number; dayEnd: number; start?: number; end?: number },
): Entry | string => {
  const ofDay = entry.segments.filter(s => (s.end ?? Infinity) > dayStart && s.start < dayEnd)
  const first = ofDay[0]
  const last = ofDay.at(-1)
  if (first === undefined || last === undefined) return `Timer ${entry.id} has no time on ${day}.`
  if (end !== undefined && last.end === undefined) return 'The timer is still running: stop it before changing its end.'
  let segments = entry.segments
  if (start !== undefined && start < first.start) segments = segments.map(s => (s === first ? { ...s, start } : s))
  if (end !== undefined && last.end !== undefined && end > last.end) segments = segments.map(s => (s === last ? { ...s, end } : s))
  let reshaped: Entry = { ...entry, segments: joined(segments) }
  if (start !== undefined && start > Math.max(first.start, dayStart)) reshaped = cutRange(reshaped, dayStart, start)
  if (end !== undefined && end < Math.min(last.end ?? Infinity, dayEnd)) reshaped = cutRange(reshaped, end, dayEnd)
  if (!hasTimeIn(reshaped, dayStart, dayEnd)) {
    return `That leaves no time on ${day}: delete the timer in the panel instead.`
  }
  const lastEnd = reshaped.segments.at(-1)?.end
  const isEndMoved = lastEnd !== entry.segments.at(-1)?.end
  return reshaped.stoppedAt === undefined || lastEnd === undefined || !isEndMoved ? reshaped : { ...reshaped, stoppedAt: lastEnd }
}

/**
 * Records that `day` of an entry was booked, under whatever reference the
 * booking has (an activity id, say); refused for a day the entry has no time on.
 */
export const markBooked = (entry: Entry, day: string, reference: string): Entry | string => {
  if (!minutesByDay(entry).has(day)) return `Timer ${entry.id} has no time on ${day}.`
  return { ...entry, booked: { ...entry.booked, [day]: reference } }
}

const CSV_HEADER = ['entry', 'session', 'repo', 'note', 'day', 'start', 'end', 'minutes', 'state', 'booked', 'tags']

const FORMULA_LEAD = /^[=+\-@\t\r]/

const csvCell = (value: string | number): string => {
  const text = typeof value === 'string' && FORMULA_LEAD.test(value) ? `'${value}` : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Every segment of every entry as one CSV row, oldest first. */
export const toCsv = (entries: readonly Entry[], now: number): string => {
  const rows = entries
    .flatMap(entry =>
      entry.segments.map(s => {
        const day = dayOf(s.start)
        return {
          start: s.start,
          cells: [
            entry.id,
            entry.sessionId,
            entry.repoName,
            entry.note,
            day,
            timeOf(s.start),
            s.end === undefined ? '' : timeOf(s.end),
            Math.round(((s.end ?? now) - s.start) / MS_PER_MINUTE),
            stateOf(entry),
            entry.booked?.[day] === undefined ? '' : String(entry.booked[day]),
            (entry.tags ?? []).join(' '),
          ],
        }
      }),
    )
    .sort((a, b) => a.start - b.start)
  return [CSV_HEADER, ...rows.map(r => r.cells)].map(cells => cells.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const MAX_TAGS = 10
const MAX_TAG_LENGTH = 32

/**
 * The tags a person typed, split on spaces and commas, a leading `#` dropped,
 * each kept once in the order given: at most ten, each cut to 32 characters.
 */
export const parseTags = (text: string): string[] =>
  [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map(tag => tag.replace(/^#+/, '').slice(0, MAX_TAG_LENGTH))
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAGS)

/**
 * A work branch as words for a timer's name (`feat/login-sso` → `login sso`);
 * undefined for a default branch or a detached HEAD, which name no task.
 */
export const branchLabel = (branch: string): string | undefined => {
  if (DEFAULT_BRANCHES.has(branch)) return undefined
  const words = branch.split('/').at(-1)?.replace(/[-_]+/g, ' ').trim()
  return words || undefined
}

/** What a timer is called and booked as: its note, else its branch, else its repo. */
export const titleOf = (entry: Entry): string =>
  entry.note ||
  entry.task?.title ||
  (entry.branch === undefined ? undefined : branchLabel(entry.branch)) ||
  entry.repoName

/** A local folder as a `file:` URL, a Windows drive kept as written and every other segment encoded. */
export const fileUrl = (path: string): string => {
  const joined = path
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file://${joined.startsWith('/') ? '' : '/'}${joined}`
}

/**
 * Every entry with time on `day`, oldest first: from its first start that day
 * to its last end (`now` while it runs), the minutes worked that day, the
 * repo it ran in, and the minutes it ran alongside the other timers that day.
 */
export const todayRows = (entries: readonly Entry[], day: string, now: number, withAgents = false): TodayRow[] => {
  const ofDay = entries
    .map(entry => ({
      entry,
      segments: entry.segments.flatMap(s => splitAtMidnight(s, now)).filter(s => dayOf(s.start) === day),
    }))
    .filter(({ segments }) => segments.length > 0)
  const closed = new Map(ofDay.map(({ entry, segments }) => [entry.id, segments.map(s => ({ start: s.start, end: s.end ?? now }))]))
  const sharedWithOthers = (id: string) =>
    ofDay
      .filter(({ entry }) => entry.id !== id)
      .reduce((sum, { entry }) => sum + sharedMs(closed.get(id) ?? [], closed.get(entry.id) ?? []), 0)
  return ofDay
    .map(({ entry, segments }) => {
      const first = Math.min(...segments.map(s => s.start))
      const isOpen = segments.some(s => s.end === undefined)
      const last = Math.max(...segments.map(s => s.end ?? now))
      return {
        first,
        row: {
          id: entry.id,
          sessionId: entry.sessionId,
          from: timeOf(first),
          to: isOpen ? 'now' : timeOf(last),
          minutes: Math.round(
            (segments.reduce((sum, s) => sum + (s.end ?? now) - s.start, 0) +
              (withAgents ? (entry.agentMs?.[day] ?? 0) : 0)) /
              MS_PER_MINUTE,
          ),
          state: stateOf(entry),
          note: entry.note,
          tags: entry.tags ?? [],
          name: titleOf(entry),
          repo: entry.location === undefined ? { name: entry.repoName } : { name: entry.repoName, path: entry.location },
          isBooked: entry.booked?.[day] !== undefined,
          ...((entry.costUsd?.[day] ?? 0) > 0 ? { costUsd: entry.costUsd?.[day] } : {}),
          overlapMinutes: Math.round(sharedWithOthers(entry.id) / MS_PER_MINUTE),
        },
      }
    })
    .sort((a, b) => a.first - b.first)
    .map(({ row }) => row)
}

/**
 * The whole minutes worked on `day` by `entries` together. Summed, each
 * timer's own minutes add up, so two timers run at once count twice; on the
 * wall clock the time they ran at once counts once. Subagents' runs add on top
 * when `withAgents`.
 */
export const dayMinutes = (
  entries: readonly Entry[],
  day: string,
  now: number,
  { withAgents, wallClock }: { withAgents: boolean; wallClock: boolean },
): number => {
  if (!wallClock) return todayRows(entries, day, now, withAgents).reduce((sum, r) => sum + r.minutes, 0)
  const pieces = entries
    .flatMap(entry => entry.segments.flatMap(s => splitAtMidnight(s, now)))
    .filter(s => dayOf(s.start) === day)
    .map(s => ({ start: s.start, end: s.end ?? now }))
    .sort((a, b) => a.start - b.start)
  let covered = 0
  let reach = -Infinity
  for (const { start, end } of pieces) {
    covered += Math.max(0, end - Math.max(start, reach))
    reach = Math.max(reach, end)
  }
  const agents = withAgents ? entries.reduce((sum, entry) => sum + (entry.agentMs?.[day] ?? 0), 0) : 0
  return Math.round((covered + agents) / MS_PER_MINUTE)
}

/**
 * Takes a paused or stopped entry up again in `sessionId`: running from `now`,
 * no longer stopped.
 */
export const reopenEntry = (entry: Entry, sessionId: string, now: number): Entry | string => {
  if (stateOf(entry) === 'running') return 'That timer is already running.'
  const { stoppedAt: _, ...open } = entry
  return { ...open, sessionId, segments: [...entry.segments, { start: now }], lastSeen: now }
}
