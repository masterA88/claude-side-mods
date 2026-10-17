import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'
import { foldExport, parseEdgeEnds } from '../src/graph/ghost'
import { decodeLedger, encodeLedger } from '../src/model/ledger'
import type { LedgerLine, OpIntent } from '../types'
import { END, START, bashAnswer, exploreView, feedLines, paneProps, world } from './world'
import type { World } from './world'

const PANE = { plugin: 'side-omnigraph-viz', surface: 'terminal', component: 'Pane', requestId: 'omnigraph' } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
const LIVE_LEDGER = '/work/.omnigraph-viz/20261006-120000-000.jsonl'
const DEV = foldExport(EXPORT_JSONL, parseEdgeEnds(SCHEMA_SOURCE), 2000)
/** Recorded the day before the tests' clock starts. */
const R0 = Date.UTC(2026, 9, 5, 9, 0, 0)

const intent = (verb: 'query' | 'mutate', name: string): OpIntent => ({
  verb, queryName: name, isInline: false, target: { store: 'graphs/dev.omni' }, isJson: false,
  argv: ['omnigraph', verb, name, '--store', 'graphs/dev.omni'], cwd: '/rec',
})

/** A recorded session: a read that loads the graph and lights an issue, then a write that adds one. */
const RECORDED: LedgerLine[] = [
  { v: 1, t: 'session', at: R0, cwd: '/rec', mod: '0.1.0' },
  { v: 1, t: 'op.start', at: R0, op: { id: 'r#0', startedAt: R0, status: 'running', intent: intent('query', 'ready') } },
  { v: 1, t: 'op.end', at: R0 + 700, id: 'r#0', status: 'ok', durationMs: 700,
    outcome: { kind: 'read', queryName: 'ready', rowCount: 1, columns: ['slug'], cells: [['iss-auth-mfa']] }, output: '1 rows from branch main via ready\n' },
  { v: 1, t: 'graph', at: R0 + 1100, target: { store: 'graphs/dev.omni' }, cwd: '/rec', graph: DEV },
  { v: 1, t: 'touch', at: R0 + 1110, opId: 'r#0', nodeIds: ['Issue:iss-auth-mfa'], isExact: false },
  { v: 1, t: 'op.start', at: R0 + 30_000, op: { id: 'w#0', startedAt: R0 + 30_000, status: 'running', intent: intent('mutate', 'create_issue') } },
  { v: 1, t: 'op.end', at: R0 + 30_800, id: 'w#0', status: 'ok', durationMs: 800,
    outcome: { kind: 'change', branch: 'main', queryName: 'create_issue', nodes: 1, edges: 1 }, output: 'changed main via create_issue: 1 nodes, 1 edges\n' },
  { v: 1, t: 'diff', at: R0 + 31_100, opId: 'w#0', commitId: 'c1', more: 0, changes: [
    { kind: 'node', type: 'Issue', id: 'iss-replayed', op: 'insert', label: 'Replayed issue' },
    { kind: 'edge', type: 'EpicContainsIssue', id: 'e-r', op: 'insert', from: 'epc-offline-sync', to: 'iss-replayed' },
  ] },
]
// At 1×: the graph lands at 1.1 s, holds 2 s for the layout, the 29 s pause shrinks to 3 s: 7.2 s in all.
const FILES = { '/work/demos/dev.jsonl': encodeLedger(RECORDED) }

async function og($: Engine, args: string): Promise<string> {
  return (await $.command.run({ command: 'og', args, ...RUN })).text ?? ''
}

const lastStatus = (w: World) => w.statuses[w.statuses.length - 1]

describe('/og replay', () => {
  test('plays a recorded ledger in the Graph tab, offline', { options: { omnigraphBin: '/nowhere/omnigraph' } }, async ($, on) => {
    const w = world(on, { files: FILES })
    await $.session.start(START)
    expect(await og($, 'replay demos/dev.jsonl')).toBe('Replaying dev.jsonl at 1×, about 7 s. /og stop ends it.')
    expect(w.opens).toEqual([{ id: 'omnigraph', focus: true }])
    const ui = await $.ui.mount({ ...PANE, props: paneProps(120, 40) })
    expect(await ui.find({ type: 'Text', text: /Loading the graph/ })).toBeDefined()
    await w.clock.advance(1200)
    // The graph landed: the top level (its types) shows for a 2 s hold…
    expect((await exploreView(ui)).text).toMatch(/◉ Issue 18/)
    expect(lastStatus(w)).toMatch(/^◉ og · 1 ops · ⟳ replay 1× \d+%$/)
    await w.clock.advance(2000)
    // …then the read lit one issue: the browser follows it there.
    expect((await exploreView(ui)).text).toMatch(/^Issue › Add TOTP MFA to auth/)
    await w.clock.advance(7000)
    // The write added an issue to an epic: the epic's links, the new issue selected.
    expect((await exploreView(ui)).text).toMatch(/^Epic › Offline editing & sync › contains › Replayed issue/)
    expect(lastStatus(w)).toBe('◉ og · main · 2 ops · +1n · ⟳ replay done')
    expect(await ui.find({ type: 'Text', text: /· ⟳ replay done   2 ops/ })).toBeDefined()
    expect(w.invalidations).toBeGreaterThan(0)
    // Nothing ran and nothing was written: the replay needs no omnigraph and leaves no ledger.
    expect(w.runs).toEqual([])
    expect([...w.files.keys()]).toEqual(['/work/demos/dev.jsonl'])
    await ui.unmount()
  })

  test('the Feed lists the recorded ops', async ($, on) => {
    const w = world(on, { files: FILES })
    await $.session.start(START)
    await og($, 'replay demos/dev.jsonl')
    await w.clock.advance(8000)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    await ui.press({ key: 'tab-feed' })
    const lines = (await feedLines(ui)).map(l => l.label)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/query\s+ready\s.*1 rows.*700ms ✓/)
    expect(lines[1]).toMatch(/mutate\s+create_issue\s.*\+1n \+1e.*800ms ✓/)
    await ui.unmount()
  })

  test('speed 2 plays it faster', async ($, on) => {
    const w = world(on, { files: FILES })
    await $.session.start(START)
    expect(await og($, 'replay demos/dev.jsonl 2')).toMatch(/at 2×, about 6 s/)
    await w.clock.advance(6200)
    expect(lastStatus(w)).toMatch(/⟳ replay done$/)
  })

  test('live ops during a replay are recorded but not shown; /og stop brings them back', async ($, on) => {
    const w = world(on, { files: FILES })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('3 rows via live_q\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query live_q' })
    await og($, 'replay demos/dev.jsonl')
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query live_q' })
    await w.clock.advance(8000)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    await ui.press({ key: 'tab-feed' })
    expect((await feedLines(ui)).map(l => l.label).join('\n')).not.toMatch(/live_q/)
    expect(decodeLedger(w.files.get(LIVE_LEDGER) ?? '').lines.filter(l => l.t === 'op.end')).toHaveLength(2)
    expect(await og($, 'stop')).toBe('Replay stopped; back to the live session.')
    expect((await feedLines(ui)).map(l => l.label)).toEqual([expect.stringMatching(/live_q/), expect.stringMatching(/live_q/)])
    expect(lastStatus(w)).toBe('◉ og · 2 ops')
    expect(await og($, 'stop')).toBe('No replay is running.')
    await ui.unmount()
  })

  test('a broken ledger is refused by line number and nothing changes', async ($, on) => {
    const good = JSON.stringify(RECORDED[1])
    const w = world(on, { files: { '/work/bad.jsonl': `${good}\n{oops\n${good}\n` } })
    await $.session.start(START)
    expect(await og($, 'replay bad.jsonl')).toBe("Can't replay bad.jsonl: line 2: not JSON")
    expect(await og($, 'replay nope.jsonl')).toMatch(/^Can't read nope.jsonl: /)
    expect(w.opens).toEqual([])
    expect(w.statuses.filter(s => s !== undefined)).toEqual([])
  })

  test('a malformed ledger leaves a running replay playing', async ($, on) => {
    const w = world(on, { files: { ...FILES, '/work/odd.jsonl': `${JSON.stringify(RECORDED[1])}\n{"v":1,"t":"op.start","at":1}\n` } })
    await $.session.start(START)
    await og($, 'replay demos/dev.jsonl')
    expect(await og($, 'replay odd.jsonl')).toBe("Can't replay odd.jsonl: line 2: op.start without an op")
    await w.clock.advance(8000)
    expect(lastStatus(w)).toBe('◉ og · main · 2 ops · +1n · ⟳ replay done')
  })

  test('three replays draw the same frames', async ($, on) => {
    const w = world(on, { files: FILES })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    const runs: string[][] = []
    for (let i = 0; i < 3; i++) {
      await og($, 'replay demos/dev.jsonl')
      // The browser at the same moments of each replay, as each op lands.
      const views: string[] = []
      let at = 0
      for (const ms of [1500, 3500, 4200, 6400, 7400, 8400, 12_000]) {
        await w.clock.advance(ms - at)
        at = ms
        views.push((await exploreView(ui)).text)
      }
      runs.push(views)
    }
    expect(new Set(runs[0]).size).toBeGreaterThan(2)
    expect(runs[1]).toEqual(runs[0])
    expect(runs[2]).toEqual(runs[0])
    await ui.unmount()
  })

  test('the browser takes the keys: select, open, back, follow live again', async ($, on) => {
    const w = world(on, { files: FILES })
    await $.session.start(START)
    await og($, 'replay demos/dev.jsonl')
    await w.clock.advance(12_000)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(110, 40) })
    // Following: the last op's place, the new issue selected in the picture and in its column.
    let view = await exploreView(ui)
    expect(view.text).toMatch(/^Epic › Offline editing & sync › contains › Replayed issue\s+● live/)
    expect(view.selected[0]).toMatch(/Replayed issue/)
    expect(await ui.find({ type: 'Text', text: /^following ops · click the graph to browse/ })).toBeDefined()
    await ui.key({ key: 'down', in: 'explore' }) // the next link
    view = await exploreView(ui)
    expect(view.text).not.toMatch(/● live/)
    expect(view.text.split('\n')[0]).not.toMatch(/Replayed issue/)
    expect(await ui.find({ type: 'Text', text: /^browsing · ↑↓ select/ })).toBeDefined()
    await ui.key({ key: 'left', in: 'explore' }) // back: the epic among its type
    expect((await exploreView(ui)).text).toMatch(/^Epic › Offline editing & sync\s*\n/)
    await ui.key({ key: 'up', meta: true, in: 'explore' }) // ⌥↑: back again, the types
    expect((await exploreView(ui)).text).toMatch(/^Epic\s*\n/)
    await ui.key({ key: 'return', in: 'explore' }) // ⏎: the epics
    await ui.key({ key: 'right', in: 'explore' }) // →: the first epic's links
    await ui.key({ key: 'down', meta: true, in: 'explore' }) // ⌥↓: a hop to its first link
    expect((await exploreView(ui)).text.split('\n')[0]!.split(' › ').length).toBeGreaterThan(4)
    await ui.key({ key: 'l', in: 'explore' }) // back to following
    expect((await exploreView(ui)).text).toMatch(/^Epic › Offline editing & sync › contains › Replayed issue/)
    await ui.key({ key: 'f', in: 'explore' })
    expect((await feedLines(ui)).length).toBe(2)
    await ui.unmount()
  })

  test('the session ending stops the replay', async ($, on) => {
    const w = world(on, { files: FILES })
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    await $.session.start(START)
    await og($, 'replay demos/dev.jsonl')
    await $.session.end(END)
    const after = w.statuses.length
    await w.clock.advance(8000)
    expect(w.statuses.slice(after).filter(s => s !== undefined)).toEqual([])
  })

  test('/og clear also ends a replay', async ($, on) => {
    const w = world(on, { files: FILES })
    await $.session.start(START)
    await og($, 'replay demos/dev.jsonl')
    await og($, 'clear')
    expect(await og($, 'stop')).toBe('No replay is running.')
    await w.clock.advance(8000)
    expect(lastStatus(w)).toBeUndefined()
  })

  test('unknown arguments show how to use /og', async ($, on) => {
    world(on)
    await $.session.start(START)
    expect(await og($, 'replya x.jsonl')).toMatch(/^Usage: \/og/)
  })
})
