import { describe, expect, test } from 'claude-code/testing'

import { encodeLedger } from '../src/model/ledger'
import { parseOgArgs } from '../src/replay/command'
import { MAX_GAP_MS, MIN_RUN_MS, Player, SETTLE_HOLD_MS, readReplay, schedule } from '../src/replay/player'
import type { LedgerLine } from '../types'

const T = 1_000_000

const start = (id: string, at: number): LedgerLine => ({
  v: 1, t: 'op.start', at,
  op: { id, startedAt: at, status: 'running', intent: { verb: 'query', queryName: 'q', isInline: false, target: {}, isJson: false, argv: ['omnigraph', 'query', 'q'], cwd: '/w' } },
})
const end = (id: string, at: number): LedgerLine => ({
  v: 1, t: 'op.end', at, id, status: 'ok', durationMs: 0,
  outcome: { kind: 'read', queryName: 'q', rowCount: 0, columns: [], cells: [] }, output: '',
})
const graph = (at: number): LedgerLine => ({
  v: 1, t: 'graph', at, target: {}, cwd: '/w', graph: { nodes: [], edges: [], truncated: false, edgeEnds: {} },
})
const touch = (at: number): LedgerLine => ({ v: 1, t: 'touch', at, opId: 'a', nodeIds: [], isExact: false })

describe('schedule', () => {
  test('keeps the recorded gaps, divided by speed', () => {
    const lines = [start('a', T), end('a', T + 500), start('b', T + 1500), end('b', T + 1800)]
    expect(schedule(lines, 1)).toEqual([0, 500, 1500, 1800])
    expect(schedule(lines, 2)).toEqual([0, 250, 750, 900])
  })
  test('long pauses shrink to MAX_GAP_MS', () => {
    expect(schedule([start('a', T), end('a', T + 200), start('b', T + 60_000)], 1)).toEqual([0, 200, 200 + MAX_GAP_MS])
  })
  test('an op shows as running for at least MIN_RUN_MS', () => {
    expect(schedule([start('a', T), end('a', T + 5)], 1)).toEqual([0, MIN_RUN_MS])
  })
  test('once the graph appears, the next line waits for the layout to settle', () => {
    expect(schedule([start('a', T), end('a', T + 100), graph(T + 300), touch(T + 310)], 1)).toEqual([0, 120, 320, 320 + SETTLE_HOLD_MS])
  })
  test('times that run backwards play in file order, never earlier', () => {
    expect(schedule([start('a', T), touch(T - 50)], 1)).toEqual([0, 0])
  })
})

describe('Player', () => {
  test('hands out lines as they come due, retimed to when they play', () => {
    const player = new Player([start('a', T), end('a', T + 500), touch(T + 900)], 1, 5000)
    expect(player.nextAt).toBe(5000)
    expect(player.due(4999)).toEqual([])
    expect(player.due(5000).map(l => [l.t, l.at])).toEqual([['op.start', 5000]])
    expect(player.progress).toBe(1 / 3)
    expect(player.due(6000).map(l => [l.t, l.at])).toEqual([['op.end', 5500], ['touch', 5900]])
    expect([player.isDone, player.progress, player.nextAt, player.durationMs]).toEqual([true, 1, undefined, 900])
  })
  test('ops keep their recorded start times (the Feed shows when they really ran)', () => {
    const [line] = new Player([start('a', T)], 1, 5000).due(5000)
    expect(line?.t === 'op.start' ? line.op.startedAt : 0).toBe(T)
  })
})

describe('readReplay', () => {
  const session: LedgerLine = { v: 1, t: 'session', at: T, cwd: '/w', mod: '0.1.0' }
  test('a recorded ledger replays without its session line', () => {
    const read = readReplay(encodeLedger([session, start('a', T), end('a', T + 1)]))
    expect('lines' in read ? read.lines.map(l => l.t) : read).toEqual(['op.start', 'op.end'])
  })
  test('a broken line is refused by its number', () => {
    const text = `${JSON.stringify(start('a', T))}\n{oops\n${JSON.stringify(end('a', T + 1))}\n`
    expect(readReplay(text)).toEqual({ error: 'line 2: not JSON' })
    expect(readReplay('{"v":2,"t":"op.start"}\n{"v":3}\n')).toEqual({ error: 'line 1: not a v1 ledger line (and 1 more)' })
  })
  test('a v1 line missing what its kind needs is refused by its number', () => {
    const good = JSON.stringify(start('a', T))
    expect(readReplay(`${good}\n{"v":1,"t":"op.start","at":1}\n`)).toEqual({ error: 'line 2: op.start without an op' })
    expect(readReplay(`${good}\n{"v":1,"t":"touch","opId":"a","nodeIds":[]}\n`)).toEqual({ error: 'line 2: no time (at)' })
    expect(readReplay(`${good}\n{"v":1,"t":"graph","at":1,"graph":{}}\n`)).toEqual({ error: 'line 2: graph without nodes, edges and edge ends' })
  })
  test('a cut-off last line (a crash mid-write) is dropped, not refused', () => {
    const read = readReplay(`${JSON.stringify(start('a', T))}\n{"v":1,"t":"op.e`)
    expect('lines' in read ? read.lines.length : read).toBe(1)
  })
  test('a ledger without operations is refused', () => {
    expect(readReplay(encodeLedger([session]))).toEqual({ error: 'it holds no omnigraph operations' })
    expect(readReplay('')).toEqual({ error: 'it holds no omnigraph operations' })
  })
})

describe('/og arguments', () => {
  test('forms', () => {
    expect(parseOgArgs('')).toEqual({ kind: 'toggle' })
    expect(parseOgArgs('  clear ')).toEqual({ kind: 'clear' })
    expect(parseOgArgs('stop')).toEqual({ kind: 'stop' })
    expect(parseOgArgs('replay demos/dev.jsonl')).toEqual({ kind: 'replay', path: 'demos/dev.jsonl', speed: 1 })
    expect(parseOgArgs('replay demos/dev.jsonl 2x')).toEqual({ kind: 'replay', path: 'demos/dev.jsonl', speed: 2 })
    expect(parseOgArgs("replay 'my demo.jsonl' 0.5")).toEqual({ kind: 'replay', path: 'my demo.jsonl', speed: 0.5 })
  })
  test('anything else shows how to use it', () => {
    for (const args of ['replay', 'bogus', 'clear now', 'replay a b c']) expect(parseOgArgs(args).kind).toBe('usage')
    expect(parseOgArgs('replay x.jsonl 0')).toEqual({ kind: 'usage', message: 'Speed must be a number from 0.1 to 20 (got 0).' })
  })
})
