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
  /** Per day, the reference of the booking that took it (an activity id); 0.1.0 wrote numbers. */
  booked?: Record<string, string | number>
}

/** One entry's time on one day, as the `entries` tool hands it to whoever books it. */
export type BookingLine = {
  entryId: string
  day: string
  /** When the timer first started that day, HH:mm, Italian time. */
  start: string
  /** Whole minutes, the closed time only. */
  minutes: number
  /** The note, else the branch's words, else the repo's name. */
  title: string
  note: string
  repo: string
  /** The git remote as `host/path`, when the repo has one. */
  remote?: string
  branch?: string
  folder?: string
  state: 'running' | 'paused' | 'stopped'
  booked?: string
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
  /** The repo it ran in; `path` is its folder. */
  repo: { name: string; path?: string }
  isBooked: boolean
}

export type View = TodayView

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
