import { describe, expect, test } from 'claude-code/testing'

import { START, paneProps, world } from './world'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

describe('/og', () => {
  test('toggles the pane', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect((await $.command.run({ command: 'og', args: '', ...RUN })).text).toBe('Omnigraph viz opened.')
    expect([...w.shown]).toEqual(['omnigraph'])
    expect(w.opens).toEqual([{ id: 'omnigraph', focus: true }]) // so g / f / enter work at once
    expect((await $.command.run({ command: 'og', args: '', ...RUN })).text).toBe('Omnigraph viz closed.')
    expect([...w.shown]).toEqual([])
  })

  test('the pane waits for operations', async ($, on) => {
    world(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'side-omnigraph-viz', surface: 'terminal', component: 'Pane', requestId: 'omnigraph', props: paneProps() })
    expect(await ui.find({ type: 'Text', text: /Waiting for omnigraph operations/ })).toBeDefined()
    await ui.unmount()
  })
})
