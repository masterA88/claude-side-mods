import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Disk, FeedItem, Limit, Row, RowState, TrailLine, Usage } from '../types'

const PANE = 'mission-control'
const MAIN = 'main'

const rows = atom({ plugin: 'mission-control', key: 'rows' } as const, [] as Row[])
const feed = atom({ plugin: 'mission-control', key: 'feed' } as const, [] as FeedItem[])
const isOn = atom({ plugin: 'mission-control', key: 'isOn' } as const, false)
const tick = atom({ plugin: 'mission-control', key: 'tick' } as const, 0)
const disk = atom({ plugin: 'mission-control', key: 'disk' } as const, null as Disk | null)
const usage = atom({ plugin: 'mission-control', key: 'usage' } as const, null as Usage | null)
const selected = atom({ plugin: 'mission-control', key: 'selected' } as const, null as string | null)
const trails = atom({ plugin: 'mission-control', key: 'trails' } as const, {} as Record<string, TrailLine[]>)

// the plan bars belong to the plan-progress mod (its plan_progress tool writes them); this pane only reads them
type PlanStep = { title: string; status: string }
type Plan = { id: string; title: string; state: string; stages: { name: string; steps: PlanStep[] }[]; note: string | null }
const PLANS = { plugin: 'plan-progress', key: 'plans' } as const
const AUTO_AGENTS = 'agents:auto' // plan-progress's own bar for spawned agents, which the board already shows

async function readPlans($: EngineInterface): Promise<Plan[]> {
  try {
    const got = (await $.state.get(PLANS as never)) as { value?: Plan[] }
    return (got.value ?? []).filter(p => p.id !== AUTO_AGENTS)
  } catch {
    return []
  }
}

const COLOR = {
  running: '#d97757',
  done: '#6cbf84',
  needs: '#e0604f',
  failed: '#e0604f',
  warn: '#e5a54b',
  dim: '#7a7a7a',
} as const

const LABEL: Record<RowState, string> = {
  running: '✱ running',
  done: '✓ done',
  needs: '! needs you',
  failed: '! failed',
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

export const fit = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat.padEnd(width)
  return `${flat.slice(0, Math.max(0, width - 1))}…`
}

// the bar from the screenshot: a dotted track with a dithered block. Running, the block slides back and forth;
// done, the track is solid; needs you, a short block stays at the start. Returns [lead, block, trail] so the block
// alone takes the state's colour.
export const bar = (state: RowState, width: number, frame: number): [string, string, string] => {
  const w = Math.max(6, width)
  if (state === 'done') return ['', '█'.repeat(w), '']
  if (state === 'needs' || state === 'failed') {
    const b = Math.max(2, Math.round(w * 0.2))
    return ['', `${'▓'.repeat(b - 1)}░`, '·'.repeat(w - b)]
  }
  const b = Math.max(3, Math.round(w * 0.45))
  const span = w - b
  const step = span === 0 ? 0 : frame % (span * 2)
  const at = step > span ? span * 2 - step : step
  const block = `░▒${'▓'.repeat(Math.max(1, b - 4))}▒░`.slice(0, b)
  return ['·'.repeat(at), block, '·'.repeat(span - at)]
}

export const meter = (pct: number, width: number): [string, string] => {
  const full = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return ['▓'.repeat(full), '·'.repeat(width - full)]
}

const describe = (e: Record<string, unknown>): string => {
  for (const key of ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path']) {
    const v = e[key]
    if (typeof v === 'string' && v.length > 0) return v.replace(/^\/Users\/[^/]+/, '~')
  }
  return ''
}

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'weekly limit', spend_limit: 'spend limit' }

export const resetIn = (iso: string | null, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resets now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `resets in ${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `resets in ${h}h ${m % 60}m` : `resets in ${Math.round(h / 24)}d`
}

export const toUsage = (u: { context: { tokens?: number; window: number; percent?: number }; rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]; cost?: { usd: number } }): Usage => ({
  limits: u.rateLimits.map((l): Limit => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
  contextPct: u.context.percent ?? null,
  contextTokens: u.context.tokens ?? null,
  window: u.context.window,
  costUsd: u.cost?.usd ?? null,
})

export const planPct = (p: Plan) => {
  const steps = p.stages.flatMap(s => s.steps)
  if (steps.length === 0) return p.state === 'done' ? 100 : 0
  return Math.round((steps.filter(s => s.status === 'done' || s.status === 'skipped').length / steps.length) * 100)
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const short = (model: string | null) => (model ? model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : null)


// the one switch /mod-on and /mod-off flip: a file every side mod watches, so no mod has to run another's command
const MODS_FILE = '.claude/side-mods/mods-on.json'
let lastMods: boolean | null = null

async function modsWanted($: EngineInterface) {
  const home = await $.env.get('HOME')
  try {
    return (JSON.parse(await $.fs.read(`${home}/${MODS_FILE}`)) as { on?: unknown }).on === true
  } catch {
    return false
  }
}

let animation: { cancel: () => void } | null = null
let modsTimer: { cancel: () => void } | null = null
let diskTimer: { cancel: () => void } | null = null
const names = new Map<string, string>()

function who(agentId: string | undefined) {
  return agentId ? (names.get(agentId) ?? 'agent') : 'claude'
}

function setRow($: EngineInterface, id: string, change: (row: Row) => Row) {
  return update($, rows, list => list.map(r => (r.id === id ? change(r) : r)))
}

function trail($: EngineInterface, agentId: string, line: TrailLine) {
  return update($, trails, all => ({ ...all, [agentId]: [...(all[agentId] ?? []), line].slice(-120) }))
}

// a message typed in the bottom panel goes to the agent the way SendMessage does; a finished one is resumed with it
async function message($: EngineInterface, agentId: string, text: string) {
  const body = text.trim()
  if (!body) return
  const now = await $.clock.now()
  await trail($, agentId, { at: now, kind: 'you', text: body })
  const sent = await $.session.send({ to: { agentId }, text: body }).catch((err: unknown) => ({ isDelivered: false as const, reason: String(err) }))
  if (!sent.isDelivered) await trail($, agentId, { at: await $.clock.now(), kind: 'error', text: `not delivered: ${sent.reason}` })
  else await setRow($, agentId, r => (r.state === 'running' ? r : { ...r, state: 'running', endedAt: null, tool: 'reading your message' }))
  await animate($)
}

function log($: EngineInterface, item: FeedItem) {
  return update($, feed, list => [...list, item].slice(-200))
}

async function readDisk($: EngineInterface) {
  for (const target of ['/System/Volumes/Data', '/']) {
    try {
      const { exitCode, stdout } = await $.process.run(['df', '-k', target])
      if (exitCode !== 0) continue
      const cols = stdout.trim().split('\n').pop()?.split(/\s+/) ?? []
      const total = Number(cols[1])
      const free = Number(cols[3])
      if (!total || Number.isNaN(free)) continue
      const host = await $.process.run(['hostname', '-s']).catch(() => null)
      const label = `${host?.stdout.trim() || 'disk'} disk`
      await update($, disk, () => ({ label, freeGb: Math.round(free / 1024 / 1024), usedPct: Math.round(((total - free) / total) * 100) }))
      return
    } catch {
      // df missing or refused: try the next mount, else leave the row out
    }
  }
}

// redraw a few times a second only while something runs and the pane is on
async function animate($: EngineInterface) {
  const isRunning = (await read($, rows)).some(r => r.state === 'running')
  const isWanted = isRunning && (await read($, isOn))
  if (isWanted && !animation) animation = $.clock.every(250, () => void update($, tick, n => n + 1))
  if (!isWanted && animation) {
    animation.cancel()
    animation = null
  }
}

// agents end without an event this mod can count on, so their status comes from the engine's own list
async function syncAgents($: EngineInterface) {
  const list = await $.agent.list().catch(() => null)
  if (!list) return
  const now = await $.clock.now()
  for (const a of list) {
    const state: RowState | null =
      a.status === 'completed' || a.status === 'idle' ? 'done' : a.status === 'failed' || a.status === 'killed' ? 'failed' : null
    if (state) {
      await setRow($, a.id, r => (r.state === 'running' || r.state === 'needs' ? { ...r, state, endedAt: now, tool: state === 'done' ? '' : a.status } : r))
    }
  }
}

async function setMods($: EngineInterface, isOnNow: boolean) {
  const home = await $.env.get('HOME')
  await $.fs.write(`${home}/${MODS_FILE}`, JSON.stringify({ on: isOnNow }) + '\n')
  await applyMods($, isOnNow)
}

async function applyMods($: EngineInterface, isOnNow: boolean) {
  lastMods = isOnNow
  await update($, isOn, () => isOnNow)
  if (isOnNow) {
    await $.ui.open({ id: PANE, title: 'Mission Control' })
    // the side mods open their tabs within a second of the switch; come back to the front after them
    // (an open of an open pane only retitles it, so close it first: the newest tab is the one shown)
    $.clock.after(1500, async () => {
      await $.ui.close({ id: PANE })
      await $.ui.open({ id: PANE, title: 'Mission Control' })
    })
  } else await $.ui.close({ id: PANE })
  await animate($)
}

async function followMods($: EngineInterface) {
  const isWanted = await modsWanted($)
  if (isWanted !== lastMods) await applyMods($, isWanted)
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mod-on', description: 'Turn on the side mods: Mission Control (agents, plan, usage) and omnigraph' })
    await $.command.register({ name: 'mod-off', description: 'Turn the side mods off again' })
    await $.command.register({ name: 'mc', description: 'Show or hide the Mission Control pane' })
    diskTimer?.cancel()
    void readDisk($)
    diskTimer = $.clock.every(60_000, () => void readDisk($))
    void $.session.usage().then(u => update($, usage, () => toUsage(u))).catch(() => undefined)
    // the switch file decides, at the start and every second after
    lastMods = null
    await followMods($)
    modsTimer?.cancel()
    modsTimer = $.clock.every(1000, () => void followMods($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    animation?.cancel()
    animation = null
    diskTimer?.cancel()
    diskTimer = null
    modsTimer?.cancel()
    modsTimer = null

    return next(e)
  })

  // the same figures /usage and the status line read, pushed here whenever one of them moves
  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))

    return next(e)
  })

  on('command.run', { command: 'mod-on' }, async $ => {
    await setMods($, true)

    return { text: 'Mods on: Mission Control (agents, plan, usage) and omnigraph. You should know stays on regardless.' }
  })

  on('command.run', { command: 'mod-off' }, async $ => {
    await setMods($, false)

    return { text: 'Mods off: Mission Control and omnigraph. You should know stays on.' }
  })

  on('command.run', { command: 'mc' }, async $ => {
    const isShown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Mission Control hidden.' }
    }
    await update($, isOn, () => true)
    await $.ui.open({ id: PANE, title: 'Mission Control' })
    await animate($)

    return { text: 'Mission Control shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      const main: Row = {
        id: MAIN,
        kind: 'main',
        title: e.text && !e.text.trimStart().startsWith('<') ? `Claude: ${e.text}` : 'Claude',
        state: 'running',
        startedAt: now,
        endedAt: null,
        tool: 'thinking',
        model: null,
        parentId: null,
      }
      await update($, rows, list => [main, ...list.filter(r => r.id !== MAIN)])
      await animate($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const now = await $.clock.now()
    const state: RowState = e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
    await setRow($, agentId ?? MAIN, r => ({ ...r, state, endedAt: now, tool: e.reason === 'aborted' ? 'stopped' : '' }))
    if (agentId) await trail($, agentId, { at: now, kind: 'end', text: e.reason === 'answer' ? 'finished' : e.reason })
    await syncAgents($)
    await animate($)

    return next(e)
  })

  // what an agent says between its tool calls, for its panel
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    if (e.agentId && step?.answer.trim()) await trail($, e.agentId, { at: await $.clock.now(), kind: 'say', text: step.answer.trim() })

    return step
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const now = await $.clock.now()
    const title = e.description || e.subagentType || 'agent'
    names.set(started.agentId, e.subagentType || 'agent')
    const row: Row = {
      id: started.agentId,
      kind: 'agent',
      title,
      state: 'running',
      startedAt: now,
      endedAt: null,
      tool: 'starting',
      model: started.model ?? null,
      parentId: e.parentAgentId ?? null,
    }
    // finished agents give way first, so the board keeps the live ones
    await update($, rows, list => {
      const kept = [...list.filter(r => r.id !== row.id), row]
      while (kept.length > 14) {
        const old = kept.findIndex(r => r.kind === 'agent' && r.state !== 'running')
        kept.splice(old >= 0 ? old : 1, 1)
      }
      return kept
    })
    await log($, { at: now, who: names.get(started.agentId) ?? 'agent', tool: 'spawned', detail: title, isError: false })
    await trail($, started.agentId, { at: now, kind: 'you', text: e.prompt })
    await animate($)

    return started
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const id = e.agent_id ?? MAIN
    await setRow($, id, r => ({ ...r, state: 'needs', tool: `asks: ${e.tool_name}` }))
    const answer = await next(e)
    if (answer.decision) await setRow($, id, r => (r.state === 'needs' ? { ...r, state: 'running' } : r))

    return answer
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const detail = describe(e as unknown as Record<string, unknown>)
    const isQuestion = e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode'
    await setRow($, id, r => ({ ...r, state: isQuestion ? 'needs' : 'running', tool: detail ? `${e.tool} ${detail}` : e.tool }))
    const ran = await next(e)
    const now = await $.clock.now()
    const isError = ran.deny !== undefined || ran.isError === true
    await setRow($, id, r => (r.state === 'needs' || r.state === 'running' ? { ...r, state: r.endedAt ? r.state : 'running' } : r))
    await log($, { at: now, who: who(e.agentId), tool: e.tool, detail, isError })
    if (e.agentId) await trail($, e.agentId, { at: now, kind: isError ? 'error' : 'tool', text: detail ? `${e.tool} ${detail}` : e.tool })
    if (!e.agentId) await syncAgents($)

    return ran
  }).catch(($, e, next) => next(e))

  // the picked agent's panel, at the bottom above the prompt: what it is doing, and a field to message it
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = await read($, selected)
    if (!id || e.props.hasSurvey) return next(e)
    const row = (await read($, rows)).find(r => r.id === id)
    if (!row) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // mobile draws no field yet, so there the panel only shows
    const Input = 'Input' in els ? els.Input : null
    await read($, tick)
    const lines = (await read($, trails))[id] ?? []
    const now = await $.clock.now()
    const name = names.get(id) ?? 'agent'
    const shown = lines.slice(-8)
    const KIND: Record<TrailLine['kind'], [string, string | undefined]> = {
      tool: ['▸', COLOR.warn],
      say: ['“', undefined],
      you: ['you →', COLOR.running],
      error: ['!', COLOR.needs],
      end: ['■', COLOR.done],
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={COLOR[row.state]} paddingX={1}>
        <Box>
          <Text color={COLOR[row.state]} bold>
            {LABEL[row.state]}
          </Text>
          <Text bold> @{name}</Text>
          <Text color={COLOR.dim}> · {row.title}{short(row.model) ? ` · ${short(row.model)}` : ''} · {clock((row.endedAt ?? now) - row.startedAt)}</Text>
        </Box>
        {shown.length === 0 && <Text color={COLOR.dim}>Nothing yet. Its tool calls and replies show here as they happen.</Text>}
        {shown.map((l, i) => (
          <Text key={`t-${i}-${l.at}`} wrap="truncate-end">
            <Text color={COLOR.dim}>{clock(now - l.at).padStart(6)} </Text>
            <Text color={KIND[l.kind][1]} bold={l.kind === 'you'}>{KIND[l.kind][0]} </Text>
            {l.text.replace(/\s+/g, ' ')}
          </Text>
        ))}
        {row.state === 'running' && row.tool ? <Text color={COLOR.dim}>now: {row.tool}</Text> : null}
        {Input && <Input
          key={`msg-${id}`}
          label={`@${name} `}
          placeholder={row.state === 'running' ? 'message this agent, Enter sends' : 'message to resume it, Enter sends'}
          submitLabel="send"
          onSubmit={(text: string) => void message($, id, text)}
        />}
        <Box gap={2}>
          <Button key="view" plain label="open full transcript" onPress={() => $.ui.view({ agentId: id })} />
          <Button key="close" plain label="close ✕" onPress={() => update($, selected, () => null)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const frame = await read($, tick)
    const picked = await read($, selected)
    const list = await read($, rows)
    const items = await read($, feed)
    const space = await read($, disk)
    const use = await read($, usage)
    const planList = await readPlans($)
    const now = await $.clock.now()
    const cols = Math.max(40, e.props.bodyColumns || 60)
    const labelW = 12
    const timeW = 8
    const barW = Math.max(8, Math.min(24, Math.round(cols * 0.28)))
    const titleW = Math.max(8, cols - labelW - barW - timeW - 3)

    const running = list.filter(r => r.state === 'running').length
    const done = list.filter(r => r.state === 'done').length
    const needs = list.filter(r => r.state === 'needs' || r.state === 'failed').length

    const board = list.map(r => {
      const [lead, block, trail] = bar(r.state, barW, frame + r.startedAt / 250)
      const time = r.state === 'failed' ? 'failed' : clock((r.endedAt ?? now) - r.startedAt)
      const indent = r.parentId ? '└ ' : ''
      const isPicked = r.id === picked
      const cells = (
        <Text wrap="truncate-end">
          <Text color={COLOR[r.state]} bold={r.state === 'needs'}>
            {LABEL[r.state].padEnd(labelW)}
          </Text>
          <Text bold={isPicked} underline={isPicked}>{fit(indent + r.title, titleW)}</Text>
          <Text> </Text>
          <Text color={COLOR.dim}>{lead}</Text>
          <Text color={COLOR[r.state]}>{block}</Text>
          <Text color={COLOR.dim}>{trail}</Text>
          <Text color={r.state === 'failed' ? COLOR.failed : undefined}>{time.padStart(timeW)}</Text>
        </Text>
      )
      // an agent's row opens its panel at the bottom; pressed again, the panel closes
      return r.kind === 'agent' ? (
        <Button key={r.id} plain onPress={() => update($, selected, cur => (cur === r.id ? null : r.id))}>
          {cells}
        </Button>
      ) : (
        <Box key={r.id}>{cells}</Box>
      )
    })

    const diskRow = space ? (
      <Box key="disk">
        <Text>{' '.repeat(labelW)}</Text>
        <Text>{fit(`${space.label} · ${space.freeGb} GB free`, titleW)} </Text>
        <Text color={space.usedPct > 90 ? COLOR.needs : COLOR.running}>{meter(space.usedPct, barW)[0]}</Text>
        <Text color={COLOR.dim}>{meter(space.usedPct, barW)[1]}</Text>
        <Text>{`${space.usedPct} %`.padStart(timeW)}</Text>
      </Box>
    ) : null

    const meterRow = (key: string, label: string, pct: number, right: string, hot: boolean) => {
      const [fill, rest] = meter(pct, barW)
      return (
        <Box key={key}>
          <Text>{' '.repeat(labelW)}</Text>
          <Text>{fit(label, titleW)} </Text>
          <Text color={hot ? COLOR.needs : COLOR.running}>{fill}</Text>
          <Text color={COLOR.dim}>{rest}</Text>
          <Text>{right.padStart(timeW)}</Text>
        </Box>
      )
    }

    const PLAN_LABEL: Record<string, [string, string]> = {
      running: ['✱ plan', COLOR.running],
      done: ['✓ plan', COLOR.done],
      needs_input: ['! plan', COLOR.needs],
      error: ['! plan', COLOR.failed],
    }
    const planRows = planList.flatMap(p => {
      const pct = planPct(p)
      const [label, color] = PLAN_LABEL[p.state] ?? ['✱ plan', COLOR.running]
      const [fill, rest] = meter(pct, barW)
      const steps = p.stages.flatMap(s => s.steps)
      const active = steps.find(s => s.status === 'active')
      const doneN = steps.filter(s => s.status === 'done' || s.status === 'skipped').length
      const sub = p.note && p.state !== 'running' ? p.note : active ? `→ ${active.title}` : p.state === 'done' ? 'all steps done' : ''
      return [
        <Box key={`plan-${p.id}`}>
          <Text color={color} bold={p.state === 'needs_input'}>{label.padEnd(labelW)}</Text>
          <Text>{fit(p.title, titleW)} </Text>
          <Text color={color}>{fill}</Text>
          <Text color={COLOR.dim}>{rest}</Text>
          <Text>{`${pct} %`.padStart(timeW)}</Text>
        </Box>,
        <Box key={`plan-sub-${p.id}`}>
          <Text>{' '.repeat(labelW)}</Text>
          <Text color={COLOR.dim}>{fit(`${sub}${sub ? ' · ' : ''}${doneN}/${steps.length} steps`, titleW + barW + timeW + 1)}</Text>
        </Box>,
      ]
    })

    const usageRows = use
      ? [
          ...use.limits.map(l =>
            meterRow(`lim-${l.kind}`, `${LIMIT_NAME[l.kind] ?? l.kind}${l.resetsAt ? ` · ${resetIn(l.resetsAt, now)}` : ''}`, l.percentUsed, `${l.percentUsed} %`, l.percentUsed >= 80),
          ),
          use.contextPct !== null
            ? meterRow('ctx', `context · ${kTokens(use.contextTokens ?? 0)} of ${kTokens(use.window)}`, use.contextPct, `${use.contextPct} %`, use.contextPct >= 85)
            : null,
          use.costUsd !== null ? (
            <Box key="cost">
              <Text>{' '.repeat(labelW)}</Text>
              <Text color={COLOR.dim}>{fit(`session cost · $${use.costUsd.toFixed(2)}`, titleW)}</Text>
            </Box>
          ) : null,
        ]
      : []

    const live = list.filter(r => r.state !== 'done' && r.tool)
    const room = Math.max(4, (e.props.scroll?.bodyRows ?? 30) - list.length - live.length - planRows.length - usageRows.length - 12)

    return (
      <Box flexDirection="column">
        {planRows.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Plan</Text>
            {planRows}
          </Box>
        )}
        <Box>
          <Text bold>Agents</Text>
          {list.some(r => r.kind === 'agent') && <Text color={COLOR.dim}>  click an agent to open its panel</Text>}
        </Box>
        {list.length === 0 && <Text color={COLOR.dim}>Nothing running yet. Rows appear as Claude and its agents work.</Text>}
        {board}
        {diskRow}
        <Box>
          <Text color={COLOR.running}>✱ {running} running</Text>
          <Text color={COLOR.dim}> · </Text>
          <Text color={COLOR.done}>✓ {done} done</Text>
          <Text color={COLOR.dim}> · </Text>
          <Text color={COLOR.warn} bold={needs > 0}>
            ! {needs} needs you
          </Text>
          <Text color={COLOR.dim}>   /mod-off</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Usage</Text>
          {use === null || (use.limits.length === 0 && use.contextPct === null) ? (
            <Text color={COLOR.dim}>No reading yet. Limits appear after the next response.</Text>
          ) : (
            usageRows
          )}
        </Box>
        {live.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Now</Text>
            {live.map(r => (
              <Text key={`now-${r.id}`} wrap="truncate-end">
                <Text color={COLOR[r.state]}>{r.kind === 'main' ? 'claude' : (names.get(r.id) ?? 'agent')}</Text>
                {short(r.model) ? <Text color={COLOR.dim}> · {short(r.model)}</Text> : null}
                <Text color={COLOR.dim}> · </Text>
                {r.tool}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Activity</Text>
          {items.length === 0 && <Text color={COLOR.dim}>No tool calls yet.</Text>}
          {items.slice(-room).map((it, i) => (
            <Text key={`feed-${i}-${it.at}`} wrap="truncate-end">
              <Text color={COLOR.dim}>{clock(now - it.at).padStart(6)} ago </Text>
              <Text color={it.who === 'claude' ? COLOR.running : COLOR.warn}>{it.who.padEnd(10).slice(0, 10)} </Text>
              <Text color={it.isError ? COLOR.needs : undefined} bold>
                {it.tool}
              </Text>
              <Text color={COLOR.dim}> {it.detail}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
