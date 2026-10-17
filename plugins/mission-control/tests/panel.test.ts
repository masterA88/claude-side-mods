import { expect, mock, test } from 'claude-code/testing'

const SPAWN = { tool_use_id: 't1', prompt: 'run the sync health check', description: 'Sync health check', subagentType: 'sync-checker', provider: { plugin: 'engine' } }
const PANE = { component: 'Pane', requestId: 'mission-control', props: { bodyColumns: 80 } }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } }

test('clicking an agent opens its panel at the bottom, and a message there reaches it', async ($, on) => {
  const sent: { to: unknown; text: string }[] = []
  mock.clock(on)
  // the engine's own drawing stands beneath: nothing of its own in the band
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('session.send', async (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  await $.agent.spawn(SPAWN as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    sent.length = 0
    // both surfaces carry Input; the union over every surface does not
    const band = (await $.ui.mount({ plugin: 'mission-control', surface, ...BAND } as never)) as Awaited<ReturnType<typeof $.ui.mount<'terminal', 'AbovePrompt'>>>
    expect(await band.find({ key: 'msg-a1' })).toBeUndefined()

    const pane = await $.ui.mount({ plugin: 'mission-control', surface, ...PANE } as never)
    await pane.press({ key: 'a1' })
    expect(await band.find({ type: 'Text', text: /@sync-checker/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /run the sync health check/ })).toBeDefined()

    await band.input({ key: 'msg-a1', text: 'stop after this check' })
    expect(sent).toEqual([{ to: 'a1', text: 'stop after this check' }])
    expect(await band.find({ type: 'Text', text: /stop after this check/ })).toBeDefined()

    await band.press({ key: 'close' })
    expect(await band.find({ key: 'msg-a1' })).toBeUndefined()
    await band.unmount()
    await pane.unmount()
  }
})

test('a resume for a finished background task is not shown as your message', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a2' }))
  on('ui.render', async ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as never)
  await $.agent.spawn({ ...SPAWN, prompt: '<task-notification><task-id>x</task-id></task-notification>' } as never)
  const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as never)
  await pane.press({ key: 'a2' })
  const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as never)
  expect(await band.find({ type: 'Text', text: /background task finished/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /task-notification/ })).toBeUndefined()
  await band.unmount()
  await pane.unmount()
})
