import { describe, expect, test } from 'claude-code/testing'

import { DEMO_LEDGER } from '../fixtures/demo-ledger'
import { Player, readReplay } from '../src/replay/player'
import { START, world } from './world'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

/** demos/dev-graph-triage.jsonl: a real agent session on the dev-graph demo store, embedded by `npm run demo:embed`. */
describe('the demo ledger', () => {
  const read = readReplay(DEMO_LEDGER)
  const lines = 'lines' in read ? read.lines : []

  test('replays cleanly: every op succeeded, reads lit nodes, writes have diffs', () => {
    expect(read).not.toHaveProperty('error')
    const ends = lines.flatMap(l => (l.t === 'op.end' ? [l] : []))
    expect(ends).toHaveLength(16)
    expect(ends.every(l => l.status === 'ok')).toBe(true)
    expect(lines.filter(l => l.t === 'graph')).toHaveLength(1)
    expect(lines.filter(l => l.t === 'touch')).toHaveLength(5)
    expect(lines.filter(l => l.t === 'diff')).toHaveLength(11)
  })

  test('runs about 50 s at 1×', () => {
    const ms = new Player(lines, 1, 0).durationMs
    expect(ms).toBeGreaterThan(40_000)
    expect(ms).toBeLessThan(60_000)
  })

  test('plays through the plugin with no omnigraph at all', { options: { omnigraphBin: '/nowhere/omnigraph' } }, async ($, on) => {
    const w = world(on, { files: { '/work/demos/dev-graph-triage.jsonl': DEMO_LEDGER } })
    await $.session.start(START)
    expect((await $.command.run({ command: 'og', args: 'replay demos/dev-graph-triage.jsonl', ...RUN })).text).toMatch(/^Replaying dev-graph-triage.jsonl at 1×/)
    await w.clock.advance(60_000)
    expect(w.statuses[w.statuses.length - 1]).toBe('◉ og · main · 16 ops · +3n · ⟳ replay done')
    expect(w.runs).toEqual([])
  })
})
