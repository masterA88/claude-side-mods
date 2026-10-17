import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'
import { decodeLedger } from '../src/model/ledger'
import { START, T0, bashAnswer, exploreView, feedLines, paneProps, world } from './world'
import type { Processes } from './world'

const LEDGER = '/work/.omnigraph-viz/20261006-120000-000.jsonl'
const PANE = { plugin: 'side-omnigraph-viz', surface: 'terminal', component: 'Pane', requestId: 'omnigraph' } as const
const READ = '1 rows from branch main via ready\nslug         | title\n-------------+---------------------\niss-auth-mfa | Add TOTP MFA to auth\n'
const WRITE = 'changed main via create_issue: 1 nodes, 1 edges\n'

/** A dev-graph store: schema, export, and one commit that adds an issue to an epic. */
const devGraph: Processes = argv => {
  const verb = argv.slice(1, 3).join(' ')
  if (verb === 'schema show') return { exitCode: 0, stdout: JSON.stringify({ schema_source: SCHEMA_SOURCE }), stderr: '' }
  if (argv[1] === 'export') return { exitCode: 0, stdout: EXPORT_JSONL, stderr: '' }
  if (verb === 'commit list') {
    return { exitCode: 0, stdout: JSON.stringify({ commits: [{ graph_commit_id: 'c-new', created_at: (T0 + 50) * 1000 }] }), stderr: '' }
  }
  if (verb === 'commit changes') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({ changes: [
        { kind: 'node', type: { id: 't', name: 'Issue' }, id: 'iss-viz-new', op: 'insert', after: { properties: { title: 'Brand new issue' } } },
        { kind: 'edge', type: { id: 'u', name: 'EpicContainsIssue' }, id: 'e-new', op: 'insert', after: { properties: {}, endpoints: { from: 'epc-offline-sync', to: 'iss-viz-new' } } },
      ] }),
    }
  }
  return { exitCode: 2, stdout: '', stderr: `error: unexpected ${argv.join(' ')}` }
}

const ledgerLines = (files: Map<string, string>) => decodeLedger(files.get(LEDGER) ?? '').lines

describe('bootstrap', () => {
  test('the first op loads the graph from the same store, in the op\'s directory', async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'cd dev && omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(w.runs.map(r => [r.argv.slice(1, 3).join(' '), r.cwd])).toEqual([
      ['schema show', '/work/dev'],
      ['export --store', '/work/dev'],
    ])
    const graph = ledgerLines(w.files).find(l => l.t === 'graph')
    if (graph?.t !== 'graph') throw new Error('no graph line')
    expect([graph.graph.nodes.length, graph.graph.edges.length]).toEqual([102, 239])
  })

  test('a read lights the nodes its rows name', async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    const touch = ledgerLines(w.files).find(l => l.t === 'touch')
    expect(touch).toMatchObject({ nodeIds: ['Issue:iss-auth-mfa'], isExact: false })
  })

  test('a write fetches its commit and applies the diff', async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(WRITE))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(w.runs.map(r => r.argv.slice(1, 3).join(' '))).toEqual(['schema show', 'export --store', 'commit list', 'commit changes'])
    expect(w.runs[2]?.argv).toContain('--branch')
    const diff = ledgerLines(w.files).find(l => l.t === 'diff')
    expect(diff).toMatchObject({ opId: expect.any(String), commitId: 'c-new', more: 0 })
  })

  test('an export that fails shows why on the Graph tab', async ($, on) => {
    const w = world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready' })
    await w.clock.advance(0)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(80, 24) })
    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ type: 'Text', text: /Couldn't load the graph: no store here/ })).toBeDefined()
    await ui.unmount()
  })

  test('enrich=false never runs the CLI', { options: { enrich: false } }, async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(w.runs).toEqual([])
  })

  test('maxGhostNodes keeps the best-connected nodes', { options: { maxGhostNodes: 30 } }, async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    const graph = ledgerLines(w.files).find(l => l.t === 'graph')
    expect(graph).toMatchObject({ graph: { truncated: true } })
    expect(graph?.t === 'graph' ? graph.graph.nodes.length : 0).toBe(30)
  })
})

describe('hot reload', () => {
  test('the graph comes back from the ledger, laid out again', async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    await $.session.start(START) // what a reload raises
    const runs = w.runs.length
    const ui = await $.ui.mount({ ...PANE, props: paneProps(90, 30) })
    expect((await exploreView(ui)).text).toMatch(/◉ Issue 18/)
    expect(w.runs.length).toBe(runs) // no second export
    await ui.unmount()
  })
})

describe('bootstrap edge cases', () => {
  test('an export cut at the 4 MiB cap starts touched-only (an empty graph)', async ($, on) => {
    const w = world(on, { processes: (argv, cwd) => ({ ...devGraph(argv, cwd)!, isStdoutTruncated: argv[1] === 'export' }) })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    const graph = ledgerLines(w.files).find(l => l.t === 'graph')
    expect(graph).toMatchObject({ graph: { nodes: [], edges: [], truncated: true } })
  })

  test('a second graph in the session does not replace the first', async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/other.omni' })
    await w.clock.advance(0)
    expect(w.runs.filter(r => r.argv[1] === 'export')).toHaveLength(1)
    expect(ledgerLines(w.files).filter(l => l.t === 'graph')).toHaveLength(1)
  })

  test('a read whose rows name no node leaves no touch', async ($, on) => {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via q\nn\n-\n42\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(ledgerLines(w.files).some(l => l.t === 'touch')).toBe(false)
  })
})

describe('Graph tab', () => {
  async function ready($: Engine, on: On, answer = READ) {
    const w = world(on, { processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(answer))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    return w
  }

  test('draws the browser sized to the pane, and a mini-feed', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(90, 30) })
    const browser = await ui.find({ type: 'Client' })
    expect([browser?.props.width, browser?.props.height]).toEqual([90, 25])
    // The read lit one issue: the browser went to it.
    expect((await exploreView(ui)).text).toMatch(/^Issue › Add TOTP MFA to auth/)
    expect(await ui.find({ type: 'Text', text: /query\s+ready/ })).toBeDefined()
    await ui.unmount()
  })

  test('the browser draws only the attributes a run needs (the Client tree has a size limit)', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(90, 30) })
    const texts: { props?: Record<string, unknown> }[] = []
    const walk = (t: unknown) => {
      if (!t || typeof t !== 'object') return
      const node = t as { props?: Record<string, unknown>; children?: unknown[] }
      texts.push(node)
      for (const c of node.children ?? []) walk(c)
    }
    walk(await ui.drawn({ in: 'explore' }))
    expect(texts.some(t => t.props?.inverse === true)).toBe(true)
    expect(texts.some(t => t.props !== undefined && 'inverse' in t.props && t.props.inverse !== true)).toBe(false)
    await ui.unmount()
  })

  test('a truncated graph gives up a browser row to say so', { options: { maxGhostNodes: 30 } }, async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(90, 30) })
    expect((await ui.find({ type: 'Client' }))?.props.height).toBe(24)
    expect(await ui.find({ type: 'Text', text: /^\(largest 30 nodes\)$/ })).toBeDefined()
    await ui.unmount()
  })

  test("clearing the Feed's selection goes back to following, if it was following", async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(120, 40) })
    const [first] = await feedLines(ui)
    await ui.press({ key: first!.key })
    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ type: 'Text', text: /^browsing/ })).toBeDefined()
    await feedLines(ui)
    await ui.press({ key: first!.key })
    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ type: 'Text', text: /^following ops/ })).toBeDefined()
    await ui.unmount()
  })

  test('animates while the read glows, then stops redrawing', async ($, on) => {
    const w = await ready($, on)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(90, 30) })
    await w.clock.advance(330)
    expect(w.invalidations).toBeGreaterThan(3)
    await w.clock.advance(5_000)
    const settled = w.invalidations
    await w.clock.advance(2_000)
    expect(w.invalidations).toBe(settled)
    await ui.unmount()
  })

  test('switching to the Feed stops the animation loop', async ($, on) => {
    const w = await ready($, on)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(90, 30) })
    await w.clock.advance(100)
    await ui.press({ key: 'tab-feed' })
    await w.clock.advance(100)
    const after = w.invalidations
    await w.clock.advance(1000)
    expect(w.invalidations).toBe(after)
    await ui.unmount()
  })

  test('selecting an op re-lights its nodes and labels them', async ($, on) => {
    const w = await ready($, on)
    await w.clock.advance(20_000)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(120, 40) })
    const [first] = await feedLines(ui)
    await ui.press({ key: first!.key })
    await ui.press({ key: 'tab-graph' })
    expect((await exploreView(ui)).text).toMatch(/^Issue › Add TOTP MFA to auth/)
    expect(await ui.find({ type: 'Text', text: /^browsing/ })).toBeDefined()
    await ui.unmount()
  })

  test('a write shows the new node among its epic\'s links, marked NEW', async ($, on) => {
    const w = await ready($, on, WRITE)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(120, 40) })
    await w.clock.advance(1000) // the picture moves there
    const { text } = await exploreView(ui)
    expect(text).toMatch(/^Epic › Offline editing & sync › contains › Brand new issue/)
    expect(text).toMatch(/● Brand new issue NEW/)
    await ui.unmount()
  })
})

/** A store whose answers a test can change: export success, export rows, commits and their changes. */
function liveStore() {
  const state = {
    exportOk: true,
    exportJsonl: EXPORT_JSONL,
    exportStderr: '',
    commits: [] as { id: string; at: number }[],
    changes: {} as Record<string, unknown[]>,
  }
  const processes: Processes = argv => {
    const verb = argv.slice(1, 3).join(' ')
    if (verb === 'schema show') return { exitCode: 0, stdout: JSON.stringify({ schema_source: SCHEMA_SOURCE }), stderr: '' }
    if (argv[1] === 'export') {
      return state.exportOk ? { exitCode: 0, stdout: state.exportJsonl, stderr: '' } : { exitCode: 1, stdout: '', stderr: state.exportStderr }
    }
    if (verb === 'commit list') {
      const commits = [...state.commits].reverse().map(c => ({ graph_commit_id: c.id, created_at: c.at * 1000 }))
      return { exitCode: 0, stdout: JSON.stringify({ commits }), stderr: '' }
    }
    if (verb === 'commit changes') return { exitCode: 0, stdout: JSON.stringify({ changes: state.changes[argv[3]!] ?? [] }), stderr: '' }
    return { exitCode: 2, stdout: '', stderr: 'error: unexpected' }
  }
  return { state, processes }
}

const insertIssue = (slug: string, title: string) => ({
  kind: 'node', type: { id: 't', name: 'Issue' }, id: slug, op: 'insert', after: { properties: { title } },
})

describe('review fixes', () => {
  test('labels with emoji, CJK or tabs never get the pane refused', async ($, on) => {
    const { state, processes } = liveStore()
    state.exportJsonl = [
      '{"type":"Issue","id":"iss-emoji","data":{"title":"🐛 Fix login"}}',
      '{"type":"Issue","id":"iss-cjk","data":{"title":"修复登录问题"}}',
      '{"type":"Issue","id":"iss-tab","data":{"title":"a\\tb"}}',
    ].join('\n')
    const w = world(on, { processes })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('3 rows via q\nslug\n----\niss-emoji\niss-cjk\niss-tab\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q --store graphs/dev.omni' })
    await w.clock.advance(0)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    const [first] = await feedLines(ui)
    await ui.press({ key: first!.key })
    await ui.press({ key: 'tab-graph' })
    expect((await exploreView(ui)).text).toMatch(/\? Fix login/)
    await ui.unmount()
  })

  test('chained writes in one Bash call each get their own commit', async ($, on) => {
    const { state, processes } = liveStore()
    state.commits = [{ id: 'c-a', at: T0 + 10 }, { id: 'c-b', at: T0 + 20 }]
    state.changes = { 'c-a': [insertIssue('iss-a', 'A')], 'c-b': [insertIssue('iss-b', 'B')] }
    const w = world(on, { processes })
    on('tool.call', { tool: 'Bash' }, async () =>
      bashAnswer('changed main via add_a: 1 nodes, 0 edges\nchanged main via add_b: 1 nodes, 0 edges\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate add_a --store g.omni && omnigraph mutate add_b --store g.omni' })
    await w.clock.advance(0)
    const diffs = ledgerLines(w.files).flatMap(l => (l.t === 'diff' ? [[l.commitId, l.changes.map(c => c.id)]] : []))
    expect(diffs).toEqual([['c-a', ['iss-a']], ['c-b', ['iss-b']]])
  })

  test('ops on another graph are not drawn into the first one', async ($, on) => {
    const { state, processes } = liveStore()
    state.commits = [{ id: 'c-x', at: T0 + 10 }]
    state.changes = { 'c-x': [insertIssue('iss-other', 'Other')] }
    const w = world(on, { processes })
    let answer = READ
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(answer))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    answer = WRITE
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue --store graphs/OTHER.omni' })
    answer = READ
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/OTHER.omni' })
    await w.clock.advance(0)
    expect(w.runs.filter(r => r.argv.includes('graphs/OTHER.omni')).map(r => r.argv[1])).toEqual([])
    expect(ledgerLines(w.files).filter(l => l.t === 'diff')).toHaveLength(0)
    expect(ledgerLines(w.files).filter(l => l.t === 'touch')).toHaveLength(1)
  })

  test('/og clear keeps the graph: the tab still draws and later writes still land', async ($, on) => {
    const { state, processes } = liveStore()
    const w = world(on, { processes })
    let answer = READ
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(answer))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    await $.command.run({ command: 'og', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
    state.commits = [{ id: 'c-1', at: T0 + 10 }]
    state.changes = { 'c-1': [insertIssue('iss-after-clear', 'After clear')] }
    answer = WRITE
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(ledgerLines(w.files).filter(l => l.t === 'diff')).toHaveLength(1)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    expect((await exploreView(ui)).text).toMatch(/After clear/)
    await ui.unmount()
  })

  test('a failed load is retried once a write on the same store succeeds', async ($, on) => {
    const { state, processes } = liveStore()
    state.exportOk = false
    state.exportStderr = 'error: no such store'
    const w = world(on, { processes })
    let answer = READ
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(answer))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    state.exportOk = true
    answer = 'loaded graphs/dev.omni on branch main with overwrite: 341 entities across 22 node types and 83 edge types\n'
    await $.tool.call({ tool: 'Bash', command: 'omnigraph load --data seed.jsonl --mode overwrite --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(w.runs.filter(r => r.argv[1] === 'export')).toHaveLength(2)
    expect(ledgerLines(w.files).filter(l => l.t === 'graph')).toHaveLength(1)
  })

  test('a failed load shows the CLI error, not its backtrace hint', async ($, on) => {
    const { state, processes } = liveStore()
    state.exportOk = false
    state.exportStderr =
      'Error: \n   0: \x1b[91mstorage: Dataset at path graphs/nope.omni was not found\x1b[0m\n\nLocation:\n   crates/omnigraph-cli/src/client.rs:725\n\nBacktrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.\nRun with RUST_BACKTRACE=full to include source snippets.\n'
    const w = world(on, { processes })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/nope.omni' })
    await w.clock.advance(0)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(120, 24) })
    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ type: 'Text', text: /Couldn't load the graph: storage: Dataset at path graphs\/nope.omni was not found/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('finding the omnigraph binary', () => {
  test('when PATH lacks it, the login shell finds it, and later calls reuse that path', async ($, on) => {
    const w = world(on, {
      env: { HOME: '/Users/r', SHELL: '/bin/zsh' },
      processes: (argv, cwd) => {
        if (argv[0] === 'omnigraph') return null
        if (argv[0] === '/bin/zsh') return { exitCode: 0, stdout: 'zsh: no job control in this shell\n/Users/r/.local/bin/omnigraph\n', stderr: '' }
        if (argv[0] === '/Users/r/.local/bin/omnigraph') return devGraph(argv, cwd)
        return null
      },
    })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(WRITE))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(ledgerLines(w.files).filter(l => l.t === 'graph')).toHaveLength(1)
    expect(ledgerLines(w.files).filter(l => l.t === 'diff')).toHaveLength(1)
    expect(w.runs.filter(r => r.argv[0] === '/bin/zsh')).toHaveLength(1)
    expect(w.runs.filter(r => r.argv[0] === 'omnigraph')).toHaveLength(1)
  })

  test('the usual install folders are tried when the shell knows nothing', async ($, on) => {
    const w = world(on, {
      env: { HOME: '/Users/r', SHELL: '/bin/zsh' },
      files: { '/Users/r/.cargo/bin/omnigraph': '' },
      processes: (argv, cwd) => {
        if (argv[0] === '/bin/zsh') return { exitCode: 1, stdout: '', stderr: '' }
        if (argv[0] === '/Users/r/.cargo/bin/omnigraph') return devGraph(argv, cwd)
        return null
      },
    })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    expect(ledgerLines(w.files).filter(l => l.t === 'graph')).toHaveLength(1)
  })

  test('when it is nowhere, the Graph tab says which option to set', async ($, on) => {
    const w = world(on, { env: { HOME: '/Users/r', SHELL: '/bin/zsh' }, processes: argv => (argv[0] === '/bin/zsh' ? { exitCode: 1, stdout: '', stderr: '' } : null) })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query ready --store graphs/dev.omni' })
    await w.clock.advance(0)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(160, 24) })
    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ type: 'Text', text: /can't find `omnigraph`.*set the omnigraphBin option to its full path/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('~ in commands', () => {
  test('cd ~/dir and --store ~/… resolve against HOME, so enrichment runs where the shell did', async ($, on) => {
    const w = world(on, { env: { HOME: '/Users/r', SHELL: '/bin/zsh' }, processes: devGraph })
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer(READ))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'cd ~/og-demo && omnigraph query ready --store ~/og-demo/graphs/dev.omni' })
    await w.clock.advance(0)
    expect(w.runs[0]?.cwd).toBe('/Users/r/og-demo')
    expect(w.runs.find(r => r.argv[1] === 'export')?.argv).toEqual(['omnigraph', 'export', '--store', '/Users/r/og-demo/graphs/dev.omni'])
  })
})

