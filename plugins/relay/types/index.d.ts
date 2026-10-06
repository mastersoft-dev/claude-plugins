export type RelayMode = 'focused' | 'full'

export type RelaySummary = 'local' | 'model'

export type RelayPhase = 'idle' | 'loading' | 'ready' | 'working'

export type RelayTarget = { value: string; label: string; note: string }

export type RelayTodo = { content: string; status: string }

export type RelayDigest = {
  goal: string
  recentPrompts: string[]
  lastAnswer: string
  files: string[]
  failed: string[]
  todos: RelayTodo[]
  git: string
}

export type RelayPanel = {
  phase: RelayPhase
  targets: RelayTarget[]
  target: string
  mode: RelayMode
  summary: RelaySummary
  isWarm: boolean
  isCacheKnown: boolean
  idleMinutes: number
  contextTokens: number
  digest: RelayDigest | null
  transcriptPath: string | null
  message: string
}

export type RelayBand = { activityAt: number; idleMinutes: number; contextTokens: number }

declare module 'claude-code' {
  interface PluginState {
    relay: {
      panel: RelayPanel
      band: RelayBand | null
      lastActivityAt: number | null
      dismissedFor: number | null
      transcriptPath: string | null
    }
  }
}
