import { describe, expect, test } from 'claude-code/testing'

import { decodeLedger } from '../src/model/ledger'
import { END, START, bashAnswer, world } from './world'

const LEDGER = '/work/.omnigraph-viz/20261006-120000-000.jsonl'

describe('capture', () => {
  test('an omnigraph call is ledgered and its result passes through unchanged', async ($, on) => {
    const w = world(on)
    const answer = bashAnswer('changed main via create_issue: 1 nodes, 2 edges\n')
    on('tool.call', { tool: 'Bash' }, async () => answer)
    await $.session.start(START)
    const r = await $.tool.call({ tool: 'Bash', command: 'cd dev-graph && omnigraph mutate create_issue --graph dev' })
    expect(r).toEqual(answer)
    await w.clock.advance(1000)
    const { lines } = decodeLedger(w.files.get(LEDGER) ?? '')
    expect(lines.map(l => l.t)).toEqual(['session', 'op.start', 'op.end'])
    const start = lines[1]
    const end = lines[2]
    if (start?.t !== 'op.start' || end?.t !== 'op.end') throw new Error('unexpected ledger')
    expect(start.op.intent).toMatchObject({ verb: 'mutate', queryName: 'create_issue', cwd: '/work/dev-graph', target: { graph: 'dev' } })
    expect(end.outcome).toEqual({ kind: 'change', branch: 'main', queryName: 'create_issue', nodes: 1, edges: 2 })
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · main · 1 ops · +1n')
  })

  test('durations come from the clock around the call', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => {
      await w.clock.advance(250)
      return bashAnswer('1 rows via q\nslug\n----\na\n')
    })
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    await w.clock.advance(1000)
    const end = decodeLedger(w.files.get(LEDGER) ?? '').lines.find(l => l.t === 'op.end')
    expect(end).toMatchObject({ durationMs: 250, status: 'ok' })
  })

  test('a failing command is an error op and still returns as the engine gave it', async ($, on) => {
    const w = world(on)
    const answer = bashAnswer('', 'error: unknown query `redy`\n', true)
    on('tool.call', { tool: 'Bash' }, async () => answer)
    await $.session.start(START)
    expect(await $.tool.call({ tool: 'Bash', command: 'omnigraph query redy' })).toEqual(answer)
    await w.clock.advance(1000)
    const end = decodeLedger(w.files.get(LEDGER) ?? '').lines.find(l => l.t === 'op.end')
    expect(end).toMatchObject({ status: 'error', outcome: { kind: 'error', message: 'unknown query `redy`' } })
  })

  test('concurrent calls each get their own op', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async (_$, e) => {
      const isSlow = e.tool === 'Bash' && e.command.includes('slow')
      await w.clock.advance(isSlow ? 300 : 10)
      return bashAnswer(isSlow ? '1 rows via slow\n' : 'changed main via fast: 1 nodes, 0 edges\n')
    })
    await $.session.start(START)
    await Promise.all([
      $.tool.call({ tool: 'Bash', command: 'omnigraph query slow' }),
      $.tool.call({ tool: 'Bash', command: 'omnigraph mutate fast' }),
    ])
    await w.clock.advance(1000)
    const ends = decodeLedger(w.files.get(LEDGER) ?? '').lines.filter(l => l.t === 'op.end')
    expect(ends.map(l => (l.t === 'op.end' ? l.outcome.kind : '')).sort()).toEqual(['change', 'read'])
    expect(new Set(ends.map(l => (l.t === 'op.end' ? l.id : ''))).size).toBe(2)
  })

  test('in a chained command a failed load is an error even though the shell exited 0', async ($, on) => {
    const w = world(on)
    const out = 'omnigraph load → graphs/dev.omni (direct, local)\nError: \n   0: storage: bad column\n\ngraph_branch: main\ngraph_manifest_version: 3\n'
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(out))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph load --data s.jsonl --mode merge g.omni ; omnigraph snapshot g.omni' })
    await w.clock.advance(1000)
    const ends = decodeLedger(w.files.get(LEDGER) ?? '').lines.flatMap(l => (l.t === 'op.end' ? [[l.status, l.outcome.kind]] : []))
    expect(ends).toEqual([['error', 'error'], ['ok', 'other']])
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · 2 ops · 1 ✗')
  })

  test('a call before session.start passes through and records nothing', async ($, on) => {
    const w = world(on)
    const answer = bashAnswer('1 rows via q\n')
    on('tool.call', { tool: 'Bash' }, async () => answer)
    expect(await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })).toEqual(answer)
    expect(w.files.size).toBe(0)
  })

  test('commands that only mention omnigraph are not ops and cost no $ calls', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('x'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'cat omnigraph.yaml' })
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    await w.clock.advance(1000)
    expect(w.files.size).toBe(0)
    expect(w.cwdCalls).toBe(0)
  })

  test('a session without omnigraph ops leaves no files and no status', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.advance(1000)
    expect(w.files.size).toBe(0)
    expect(w.statuses.filter(s => s !== undefined)).toEqual([])
  })

  test('the first op creates the ledger and a .gitignore beside it', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via q\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    await w.clock.advance(0)
    expect(w.files.get('/work/.omnigraph-viz/.gitignore')).toBe('*\n')
    expect(decodeLedger(w.files.get(LEDGER) ?? '').lines.map(l => l.t)).toEqual(['session', 'op.start', 'op.end'])
  })

  test('ok && fail: the first op keeps its result, only the second is an error', async ($, on) => {
    const w = world(on)
    const out = "1 rows via a\nslug\n----\nx\nError: \n   0: query 'bad' not found\n"
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(out, '', true))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query a && omnigraph query bad' })
    await w.clock.advance(0)
    const ends = decodeLedger(w.files.get(LEDGER) ?? '').lines.flatMap(l => (l.t === 'op.end' ? [[l.status, l.outcome.kind]] : []))
    expect(ends).toEqual([['ok', 'read'], ['error', 'error']])
  })

  test('one result for two ops goes to the op whose verb fits, never to both', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('main\nreview\nchanged main via add_x: 1 nodes, 0 edges\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph branch list && omnigraph mutate add_x' })
    await w.clock.advance(0)
    const ends = decodeLedger(w.files.get(LEDGER) ?? '').lines.flatMap(l => (l.t === 'op.end' ? [[l.status, l.outcome.kind]] : []))
    expect(ends).toEqual([['ok', 'other'], ['ok', 'change']])
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · main · 2 ops · +1n')
  })

  test('a failed exit with no error text blames the last op that has no result', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via a\n', 'Exit code 1', true))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query a && omnigraph lint' })
    await w.clock.advance(0)
    const ends = decodeLedger(w.files.get(LEDGER) ?? '').lines.flatMap(l => (l.t === 'op.end' ? [[l.status, l.outcome.kind]] : []))
    expect(ends).toEqual([['ok', 'read'], ['error', 'error']])
  })

  test('an op that ends right before a reload is not lost', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via ready\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready' })
    await w.clock.advance(0) // no time passes: a debounced writer would not have written yet
    await $.session.start(START)
    expect(decodeLedger(w.files.get(LEDGER) ?? '').lines.filter(l => l.t === 'op.end')).toHaveLength(1)
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · 1 ops')
  })

  test('after /clear (session.end without a new session.start) the status line comes back', async ($, on) => {
    const w = world(on)
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via q\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    await $.session.end({ ...END, reason: 'clear' })
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · 2 ops')
  })

  test('session.end clears the status line', async ($, on) => {
    const w = world(on)
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via q\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    await $.session.end(END)
    expect(w.statuses[w.statuses.length - 1]).toBeUndefined()
  })

  test('a viz failure never reaches the tool result', async ($, on) => {
    const w = world(on, { cwd: null })
    const answer = bashAnswer('1 rows via q\n')
    on('tool.call', { tool: 'Bash' }, async () => answer)
    await $.session.start(START)
    expect(await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })).toEqual(answer)
    expect(w.logs).toEqual([])
  })

  test('debug logs viz failures as dim lines', { options: { debug: true } }, async ($, on) => {
    const w = world(on, { cwd: null })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(''))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^omnigraph-viz: /)
  })

  test('a custom binary is matched by basename', { options: { omnigraphBin: '/opt/bin/og' } }, async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via q\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'og query q' })
    await w.clock.advance(1000)
    expect(decodeLedger(w.files.get(LEDGER) ?? '').lines.map(l => l.t)).toEqual(['session', 'op.start', 'op.end'])
  })

  test('a second session.start (hot reload) continues the same ledger and counters', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via ready\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready' })
    await w.clock.advance(1000)
    await $.session.start(START) // what a reload raises
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready' })
    await w.clock.advance(1000)
    const lines = decodeLedger(w.files.get(LEDGER) ?? '').lines
    expect(lines.filter(l => l.t === 'session')).toHaveLength(1)
    expect(lines.filter(l => l.t === 'op.end')).toHaveLength(2)
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · 2 ops')
  })
})
