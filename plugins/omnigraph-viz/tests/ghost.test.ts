import { describe, expect, test } from 'claude-code/testing'

import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'
import { applyChanges, foldExport, labelOf, nodeId, parseEdgeEnds, resolveKey } from '../src/graph/ghost'

const ENDS = parseEdgeEnds(SCHEMA_SOURCE)

describe('schema', () => {
  test('edge declarations give endpoint types', () => {
    expect(Object.keys(ENDS)).toHaveLength(92)
    expect(ENDS.EpicContainsIssue).toEqual(['Epic', 'Issue'])
  })
})

describe('foldExport on a real dev-graph export', () => {
  const g = foldExport(EXPORT_JSONL, ENDS, 2000)
  test('nodes and edges with typed ids', () => {
    expect(g.nodes).toHaveLength(102)
    expect(g.edges).toHaveLength(239)
    expect(g.truncated).toBe(false)
    expect(g.nodes.every(n => n.id === nodeId(n.type, n.key))).toBe(true)
  })
  test('edge endpoints resolve to node ids', () => {
    const ids = new Set(g.nodes.map(n => n.id))
    expect(g.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true)
    const contains = g.edges.find(e => e.type === 'EpicContainsIssue')
    expect(contains?.from.startsWith('Epic:')).toBe(true)
    expect(contains?.to.startsWith('Issue:')).toBe(true)
  })
  test('labels prefer name, then title, then slug, then the key', () => {
    expect(labelOf({ name: 'N', title: 'T' }, 'k')).toBe('N')
    expect(labelOf({ title: 'T', slug: 's' }, 'k')).toBe('T')
    expect(labelOf({ slug: 's' }, 'k')).toBe('s')
    expect(labelOf({ n: 1 }, 'k')).toBe('k')
  })
  test('above maxNodes the best-connected nodes are kept, with their edges', () => {
    const small = foldExport(EXPORT_JSONL, ENDS, 20)
    expect(small.nodes).toHaveLength(20)
    expect(small.truncated).toBe(true)
    const kept = new Set(small.nodes.map(n => n.id))
    expect(small.edges.every(e => kept.has(e.from) && kept.has(e.to))).toBe(true)
    const degree = (id: string) => g.edges.filter(e => e.from === id || e.to === id).length
    const minKept = Math.min(...small.nodes.map(n => degree(n.id)))
    const maxDropped = Math.max(...g.nodes.filter(n => !kept.has(n.id)).map(n => degree(n.id)))
    expect(minKept).toBeGreaterThanOrEqual(maxDropped)
  })
  test('rows that are not JSON are skipped', () => {
    expect(foldExport('nope\n{"type":"A","id":"a","data":{}}\n', {}, 10).nodes).toHaveLength(1)
  })
  test('without the schema, a unique key still resolves', () => {
    const h = foldExport('{"type":"A","id":"a","data":{}}\n{"type":"B","id":"b","data":{}}\n{"edge":"E","id":"e1","from":"a","to":"b","data":{}}\n', {}, 10)
    expect(h.edges).toEqual([{ id: 'e1', type: 'E', from: 'A:a', to: 'B:b' }])
  })
})

describe('resolveKey', () => {
  const g = foldExport('{"type":"A","id":"x","data":{}}\n{"type":"B","id":"x","data":{}}\n', {}, 10)
  test('an ambiguous key needs the wanted type', () => {
    expect(resolveKey(g, 'x')).toBeUndefined()
    expect(resolveKey(g, 'x', 'B')).toBe('B:x')
    expect(resolveKey(g, 'nope', 'B')).toBeUndefined()
  })
})

describe('applyChanges', () => {
  const base = foldExport(
    '{"type":"Epic","id":"ep","data":{"title":"Epic"}}\n{"type":"Issue","id":"i1","data":{"title":"One"}}\n{"edge":"EpicContainsIssue","id":"e1","from":"ep","to":"i1","data":{}}\n',
    { EpicContainsIssue: ['Epic', 'Issue'] },
    10,
  )
  test('insert a node and an edge to it', () => {
    const g = applyChanges(base, [
      { kind: 'node', type: 'Issue', id: 'i2', op: 'insert', label: 'Two' },
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e2', op: 'insert', from: 'ep', to: 'i2' },
    ])
    expect(g.nodes.map(n => n.id)).toEqual(['Epic:ep', 'Issue:i1', 'Issue:i2'])
    expect(g.nodes[2]?.label).toBe('Two')
    expect(g.edges.map(e => [e.id, e.from, e.to])).toEqual([['e1', 'Epic:ep', 'Issue:i1'], ['e2', 'Epic:ep', 'Issue:i2']])
    expect(base.nodes).toHaveLength(2)
  })
  test('update relabels; inserting an existing node is an update', () => {
    const g = applyChanges(base, [
      { kind: 'node', type: 'Issue', id: 'i1', op: 'update', label: 'Uno' },
      { kind: 'node', type: 'Epic', id: 'ep', op: 'insert', label: 'Big epic' },
    ])
    expect(g.nodes.map(n => n.label)).toEqual(['Big epic', 'Uno'])
  })
  test('deleting a node drops its edges; deleting an edge drops just it', () => {
    expect(applyChanges(base, [{ kind: 'node', type: 'Issue', id: 'i1', op: 'delete' }]).edges).toEqual([])
    const g = applyChanges(base, [{ kind: 'edge', type: 'EpicContainsIssue', id: 'e1', op: 'delete' }])
    expect([g.nodes.length, g.edges.length]).toEqual([2, 0])
  })
  test('an edge to an unknown node is skipped', () => {
    expect(applyChanges(base, [{ kind: 'edge', type: 'EpicContainsIssue', id: 'e9', op: 'insert', from: 'ep', to: 'zz' }]).edges).toHaveLength(1)
  })
})
