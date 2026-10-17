import { describe, expect, test } from 'claude-code/testing'

import { START, bashAnswer, feedLines, paneProps, world } from './world'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
const PANE = { plugin: 'side-omnigraph-viz', surface: 'terminal', component: 'Pane', requestId: 'omnigraph' } as const

describe('feed', () => {
  test('shows ops; selecting one shows its command and output', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('changed main via create_issue: 1 nodes, 0 edges\n'))
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, props: paneProps(100, 30) })
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue --branch main' })
    expect(await ui.find({ type: 'Text', text: /1 ops · \+1n \+0e/ })).toBeDefined()
    const lines = await feedLines(ui)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.plain).toBe(true) // drawn as a line of text, not a collapsed picker
    expect(lines[0]?.label).toMatch(/mutate  create_issue .* ✓$/)
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
    await ui.press({ key: lines[0]!.key })
    const [command, output] = await ui.findAll({ type: 'Code' })
    expect(command?.props.source).toBe('omnigraph mutate create_issue --branch main')
    expect(output?.props.source).toBe('changed main via create_issue: 1 nodes, 0 edges\n')
    await ui.unmount()
  })

  test('every line fits a narrow pane', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('changed main via create_issue: 1 nodes, 0 edges\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph mutate create_issue' })
    const ui = await $.ui.mount({ ...PANE, props: paneProps(44, 20) })
    const lines = await feedLines(ui)
    expect(lines.length).toBe(1)
    expect(lines.every(l => l.label.length <= 42)).toBe(true)
    await ui.unmount()
  })

  test('tabs switch with their buttons', async ($, on) => {
    world(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, props: paneProps() })
    // Graph is the default tab; before any graph it says what it waits for.
    expect(await ui.find({ type: 'Text', text: /the graph appears after the first command that names a graph/ })).toBeDefined()
    await ui.press({ key: 'tab-graph' })
    expect(await ui.find({ type: 'Text', text: /the graph appears after the first command that names a graph/ })).toBeDefined()
    await ui.press({ key: 'tab-feed' })
    expect(await ui.find({ type: 'Text', text: /^Waiting for omnigraph operations…$/ })).toBeDefined()
    await ui.unmount()
  })

  test('/og clear empties the view', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'Bash' }, async () => bashAnswer('1 rows via q\n'))
    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'omnigraph query q' })
    expect((await $.command.run({ command: 'og', args: 'clear', ...RUN })).text).toBe('Omnigraph viz cleared.')
    const ui = await $.ui.mount({ ...PANE, props: paneProps() })
    await ui.press({ key: 'tab-feed' })
    expect(await ui.find({ type: 'Text', text: /Waiting for omnigraph operations/ })).toBeDefined()
    await ui.unmount()
  })

  test('the tab row tells you the keys', async ($, on) => {
    world(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...PANE, props: paneProps() })
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('tab-')).map(b => [b.props.label, b.props.hotkey])).toEqual([
      ['Graph', 'g'], ['Feed', 'f'],
    ])
    // The Graph tab says how to browse it; the Feed names its own keys.
    expect(await ui.find({ type: 'Text', text: /click the graph to browse with ↑↓←→/ })).toBeDefined()
    await ui.press({ key: 'tab-feed' })
    expect(await ui.find({ type: 'Text', text: /enter: details · esc: back to the prompt/ })).toBeDefined()
    await ui.unmount()
  })
})
