export type Verb =
  | 'query' | 'mutate' | 'alias' | 'load' | 'branch' | 'commit' | 'changes'
  | 'snapshot' | 'export' | 'schema' | 'queries' | 'lint' | 'other'

/** One `omnigraph …` command found inside a Bash command line. */
export interface Invocation {
  argv: string[]
  cwd: string
  index: number
}

/** Where an op ran; passed through verbatim to enrichment calls. */
export interface Target {
  server?: string
  graph?: string
  store?: string
  profile?: string
  cluster?: string
  uri?: string
}

export interface OpIntent {
  verb: Verb
  sub?: string
  queryName?: string
  isInline: boolean
  branch?: string
  target: Target
  isJson: boolean
  argv: string[]
  cwd: string
}

export type MergeKind = 'already_up_to_date' | 'fast_forward' | 'merged'

export type OpOutcome =
  | { kind: 'read'; queryName: string; rowCount: number; branch?: string; snapshot?: string
      columns: string[]; cells: string[][] }
  | { kind: 'change'; branch: string; queryName: string; nodes: number; edges: number }
  | { kind: 'branch'; action: 'created' | 'deleted' | 'merged'; name: string
      from?: string; into?: string; merge?: MergeKind }
  | { kind: 'load'; branch: string; mode: string; total: number; nodeTypes: number; edgeTypes: number
      branchCreatedFrom?: string }
  | { kind: 'error'; message: string }
  | { kind: 'other'; firstLine: string }

export interface OpEvent {
  id: string
  startedAt: number
  intent: OpIntent
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  outcome?: OpOutcome
  /** stdout (or stderr on failure), clipped by `clipOutput`. */
  output?: string
  agentId?: string
}

export interface Counters {
  ops: number
  errors: number
  nodes: number
  edges: number
}

/** A node of the ghost graph; `id` is `${type}:${key}`. */
export interface GhostNode {
  id: string
  type: string
  key: string
  label: string
}

/** An edge of the ghost graph; `from`/`to` are node ids. */
export interface GhostEdge {
  id: string
  type: string
  from: string
  to: string
}

export interface GhostGraph {
  nodes: GhostNode[]
  edges: GhostEdge[]
  /** More nodes existed than `maxGhostNodes`; the best-connected were kept. */
  truncated: boolean
  /** Edge type → [from node type, to node type], from the schema. */
  edgeEnds: Record<string, [string, string]>
}

/** One entity a commit changed (`commit changes --json`); `from`/`to` are raw keys. */
export interface EntityChange {
  kind: 'node' | 'edge'
  type: string
  id: string
  op: 'insert' | 'update' | 'delete'
  from?: string
  to?: string
  label?: string
}

export type LedgerLine =
  | { v: 1; t: 'session'; at: number; cwd: string; mod: string }
  | { v: 1; t: 'graph'; at: number; target: Target; cwd: string; graph: GhostGraph }
  | { v: 1; t: 'diff'; at: number; opId: string; commitId: string; changes: EntityChange[]; more: number }
  | { v: 1; t: 'touch'; at: number; opId: string; nodeIds: string[]; isExact: boolean }
  | { v: 1; t: 'op.start'; at: number; op: OpEvent }
  | { v: 1; t: 'op.end'; at: number; id: string; status: 'ok' | 'error'; durationMs: number
      outcome: OpOutcome; output: string }

/** Everything the views need, rebuilt from the ledger by `reduce`. */
export interface VizState {
  ops: OpEvent[]
  counters: Counters
  graph: string | null
  branch: string | null
  /** The ghost graph, once bootstrapped. */
  ghost: GhostGraph | null
  /** Node ids each op touched (from its diff or read match). */
  touches: Record<string, string[]>
}

export type GraphState = 'none' | 'loading' | 'ready' | 'failed'

export type Tab = 'graph' | 'feed'

export type UiState = { tab: Tab; selectedOpId: string | null }

/** A replay on screen: how fast, how far. */
export type ReplayView = { speed: number; progress: number; isDone: boolean }

export type ViewState = {
  recentOps: OpEvent[]
  counters: Counters
  graph: string | null
  branch: string | null
  ghost: { state: GraphState; nodes: number; edges: number; truncated: boolean; message: string | null }
  /** Set while the pane shows a replay instead of the live session. */
  replay: ReplayView | null
}

declare module 'claude-code' {
  interface PluginState {
    'omnigraph-viz': {
      ui: UiState
      view: ViewState
      ledgerPath: string | null
    }
  }
}
