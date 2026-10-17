import { applyChanges, resolveKey } from '../graph/ghost'
import { basename } from '../util/path'
import type { Counters, EntityChange, GhostGraph, LedgerLine, OpOutcome, Target, VizState } from '../../types'

export function emptyViz(): VizState {
  return {
    ops: [],
    counters: { ops: 0, errors: 0, nodes: 0, edges: 0 },
    graph: null,
    branch: null,
    ghost: null,
    touches: {},
  }
}

/** A short name for where an op ran: the graph id, else the store/uri/cluster folder, else the server. */
export function targetLabel(t: Target): string | null {
  if (t.graph) return t.graph
  const where = t.store ?? t.uri ?? t.cluster
  if (where) return basename(where.replace(/\/+$/, ''))
  return t.server ?? null
}

function outcomeBranch(o: OpOutcome): string | null {
  switch (o.kind) {
    case 'read':
      return o.branch ?? null
    case 'change':
    case 'load':
      return o.branch || null
    case 'branch':
      return o.action === 'merged' ? (o.into ?? null) : null
    default:
      return null
  }
}

function addCounts(c: Counters, o: OpOutcome): Counters {
  if (o.kind === 'error') return { ...c, errors: c.errors + 1 }
  if (o.kind === 'change') return { ...c, nodes: c.nodes + o.nodes, edges: c.edges + o.edges }
  if (o.kind === 'load') return { ...c, nodes: c.nodes + o.total }
  return c
}

/** Node ids a diff touched: changed nodes and both ends of changed edges. */
function diffTouches(graph: GhostGraph, changes: readonly EntityChange[]): string[] {
  const ids = new Set<string>()
  for (const c of changes) {
    if (c.kind === 'node') {
      ids.add(`${c.type}:${c.id}`)
      continue
    }
    const ends = graph.edgeEnds[c.type]
    for (const [key, type] of [[c.from, ends?.[0]], [c.to, ends?.[1]]] as const) {
      const id = key === undefined ? undefined : resolveKey(graph, key, type)
      if (id !== undefined) ids.add(id)
    }
  }
  return [...ids]
}

export function reduce(s: VizState, line: LedgerLine): VizState {
  if (line.t === 'graph') return { ...s, ghost: line.graph }
  if (line.t === 'touch') return { ...s, touches: { ...s.touches, [line.opId]: line.nodeIds } }
  if (line.t === 'diff') {
    if (!s.ghost) return s
    const ghost = applyChanges(s.ghost, line.changes)
    return { ...s, ghost, touches: { ...s.touches, [line.opId]: diffTouches(ghost, line.changes) } }
  }
  if (line.t === 'op.start') {
    return {
      ...s,
      ops: [...s.ops, line.op],
      counters: { ...s.counters, ops: s.counters.ops + 1 },
      graph: targetLabel(line.op.intent.target) ?? s.graph,
      branch: line.op.intent.branch ?? s.branch,
    }
  }
  if (line.t === 'op.end') {
    const i = s.ops.findIndex(o => o.id === line.id)
    const prev = s.ops[i]
    if (!prev) return s
    const ops = s.ops.slice()
    ops[i] = {
      ...prev,
      status: line.status,
      durationMs: line.durationMs,
      outcome: line.outcome,
      output: line.output,
    }
    return {
      ...s,
      ops,
      counters: addCounts(s.counters, line.outcome),
      branch: outcomeBranch(line.outcome) ?? s.branch,
    }
  }
  return s
}

export function reduceAll(lines: readonly LedgerLine[], from: VizState = emptyViz()): VizState {
  return lines.reduce(reduce, from)
}
