import type { EntityChange, GhostGraph, LedgerLine, OpIntent } from '../../types'
import { back, centreOf, deeper, move, pathForDeletes, pathForDiff, pathForNodes, repair, TOP } from '../browse/model'
import type { Browse } from '../browse/model'
import { effectsFor, isLive, pulsesAmong } from '../graph/effects'
import type { Effect } from '../graph/effects'
import { assignColors } from '../graph/palette'
import type { BrailleCanvas } from './braille'
import { drawBrowser } from './browser'
import type { Action } from './explore'

/** The nodes a diff touched: changed nodes, and both ends of new or changed edges. */
function touchedBy(changes: readonly EntityChange[], graph: GhostGraph): string[] {
  const edges = new Map(graph.edges.map(e => [e.id, e]))
  return changes.flatMap(c => {
    if (c.kind === 'node') return c.op === 'delete' ? [] : [`${c.type}:${c.id}`]
    const edge = edges.get(c.id)
    return edge ? [edge.from, edge.to] : []
  })
}

/** How long the picture takes to move to a new centre. */
export const MOVE_MS = 450

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** What a browser centres on, as a key: a different key is a move through the graph. */
function centreKey(b: Browse, graph: GhostGraph): string {
  const c = centreOf(b, graph)
  if (!c) return ''
  return c.kind === 'type' ? `type:${c.type}` : c.kind === 'node' ? `node:${c.node}` : `hub:${c.hub.label}:${c.hub.nodes.join(',')}`
}

/** How an op reads in the picture's centre: `query ready`. */
export const opName = (intent: OpIntent): string => [intent.verb, intent.queryName].filter(Boolean).join(' ')

/**
 * Everything the browser draws that is not in the ledger: where it is, whether
 * it follows ops, live effects, type colors. Fed ledger lines in order, so
 * live capture and replay draw the same picture.
 */
export class Scene {
  effects: Effect[] = []
  private typeOrder: string[] = []
  colors = new Map<string, number>()
  /** The latest op's nodes: lit until another op lights something. */
  accent = new Set<string>()
  /** Nodes of the op selected in the Feed, lit while it stays selected. */
  pinned: string[] = []
  /** Node and edge ids the latest lit diff inserted: marked NEW. */
  private fresh = new Set<string>()
  /** Where the browser is. */
  browse: Browse = TOP
  /** Following: each op moves the browser to it. A key stops that; `l` resumes it. */
  isFollowing = true
  /** Where the latest op took (or would take) the browser. */
  private latest: Browse | null = null
  private opNames = new Map<string, string>()
  /** The last move: where the browser was, and when it left (scene time, so replays repeat). */
  private moved: { from: Browse; at: number } | null = null
  /** Whether it was following when the Feed's selection took it: deselecting resumes that. */
  private wasFollowing = false

  private learnTypes(graph: GhostGraph): void {
    let isNew = false
    for (const node of graph.nodes) {
      if (this.typeOrder.includes(node.type)) continue
      this.typeOrder.push(node.type)
      isNew = true
    }
    if (isNew) this.colors = assignColors(this.typeOrder)
  }

  /**
   * Moves the browser at `at`. A new centre slides in over MOVE_MS; the same
   * centre (another row in its links) doesn't move, and a move started while
   * one is still running jumps, so quick keys never show a stale picture.
   */
  private go(to: Browse, at: number, graph: GhostGraph): void {
    const isRunning = this.moved !== null && at - this.moved.at < MOVE_MS
    this.moved = isRunning || centreKey(this.browse, graph) === centreKey(to, graph) ? null : { from: this.browse, at }
    this.browse = to
  }

  /** `before`/`after`: the reduced graph before and after this line. */
  onLine(line: LedgerLine, _before: GhostGraph | null, after: GhostGraph | null): void {
    if (line.t === 'op.start') {
      this.opNames.set(line.op.id, opName(line.op.intent))
      return
    }
    if (!after || (line.t !== 'graph' && line.t !== 'diff' && line.t !== 'touch')) return
    this.learnTypes(after)
    if (line.t === 'graph') return
    // Deleted nodes leave nothing to fade in a picture of what is there.
    this.effects.push(...effectsFor(line, after).filter(e => e.kind !== 'fade'))
    if (line.t === 'diff') this.forget(after)
    const lit = line.t === 'touch' ? line.nodeIds : touchedBy(line.changes, after)
    if (lit.length === 0) {
      // A diff that only deleted shows the deleted node's type; any other op that lights nothing keeps the previous one on screen.
      const path = line.t === 'diff' ? pathForDeletes(after, line.changes) : null
      if (path) {
        this.latest = path
        if (this.isFollowing) this.go(path, line.at, after)
      }
      return
    }
    this.accent = new Set(lit)
    this.fresh = new Set(
      line.t === 'diff' ? line.changes.filter(c => c.op === 'insert').map(c => (c.kind === 'node' ? `${c.type}:${c.id}` : c.id)) : [],
    )
    const path = line.t === 'touch' ? pathForNodes(after, line.nodeIds, this.opNames.get(line.opId) ?? 'read') : pathForDiff(after, line.changes)
    if (!path) return
    this.latest = path
    if (this.isFollowing) this.go(path, line.at, after)
  }

  /** Drops what a diff deleted from where the browser is, where `l` goes, and the Feed's selection. */
  private forget(graph: GhostGraph): void {
    this.browse = repair(this.browse, graph)
    if (this.latest) this.latest = repair(this.latest, graph)
    if (this.moved) this.moved = { ...this.moved, from: repair(this.moved.from, graph) }
    const ids = new Set(graph.nodes.map(n => n.id))
    this.pinned = this.pinned.filter(id => ids.has(id))
  }

  /** The Feed's selection: the op's nodes glow again and the browser goes to them. */
  focus(nodeIds: readonly string[], graph: GhostGraph, now: number, label = 'selected op'): void {
    this.pinned = [...nodeIds]
    const path = pathForNodes(graph, nodeIds, label)
    if (path) {
      if (this.pinned.length > 0 && this.isFollowing) this.wasFollowing = true
      this.isFollowing = false
      this.go(path, now, graph)
    }
    this.effects.push(
      ...nodeIds.map(id => ({ kind: 'glow' as const, target: id, startedAt: now, durationMs: 1600 })),
      ...pulsesAmong(graph, nodeIds, now),
    )
  }

  /** The Feed's selection cleared: its nodes go dark, and following resumes if the selection stopped it. */
  unfocus(graph: GhostGraph, now: number): void {
    this.pinned = []
    if (!this.wasFollowing) return
    this.wasFollowing = false
    this.key({ kind: 'live' }, graph, now)
  }

  /** A key in the browser. Any move stops following; `l` goes back to the latest op. */
  key(action: Action, graph: GhostGraph, now: number): void {
    this.wasFollowing = false
    if (action.kind === 'live') {
      this.isFollowing = true
      if (this.latest) this.go(this.latest, now, graph)
      return
    }
    // The op's hub gives way to the column it was drawn over.
    const here: Browse = { path: this.browse.path }
    let next: Browse
    if (action.kind === 'move') next = move(here, graph, action.delta)
    else if (action.kind === 'deeper') next = deeper(here, graph)
    else if (action.kind === 'back') next = back(here)
    else return
    this.isFollowing = false
    this.go(next, now, graph)
  }

  /** A frame's worth of time: spent effects dropped. */
  tick(now: number): void {
    this.effects = this.effects.filter(e => isLive(e, now))
  }

  isAnimating(now: number): boolean {
    return this.effects.some(e => isLive(e, now)) || (this.moved !== null && now - this.moved.at < MOVE_MS)
  }

  /** The browser: breadcrumb, picture and columns. */
  drawFrame(canvas: BrailleCanvas, graph: GhostGraph | null, now: number): void {
    if (!graph) return
    const look = {
      colorOf: (type: string) => this.colors.get(type) ?? 0xc0caf5,
      lit: new Set([...this.accent, ...this.pinned]),
      fresh: this.fresh,
      isFollowing: this.isFollowing,
    }
    const k = this.moved ? easeInOut(Math.max(0, Math.min(1, (now - this.moved.at) / MOVE_MS))) : 1
    drawBrowser(canvas, graph, this.browse, look, {
      ...(this.moved && k < 1 ? { from: this.moved.from, k } : {}),
      live: { effects: this.effects, now, graph },
    })
  }
}
