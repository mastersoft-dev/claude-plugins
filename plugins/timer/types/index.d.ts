export type Segment = { start: number; end?: number }

export type Entry = {
  id: string
  sessionId: string
  repoKey: string
  repoName: string
  note: string
  segments: Segment[]
  stoppedAt?: number
  lastSeen?: number
  auto?: boolean
  location?: string
  branch?: string
  booked?: Record<string, number>
}

export type Project = { id: number; label: string }

/** What a repo's time books onto: a project, a customer still missing one, or nobody. */
export type Link =
  | { kind: 'project'; project: Project }
  | { kind: 'customer'; customers: string[] }
  | { kind: 'none' }

export type Draft = {
  entryId: string
  day: string
  startHour: number
  minutes: number
  project: Project
  descrizione: string
  isSkipped?: boolean
}

export type BookView = {
  kind: 'book'
  drafts: Draft[]
  needsProject: string[]
  ignored: number
  results: string[]
  isBusy: boolean
  isDone: boolean
}

export type PickView = {
  kind: 'pick'
  repoKey: string
  repoName: string
  matches: Project[]
}

export type TodayTab = 'session' | 'all'

export type TodayView = {
  kind: 'today'
  tab: TodayTab
  selectedId: string | null
  confirmDeleteId: string | null
}

/** One timer of the day as the Today pane lists it. */
export type TodayRow = {
  id: string
  sessionId: string
  from: string
  to: string
  minutes: number
  state: 'running' | 'paused' | 'stopped'
  note: string
  /** The note, else the branch's words, else the repo's name (its git remote's, else its folder's). */
  name: string
  where: string
  /** The repo it ran in, shown when its time books onto no project; `path` is its folder. */
  repo?: { name: string; path?: string }
  isBooked: boolean
}

export type View = BookView | PickView | TodayView

export type Band = {
  state: 'idle' | 'running' | 'paused'
  worked: string
  note: string
  /** What the timer is called while it has no note: its branch's words, else its repo. */
  defaultTitle: string
  unbooked: number
  auto: boolean
  isBookTime: boolean
}

declare module 'claude-code' {
  interface PluginState {
    timer: {
      activeId: string | null
      view: View | null
      band: Band | null
      /** The timer the band asks about after a /clear: keep it running or stop it. */
      askAfterClear: string | null
    }
  }
}
