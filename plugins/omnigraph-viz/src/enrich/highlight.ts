import type { GhostGraph } from '../../types'

export interface MatchIndex {
  byKey: Map<string, string[]>
  byLabel: Map<string, string[]>
}

export const MAX_MATCHES = 50

function add(map: Map<string, string[]>, text: string, id: string): void {
  const ids = map.get(text)
  if (!ids) map.set(text, [id])
  else if (!ids.includes(id)) ids.push(id)
}

export function buildMatchIndex(graph: GhostGraph): MatchIndex {
  const byKey = new Map<string, string[]>()
  const byLabel = new Map<string, string[]>()
  for (const node of graph.nodes) {
    add(byKey, node.key, node.id)
    add(byLabel, node.label, node.id)
  }
  return { byKey, byLabel }
}

/** A `return { $p }` cell is the node as JSON: `{"@id": "…", …}`. */
function exactKey(cell: string): string | undefined {
  if (!cell.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(cell)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const id = (parsed as Record<string, unknown>)['@id']
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

function prefixMatch(map: Map<string, string[]>, prefix: string): string[] | undefined {
  let found: string[] | undefined
  for (const [text, ids] of map) {
    if (!text.startsWith(prefix)) continue
    if (found) return undefined
    found = ids
  }
  return found
}

/**
 * Nodes a read's result cells name: exact via `@id`, else a cell equal to a
 * node key or label, else a truncated cell (`…`) matching one key or label.
 * Numbers, booleans, `null` and short cells are ignored; at most 50 nodes.
 */
export function matchCells(cells: readonly string[][], index: MatchIndex): { nodeIds: string[]; isExact: boolean } {
  const found = new Set<string>()
  let isExact = true
  for (const row of cells) {
    for (const cell of row) {
      if (found.size >= MAX_MATCHES) break
      const text = cell.trim()
      if (text.length < 3 || text === 'null' || text === 'true' || text === 'false' || /^-?\d+(\.\d+)?$/.test(text)) continue
      const key = exactKey(text)
      let ids: string[] | undefined
      if (key !== undefined) {
        ids = index.byKey.get(key)
      } else {
        ids = index.byKey.get(text) ?? index.byLabel.get(text)
        if (!ids && text.endsWith('…') && text.length > 3) {
          const prefix = text.slice(0, -1)
          ids = prefixMatch(index.byKey, prefix) ?? prefixMatch(index.byLabel, prefix)
        }
        if (ids) isExact = false
      }
      for (const id of ids ?? []) if (found.size < MAX_MATCHES) found.add(id)
    }
  }
  return { nodeIds: [...found], isExact: found.size > 0 && isExact }
}
