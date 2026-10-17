import { fit } from '../render/braille'

/** A neighbour to place around the centre. */
export interface EgoNode {
  /** Unique in the picture (a node can sit in two relations). */
  id: string
  label: string
  /** Higher keeps its slot when not everything fits: selected 3, lit or new 2. */
  priority: number
  group: string
  /** A word kept whole beside the label, between it and the dot (`NEW`). */
  tag?: string
}

/** A neighbour as placed: its dot's cell, and its label beside it, away from the centre. */
export interface Placed {
  id: string
  col: number
  row: number
  side: 'left' | 'right'
  text: string
  textCol: number
  /** Where the tag goes, when there is one. */
  tagCol?: number
}

export interface EgoLayout {
  /** The centre's dot, and its label right of it (then its tag, if any). */
  centre: { col: number; row: number; text: string; textCol: number; tagCol?: number }
  nodes: Placed[]
  /** One label per relation, halfway along its arc. */
  labels: { group: string; col: number; row: number; text: string }[]
  /** Neighbours left out for want of room. */
  hidden: number
  /** Where `+N more` fits without covering a label, when some are hidden. */
  more?: { col: number; row: number; text: string }
}

const LABEL_MAX = 24
const CENTRE_MAX = 36
/** Rows a label may move off its spot on the ellipse to find room. */
const NUDGE = [0, 1, -1, 2, -2, 3, -3]

/**
 * A star around one centre, laid out in a `cols` × `rows` cell box: the
 * centre in the middle, neighbours on an ellipse clockwise from the top in
 * the order given (so a relation keeps one arc), each label outward from its
 * dot. Labels never overlap; what can't find a row is counted as hidden.
 * Pure: the same input always gives the same picture.
 */
export function egoLayout(
  centre: string,
  nodes: readonly EgoNode[],
  groups: readonly { key: string; label: string }[],
  cols: number,
  rows: number,
  centreTag?: string,
): EgoLayout {
  const taken: [number, number][][] = Array.from({ length: rows }, () => [])
  const isFree = (row: number, a: number, b: number) =>
    row >= 0 && row < rows && a >= 0 && b < cols && taken[row]!.every(([x, y]) => b < x - 1 || a > y + 1)
  const take = (row: number, a: number, b: number) => taken[row]!.push([a, b])

  const cx = Math.floor(cols / 2)
  const cy = Math.floor(rows / 2)
  const tagWidth = centreTag ? centreTag.length + 1 : 0
  const centreText = fit(centre, Math.min(CENTRE_MAX, cols - 4 - tagWidth))
  const centreWidth = 2 + centreText.length + tagWidth
  const centreCol = Math.max(0, cx - Math.floor(centreWidth / 2))
  take(cy, centreCol, centreCol + centreWidth - 1)

  // Keep the most important neighbours when there are more than rows to hold them.
  const room = Math.max(0, 2 * (rows - 1))
  const keep = new Set(
    nodes
      .map((n, i) => ({ n, i }))
      .sort((a, b) => b.n.priority - a.n.priority || a.i - b.i)
      .slice(0, room)
      .map(({ n }) => n.id),
  )
  const shown = nodes.filter(n => keep.has(n.id))
  const rx = Math.max(6, Math.round(cols * 0.22))
  const ry = Math.max(1, rows / 2 - 1)
  const placed: Placed[] = []
  const angles = new Map<string, number>()
  shown.forEach((n, i) => {
    const angle = shown.length === 1 ? 0 : -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / shown.length
    const side = Math.cos(angle) >= -1e-9 ? 'right' : 'left'
    const col = Math.round(cx + rx * Math.cos(angle))
    const ideal = Math.round(cy + ry * Math.sin(angle))
    const extra = n.tag ? n.tag.length + 1 : 0
    const space = (side === 'right' ? cols - col - 2 : col - 1) - extra
    const text = fit(n.label, Math.min(LABEL_MAX, space))
    if (text.length < 3) return
    const width = text.length + extra
    const span = (row: number): [number, number] => (side === 'right' ? [col, col + 1 + width] : [col - 1 - width, col])
    const row = NUDGE.map(d => ideal + d).find(r => isFree(r, ...span(r)))
    if (row === undefined) return
    take(row, ...span(row))
    angles.set(n.id, angle)
    const textCol = side === 'right' ? col + 2 : col - 1 - width
    placed.push({ id: n.id, col, row, side, text, textCol, ...(n.tag ? { tagCol: textCol + text.length + 1 } : {}) })
  })

  // The count of what didn't fit goes in a free corner, bottom right first.
  const hidden = nodes.length - placed.length
  let more: EgoLayout['more']
  if (hidden > 0) {
    const text = `+${hidden} more`
    const spots = Array.from({ length: rows }, (_, i) => rows - 1 - i).flatMap(r => [[cols - text.length, r], [0, r]] as const)
    const spot = spots.find(([c, r]) => isFree(r, c, c + text.length - 1))
    if (spot) {
      take(spot[1], spot[0], spot[0] + text.length - 1)
      more = { col: spot[0], row: spot[1], text }
    }
  }

  const labels: EgoLayout['labels'] = []
  for (const g of groups) {
    const members = shown.filter(n => n.group === g.key && angles.has(n.id))
    if (members.length === 0 || g.label === '') continue
    const mid = (angles.get(members[0]!.id)! + angles.get(members[members.length - 1]!.id)!) / 2
    const text = fit(g.label, 18)
    const x = Math.round(cx + 0.55 * rx * Math.cos(mid) - text.length / 2)
    const y = Math.round(cy + 0.55 * ry * Math.sin(mid))
    const row = [y, y - 1, y + 1].find(r => isFree(r, x, x + text.length - 1))
    if (row === undefined) continue
    take(row, x, x + text.length - 1)
    labels.push({ group: g.key, col: x, row, text })
  }

  return {
    centre: { col: centreCol, row: cy, text: centreText, textCol: centreCol + 2, ...(centreTag ? { tagCol: centreCol + 3 + centreText.length } : {}) },
    nodes: placed,
    labels,
    hidden,
    ...(more ? { more } : {}),
  }
}
