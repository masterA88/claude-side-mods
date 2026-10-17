import type { EntityChange, GhostEdge, GhostGraph, GhostNode } from '../../types'

export const nodeId = (type: string, key: string): string => `${type}:${key}`

/** `edge Name: From -> To` declarations of a `.pg` schema. */
export function parseEdgeEnds(schemaSource: string): Record<string, [string, string]> {
  const ends: Record<string, [string, string]> = {}
  for (const m of schemaSource.matchAll(/^\s*edge\s+(\w+)\s*:\s*(\w+)\s*->\s*(\w+)/gm)) {
    ends[m[1]!] = [m[2]!, m[3]!]
  }
  return ends
}

export function labelOf(data: Record<string, unknown>, key: string): string {
  for (const field of ['name', 'title', 'slug']) {
    const value = data[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return key
}

/** The node id a raw key names; with several types sharing it, `type` picks one. */
export function resolveKey(graph: GhostGraph, key: string, type?: string): string | undefined {
  if (type !== undefined) {
    const id = nodeId(type, key)
    return graph.nodes.some(n => n.id === id) ? id : undefined
  }
  const found = graph.nodes.filter(n => n.key === key)
  return found.length === 1 ? found[0]!.id : undefined
}

function resolveEnd(byKey: Map<string, GhostNode[]>, key: string, type: string | undefined): string | undefined {
  const candidates = byKey.get(key) ?? []
  if (type !== undefined) return candidates.find(n => n.type === type)?.id ?? (candidates.length === 1 ? candidates[0]!.id : undefined)
  return candidates.length === 1 ? candidates[0]!.id : undefined
}

function keyIndex(nodes: readonly GhostNode[]): Map<string, GhostNode[]> {
  const byKey = new Map<string, GhostNode[]>()
  for (const node of nodes) byKey.set(node.key, [...(byKey.get(node.key) ?? []), node])
  return byKey
}

/**
 * Folds `omnigraph export` JSONL (`{"type","id","data"}` nodes and
 * `{"edge","id","from","to","data"}` edges) into a ghost graph. Above
 * `maxNodes`, the best-connected nodes are kept (ties in export order).
 */
export function foldExport(jsonl: string, edgeEnds: Record<string, [string, string]>, maxNodes: number): GhostGraph {
  const nodes: GhostNode[] = []
  const rawEdges: { id: string; type: string; from: string; to: string }[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const data = typeof r.data === 'object' && r.data !== null ? (r.data as Record<string, unknown>) : {}
    if (typeof r.edge === 'string' && typeof r.from === 'string' && typeof r.to === 'string') {
      rawEdges.push({ id: typeof r.id === 'string' ? r.id : `${r.edge}|${r.from}|${r.to}`, type: r.edge, from: r.from, to: r.to })
    } else if (typeof r.type === 'string' && typeof r.id === 'string') {
      nodes.push({ id: nodeId(r.type, r.id), type: r.type, key: r.id, label: labelOf(data, r.id) })
    }
  }
  const byKey = keyIndex(nodes)
  let edges: GhostEdge[] = []
  for (const e of rawEdges) {
    const ends = edgeEnds[e.type]
    const from = resolveEnd(byKey, e.from, ends?.[0])
    const to = resolveEnd(byKey, e.to, ends?.[1])
    if (from !== undefined && to !== undefined) edges.push({ id: e.id, type: e.type, from, to })
  }
  if (nodes.length <= maxNodes) return { nodes, edges, truncated: false, edgeEnds }

  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  const ranked = nodes
    .map((node, order) => ({ node, order, degree: degree.get(node.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.order - b.order)
    .slice(0, maxNodes)
    .sort((a, b) => a.order - b.order)
  const kept = new Set(ranked.map(r => r.node.id))
  edges = edges.filter(e => kept.has(e.from) && kept.has(e.to))
  return { nodes: ranked.map(r => r.node), edges, truncated: true, edgeEnds }
}

/** A commit's changes applied to the graph (a new graph; the input is untouched). */
export function applyChanges(graph: GhostGraph, changes: readonly EntityChange[]): GhostGraph {
  let nodes = graph.nodes.slice()
  let edges = graph.edges.slice()
  for (const c of changes) {
    if (c.kind === 'node') {
      const id = nodeId(c.type, c.id)
      const at = nodes.findIndex(n => n.id === id)
      if (c.op === 'delete') {
        if (at >= 0) nodes.splice(at, 1)
        edges = edges.filter(e => e.from !== id && e.to !== id)
      } else if (at >= 0) {
        if (c.label !== undefined) nodes[at] = { ...nodes[at]!, label: c.label }
      } else {
        nodes.push({ id, type: c.type, key: c.id, label: c.label ?? c.id })
      }
      continue
    }
    if (c.op === 'delete') {
      edges = edges.filter(e => e.id !== c.id)
      continue
    }
    if (c.from === undefined || c.to === undefined || edges.some(e => e.id === c.id)) continue
    const byKey = keyIndex(nodes)
    const ends = graph.edgeEnds[c.type]
    const from = resolveEnd(byKey, c.from, ends?.[0])
    const to = resolveEnd(byKey, c.to, ends?.[1])
    if (from !== undefined && to !== undefined) edges.push({ id: c.id, type: c.type, from, to })
  }
  nodes = nodes.slice()
  return { ...graph, nodes, edges }
}
