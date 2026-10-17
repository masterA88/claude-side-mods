import { describe, expect, test } from 'claude-code/testing'

import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'
import { applyChanges, foldExport, parseEdgeEnds } from '../src/graph/ghost'
import { back, centreOf, columnItems, deeper, edgeLabel, move, pathForDiff, pathForNodes, selectedItem, TOP } from '../src/browse/model'
import type { Browse } from '../src/browse/model'

const DEV = foldExport(EXPORT_JSONL, parseEdgeEnds(SCHEMA_SOURCE), 2000)
const EPIC = 'Epic:epc-offline-sync'
const labels = (b: Browse) => b.path.map(s => selectedItem(DEV, s)?.label)

describe('browser columns', () => {
  test('edge types read as verbs between their two node types', () => {
    expect(edgeLabel('EpicContainsIssue', 'Epic', 'Issue')).toBe('contains')
    expect(edgeLabel('IssueOwnedBy', 'Issue', 'Actor')).toBe('owned by')
    expect(edgeLabel('ReleaseSupersedes', 'Release', 'Release')).toBe('supersedes')
  })

  test('the top level lists node types, the biggest first, with counts', () => {
    const types = columnItems(DEV, { kind: 'types' })
    expect(types[0]).toMatchObject({ id: 'type:Issue', label: 'Issue', count: 18 })
    expect(types.map(t => t.count)).toEqual([...types.map(t => t.count)].sort((a, b) => b! - a!))
    expect(types.reduce((n, t) => n + t.count!, 0)).toBe(DEV.nodes.length)
  })

  test("a type's nodes are listed by label", () => {
    const epics = columnItems(DEV, { kind: 'nodes', type: 'Epic' })
    expect(epics.map(e => e.label)).toEqual(['Hard tenant isolation', 'Offline editing & sync', 'Sync observability baseline', 'Usage-based billing v2'])
  })

  test("a node's links are grouped by relation, outgoing first, each under a header", () => {
    const links = columnItems(DEV, { kind: 'links', node: EPIC })
    const headers = links.filter(i => i.isHeader).map(i => i.label)
    expect(headers[0]).toBe('→ contains · Issue 4')
    expect(headers.indexOf('← tracked by · Capability 1')).toBeGreaterThan(headers.indexOf('→ owned by · Actor 1'))
    expect(links.filter(i => i.group === 'out:EpicContainsIssue' && !i.isHeader)).toHaveLength(4)
    expect(new Set(links.map(i => i.id)).size).toBe(links.length)
  })
})

describe('browser moves', () => {
  test('down and up skip headers and stop at the ends', () => {
    let b: Browse = { path: [{ column: { kind: 'links', node: EPIC }, selected: null }] }
    expect(selectedItem(DEV, b.path[0]!)?.isHeader).toBeUndefined()
    b = move(b, DEV, -1)
    expect(selectedItem(DEV, b.path[0]!)?.group).toBe('out:EpicContainsIssue')
    for (let i = 0; i < 4; i++) b = move(b, DEV, 1)
    expect(selectedItem(DEV, b.path[0]!)?.group).toBe('out:EpicOwnedBy')
    for (let i = 0; i < 50; i++) b = move(b, DEV, 1)
    const last = columnItems(DEV, { kind: 'links', node: EPIC }).at(-1)!
    expect(b.path[0]!.selected).toBe(last.id)
  })

  test('deeper opens a type, then a node, then a neighbour; back keeps the way', () => {
    let b = TOP
    while (selectedItem(DEV, b.path[0]!)?.label !== 'Epic') b = move(b, DEV, 1)
    b = deeper(b, DEV) // Epic's nodes
    b = move(b, DEV, 1) // Offline editing & sync
    b = deeper(b, DEV) // its links: the first issue it contains
    expect(labels(b)).toEqual(['Epic', 'Offline editing & sync', 'Conflict-resolution UI for offline edits'])
    expect(centreOf(b, DEV)).toEqual({ kind: 'node', node: EPIC, selected: 'Issue:iss-offline-conflict-ui' })
    b = deeper(b, DEV) // a hop: the issue's links
    expect(b.path).toHaveLength(4)
    expect(centreOf(b, DEV)).toMatchObject({ kind: 'node', node: 'Issue:iss-offline-conflict-ui' })
    b = back(back(b))
    expect(labels(b)).toEqual(['Epic', 'Offline editing & sync'])
    expect(centreOf(b, DEV)).toEqual({ kind: 'node', node: EPIC, selected: null })
    b = back(back(back(b)))
    expect(centreOf(b, DEV)).toEqual({ kind: 'type', type: 'Epic' })
  })

  test('a selection deleted from the graph falls back to the first row', () => {
    const b: Browse = { path: [{ column: { kind: 'nodes', type: 'Epic' }, selected: 'Epic:gone' }] }
    expect(selectedItem(DEV, b.path[0]!)?.label).toBe('Hard tenant isolation')
  })
})

describe('following ops', () => {
  test("a new link shows its source's links with the new target selected", () => {
    const changes = [
      { kind: 'node' as const, type: 'Issue', id: 'iss-new', op: 'insert' as const, label: 'New issue' },
      { kind: 'edge' as const, type: 'EpicContainsIssue', id: 'e-new', op: 'insert' as const, from: 'epc-offline-sync', to: 'iss-new' },
    ]
    const after = applyChanges(DEV, changes)
    const b = pathForDiff(after, changes)!
    expect(b.path.map(s => s.column.kind)).toEqual(['types', 'nodes', 'links'])
    expect(b.path[2]!.selected).toBe('out:EpicContainsIssue|Issue:iss-new')
    expect(centreOf(b, after)).toEqual({ kind: 'node', node: EPIC, selected: 'Issue:iss-new' })
  })

  test('a new node alone is selected among its type', () => {
    const changes = [{ kind: 'node' as const, type: 'Issue', id: 'iss-new', op: 'insert' as const, label: 'New issue' }]
    const after = applyChanges(DEV, changes)
    expect(centreOf(pathForDiff(after, changes)!, after)).toEqual({ kind: 'node', node: 'Issue:iss-new', selected: null })
    expect(pathForDiff(DEV, [{ kind: 'node', type: 'Issue', id: 'iss-new', op: 'delete' }])).toBeNull()
  })

  test('a read of one node selects it; a wide read centres on the op', () => {
    expect(centreOf(pathForNodes(DEV, ['Issue:iss-auth-mfa'], 'query ready')!, DEV)).toEqual({ kind: 'node', node: 'Issue:iss-auth-mfa', selected: null })
    const ids = ['Issue:iss-auth-mfa', 'Issue:iss-split-brain', 'Actor:act-mei', 'Issue:nope']
    const wide = pathForNodes(DEV, ids, 'query ready')!
    expect(centreOf(wide, DEV)).toEqual({ kind: 'hub', hub: { label: 'query ready', nodes: ids.slice(0, 3) } })
    expect(labels(wide)).toEqual(['Issue', 'Add TOTP MFA to auth'])
    expect(pathForNodes(DEV, ['Issue:nope'], 'q')).toBeNull()
  })
})
