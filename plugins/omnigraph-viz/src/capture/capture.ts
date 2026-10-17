import type { LedgerLine, OpEvent, OpOutcome, Verb } from '../../types'
import { classify } from './classify'
import { parseOutput, segmentOutput, stripAnsi } from './parse-output'
import { findInvocations } from './tokenize'

/** The parts of a `tool.call` result the capture reads. */
export interface ToolResultLike {
  deny?: string
  isError?: boolean
  result?: unknown
  text?: string
}

export function bashOutput(r: ToolResultLike): { stdout: string; stderr: string; isError: boolean } {
  if (r.deny !== undefined) return { stdout: '', stderr: r.deny, isError: true }
  const result = r.result
  if (typeof result === 'object' && result !== null && 'stdout' in result) {
    const { stdout, stderr } = result as { stdout?: unknown; stderr?: unknown }
    return {
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
      isError: r.isError === true,
    }
  }
  return { stdout: r.text ?? '', stderr: '', isError: r.isError === true }
}

export const OUTPUT_LINES = 40
export const OUTPUT_CHARS = 4000

/** The first 40 lines / 4000 chars: enough for the Feed's detail, small enough for the ledger. */
export function clipOutput(text: string): string {
  const lines = text.split('\n')
  const head = lines.slice(0, OUTPUT_LINES).join('\n')
  const clipped = head.length > OUTPUT_CHARS ? head.slice(0, OUTPUT_CHARS) : head
  return clipped.length < text.length ? `${clipped.trimEnd()}\n…` : clipped
}

export interface BeginArgs {
  command: string
  toolUseId: string
  cwd: string
  bin: string
  now: number
  agentId?: string
  /** HOME, to expand `~` the way the shell did. */
  home?: string
}

export function beginOps(args: BeginArgs): OpEvent[] {
  return findInvocations(args.command, args.cwd, args.bin, args.home).map(inv => {
    const op: OpEvent = {
      id: `${args.toolUseId}#${inv.index}`,
      startedAt: args.now,
      intent: classify(inv),
      status: 'running',
    }
    if (args.agentId !== undefined) op.agentId = args.agentId
    return op
  })
}

/** Which verbs can have produced each outcome kind. */
const PRODUCED_BY: Readonly<Record<OpOutcome['kind'], readonly Verb[] | 'any'>> = {
  read: ['query', 'alias'],
  change: ['mutate'],
  branch: ['branch', 'mutate'],
  load: ['load'],
  error: 'any',
  other: 'any',
}

const isResult = (o: OpOutcome | undefined) => o !== undefined && o.kind !== 'error' && o.kind !== 'other'

interface Slot {
  outcome: OpOutcome
  output: string
}

/**
 * One outcome per op. A single call parses the whole output. Several calls
 * get one segment each when the counts line up; otherwise each segment goes
 * to the next op whose verb can have produced it, so one result never counts
 * twice. A failed exit with no error found blames the last op with no result.
 */
function slotsFor(ops: readonly OpEvent[], stdout: string, stderr: string, isError: boolean): Slot[] {
  if (ops.length === 1) {
    return [{ outcome: parseOutput(stdout, stderr, isError), output: isError && stderr !== '' ? stderr : stdout }]
  }
  const segments = segmentOutput(stdout)
  const slots: (Slot | undefined)[] = ops.map(() => undefined)
  if (segments.length === ops.length) {
    segments.forEach((segment, i) => {
      slots[i] = { outcome: parseOutput(segment, '', false), output: segment }
    })
  } else {
    let from = 0
    for (const segment of segments) {
      const outcome = parseOutput(segment, '', false)
      const verbs = PRODUCED_BY[outcome.kind]
      const at = ops.findIndex((op, i) => i >= from && (verbs === 'any' || verbs.includes(op.intent.verb)))
      if (at < 0) continue
      slots[at] = { outcome, output: segment }
      from = at + 1
    }
  }
  if (isError && !slots.some(slot => slot?.outcome.kind === 'error')) {
    let at = -1
    slots.forEach((slot, i) => {
      if (!isResult(slot?.outcome)) at = i
    })
    if (at >= 0) slots[at] = { outcome: parseOutput(stdout, stderr, true), output: stderr !== '' ? stderr : stdout }
  }
  return slots.map(slot => slot ?? { outcome: { kind: 'other', firstLine: '' }, output: '' })
}

export function endLines(ops: readonly OpEvent[], r: ToolResultLike, now: number): LedgerLine[] {
  const { stdout, stderr, isError } = bashOutput(r)
  return slotsFor(ops, stdout, stderr, isError).map(({ outcome, output }, i) => ({
    v: 1,
    t: 'op.end',
    at: now,
    id: ops[i]!.id,
    status: outcome.kind === 'error' ? 'error' : 'ok',
    durationMs: Math.max(0, now - ops[i]!.startedAt),
    outcome,
    output: clipOutput(stripAnsi(output)),
  }))
}
