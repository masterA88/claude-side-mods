import { describe, expect, test } from 'claude-code/testing'

import { foldExport } from '../src/graph/ghost'
import { emptyViz, reduceAll } from '../src/model/reduce'
import { toView } from '../src/model/state'
import type { GhostGraph, LedgerLine } from '../types'

const GRAPH: GhostGraph = foldExport(
  '{"type":"Epic","id":"ep","data":{}}\n{"type":"Issue","id":"i1","data":{}}\n',
  { EpicContainsIssue: ['Epic', 'Issue'] },
  10,
)
const graphLine: LedgerLine = { v: 1, t: 'graph', at: 1, target: { store: 'g' }, cwd: '/w', graph: GRAPH }

describe('reduce: ghost graph lines', () => {
  test('a graph line sets the ghost; the view reports it ready', () => {
    const s = reduceAll([graphLine])
    expect(s.ghost?.nodes).toHaveLength(2)
    expect(toView(s).ghost).toEqual({ state: 'ready', nodes: 2, edges: 0, truncated: false, message: null })
    expect(toView(emptyViz(), 'failed', 'boom').ghost).toEqual({ state: 'failed', nodes: 0, edges: 0, truncated: false, message: 'boom' })
  })
  test('a diff changes the ghost and records what the op touched, edge ends included', () => {
    const s = reduceAll([graphLine, { v: 1, t: 'diff', at: 2, opId: 'w#0', commitId: 'c', more: 0, changes: [
      { kind: 'node', type: 'Issue', id: 'i2', op: 'insert' },
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e', op: 'insert', from: 'ep', to: 'i2' },
    ] }])
    expect(s.ghost?.nodes.map(n => n.id)).toEqual(['Epic:ep', 'Issue:i1', 'Issue:i2'])
    expect(s.ghost?.edges).toHaveLength(1)
    expect(s.touches['w#0']?.sort()).toEqual(['Epic:ep', 'Issue:i2'])
  })
  test('a diff before any graph is ignored; a touch line records its nodes', () => {
    const diff: LedgerLine = { v: 1, t: 'diff', at: 2, opId: 'w#0', commitId: 'c', more: 0, changes: [] }
    expect(reduceAll([diff])).toEqual(emptyViz())
    expect(reduceAll([graphLine, { v: 1, t: 'touch', at: 3, opId: 'r#0', nodeIds: ['Issue:i1'], isExact: true }]).touches).toEqual({ 'r#0': ['Issue:i1'] })
  })
})
