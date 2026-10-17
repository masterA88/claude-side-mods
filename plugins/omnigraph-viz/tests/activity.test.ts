import { describe, expect, test } from 'claude-code/testing'

import { START, bashAnswer, feedLines, paneProps, world } from './world'

const PANE = { plugin: 'side-omnigraph-viz', surface: 'terminal', component: 'Pane', requestId: 'omnigraph' } as const

// fork: without an omnigraph store the pane draws the session's own activity; a store, once used, takes over
describe('activity graph', () => {
  test('tool calls are drawn with no omnigraph, and write no files and no status', async ($, on) => {
    const w = world(on)
    on('tool.call', async () => bashAnswer('ok\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Read', file_path: '/work/README.md' } as never)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    expect(await feedLines(ui)).toHaveLength(2)
    expect(w.files.size).toBe(0)
    expect(w.statuses.filter(Boolean)).toHaveLength(0)
    await ui.unmount()
  })

  test('the first omnigraph op hands the pane to the store, which then records only omnigraph ops', async ($, on) => {
    const w = world(on)
    on('tool.call', async (_$, e) =>
      bashAnswer(e.tool === 'Bash' && e.command.includes('omnigraph') ? 'changed main via create_issue: 1 nodes, 0 edges\n' : 'ok\n'),
    )
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue --branch main' })
    await $.tool.call({ tool: 'Bash', command: 'pwd' })
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    const lines = await feedLines(ui)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.label).toMatch(/mutate  create_issue/)
    expect([...w.files.keys()].some(p => p.startsWith('/work/.omnigraph-viz/'))).toBe(true)
    expect(w.statuses.at(-1)).toMatch(/^◉ og · main · 1 ops/)
    await ui.unmount()
  })
})
