import type { GhostGraph, LedgerLine } from '../../types'
import { nodeId } from './ghost'

export type EffectKind = 'glow' | 'flash' | 'fade' | 'pulse' | 'draw'

export interface Effect {
  kind: EffectKind
  /** A node id, or an edge id for `pulse` and `draw`. */
  target: string
  startedAt: number
  durationMs: number
}

export const DURATION: Readonly<Record<EffectKind, number>> = {
  glow: 1600,
  flash: 900,
  fade: 1200,
  pulse: 600,
  draw: 500,
}

/** 0 at the start, 1 at the end (and beyond, once over). */
export const progress = (e: Effect, now: number): number => Math.max(0, (now - e.startedAt) / e.durationMs)
export const isLive = (e: Effect, now: number): boolean => progress(e, now) < 1
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, t)) ** 3

const effect = (kind: EffectKind, target: string, at: number): Effect => ({ kind, target, startedAt: at, durationMs: DURATION[kind] })

/** Pulses along every edge whose two ends are both in `ids`. */
export function pulsesAmong(graph: GhostGraph, ids: readonly string[], at: number): Effect[] {
  const set = new Set(ids)
  return graph.edges.filter(e => set.has(e.from) && set.has(e.to)).map(e => effect('pulse', e.id, at))
}

/**
 * The effects a ledger line starts: inserts flash, updates glow, deletes
 * fade, new edges draw in; a read's nodes glow and the edges between them pulse.
 */
export function effectsFor(line: LedgerLine, graph: GhostGraph | null): Effect[] {
  if (line.t === 'touch') {
    return [...line.nodeIds.map(id => effect('glow', id, line.at)), ...(graph ? pulsesAmong(graph, line.nodeIds, line.at) : [])]
  }
  if (line.t !== 'diff') return []
  return line.changes.flatMap(c => {
    if (c.kind === 'edge') return c.op === 'insert' ? [effect('draw', c.id, line.at)] : []
    const id = nodeId(c.type, c.id)
    return [effect(c.op === 'insert' ? 'flash' : c.op === 'update' ? 'glow' : 'fade', id, line.at)]
  })
}
