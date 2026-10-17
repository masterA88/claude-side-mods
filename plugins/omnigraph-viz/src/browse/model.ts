import type { EntityChange, GhostEdge, GhostGraph, GhostNode } from '../../types'

/** One column of the browser: every node type, one type's nodes, or one node's links. */
export type Column = { kind: 'types' } | { kind: 'nodes'; type: string } | { kind: 'links'; node: string }

/** A row of a column. Headers (a relation in a links column) can't be selected. */
export interface Item {
  /** Unique within its column: `type:<T>`, a node id, or `<group>|<node id>`. */
  id: string
  label: string
  /** The node type the row stands for, or its node's type. */
  type: string
  /** The node the row stands for (nodes and links columns). */
  node?: string
  /** Types: how many nodes; headers: how many links. */
  count?: number
  /** Links: the relation the row belongs to (`out:EpicContainsIssue`). */
  group?: string
  isHeader?: boolean
}

export interface Step {
  column: Column
  /** The selected item's id; null (or one gone from the column): its first item. */
  selected: string | null
}

/** A virtual centre for a read that lit several nodes: the op, its results around it. */
export interface Hub {
  label: string
  nodes: string[]
}

/** Where the browser is: the path of columns from the types to the active (last) one. */
export interface Browse {
  path: Step[]
  /** While following a wide read, the picture centres on the op instead. */
  hub?: Hub
}

/** What the picture centres on. `selected`: the neighbour selected in a links column. */
export type Centre =
  | { kind: 'type'; type: string }
  | { kind: 'node'; node: string; selected: string | null }
  | { kind: 'hub'; hub: Hub }

export const TOP: Browse = { path: [{ column: { kind: 'types' }, selected: null }] }

/** `EpicContainsIssue` between an Epic and an Issue → `contains`; `IssueOwnedBy` → `owned by`. */
export function edgeLabel(type: string, from: string, to: string): string {
  const words = type.split(/(?<=[a-z0-9])(?=[A-Z])/)
  const kept = words.filter((w, i) => !((i === 0 && w === from) || (i === words.length - 1 && w === to)))
  return (kept.length > 0 ? kept : words).join(' ').toLowerCase()
}

/** All edges of one type between two node types. */
export interface TypeLink {
  from: string
  to: string
  type: string
  count: number
}

interface Index {
  nodes: Map<string, GhostNode>
  /** Per node, its edges in graph order. */
  adjacent: Map<string, GhostEdge[]>
  counts: Map<string, number>
  typeLinks: TypeLink[]
  /** Relations and column rows as first asked for: a frame asks for the same ones many times. */
  relations: Map<string, Relation[]>
  columns: Map<string, Item[]>
}

/** Text order that doesn't depend on the machine's locale: case-blind, then exact. */
export const compareText = (a: string, b: string): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

const indexes = new WeakMap<GhostGraph, Index>()

/** Lookups for a graph, built once per graph value (the reducer makes a new one on every change). */
export function indexOf(graph: GhostGraph): Index {
  const cached = indexes.get(graph)
  if (cached) return cached
  const nodes = new Map(graph.nodes.map(n => [n.id, n]))
  const adjacent = new Map<string, GhostEdge[]>()
  const counts = new Map<string, number>()
  for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
  const grouped = new Map<string, TypeLink>()
  for (const e of graph.edges) {
    const from = nodes.get(e.from)
    const to = nodes.get(e.to)
    if (!from || !to) continue
    const list = adjacent.get(e.from) ?? []
    list.push(e)
    adjacent.set(e.from, list)
    if (e.to !== e.from) {
      const back = adjacent.get(e.to) ?? []
      back.push(e)
      adjacent.set(e.to, back)
    }
    if (from.type === to.type) continue
    const key = `${from.type}\u0000${e.type}\u0000${to.type}`
    const link = grouped.get(key)
    if (link) link.count++
    else grouped.set(key, { from: from.type, to: to.type, type: e.type, count: 1 })
  }
  const typeLinks = [...grouped.values()].sort((a, b) => b.count - a.count || compareText(a.type, b.type))
  const index = { nodes, adjacent, counts, typeLinks, relations: new Map(), columns: new Map() }
  indexes.set(graph, index)
  return index
}

const byLabel = (a: { label: string; id: string }, b: { label: string; id: string }) =>
  compareText(a.label, b.label) || compareText(a.id, b.id)

/** One relation of a node: the edge type and which way it points, with the nodes at the other end. */
export interface Relation {
  key: string
  label: string
  /** The other end's type (the first, if the relation mixes types). */
  type: string
  nodes: GhostNode[]
}

/** A node's links grouped by relation: outgoing first, then incoming; the biggest first; nodes by label. */
export function relationsOf(graph: GhostGraph, id: string): Relation[] {
  const index = indexOf(graph)
  const cached = index.relations.get(id)
  if (cached) return cached
  const self = index.nodes.get(id)
  if (!self) return []
  const groups = new Map<string, { isOut: boolean; edge: string; nodes: Map<string, GhostNode> }>()
  for (const e of index.adjacent.get(id) ?? []) {
    const isOut = e.from === id
    const other = index.nodes.get(isOut ? e.to : e.from)
    if (!other) continue
    const key = `${isOut ? 'out' : 'in'}:${e.type}`
    const group = groups.get(key) ?? { isOut, edge: e.type, nodes: new Map() }
    group.nodes.set(other.id, other)
    groups.set(key, group)
  }
  const relations = [...groups.entries()]
    .sort(([ka, a], [kb, b]) => Number(b.isOut) - Number(a.isOut) || b.nodes.size - a.nodes.size || compareText(ka, kb))
    .map(([key, g]) => {
      const members = [...g.nodes.values()].sort(byLabel)
      const type = members[0]!.type
      const verb = g.isOut ? edgeLabel(g.edge, self.type, type) : edgeLabel(g.edge, type, self.type)
      return { key, label: `${g.isOut ? '→' : '←'} ${verb}`, type, nodes: members }
    })
  index.relations.set(id, relations)
  return relations
}

/** A column's rows. */
export function columnItems(graph: GhostGraph, column: Column): Item[] {
  const index = indexOf(graph)
  const key = column.kind === 'types' ? 'types' : column.kind === 'nodes' ? `nodes:${column.type}` : `links:${column.node}`
  const cached = index.columns.get(key)
  if (cached) return cached
  const items = itemsOf(graph, column)
  index.columns.set(key, items)
  return items
}

function itemsOf(graph: GhostGraph, column: Column): Item[] {
  const { nodes, counts } = indexOf(graph)
  if (column.kind === 'types') {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
      .map(([type, count]) => ({ id: `type:${type}`, label: type, type, count }))
  }
  if (column.kind === 'nodes') {
    return graph.nodes
      .filter(n => n.type === column.type)
      .map(n => ({ id: n.id, label: n.label, type: n.type, node: n.id }))
      .sort(byLabel)
  }
  if (!nodes.has(column.node)) return []
  return relationsOf(graph, column.node).flatMap(r => [
    { id: `h:${r.key}`, label: `${r.label} · ${r.type} ${r.nodes.length}`, type: r.type, count: r.nodes.length, group: r.key, isHeader: true },
    ...r.nodes.map(n => ({ id: `${r.key}|${n.id}`, label: n.label, type: n.type, node: n.id, group: r.key })),
  ])
}

/** The selected item of a step: the remembered one if it is still there, else the first selectable. */
export function selectedItem(graph: GhostGraph, step: Step): Item | undefined {
  const items = columnItems(graph, step.column)
  return items.find(i => i.id === step.selected && !i.isHeader) ?? items.find(i => !i.isHeader)
}

const active = (b: Browse): Step => b.path[b.path.length - 1]!

/** Moves the active column's selection by `delta` selectable rows, stopping at the ends. */
export function move(b: Browse, graph: GhostGraph, delta: number): Browse {
  const step = active(b)
  const items = columnItems(graph, step.column).filter(i => !i.isHeader)
  if (items.length === 0) return { path: b.path }
  const at = Math.max(0, items.findIndex(i => i.id === selectedItem(graph, step)?.id))
  const next = items[Math.max(0, Math.min(items.length - 1, at + delta))]!
  return { path: [...b.path.slice(0, -1), { ...step, selected: next.id }] }
}

/** The column the selected item opens: a type's nodes, or a node's links. */
export function opens(item: Item | undefined): Column | null {
  if (!item || item.isHeader) return null
  if (item.node !== undefined) return { kind: 'links', node: item.node }
  return { kind: 'nodes', type: item.type }
}

/** Opens the selected item as a new active column (the current selection is kept for the way back). */
export function deeper(b: Browse, graph: GhostGraph): Browse {
  const step = active(b)
  const item = selectedItem(graph, step)
  const column = opens(item)
  if (!column || !item) return { path: b.path }
  return { path: [...b.path.slice(0, -1), { ...step, selected: item.id }, { column, selected: null }] }
}

/** Closes the active column; the one before it keeps its selection. */
export function back(b: Browse): Browse {
  return { path: b.path.length > 1 ? b.path.slice(0, -1) : b.path }
}

/** What the picture centres on: the op hub, the type or node selected, or the node whose links are listed. */
export function centreOf(b: Browse, graph: GhostGraph): Centre | null {
  if (b.hub) return { kind: 'hub', hub: b.hub }
  const step = active(b)
  const item = selectedItem(graph, step)
  if (step.column.kind === 'links') {
    return indexOf(graph).nodes.has(step.column.node) ? { kind: 'node', node: step.column.node, selected: item?.node ?? null } : null
  }
  if (!item) return null
  return step.column.kind === 'types' ? { kind: 'type', type: item.type } : { kind: 'node', node: item.node!, selected: null }
}

/** The path to a node: its type, then the node selected among its type's nodes. */
export function pathTo(graph: GhostGraph, id: string): Browse | null {
  const node = indexOf(graph).nodes.get(id)
  if (!node) return null
  return {
    path: [
      { column: { kind: 'types' }, selected: `type:${node.type}` },
      { column: { kind: 'nodes', type: node.type }, selected: node.id },
    ],
  }
}

/** The path to a link: `from`'s links listed, `to` selected among them. */
function pathToLink(graph: GhostGraph, edge: GhostEdge): Browse | null {
  const to = pathTo(graph, edge.from)
  if (!to) return null
  const relation = relationsOf(graph, edge.from).find(r => r.key === `out:${edge.type}` && r.nodes.some(n => n.id === edge.to))
  return { path: [...to.path, { column: { kind: 'links', node: edge.from }, selected: relation ? `${relation.key}|${edge.to}` : null }] }
}

/**
 * Where following goes for a diff: a new or changed link shows its source's
 * links with the target selected; else the first changed node, selected among
 * its type. Null when nothing it touched is left (deletes only).
 */
export function pathForDiff(graph: GhostGraph, changes: readonly EntityChange[]): Browse | null {
  const edges = new Map(graph.edges.map(e => [e.id, e]))
  for (const c of changes) {
    if (c.kind !== 'edge' || c.op === 'delete') continue
    const edge = edges.get(c.id)
    const path = edge && pathToLink(graph, edge)
    if (path) return path
  }
  for (const c of changes) {
    if (c.kind !== 'node' || c.op === 'delete') continue
    const path = pathTo(graph, `${c.type}:${c.id}`)
    if (path) return path
  }
  return null
}

/**
 * Where following goes for a read: one node is selected among its type; several
 * show the most common type's nodes, and the picture centres on the op (`hub`).
 */
export function pathForNodes(graph: GhostGraph, ids: readonly string[], hubLabel: string): Browse | null {
  const { nodes } = indexOf(graph)
  const found = ids.filter(id => nodes.has(id))
  if (found.length === 0) return null
  if (found.length === 1) return pathTo(graph, found[0]!)
  const count = new Map<string, number>()
  for (const id of found) count.set(nodes.get(id)!.type, (count.get(nodes.get(id)!.type) ?? 0) + 1)
  const main = [...count.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]![0]
  const first = found.find(id => nodes.get(id)!.type === main)!
  return { ...pathTo(graph, first)!, hub: { label: hubLabel, nodes: found } }
}

/**
 * A path still valid after nodes went away: it ends before the first column
 * listing a deleted node's links (the column before keeps its selection,
 * which falls back to its first row), and an op hub keeps only the results
 * that are left (none or one: no hub).
 */
export function repair(b: Browse, graph: GhostGraph): Browse {
  const { nodes } = indexOf(graph)
  const gone = b.path.findIndex(s => s.column.kind === 'links' && !nodes.has(s.column.node))
  const path = gone > 0 ? b.path.slice(0, gone) : gone === 0 ? TOP.path : b.path
  const left = b.hub?.nodes.filter(id => nodes.has(id)) ?? []
  return left.length > 1 ? { path, hub: { ...b.hub!, nodes: left } } : { path }
}

/** Where following goes when a diff only deleted nodes: the first one's type, its nodes listed. */
export function pathForDeletes(graph: GhostGraph, changes: readonly EntityChange[]): Browse | null {
  const deleted = changes.find(c => c.kind === 'node' && c.op === 'delete')
  if (!deleted || !indexOf(graph).counts.has(deleted.type)) return null
  return {
    path: [
      { column: { kind: 'types' }, selected: `type:${deleted.type}` },
      { column: { kind: 'nodes', type: deleted.type }, selected: null },
    ],
  }
}
