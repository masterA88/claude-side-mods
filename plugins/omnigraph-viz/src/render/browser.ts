import type { GhostGraph } from '../../types'
import { egoLayout } from '../browse/ego'
import type { EgoLayout, EgoNode } from '../browse/ego'
import { centreOf, columnItems, edgeLabel, indexOf, opens, relationsOf, selectedItem } from '../browse/model'
import type { Browse, Centre, Column, Item } from '../browse/model'
import { easeOut, progress } from '../graph/effects'
import type { Effect } from '../graph/effects'
import { ACCENT_RING, dim, mix, WHITE } from '../graph/palette'
import { fit } from './braille'
import type { BrailleCanvas } from './braille'

/** What the browser needs besides the graph and the path. */
export interface BrowserLook {
  colorOf: (type: string) => number
  /** The latest op's nodes, and the Feed's selected op's. */
  lit: ReadonlySet<string>
  /** Node and edge ids the latest diff inserted. */
  fresh: ReadonlySet<string>
  isFollowing: boolean
}

/** A neighbour in the picture: which node (or type) it stands for. */
export interface PictureNode extends EgoNode {
  /** What the dot stands for (a node id, `type:<T>`): a move matches dots across two pictures by it. */
  entity: string
  node?: string
  type: string
  isLit: boolean
  isNew: boolean
}

/** The picture's content for one centre, before layout. */
export interface Picture {
  /** Identifies the centre: a change of key is a move through the graph. */
  key: string
  centre: { entity: string; text: string; type: string | null; glyph: string; isLit: boolean; isNew: boolean }
  nodes: PictureNode[]
  groups: { key: string; label: string }[]
  /** The selected neighbour's id, or null when the centre itself is selected. */
  selected: string | null
}

const TEXT = 0xc0caf5
const TEXT_DIM = 0x737aa2
const RULE = 0x3b4261
const RELATION = 0x565f89
/** Dotted links: visible on a dark terminal, quieter than the labels. */
const LINK = 0x4e5679
const NODE_DIM = 0.8
const PREVIEW_DIM = 0.6
const COLUMNS = 3
/** Below this, a fading dot isn't drawn at all (a black glyph would still cover the links). */
const MIN_ALPHA = 0.08
/** At most this many relations are named in the picture. */
const RELATION_LABELS = 5
/** Dots kept clear around the centre's glyph. */
const HALO = 5

const counted = (label: string, n: number) => (n > 1 ? `${label} ×${n}` : label)

/** The picture around a centre: a node's neighbours by relation, a type's linked types, or an op's results. */
export function pictureOf(graph: GhostGraph, centre: Centre, look: BrowserLook): Picture | null {
  const { nodes, counts, typeLinks } = indexOf(graph)
  const priority = (isSelected: boolean, isHot: boolean) => (isSelected ? 3 : isHot ? 2 : 0)
  if (centre.kind === 'type') {
    const links = typeLinks.filter(l => l.from === centre.type || l.to === centre.type)
    const out = links.map(l => {
      const isOut = l.from === centre.type
      const other = isOut ? l.to : l.from
      const key = `${isOut ? 'out' : 'in'}:${l.type}:${other}`
      return {
        group: { key, label: counted(isOut ? edgeLabel(l.type, centre.type, other) : edgeLabel(l.type, other, centre.type), l.count) },
        node: { id: key, entity: `type:${other}`, label: `${other} ${counts.get(other) ?? 0}`, group: key, priority: 0, type: other, isLit: false, isNew: false },
      }
    })
    return {
      key: `type:${centre.type}`,
      centre: { entity: `type:${centre.type}`, text: `${centre.type} ${counts.get(centre.type) ?? 0}`, type: centre.type, glyph: '◉', isLit: false, isNew: false },
      nodes: out.map(o => o.node),
      groups: out.map(o => o.group),
      selected: null,
    }
  }
  if (centre.kind === 'hub') {
    const members = centre.hub.nodes.flatMap(id => nodes.get(id) ?? [])
    const types = [...new Set(members.map(n => n.type))].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    const ordered = types.flatMap(t => members.filter(n => n.type === t))
    const key = `hub:${centre.hub.label}:${centre.hub.nodes.join(',')}`
    return {
      key,
      centre: { entity: key, text: `${centre.hub.label} · ${members.length}`, type: null, glyph: '◆', isLit: true, isNew: false },
      nodes: ordered.map(n => ({ id: n.id, entity: n.id, node: n.id, label: n.label, group: n.type, priority: 2, type: n.type, isLit: look.lit.has(n.id), isNew: look.fresh.has(n.id) })),
      groups: types.map(t => ({ key: t, label: counted(t, members.filter(n => n.type === t).length) })),
      selected: null,
    }
  }
  const self = nodes.get(centre.node)
  if (!self) return null
  const relations = relationsOf(graph, centre.node)
  let selected: string | null = null
  const items = relations.flatMap(r =>
    r.nodes.map(n => {
      const id = `${r.key}|${n.id}`
      const isSelected = selected === null && centre.selected === n.id
      if (isSelected) selected = id
      const isHot = look.lit.has(n.id) || look.fresh.has(n.id)
      return { id, entity: n.id, node: n.id, label: n.label, group: r.key, priority: priority(isSelected, isHot), type: n.type, isLit: look.lit.has(n.id), isNew: look.fresh.has(n.id) }
    }),
  )
  return {
    key: `node:${self.id}`,
    centre: { entity: self.id, text: self.label, type: self.type, glyph: '◉', isLit: look.lit.has(self.id), isNew: look.fresh.has(self.id) },
    nodes: items,
    groups: relations.map(r => ({ key: r.key, label: counted(r.label.slice(2), r.nodes.length) })),
    selected,
  }
}

/** Rows of the browser: breadcrumb, picture, a rule, the columns. */
export function regions(rows: number) {
  // About 55% for the picture, but the columns keep at least a title and four rows.
  const pictureRows = Math.max(3, Math.min(Math.round((rows - 2) * 0.55), rows - 7))
  return { top: 1, pictureRows, rule: 1 + pictureRows, columnsTop: 2 + pictureRows }
}

/** A move between two pictures in progress: from what, how far (0..1, eased). */
export interface Motion {
  from: Picture
  fromLayout: EgoLayout
  k: number
}

/** Live effects to draw over the picture, at `now`. */
export interface Live {
  effects: readonly Effect[]
  now: number
  graph: GhostGraph
}

interface Spot {
  col: number
  row: number
  /** 1: fully shown; less while fading in or out. */
  alpha: number
}

/**
 * The picture drawn into rows `top`.. of the canvas. During a move, dots that
 * are in both pictures slide from their old place to their new one, new ones
 * fade in and gone ones fade out. Effects light dots and links: a new node
 * flashes white with a ring, a read glows, a new link draws in from the
 * centre, a pulse runs along a link.
 */
export function drawPicture(
  canvas: BrailleCanvas,
  pic: Picture,
  layout: EgoLayout,
  top: number,
  rows: number,
  look: BrowserLook,
  motion?: Motion,
  live?: Live,
): void {
  const colorOf = (type: string | null) => (type === null ? ACCENT_RING : look.colorOf(type))
  const k = motion ? Math.max(0, Math.min(1, motion.k)) : 1
  const before = new Map<string, { col: number; row: number }>()
  if (motion) {
    before.set(motion.from.centre.entity, motion.fromLayout.centre)
    const fromNodes = new Map(motion.from.nodes.map(n => [n.id, n]))
    for (const p of motion.fromLayout.nodes) {
      const entity = fromNodes.get(p.id)!.entity
      if (!before.has(entity)) before.set(entity, p)
    }
  }
  // Dots in both pictures slide all the way; the old picture's others fade out in the
  // first half and the new one's fade in during the second, so their labels never overlap.
  const spotOf = (entity: string, to: { col: number; row: number }): Spot => {
    const from = before.get(entity)
    if (!motion) return { ...to, alpha: 1 }
    if (!from) return { ...to, alpha: Math.max(0, 2 * k - 1) }
    return { col: Math.round(from.col + (to.col - from.col) * k), row: Math.round(from.row + (to.row - from.row) * k), alpha: 1 }
  }
  const dot = (at: { col: number; row: number }) => ({ x: at.col * 2 + 1, y: (at.row + top) * 4 + 2 })

  // Effects by target: a node id, or an edge id.
  const fx = new Map<string, { kind: Effect['kind']; t: number }[]>()
  for (const e of live?.effects ?? []) {
    const t = progress(e, live!.now)
    if (t >= 1) continue
    fx.set(e.target, [...(fx.get(e.target) ?? []), { kind: e.kind, t }])
  }
  const edges = new Map((live?.graph.edges ?? []).filter(e => fx.has(e.id)).map(e => [e.id, e]))
  /** The effect on the link between the centre and `entity`, if any. */
  const linkFx = (entity: string) => {
    for (const [id, edge] of edges) {
      const ends = [edge.from, edge.to]
      if (ends.includes(pic.centre.entity) && ends.includes(entity) && edge.from !== edge.to) return fx.get(id)!
    }
    return []
  }

  const centre = spotOf(pic.centre.entity, layout.centre)
  const c = dot(centre)
  const byId = new Map(pic.nodes.map(n => [n.id, n]))
  const placed = layout.nodes.map(p => ({ p, n: byId.get(p.id)!, at: spotOf(byId.get(p.id)!.entity, p) }))

  canvas.clip(top, top + rows - 1)
  for (const { p, n, at } of placed) {
    if (at.alpha < MIN_ALPHA) continue
    const d = dot(at)
    // Links leave a little room around the centre's glyph, so it stays legible where they meet.
    const h = Math.min(0.5, HALO / Math.max(1, Math.hypot(d.x - c.x, d.y - c.y)))
    const s = { x: c.x + (d.x - c.x) * h, y: c.y + (d.y - c.y) * h }
    const color = colorOf(n.type)
    const effects = linkFx(n.entity)
    const drawIn = effects.find(e => e.kind === 'draw')
    // The op's own links (both ends lit) and the selected one are solid; the rest dotted.
    const isHot = pic.selected === p.id || (n.isLit && (pic.centre.isLit || pic.centre.type === null))
    if (drawIn) {
      const t = easeOut(drawIn.t)
      canvas.line(s.x, s.y, s.x + (d.x - s.x) * t, s.y + (d.y - s.y) * t, WHITE, 3)
    } else if (isHot) canvas.line(s.x, s.y, d.x, d.y, dim(mix(color, WHITE, 0.15), at.alpha), 2)
    else canvas.line(s.x, s.y, d.x, d.y, dim(LINK, at.alpha), 1, 2)
    for (const pulse of effects.filter(e => e.kind === 'pulse')) canvas.disc(s.x + (d.x - s.x) * pulse.t, s.y + (d.y - s.y) * pulse.t, 1, WHITE, 4)
  }
  // Rings around lit dots: a flash grows white, a glow fades out.
  const ring = (entity: string, at: Spot, color: number) => {
    for (const e of fx.get(entity) ?? []) {
      const t = easeOut(e.t)
      const d = dot(at)
      if (e.kind === 'flash') canvas.ring(d.x, d.y, 3 + 5 * t, mix(WHITE, color, t), 4)
      else if (e.kind === 'glow') canvas.ring(d.x, d.y, 3 + 3 * t, dim(color, 1 - t), 3)
    }
  }
  for (const { n, at } of placed) if (at.alpha >= MIN_ALPHA) ring(n.entity, at, colorOf(n.type))
  ring(pic.centre.entity, centre, colorOf(pic.centre.type))
  canvas.clip()

  /** A dot's color now: lit or new at full strength, else dimmed; a flash starts white; fading scales it. */
  const tone = (entity: string, type: string | null, isBright: boolean, alpha: number) => {
    const full = colorOf(type)
    let color = isBright ? full : dim(full, NODE_DIM)
    for (const e of fx.get(entity) ?? []) {
      if (e.kind === 'flash') color = mix(WHITE, color, easeOut(e.t))
      else if (e.kind === 'glow') color = mix(mix(full, WHITE, 0.4), color, easeOut(e.t))
    }
    return dim(color, alpha)
  }

  if (motion) {
    // Dots of the old picture that the new one doesn't have fade out where they were.
    const now = new Set([pic.centre.entity, ...pic.nodes.map(n => n.entity)])
    const fromNodes = new Map(motion.from.nodes.map(n => [n.id, n]))
    const alpha = 1 - 2 * k
    const leaving = [
      ...motion.fromLayout.nodes.map(p => ({ entity: fromNodes.get(p.id)!.entity, type: fromNodes.get(p.id)!.type, col: p.col, row: p.row, text: p.text, textCol: p.textCol, glyph: '●' })),
      { entity: motion.from.centre.entity, type: motion.from.centre.type, ...motion.fromLayout.centre, glyph: motion.from.centre.glyph },
    ]
    for (const l of alpha >= MIN_ALPHA ? leaving : []) {
      if (now.has(l.entity)) continue
      const color = dim(colorOf(l.type), NODE_DIM * alpha)
      canvas.text(l.col, top + l.row, l.glyph, color)
      canvas.text(l.textCol, top + l.row, l.text, color)
    }
  } else {
    for (const l of layout.labels) canvas.text(l.col, top + l.row, l.text, RELATION)
  }
  for (const { p, n, at } of placed) {
    if (at.alpha < MIN_ALPHA) continue
    const color = tone(n.entity, n.type, n.isLit || n.isNew, at.alpha)
    const row = top + at.row
    const shift = at.col - p.col
    canvas.text(at.col, row, '●', color)
    canvas.text(p.textCol + shift, row, p.text, color)
    if (p.tagCol !== undefined) canvas.text(p.tagCol + shift, row, 'NEW', dim(WHITE, at.alpha))
    if (pic.selected === p.id && !motion) canvas.invert(p.textCol, row, p.text.length)
  }
  const centreColor = tone(pic.centre.entity, pic.centre.type, true, Math.max(MIN_ALPHA, centre.alpha))
  const shift = centre.col - layout.centre.col
  const row = top + centre.row
  canvas.text(centre.col, row, pic.centre.glyph, centreColor)
  canvas.text(layout.centre.textCol + shift, row, layout.centre.text, centreColor)
  if (layout.centre.tagCol !== undefined) canvas.text(layout.centre.tagCol + shift, row, 'NEW', WHITE)
  if (pic.selected === null && !motion) canvas.invert(layout.centre.textCol, row, layout.centre.text.length)
  if (layout.more && !motion) canvas.text(layout.more.col, top + layout.more.row, layout.more.text, TEXT_DIM)
}

/**
 * Lays a picture out in a canvas-wide box `rows` tall. Only a few relations
 * get a label (the selected neighbour's, then the op's, then the biggest):
 * a hub's dozen labels would bury its centre.
 */
export function layoutOf(pic: Picture, cols: number, rows: number): EgoLayout {
  const weight = (key: string) => {
    const members = pic.nodes.filter(n => n.group === key)
    return members.some(n => n.id === pic.selected) ? 1e6 : members.some(n => n.isLit || n.isNew) ? 1e3 + members.length : members.length
  }
  const named = new Set([...pic.groups].sort((a, b) => weight(b.key) - weight(a.key)).slice(0, RELATION_LABELS).map(g => g.key))
  const groups = pic.groups.map(g => (named.has(g.key) ? g : { ...g, label: '' }))
  return egoLayout(pic.centre.text, pic.nodes.map(n => (n.isNew ? { ...n, tag: 'NEW' } : n)), groups, cols, rows, pic.centre.isNew ? 'NEW' : undefined)
}

/** A column's title: what it lists. */
function titleOf(graph: GhostGraph, column: Column): string {
  if (column.kind === 'types') return 'Types'
  if (column.kind === 'nodes') return `${column.type} ${indexOf(graph).counts.get(column.type) ?? 0}`
  return indexOf(graph).nodes.get(column.node)?.label ?? '(gone)'
}

/** The breadcrumb: each step's selection, links read as their relation (`Epic › Offline sync › contains › Fix login`). */
export function breadcrumb(graph: GhostGraph, b: Browse): string {
  if (b.hub) return `◆ ${b.hub.label} · ${b.hub.nodes.length} nodes`
  const parts: string[] = []
  for (const step of b.path) {
    const item = selectedItem(graph, step)
    if (!item) continue
    if (step.column.kind === 'links' && item.group) {
      const header = columnItems(graph, step.column).find(i => i.isHeader && i.group === item.group)
      const verb = header?.label.split(' · ')[0] ?? ''
      parts.push(verb.startsWith('→ ') ? verb.slice(2) : verb)
    }
    parts.push(item.label)
  }
  return parts.join(' › ')
}

function drawItem(canvas: BrailleCanvas, item: Item, x: number, row: number, w: number, look: BrowserLook, litTypes: ReadonlySet<string>, factor: number): void {
  if (item.isHeader) {
    canvas.text(x, row, fit(item.label, w), dim(RELATION, factor))
    return
  }
  const color = look.colorOf(item.type)
  const isLit = item.node !== undefined ? look.lit.has(item.node) : litTypes.has(item.type)
  const isNew = item.node !== undefined && look.fresh.has(item.node)
  canvas.text(x, row, isLit ? '▶' : ' ', dim(ACCENT_RING, factor))
  const tail = item.count !== undefined && item.node === undefined ? ` ${item.count}` : isNew ? ' NEW' : ''
  const label = fit(item.label, w - 2 - tail.length)
  canvas.text(x + 2, row, label, dim(isLit || isNew ? color : dim(color, NODE_DIM), factor))
  if (tail) canvas.text(x + w - tail.length, row, tail, dim(isNew ? WHITE : TEXT_DIM, factor))
}

/** One column in a `w`-wide slot: its title, then its rows around the selection, with `↑ n more` / `↓ n more`. */
function drawColumn(
  canvas: BrailleCanvas,
  graph: GhostGraph,
  column: Column,
  selected: string | null,
  x: number,
  w: number,
  top: number,
  look: BrowserLook,
  role: 'path' | 'active' | 'preview',
): void {
  const factor = role === 'preview' ? PREVIEW_DIM : 1
  const nodes = indexOf(graph).nodes
  const litTypes = new Set([...look.lit].flatMap(id => nodes.get(id)?.type ?? []))
  canvas.text(x, top, fit(titleOf(graph, column), w), role === 'active' ? TEXT : dim(TEXT_DIM, factor))
  const items = columnItems(graph, column)
  const height = canvas.rows - top - 1
  if (items.length === 0) {
    canvas.text(x, top + 1, fit(column.kind === 'links' ? '(no links)' : '(empty)', w), dim(TEXT_DIM, factor))
    return
  }
  const chosen = role === 'preview' ? undefined : selectedItem(graph, { column, selected })
  const at = Math.max(0, items.findIndex(i => i.id === chosen?.id))
  let start = 0
  if (items.length > height) start = Math.max(0, Math.min(items.length - height, at - Math.floor(height / 2)))
  const end = Math.min(items.length, start + height)
  // Too short for `more` rows without covering the selection: a bare window.
  const hasMarks = height >= 3
  for (let i = start; i < end; i++) {
    const row = top + 1 + i - start
    if (hasMarks && i === start && start > 0) canvas.text(x, row, fit(`  ↑ ${start + 1} more`, w), TEXT_DIM)
    else if (hasMarks && i === end - 1 && end < items.length) canvas.text(x, row, fit(`  ↓ ${items.length - end + 1} more`, w), TEXT_DIM)
    else {
      drawItem(canvas, items[i]!, x, row, w, look, litTypes, factor)
      if (chosen && items[i]!.id === chosen.id) canvas.invert(x, row, w)
    }
  }
}

/** The columns: the path's last ones, then a preview of what the active selection opens. */
export function drawColumns(canvas: BrailleCanvas, graph: GhostGraph, b: Browse, top: number, look: BrowserLook): void {
  const last = b.path[b.path.length - 1]!
  const preview = opens(selectedItem(graph, last))
  const shown: { column: Column; selected: string | null; role: 'path' | 'active' | 'preview' }[] = [
    ...b.path.map((s, i) => ({ column: s.column, selected: s.selected, role: i === b.path.length - 1 ? ('active' as const) : ('path' as const) })),
    ...(preview ? [{ column: preview, selected: null, role: 'preview' as const }] : []),
  ].slice(-COLUMNS)
  const w = Math.floor((canvas.cols - (COLUMNS - 1)) / COLUMNS)
  shown.forEach((s, i) => drawColumn(canvas, graph, s.column, s.selected, i * (w + 1), w, top, look, s.role))
  for (let i = 1; i < COLUMNS; i++) {
    for (let row = top; row < canvas.rows; row++) canvas.text(i * (w + 1) - 1, row, '│', RULE)
  }
}

/** How the browser moves and what lights it: where it was before the last move, how far that move is, the live effects. */
export interface BrowserMotion {
  from?: Browse
  k?: number
  live?: Live
}

/** The whole browser: the breadcrumb, the picture of where the browser is, and the columns. */
export function drawBrowser(canvas: BrailleCanvas, graph: GhostGraph, b: Browse, look: BrowserLook, move: BrowserMotion = {}): void {
  const { top, pictureRows, rule, columnsTop } = regions(canvas.rows)
  const tag = look.isFollowing ? '● live' : ''
  const crumb = breadcrumb(graph, b)
  const room = canvas.cols - tag.length - 1
  canvas.text(0, 0, crumb.length <= room ? crumb : `…${crumb.slice(crumb.length - room + 1)}`, TEXT)
  if (tag) canvas.text(canvas.cols - tag.length, 0, tag, ACCENT_RING)
  const centre = centreOf(b, graph)
  const pic = centre && pictureOf(graph, centre, look)
  if (pic) {
    let motion: Motion | undefined
    if (move.from && move.k !== undefined && move.k < 1) {
      const was = centreOf(move.from, graph)
      const from = was && pictureOf(graph, was, look)
      if (from && from.key !== pic.key) motion = { from, fromLayout: layoutOf(from, canvas.cols, pictureRows), k: move.k }
    }
    drawPicture(canvas, pic, layoutOf(pic, canvas.cols, pictureRows), top, pictureRows, look, motion, move.live)
  }
  canvas.text(0, rule, '─'.repeat(canvas.cols), RULE)
  drawColumns(canvas, graph, b, columnsTop, look)
}
