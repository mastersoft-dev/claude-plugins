export type Segment = { start: number; end?: number }

/**
 * What an orchestrator says the timer's work is: `group` is the place it runs
 * in (an Orca worktree), `title` the task's name (its linked issue, or a name
 * the person gave it) and `url` the issue's link.
 */
export type Task = { source: string; group: string; title?: string; url?: string }

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
  task?: Task
  /** Free labels the person gives the timer (review, meeting, support), listed with its time. */
  tags?: string[]
  /** Per day, the reference of the booking that took it (an activity id); 0.1.0 wrote numbers. */
  booked?: Record<string, string | number>
  /**
   * Per day, the milliseconds subagents worked while the timer ran. Kept under
   * its own store key and joined on load, never written with the entry.
   */
  agentMs?: Record<string, number>
}

/** One entry's time on one day, as the `entries` tool hands it to whoever books it. */
export type BookingLine = {
  entryId: string
  day: string
  /** When the timer first started that day, HH:mm, Italian time. */
  start: string
  /** Whole minutes, the closed time only, rounded to the person's `roundTo` when set. */
  minutes: number
  /** The whole minutes before rounding, when rounding changed them. */
  exactMinutes?: number
  /** The note, else the orchestrator's task title, else the branch's words, else the repo's name. */
  title: string
  note: string
  tags?: string[]
  repo: string
  /** The git remote as `host/path`, when the repo has one. */
  remote?: string
  branch?: string
  folder?: string
  /** The orchestrator's task, when the timer started under one. */
  task?: Task
  state: 'running' | 'paused' | 'stopped'
  booked?: string
  /** Whole minutes subagents worked that day while the timer ran; in `minutes` too when agent time is summed. */
  agentMinutes?: number
  /** The other timers that ran at the same time that day, with the whole minutes they share with this one. */
  overlaps?: { entryId: string; title: string; minutes: number }[]
}

/** The panel's tabs: today's timers of this session, today's of every session, and every day still to book. */
export type TodayTab = 'session' | 'all' | 'book'

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
  tags: string[]
  /** The note, else the branch's words, else the repo's name (its git remote's, else its folder's). */
  name: string
  /** The repo it ran in; `path` is its folder. */
  repo: { name: string; path?: string }
  isBooked: boolean
}

export type View = TodayView

/**
 * Time the person was away while a timer ran: from `from`, until `to` once they
 * are back (null while they are still away).
 */
export type Away = { entryId: string; from: number; to: number | null }

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
      /** The away time the band asks about, or that waits for the person to be back. */
      away: Away | null
    }
  }
}
