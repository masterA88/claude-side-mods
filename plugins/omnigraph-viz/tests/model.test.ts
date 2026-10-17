import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../src/capture/classify'
import { LedgerWriter, decodeLedger, encodeLedger, ledgerFileName, ledgerPathFor } from '../src/model/ledger'
import { emptyViz, reduceAll, targetLabel } from '../src/model/reduce'
import { toView } from '../src/model/state'
import type { LedgerLine, OpEvent } from '../types'

const op = (id: string, args: string[], startedAt = 1000): OpEvent => ({
  id, startedAt, status: 'running', intent: classify({ argv: ['omnigraph', ...args], cwd: '/w', index: 0 }),
})

/** Lets pending promise chains run (the mod environment types no setTimeout). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const LINES: LedgerLine[] = [
  { v: 1, t: 'session', at: 900, cwd: '/w', mod: '0.1.0' },
  { v: 1, t: 'op.start', at: 1000, op: op('a#0', ['query', 'ready', '--graph', 'dev']) },
  { v: 1, t: 'op.end', at: 1040, id: 'a#0', status: 'ok', durationMs: 40, output: '2 rows…',
    outcome: { kind: 'read', queryName: 'ready', rowCount: 2, branch: 'main', columns: [], cells: [] } },
  { v: 1, t: 'op.start', at: 2000, op: op('b#0', ['mutate', 'create_issue', '--branch', 'feat'], 2000) },
  { v: 1, t: 'op.end', at: 2090, id: 'b#0', status: 'ok', durationMs: 90, output: 'changed…',
    outcome: { kind: 'change', branch: 'feat', queryName: 'create_issue', nodes: 1, edges: 2 } },
  { v: 1, t: 'op.start', at: 3000, op: op('c#0', ['load', '--data', 'x', '--mode', 'merge', 'g.omni'], 3000) },
  { v: 1, t: 'op.end', at: 3010, id: 'c#0', status: 'error', durationMs: 10, output: 'error: nope',
    outcome: { kind: 'error', message: 'nope' } },
]

describe('reduce', () => {
  test('folds a ledger into ops, counters, graph and branch', () => {
    const s = reduceAll(LINES)
    expect(s.ops.map(o => [o.id, o.status, o.durationMs])).toEqual([['a#0', 'ok', 40], ['b#0', 'ok', 90], ['c#0', 'error', 10]])
    expect(s.counters).toEqual({ ops: 3, errors: 1, nodes: 1, edges: 2 })
    expect(s.graph).toBe('g.omni')
    expect(s.branch).toBe('feat')
    expect(s.ops[0]?.output).toBe('2 rows…')
  })
  test('an op.end for an unknown op changes nothing', () => {
    const lone: LedgerLine = { v: 1, t: 'op.end', at: 1, id: 'zz', status: 'ok', durationMs: 1, output: '', outcome: { kind: 'other', firstLine: '' } }
    expect(reduceAll([lone])).toEqual(emptyViz())
  })
  test('targetLabel prefers graph id, then store folder, then server', () => {
    expect(targetLabel({ graph: 'dev', store: '/x/y.omni' })).toBe('dev')
    expect(targetLabel({ store: '/x/y.omni/' })).toBe('y.omni')
    expect(targetLabel({ server: 'http://h:8080' })).toBe('http://h:8080')
    expect(targetLabel({})).toBe(null)
  })
})

describe('ledger', () => {
  test('round trip: encode → decode → reduce equals the live reduce', () => {
    const { lines, errors } = decodeLedger(encodeLedger(LINES))
    expect(errors).toEqual([])
    expect(reduceAll(lines)).toEqual(reduceAll(LINES))
  })
  test('a cut-off last line is dropped silently, a bad middle line is reported', () => {
    const text = `${encodeLedger(LINES.slice(0, 2))}{"v":1,"t":"op.e`
    expect(decodeLedger(text)).toEqual({ lines: LINES.slice(0, 2), errors: [] })
    const bad = `${JSON.stringify(LINES[0])}\nnope\n{"v":2,"t":"x"}\n${JSON.stringify(LINES[1])}\n`
    expect(decodeLedger(bad)).toEqual({ lines: LINES.slice(0, 2), errors: ['line 2: not JSON', 'line 3: not a v1 ledger line'] })
  })
  test('file name and absolute path', () => {
    const t = Date.UTC(2026, 9, 6, 9, 5, 7, 42)
    expect(ledgerFileName(t)).toBe('20261006-090507-042.jsonl')
    expect(ledgerPathFor('/work', '.omnigraph-viz', t)).toBe('/work/.omnigraph-viz/20261006-090507-042.jsonl')
    expect(ledgerPathFor('/work', '/var/og/', t)).toBe('/var/og/20261006-090507-042.jsonl')
  })
  test('the writer writes through, coalescing appends made while a write is in flight', async () => {
    const writes: string[] = []
    let release: () => void = () => undefined
    const io = {
      write: (_p: string, text: string) => {
        writes.push(text)
        return new Promise<void>(resolve => {
          release = resolve
        })
      },
    }
    const w = new LedgerWriter('/l.jsonl', LINES.slice(0, 1))
    w.append(LINES[1]!, io)
    expect(writes).toEqual([encodeLedger(LINES.slice(0, 2))])
    w.append(LINES[2]!, io)
    w.append(LINES[3]!, io)
    expect(writes).toHaveLength(1)
    release()
    await settle()
    expect(writes).toEqual([encodeLedger(LINES.slice(0, 2)), encodeLedger(LINES.slice(0, 4))])
  })
  test('a failing write (unwritable ledger dir) is reported and later appends still write', async () => {
    const errors: unknown[] = []
    let calls = 0
    const io = {
      write: async () => {
        calls++
        throw new Error('EACCES')
      },
      onError: (err: unknown) => void errors.push(err),
    }
    const w = new LedgerWriter('/ro/l.jsonl')
    w.append(LINES[0]!, io)
    await settle()
    w.append(LINES[1]!, io)
    await settle()
    expect(calls).toBe(2)
    expect(errors).toHaveLength(2)
  })
})

describe('toView', () => {
  test('keeps $.state small: no raw output, no read cells', () => {
    const viz = reduceAll([
      ...LINES.slice(0, 2),
      { v: 1, t: 'op.end', at: 1040, id: 'a#0', status: 'ok', durationMs: 40, output: 'x'.repeat(4000),
        outcome: { kind: 'read', queryName: 'ready', rowCount: 2, branch: 'main', columns: ['slug'], cells: [['a'], ['b']] } },
    ])
    const [op] = toView(viz).recentOps
    expect(op?.output).toBeUndefined()
    expect(op?.outcome).toEqual({ kind: 'read', queryName: 'ready', rowCount: 2, branch: 'main', columns: ['slug'], cells: [] })
    expect(viz.ops[0]?.output).toHaveLength(4000)
  })
})
