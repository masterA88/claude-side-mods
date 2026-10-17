import { decodeLedger } from '../model/ledger'
import type { LedgerLine } from '../../types'

/** The longest pause a replay keeps between two lines, in ms. */
export const MAX_GAP_MS = 3000
/** An op shows as running (…) at least this long before its ✓ or ✗. */
export const MIN_RUN_MS = 120
/** Once the graph appears, the next line waits this long, so the layout settles on screen. */
export const SETTLE_HOLD_MS = 2000

/**
 * When each line plays, in ms from the replay's start: the recorded gaps
 * divided by `speed`, each at most MAX_GAP_MS, with the MIN_RUN_MS and
 * SETTLE_HOLD_MS floors. Whole milliseconds, so every replay lands on the
 * same times.
 */
export function schedule(lines: readonly LedgerLine[], speed: number): number[] {
  const offsets: number[] = []
  const startedAt = new Map<string, number>()
  let t = 0
  let holdUntil = 0
  lines.forEach((line, i) => {
    if (i > 0) t = Math.max(t + Math.min(MAX_GAP_MS, Math.max(0, line.at - lines[i - 1]!.at) / speed), holdUntil)
    if (line.t === 'op.end') t = Math.max(t, (startedAt.get(line.id) ?? -Infinity) + MIN_RUN_MS)
    t = Math.round(t)
    offsets.push(t)
    if (line.t === 'op.start') startedAt.set(line.op.id, t)
    if (line.t === 'graph') holdUntil = t + SETTLE_HOLD_MS
  })
  return offsets
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Why a v1 line can't be played, if it can't: its time, and the fields its kind needs downstream. */
function shapeError(line: Record<string, unknown>): string | undefined {
  if (typeof line.at !== 'number' || !Number.isFinite(line.at)) return 'no time (at)'
  switch (line.t) {
    case 'op.start': {
      const op = line.op
      const intent = isObject(op) ? op.intent : undefined
      return isObject(op) && typeof op.id === 'string' && isObject(intent) && typeof intent.verb === 'string' && Array.isArray(intent.argv)
        ? undefined
        : 'op.start without an op'
    }
    case 'op.end':
      return typeof line.id === 'string' && isObject(line.outcome) && typeof line.outcome.kind === 'string' ? undefined : 'op.end without an id or outcome'
    case 'graph': {
      const g = line.graph
      return isObject(g) && Array.isArray(g.nodes) && Array.isArray(g.edges) && isObject(g.edgeEnds) ? undefined : 'graph without nodes, edges and edge ends'
    }
    case 'diff':
      return typeof line.opId === 'string' && Array.isArray(line.changes) ? undefined : 'diff without changes'
    case 'touch':
      return typeof line.opId === 'string' && Array.isArray(line.nodeIds) ? undefined : 'touch without node ids'
    default:
      return undefined
  }
}

/** A ledger's text, checked for replay: its lines, or what is wrong with it (line-numbered). */
export function readReplay(text: string): { lines: LedgerLine[] } | { error: string } {
  const { errors } = decodeLedger(text)
  if (errors.length > 0) return { error: errors.length > 1 ? `${errors[0]} (and ${errors.length - 1} more)` : errors[0]! }
  // decodeLedger has vouched for every row but a cut-off last one; walk them again to check each line's shape by number.
  const lines: LedgerLine[] = []
  const rows = text.split('\n')
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(rows[i]!)
    } catch {
      continue
    }
    const why = shapeError(value as Record<string, unknown>)
    if (why !== undefined) return { error: `line ${i + 1}: ${why}` }
    lines.push(value as LedgerLine)
  }
  const played = lines.filter(line => line.t !== 'session')
  if (!played.some(line => line.t === 'op.start')) return { error: 'it holds no omnigraph operations' }
  return { lines: played }
}

/**
 * Plays ledger lines on the clock: `due(now)` hands back every line whose
 * time has come, in order, retimed so `at` is when it plays. Effects start at
 * `at`, so a replay animates as the session did.
 */
export class Player {
  private readonly offsets: number[]
  private cursor = 0

  constructor(
    private readonly lines: readonly LedgerLine[],
    readonly speed: number,
    readonly startAt: number,
  ) {
    this.offsets = schedule(lines, speed)
  }

  get isDone(): boolean {
    return this.cursor >= this.lines.length
  }

  /** Share of lines played, 0 to 1. */
  get progress(): number {
    return this.lines.length === 0 ? 1 : this.cursor / this.lines.length
  }

  /** How long the whole replay runs, in ms. */
  get durationMs(): number {
    return this.offsets[this.offsets.length - 1] ?? 0
  }

  /** When the next line plays; undefined once all have. */
  get nextAt(): number | undefined {
    return this.isDone ? undefined : this.startAt + this.offsets[this.cursor]!
  }

  due(now: number): LedgerLine[] {
    const out: LedgerLine[] = []
    while (!this.isDone && this.startAt + this.offsets[this.cursor]! <= now) {
      out.push({ ...this.lines[this.cursor]!, at: this.startAt + this.offsets[this.cursor]! })
      this.cursor++
    }
    return out
  }
}
