import type { Draft, Entry, Link, Project, Segment, TodayRow } from '../types'

export const TIME_ZONE = 'Europe/Rome'
export const BOOKING_STEP_MINUTES = 5
const MS_PER_MINUTE = 60_000

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

/** The calendar day of `ms` in GEWEB's time zone, as YYYY-MM-DD. */
export const dayOf = (ms: number): string => dayFormat.format(ms)

/** The wall-clock time of `ms` in GEWEB's time zone, as HH:mm. */
export const timeOf = (ms: number): string => timeFormat.format(ms)

/** The hour (0-23) of `ms` in GEWEB's time zone. */
export const hourOf = (ms: number): number => Number(timeOf(ms).slice(0, 2))

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
 * Stops a running entry whose session stopped beating before `staleBefore`
 * (a crash or a killed terminal), at the last moment it was seen alive.
 */
export const closeStale = (entry: Entry, staleBefore: number): Entry | undefined => {
  if (stateOf(entry) !== 'running') return undefined
  const lastSeen = entry.lastSeen ?? entry.segments.at(-1)?.start ?? staleBefore
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
    (e.booked === undefined || (typeof e.booked === 'object' && Object.values(e.booked).every(isNumber)))
  return isValid ? e : undefined
}

/**
 * A git remote in GEWEB's canonical `host/path` form, as
 * `hr.gitrepo_url.canonicalizza_remote_url` stores `GitRepo.remote_url`.
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

/**
 * Minutes worked per day, each closed segment counted on the day it started
 * (GEWEB refuses a day's time past midnight anyway).
 */
export const minutesByDay = (entry: Entry): Map<string, { minutes: number; firstStart: number }> => {
  const days = new Map<string, { minutes: number; firstStart: number }>()
  for (const s of entry.segments) {
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

/**
 * Rounds to whole minutes, then up to GEWEB's 5-minute step as
 * `aggiungi_tempo` does; under half a minute is nothing to book.
 */
export const roundToStep = (minutes: number): number =>
  Math.ceil(Math.round(minutes) / BOOKING_STEP_MINUTES) * BOOKING_STEP_MINUTES

/**
 * The days of a stopped entry still to book: some time to book, and no
 * activity (or claim on one) recorded under `booked`.
 */
export const pendingDays = (entry: Entry): [string, { minutes: number; firstStart: number }][] =>
  stateOf(entry) === 'stopped'
    ? [...minutesByDay(entry)].filter(
        ([day, { minutes }]) => entry.booked?.[day] === undefined && roundToStep(minutes) > 0,
      )
    : []

/**
 * One draft per pending day of each entry whose repo books onto a project; a
 * line per repo that belongs to a customer but has no project yet; and how
 * many entries belong to nobody and are left alone.
 */
export const planBooking = (
  entries: readonly Entry[],
  linkOf: (entry: Entry) => Link,
): { drafts: Draft[]; needsProject: string[]; ignored: number } => {
  const drafts: Draft[] = []
  const unlinked = new Map<string, { n: number; customers: string[] }>()
  let ignored = 0
  for (const entry of entries) {
    const pending = pendingDays(entry)
    if (pending.length === 0) continue
    const link = linkOf(entry)
    if (link.kind === 'none') {
      ignored += 1
      continue
    }
    if (link.kind === 'customer') {
      const held = unlinked.get(entry.repoName)
      unlinked.set(entry.repoName, { n: (held?.n ?? 0) + 1, customers: link.customers })
      continue
    }
    for (const [day, { minutes, firstStart }] of pending) {
      drafts.push({
        entryId: entry.id,
        day,
        startHour: hourOf(firstStart),
        minutes: roundToStep(minutes),
        project: link.project,
        descrizione: entry.note || entry.repoName,
      })
    }
  }
  const needsProject = [...unlinked].map(
    ([repo, { n, customers }]) =>
      `${n} entr${n === 1 ? 'y' : 'ies'} in ${repo} (${customers.join(', ')}): no project, run /timer project <search> there`,
  )
  return { drafts: drafts.sort((a, b) => a.day.localeCompare(b.day)), needsProject, ignored }
}

const CSV_HEADER = ['entry', 'session', 'repo', 'project', 'note', 'day', 'start', 'end', 'minutes', 'state', 'activity']

const FORMULA_LEAD = /^[=+\-@\t\r]/

const csvCell = (value: string | number): string => {
  const text = typeof value === 'string' && FORMULA_LEAD.test(value) ? `'${value}` : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Every segment of every entry as one CSV row, oldest first. */
export const toCsv = (
  entries: readonly Entry[],
  projectOf: (entry: Entry) => Project | undefined,
  now: number,
): string => {
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
            projectOf(entry)?.label ?? '',
            entry.note,
            day,
            timeOf(s.start),
            s.end === undefined ? '' : timeOf(s.end),
            Math.round(((s.end ?? now) - s.start) / MS_PER_MINUTE),
            stateOf(entry),
            entry.booked?.[day] ? String(entry.booked[day]) : '',
          ],
        }
      }),
    )
    .sort((a, b) => a.start - b.start)
  return [CSV_HEADER, ...rows.map(r => r.cells)].map(cells => cells.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/**
 * Every entry with time on `day`, oldest first: from its first start that day
 * to its last end (`now` while it runs), the minutes worked that day, and where
 * it books as `whereOf` names it.
 */
export const todayRows = (
  entries: readonly Entry[],
  day: string,
  now: number,
  whereOf: (entry: Entry) => string,
): TodayRow[] =>
  entries
    .map(entry => ({ entry, segments: entry.segments.filter(s => dayOf(s.start) === day) }))
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
          where: whereOf(entry),
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
