import type { GraphState, OpEvent, ReplayView, UiState, ViewState, VizState } from '../../types'

export const RECENT_OPS = 200

export const INITIAL_UI: UiState = { tab: 'graph', selectedOpId: null }

export const INITIAL_VIEW: ViewState = {
  recentOps: [],
  counters: { ops: 0, errors: 0, nodes: 0, edges: 0 },
  graph: null,
  branch: null,
  ghost: { state: 'none', nodes: 0, edges: 0, truncated: false, message: null },
  replay: null,
}

/** What the Feed lists: no raw output, no read cells (those stay in module memory). */
function slim(op: OpEvent): OpEvent {
  const { output: _output, ...rest } = op
  if (rest.outcome?.kind === 'read') return { ...rest, outcome: { ...rest.outcome, cells: [] } }
  return rest
}

export function toView(
  viz: VizState,
  state: GraphState = 'none',
  message: string | null = null,
  replay: ReplayView | null = null,
): ViewState {
  return {
    ghost: {
      state: viz.ghost ? 'ready' : state,
      nodes: viz.ghost?.nodes.length ?? 0,
      edges: viz.ghost?.edges.length ?? 0,
      truncated: viz.ghost?.truncated ?? false,
      message,
    },
    recentOps: viz.ops.slice(-RECENT_OPS).map(slim),
    counters: viz.counters,
    graph: viz.graph,
    branch: viz.branch,
    replay,
  }
}
