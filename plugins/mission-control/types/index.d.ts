export type RowState = 'running' | 'done' | 'needs' | 'failed'

export type Row = {
  id: string
  kind: 'main' | 'agent'
  title: string
  state: RowState
  startedAt: number
  endedAt: number | null
  tool: string
  model: string | null
  parentId: string | null
}

export type FeedItem = { at: number; who: string; tool: string; detail: string; isError: boolean }

export type Disk = { label: string; freeGb: number; usedPct: number }

// what /usage shows, kept live from session.measure: the plan's rate-limit windows, the context fill and the cost
export type Limit = { kind: string; percentUsed: number; resetsAt: string | null }
export type Usage = { limits: Limit[]; contextPct: number | null; contextTokens: number | null; window: number; costUsd: number | null }

// one line of an agent's own story for the bottom panel: a tool it ran, what it said, what you sent it, how it ended
export type TrailLine = { at: number; kind: 'tool' | 'say' | 'you' | 'error' | 'end'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      rows: Row[]
      feed: FeedItem[]
      isOn: boolean
      tick: number
      disk: Disk | null
      usage: Usage | null
      // the agent whose panel is open at the bottom, and every agent's trail keyed by its id
      selected: string | null
      trails: Record<string, TrailLine[]>
    }
  }
}
