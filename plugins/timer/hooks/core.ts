import type { BookingLine, Entry, Segment, TodayRow } from '../types'

export const TIME_ZONE = 'Europe/Rome'
export const PATH_KEY_PREFIX = 'path:'
const MS_PER_MINUTE = 60_000
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

export const workedMs = (entry: Entry, now: number): number =>
  entry.segments.reduce((sum, s) => sum + ((s.end ?? now) - s.start), 0)

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
export const minutesByDay = (entry: Entry): Map<string, { minutes: number; firstStart: number }> => {
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

/**
 * One line per entry and day, oldest first, for whoever books the time (Claude,
 * through the timer's `entries` tool): whole minutes, the closed time only, so
 * a timer still open counts what it has done so far and says it is open.
 */
export const bookingLines = (
  entries: readonly Entry[],
  range: { from?: string; to?: string; includeBooked?: boolean },
): BookingLine[] =>
  entries
    .flatMap(entry =>
      [...minutesByDay(entry)].map(([day, { minutes, firstStart }]) => {
        const booked = entry.booked?.[day]
        return {
          firstStart,
          line: {
            entryId: entry.id,
            day,
            start: timeOf(firstStart),
            minutes: Math.round(minutes),
            title: titleOf(entry),
            note: entry.note,
            repo: entry.repoName,
            ...(entry.repoKey.startsWith(PATH_KEY_PREFIX) ? {} : { remote: entry.repoKey }),
            ...(entry.branch === undefined ? {} : { branch: entry.branch }),
            ...(entry.location === undefined ? {} : { folder: entry.location }),
            state: stateOf(entry),
            ...(booked === undefined ? {} : { booked: String(booked) }),
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

const DAY = /^\d{4}-\d{2}-\d{2}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The `entries` tool's input, or why it is refused. */
export const parseBookingRange = (input: unknown): { from?: string; to?: string; includeBooked?: boolean } | string => {
  if (!isRecord(input)) return 'The input must be an object.'
  const { from, to, includeBooked } = input
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !DAY.test(value))) return `${name} must be a day, YYYY-MM-DD.`
  }
  if (includeBooked !== undefined && typeof includeBooked !== 'boolean') return 'includeBooked must be true or false.'
  return {
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

/**
 * Records that `day` of an entry was booked, under whatever reference the
 * booking has (an activity id, say); refused for a day the entry has no time on.
 */
export const markBooked = (entry: Entry, day: string, reference: string): Entry | string => {
  if (!minutesByDay(entry).has(day)) return `Timer ${entry.id} has no time on ${day}.`
  return { ...entry, booked: { ...entry.booked, [day]: reference } }
}

const CSV_HEADER = ['entry', 'session', 'repo', 'note', 'day', 'start', 'end', 'minutes', 'state', 'booked']

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
          ],
        }
      }),
    )
    .sort((a, b) => a.start - b.start)
  return [CSV_HEADER, ...rows.map(r => r.cells)].map(cells => cells.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

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
  entry.note || (entry.branch === undefined ? undefined : branchLabel(entry.branch)) || entry.repoName

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
 * to its last end (`now` while it runs), the minutes worked that day, and the
 * repo it ran in.
 */
export const todayRows = (entries: readonly Entry[], day: string, now: number): TodayRow[] =>
  entries
    .map(entry => ({
      entry,
      segments: entry.segments.flatMap(s => splitAtMidnight(s, now)).filter(s => dayOf(s.start) === day),
    }))
    .filter(({ segments }) => segments.length > 0)
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
          minutes: Math.round(segments.reduce((sum, s) => sum + (s.end ?? now) - s.start, 0) / MS_PER_MINUTE),
          state: stateOf(entry),
          note: entry.note,
          name: titleOf(entry),
          repo: entry.location === undefined ? { name: entry.repoName } : { name: entry.repoName, path: entry.location },
          isBooked: entry.booked?.[day] !== undefined,
        },
      }
    })
    .sort((a, b) => a.first - b.first)
    .map(({ row }) => row)

/**
 * Takes a paused or stopped entry up again in `sessionId`: running from `now`,
 * no longer stopped.
 */
export const reopenEntry = (entry: Entry, sessionId: string, now: number): Entry | string => {
  if (stateOf(entry) === 'running') return 'That timer is already running.'
  const { stoppedAt: _, ...open } = entry
  return { ...open, sessionId, segments: [...entry.segments, { start: now }], lastSeen: now }
}
