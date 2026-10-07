import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, Register, Timer } from 'claude-code'

import type { BookView, Draft, Entry, Link, PickView, Project, TodayRow, TodayTab } from '../types'
import {
  canonicalRemote,
  closeStale,
  dayOf,
  fileUrl,
  formatDuration,
  parseEntry,
  pauseEntry,
  pendingDays,
  planBooking,
  reopenEntry,
  resumeEntry,
  roundToStep,
  startEntry,
  stateOf,
  stopEntry,
  timeOf,
  titleOf,
  toCsv,
  todayRows,
  workedMs,
} from './core'
import { createActivity, customersOfRemote, errorText, fillActivity, projectOfRemote, searchProjects } from './geweb'
import type { Runner } from './geweb'
import { worktreeOf } from './git'

const COMMAND = 'timer'
const PANE = 'timer'
const MS_PER_MINUTE = 60_000
const TICK_MS = 30_000
const STALE_MS = 5 * TICK_MS
const ENTRY_PREFIX = 'entry:'
const SEEN_PREFIX = 'seen:'
const PROJECT_PREFIX = 'project:'
const LINK_PREFIX = 'link:'
const REMINDED_PREFIX = 'reminded:'
const DEFAULT_REMINDER = '17:30'
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const PATH_KEY_PREFIX = 'path:'
const CLAIMED = 0
const EXPORT_PREFIX = 'timer-export-'
const EXPORT_SUFFIX = '.csv'
const BOOK_TITLE = 'Book on GEWEB'
const PICK_TITLE = 'Pick a GEWEB project'
const TODAY_TITLE = 'Timer'
const PANEL_CHROME_ROWS = 9
const PANEL_MAX_ROWS = 30
const USAGE =
  'Usage: /timer [status] | start [note] | pause | resume | stop | auto | open | project [search] | book | export [file.csv]'

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

const isProject = (value: unknown): value is Project =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Project).id === 'number' &&
  typeof (value as Project).label === 'string'

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

const storedProject = async ($: EngineInterface, repoKey: string): Promise<Project | undefined> => {
  const value = await $.store.get(PROJECT_PREFIX + repoKey)
  return isProject(value) ? value : undefined
}

const repoOf = async ($: EngineInterface): Promise<Repo> => {
  const repo = await $.session.repo()
  const canonical = repo?.remote ? canonicalRemote(repo.remote) : null
  const root = repo?.root ?? (await $.session.cwd())
  const name = canonical?.split('/').at(-1) ?? root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
  return { key: canonical ?? `${PATH_KEY_PREFIX}${root}`, name, root }
}

const isLink = (value: unknown): value is Link =>
  typeof value === 'object' &&
  value !== null &&
  (((value as Link).kind === 'customer' && Array.isArray((value as { customers?: unknown }).customers)) ||
    (value as Link).kind === 'none')

/** What the repo books onto as last seen, without asking GEWEB; undefined when never checked. */
const cachedLink = async ($: EngineInterface, repoKey: string): Promise<Link | undefined> => {
  const project = await storedProject($, repoKey)
  if (project !== undefined) return { kind: 'project', project }
  const value = await $.store.get(LINK_PREFIX + repoKey)
  return isLink(value) ? value : undefined
}

/**
 * What the repo books onto: a project you picked or GEWEB links to the remote,
 * else the customers it is installed at, else nobody. Falls back to the last
 * answer when GEWEB cannot be reached.
 */
const resolveLink = async ($: EngineInterface, repoKey: string): Promise<Link> => {
  const project = await storedProject($, repoKey)
  if (project !== undefined) return { kind: 'project', project }
  if (repoKey.startsWith(PATH_KEY_PREFIX)) return { kind: 'none' }
  try {
    const linked = await projectOfRemote(runnerOf($), repoKey)
    if (linked !== undefined) {
      await $.store.set(PROJECT_PREFIX + repoKey, linked)
      return { kind: 'project', project: linked }
    }
    const customers = await customersOfRemote(runnerOf($), repoKey)
    const link: Link = customers.length > 0 ? { kind: 'customer', customers } : { kind: 'none' }
    await $.store.set(LINK_PREFIX + repoKey, link)
    return link
  } catch (error) {
    const cached = await cachedLink($, repoKey)
    if (cached === undefined) throw error
    return cached
  }
}

const linkLine = (link: Link, repo: string): string => {
  switch (link.kind) {
    case 'project':
      return `GEWEB project: ${link.project.label}`
    case 'customer':
      return `Customer ${link.customers.join(', ')}, no project linked: /timer project <search> picks one before booking.`
    case 'none':
      return `No GEWEB customer for ${repo}: its time stays local and is never booked.`
  }
}

const projectLine = async ($: EngineInterface, repo: Repo): Promise<string> => {
  try {
    return linkLine(await resolveLink($, repo.key), repo.name)
  } catch (error) {
    return `Could not check GEWEB: ${errorText(error)}`
  }
}

/** Stopped entries still to book, leaving out repos known to belong to nobody. */
const countUnbooked = async ($: EngineInterface, entries: readonly Entry[]): Promise<number> => {
  const links = new Map<string, Link | undefined>()
  let count = 0
  for (const entry of entries) {
    if (pendingDays(entry).length === 0) continue
    if (!links.has(entry.repoKey)) links.set(entry.repoKey, await cachedLink($, entry.repoKey))
    if (links.get(entry.repoKey)?.kind !== 'none') count += 1
  }
  return count
}

let reminderAt = DEFAULT_REMINDER

const isBookTime = (now: number) => timeOf(now) >= reminderAt

const remindOnce = async ($: EngineInterface, now: number, unbooked: number) => {
  if (unbooked === 0 || !isBookTime(now)) return
  const key = REMINDED_PREFIX + dayOf(now)
  if ((await $.store.get(key)) !== undefined) return
  await $.store.set(key, now)
  $.ui.toast(`${plural(unbooked, 'entry', 'entries')} ready for GEWEB: /timer book`)
}

const describe = (entry: Entry, now: number): string =>
  `${formatDuration(workedMs(entry, now))}${titleOf(entry) === entry.repoName ? '' : ` · ${titleOf(entry)}`} (${entry.repoName})`

const beat = async ($: EngineInterface) => {
  const entry = await loadActive($)
  const now = await $.clock.now()
  const unbooked = await countUnbooked($, await loadEntries($))
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

/** Changes an entry's note, which every unbooked day of it is described with on GEWEB. */
const setNote = async ($: EngineInterface, entryId: string, note: string): Promise<string> => {
  const entry = await loadEntry($, entryId)
  if (entry === undefined) return 'That entry is gone.'
  const trimmed = note.trim()
  await saveEntry($, { ...entry, note: trimmed })
  await update($, view, current =>
    current?.kind === 'book'
      ? {
          ...current,
          drafts: current.drafts.map(d =>
            d.entryId === entryId ? { ...d, descrizione: titleOf({ ...entry, note: trimmed }) } : d,
          ),
        }
      : current,
  )
  return `Note set: ${trimmed || `(none, books as ${titleOf({ ...entry, note: '' })})`}`
}

const setActiveNote = async ($: EngineInterface, note: string) => {
  const entry = await loadActive($)
  if (entry === undefined) return
  await fromBand($, () => setNote($, entry.id, note))
}

const editDraft = ($: EngineInterface, index: number, change: (draft: Draft) => Draft) =>
  setBook($, b => (b.isBusy || b.isDone ? b : { ...b, drafts: b.drafts.map((d, i) => (i === index ? change(d) : d)) }))

const setDraftMinutes = async ($: EngineInterface, index: number, value: string) => {
  const minutes = roundToStep(Number(value))
  if (!Number.isFinite(minutes) || minutes <= 0) {
    $.ui.toast(`"${value}" is not a number of minutes above 0`)
    return
  }
  await editDraft($, index, d => ({ ...d, minutes }))
}

const setDraftNote = async ($: EngineInterface, draft: Draft, value: string) => {
  $.ui.toast(await setNote($, draft.entryId, value))
}

const toggleSkip = ($: EngineInterface, index: number) => editDraft($, index, d => ({ ...d, isSkipped: d.isSkipped !== true }))

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
  return [`Timer started in ${repo.name}.`, await projectLine($, repo), ...overlap].join('\n')
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
  const unbooked = await countUnbooked($, entries)
  return [
    active === undefined ? 'No timer in this session.' : `This session: ${stateOf(active)} ${describe(active, now)}`,
    `Today, every session: ${formatDuration(todayMs)}`,
    unbooked > 0 ? `${plural(unbooked, 'stopped entry', 'stopped entries')} not booked on GEWEB yet: /timer book` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const exportCsv = async ($: EngineInterface, path: string): Promise<string> => {
  const now = await $.clock.now()
  const entries = await loadEntries($)
  if (entries.length === 0) return 'Nothing tracked yet.'
  const projects = new Map<string, Project | undefined>()
  for (const key of new Set(entries.map(e => e.repoKey))) projects.set(key, await storedProject($, key))
  const target = path || `${EXPORT_PREFIX}${dayOf(now)}${EXPORT_SUFFIX}`
  await $.fs.write(target, toCsv(entries, e => projects.get(e.repoKey), now))
  const sessions = new Set(entries.map(e => e.sessionId)).size
  return `Exported ${plural(entries.length, 'entry', 'entries')} from ${plural(sessions, 'session', 'sessions')} to ${target}`
}

const pickProject = async ($: EngineInterface, words: string): Promise<string> => {
  const repo = await repoOf($)
  if (!words) return `${repo.name}: ${await projectLine($, repo)}`
  let matches: Project[]
  try {
    matches = await searchProjects(runnerOf($), words)
  } catch (error) {
    return `Could not search GEWEB: ${errorText(error)}`
  }
  if (matches.length === 0) return `No open GEWEB project matches "${words}".`
  const pick: PickView = { kind: 'pick', repoKey: repo.key, repoName: repo.name, matches }
  await update($, view, () => pick)
  await $.ui.open({ id: PANE, title: PICK_TITLE, focus: true })
  return `${plural(matches.length, 'project matches', 'projects match')}: pick one in the pane.`
}

const prepareBooking = async ($: EngineInterface): Promise<string> => {
  await recoverStale($, (await $.clock.now()) - STALE_MS)
  const entries = await loadEntries($)
  const links = new Map<string, Link>()
  try {
    for (const entry of entries) {
      if (links.has(entry.repoKey) || pendingDays(entry).length === 0) continue
      links.set(entry.repoKey, await resolveLink($, entry.repoKey))
    }
  } catch (error) {
    return `Could not reach GEWEB: ${errorText(error)}`
  }
  const { drafts, needsProject, ignored } = planBooking(entries, e => links.get(e.repoKey) ?? { kind: 'none' })
  if (drafts.length === 0 && needsProject.length === 0) return 'Nothing to book on GEWEB.'
  const book: BookView = {
    kind: 'book',
    drafts,
    needsProject,
    ignored,
    results: [],
    isBusy: false,
    isDone: drafts.length === 0,
  }
  await update($, view, () => book)
  await $.ui.open({ id: PANE, title: BOOK_TITLE, focus: true })
  return `${plural(drafts.length, 'slot', 'slots')} ready to book: confirm in the pane.`
}

const setBooked = async ($: EngineInterface, draft: Draft, value: number | undefined) => {
  const entry = await loadEntry($, draft.entryId)
  if (entry === undefined) throw new Error(`entry ${draft.entryId} is gone from the store`)
  const { [draft.day]: _, ...rest } = entry.booked ?? {}
  await saveEntry($, { ...entry, booked: value === undefined ? rest : { ...rest, [draft.day]: value } })
}

/**
 * Books one draft: claims its day in the store first, so a retry or another
 * session never books it twice, then records the activity id as soon as GEWEB
 * created it. Resolves the result line, and whether to go on with the rest.
 */
const bookOne = async ($: EngineInterface, draft: Draft): Promise<{ line: string; isOk: boolean }> => {
  const label = `${draft.day} ${draft.minutes} min ${draft.project.label}`
  const fresh = await loadEntry($, draft.entryId)
  if (fresh?.booked?.[draft.day] !== undefined) return { line: `– ${label}: already booked`, isOk: true }
  await setBooked($, draft, CLAIMED)
  let id: number
  try {
    id = await createActivity(runnerOf($), draft)
  } catch (error) {
    await setBooked($, draft, undefined)
    return { line: `✗ ${label}: ${errorText(error)}`, isOk: false }
  }
  try {
    await setBooked($, draft, id)
  } catch (error) {
    return { line: `✗ ${label}: activity ${id} created but not recorded here (${errorText(error)})`, isOk: false }
  }
  const warning = await fillActivity(runnerOf($), id, draft)
  return { line: warning === undefined ? `✓ ${label} → activity ${id}` : `! ${label}: ${warning}`, isOk: true }
}

const setBook = ($: EngineInterface, change: (book: BookView) => BookView) =>
  update($, view, current => (current?.kind === 'book' ? change(current) : current))

const choose = async ($: EngineInterface, pick: PickView, project: Project) => {
  await $.store.set(PROJECT_PREFIX + pick.repoKey, project)
  await closePane($)
  $.ui.toast(`${pick.repoName} now books on ${project.label}`)
}

/** Where an entry's time goes, for the Today pane: its project, else the repo it ran in. */
const whereOf = (entry: Entry, link: Link | undefined): Pick<TodayRow, 'where' | 'repo'> => {
  const repo = { name: entry.repoName, path: entry.location }
  switch (link?.kind) {
    case 'project':
      return { where: link.project.label }
    case 'customer':
      return { where: `${link.customers.join(', ')}, no project · `, repo }
    default:
      return { where: '', repo }
  }
}

const openToday = async ($: EngineInterface): Promise<string> => {
  const now = await $.clock.now()
  const count = todayRows(await loadEntries($), dayOf(now), now, () => ({ where: '' })).length
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
 * gone from the export and from booking; an activity already on GEWEB stays.
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
  const activities = Object.values(entry?.booked ?? {}).filter(Boolean)
  $.ui.toast(
    activities.length === 0
      ? 'Timer deleted.'
      : `Timer deleted. It was already booked on GEWEB (activity ${activities.join(', ')}): delete it there too.`,
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
let isBooking = false

const confirmBooking = async ($: EngineInterface) => {
  if (isBooking) return
  isBooking = true
  try {
    const current = await read($, view)
    if (current?.kind !== 'book' || current.isDone) return
    await setBook($, b => ({ ...b, isBusy: true }))
    let booked = 0
    const chosen = current.drafts.filter(d => d.isSkipped !== true)
    for (const draft of chosen) {
      const { line, isOk } = await bookOne($, draft)
      await setBook($, b => ({ ...b, results: [...b.results, line] }))
      if (!isOk) {
        await setBook($, b => ({ ...b, results: [...b.results, 'Stopped: the rest stays unbooked.'] }))
        break
      }
      booked += 1
    }
    $.ui.toast(`Booked ${booked} of ${chosen.length} on GEWEB`)
  } finally {
    await setBook($, b => ({ ...b, isBusy: false, isDone: true }))
    isBooking = false
  }
}

export const register: Register = (on, options) => {
  const configured = String(options.reminderTime ?? '')
  reminderAt = CLOCK_TIME.test(configured) ? configured : DEFAULT_REMINDER

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Track work time: start, pause, resume, stop, auto, open (panel), status, project, book (GEWEB), export',
      argumentHint: '[status] | start [note] | pause | resume | stop | auto | open | project [search] | book | export [file]',
      immediate: true,
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
        case 'project':
          return pickProject($, arg)
        case 'book':
          return prepareBooking($)
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
    const book = info.isBookTime && info.unbooked > 0 && (
      <Button key="book" label={`Book all (${info.unbooked})`} onPress={() => fromBand($, () => prepareBooking($))} />
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
              {book}
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
            {book}
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

    if (current.kind === 'today') {
      await read($, band)
      const now = await $.clock.now()
      const own = await read($, activeId)
      const sessionId = await $.session.id()
      const entries = await loadEntries($)
      const links = new Map<string, Link | undefined>()
      for (const entry of entries) {
        if (!links.has(entry.repoKey)) links.set(entry.repoKey, await cachedLink($, entry.repoKey))
      }
      const allRows = todayRows(entries, dayOf(now), now, entry => whereOf(entry, links.get(entry.repoKey)))
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
          {rows.length > 0 && (
            <Text dimColor>Select a timer of this session to change its note, continue or delete it.</Text>
          )}
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
                  {r.where}
                  {r.repo === undefined ? '' : r.repo.path === undefined ? r.repo.name : <Link href={fileUrl(r.repo.path)}>{r.repo.name}</Link>}
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
    }

    if (current.kind === 'pick') {
      return (
        <Box flexDirection="column">
          <Text bold>GEWEB project for {current.repoName}</Text>
          {current.matches.map(project => (
            <Button key={`p${project.id}`} label={project.label} onPress={() => choose($, current, project)} />
          ))}
          <Button key="cancel" label="Cancel" role="dismiss" onPress={() => closePane($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>Book on the GEWEB live timesheet</Text>
        {!current.isBusy && !current.isDone && current.drafts.length > 0 && (
          <Text dimColor>Edit a description or minutes and press Enter; Skip leaves a line out of this batch.</Text>
        )}
        {current.drafts.map((d, i) =>
          current.isBusy || current.isDone || Input === undefined ? (
            <Text key={`d${i}`} dimColor={d.isSkipped === true}>
              {d.day} {String(d.minutes).padStart(4)} min {d.project.label} · {d.descrizione}
              {d.isSkipped === true ? ' (skipped)' : ''}
            </Text>
          ) : (
            <Box key={`d${i}`} flexDirection="column">
              <Text dimColor={d.isSkipped === true}>
                {d.day} {d.project.label}
                {d.isSkipped === true ? ' (skipped)' : ''}
              </Text>
              <Box gap={1}>
                <Input
                  key={`desc${i}`}
                  label="Description"
                  value={d.descrizione}
                  submitLabel="Set"
                  onSubmit={(value: string) => setDraftNote($, d, value)}
                />
                <Input
                  key={`min${i}`}
                  label="Minutes"
                  value={String(d.minutes)}
                  submitLabel="Set"
                  onSubmit={(value: string) => setDraftMinutes($, i, value)}
                />
                <Button
                  key={`skip${i}`}
                  label={d.isSkipped === true ? 'Include' : 'Skip'}
                  onPress={() => toggleSkip($, i)}
                />
              </Box>
            </Box>
          ),
        )}
        {current.needsProject.map((line, i) => (
          <Text key={`n${i}`} color="yellow">
            Needs a project: {line}
          </Text>
        ))}
        {current.ignored > 0 && (
          <Text dimColor>{plural(current.ignored, 'entry', 'entries')} with no GEWEB customer left out</Text>
        )}
        {current.results.map((line, i) => (
          <Text key={`r${i}`}>{line}</Text>
        ))}
        {!current.isBusy && (
          <Box>
            {!current.isDone && (
              <Button
                key="confirm"
                label={`Confirm ${current.drafts.filter(d => d.isSkipped !== true).length}`}
                variant="primary"
                onPress={() => confirmBooking($)}
              />
            )}
            <Button
              key="close"
              label={current.isDone ? 'Close' : 'Cancel'}
              role="dismiss"
              onPress={() => closePane($)}
            />
          </Box>
        )}
        {current.isBusy && <Text dimColor>Booking…</Text>}
      </Box>
    )
  })
}
