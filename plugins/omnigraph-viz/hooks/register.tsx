import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { CLAUDE_KEY, callDiff, detailOf, endLine, fileOf, graphLine, spawnDiff, startLine } from '../src/activity/activity'
import { beginOps, endLines } from '../src/capture/capture'
import { parseOutput } from '../src/capture/parse-output'
import { findInvocations } from '../src/capture/tokenize'
import {
  commitChangesArgv, commitListArgv, exportArgv, parseChanges, parseCommits, pickCommit, schemaArgv, schemaSourceOf, targetKey,
} from '../src/enrich/cli'
import { buildMatchIndex, matchCells } from '../src/enrich/highlight'
import { binCandidates, isPlainName, pathFromShell } from '../src/enrich/locate'
import { JobQueue } from '../src/enrich/queue'
import { foldExport, parseEdgeEnds } from '../src/graph/ghost'
import { LedgerWriter, decodeLedger, ledgerPathFor } from '../src/model/ledger'
import type { LedgerIO } from '../src/model/ledger'
import { emptyViz, reduce } from '../src/model/reduce'
import { INITIAL_UI, INITIAL_VIEW, toView } from '../src/model/state'
import { BrailleCanvas } from '../src/render/braille'
import { statusText } from '../src/render/format'
import { browserRowsFor } from '../src/render/graph-view'
import type { GraphViewData } from '../src/render/graph-view'
import { drawPane } from '../src/render/pane'
import { actionFor } from '../src/render/explore'
import { opName, Scene } from '../src/render/scene'
import { OG_HINT, parseOgArgs } from '../src/replay/command'
import { Player, readReplay } from '../src/replay/player'
import { basename, resolvePath } from '../src/util/path'
import type { GraphState, LedgerLine, OpEvent, OpIntent, UiState, VizState } from '../types'

const MOD_VERSION = '0.1.0'
const PANE = 'omnigraph'

// fork: the one switch /mod-on and /mod-off flip, a file every side mod watches
const MODS_FILE = '.claude/side-mods/mods-on.json'
let lastMods: boolean | null = null

async function followMods($: EngineInterface) {
  const home = await $.env.get('HOME')
  let isWanted = false
  try {
    isWanted = (JSON.parse(await $.fs.read(`${home}/${MODS_FILE}`)) as { on?: unknown }).on === true
  } catch {
    // no switch file yet: off
  }
  if (isWanted === lastMods) return
  lastMods = isWanted
  if (isWanted) await $.ui.open({ id: PANE, title: 'omnigraph' })
  else await $.ui.close({ id: PANE })
}
const FRAME_MS = 33

interface Config {
  bin: string
  ledgerDir: string
  maxGhostNodes: number
  isEnriching: boolean
  isDebug: boolean
}

/** What the pane can show: a reduced state and the scene drawn from the same lines. */
interface Show {
  viz: VizState
  scene: Scene
}

interface Session extends Show {
  cwd: string
  /** Created by the first op, so a session without omnigraph leaves no files. */
  ledger: LedgerWriter | undefined
  /** After `session.end`: background jobs may still finish, but the status line stays clear. */
  isEnded?: boolean
}

/** A recorded ledger playing in the pane instead of the live session (which carries on, unseen). */
interface Replay extends Show {
  name: string
  player: Player
  hasGraph: boolean
  timer: { cancel: () => void } | undefined
}

// $.state: small, survives hot reload, redraws its readers. Declared here so the validator can see them.
const uiAtom = atom({ plugin: 'omnigraph-viz', key: 'ui' } as const, INITIAL_UI)
const viewAtom = atom({ plugin: 'omnigraph-viz', key: 'view' } as const, INITIAL_VIEW)
const ledgerPathAtom = atom({ plugin: 'omnigraph-viz', key: 'ledgerPath' } as const, null)

// Module memory: rebuilt from the ledger on every (re)load.
let config: Config = { bin: 'omnigraph', ledgerDir: '.omnigraph-viz', maxGhostNodes: 2000, isEnriching: true, isDebug: false }
let session: Session | undefined
let replay: Replay | undefined
let queue: JobQueue | undefined
/** Bootstrap progress for the graph `graphKey` names; `ready` once a graph line exists. */
let graphState: GraphState = 'none'
let graphMessage: string | null = null
let graphKey: string | null = null
/** The browser's canvas while the Graph tab is on screen; the animation loop redraws it. */
let canvas: BrailleCanvas | null = null
let frameTimer: { cancel: () => void } | undefined
let isFrameBusy = false
/** Where `omnigraph` really is, once a bare name failed to start on Claude Code's PATH. */
let resolvedBin: string | undefined
/** HOME, read once: `null` until then. */
let homeCache: string | undefined | null = null

// fork: the session's own activity, drawn as a graph while no omnigraph store is in play.
// It is a Session of its own with no ledger, so it never takes the store graph's place and writes no files.
const agentLabels = new Map<string, string>()
const callStarts = new Map<string, { at: number; detail: string }>()
let activity: Session | undefined

async function ensureActivity($: EngineInterface): Promise<Session> {
  if (activity) return activity
  const cwd = session?.cwd ?? (await $.session.cwd())
  const a: Session = { cwd, ledger: undefined, viz: emptyViz(), scene: new Scene() }
  activity = a
  apply($, a, graphLine(await $.clock.now(), cwd))
  return a
}

/** An omnigraph op made the session's ledger: from then on the store's graph is the one shown. */
function isStoreLive(): boolean {
  return session?.ledger !== undefined
}

function whoIs(agentId: string | undefined): string {
  return agentId ? (agentLabels.get(agentId) ?? 'agent') : CLAUDE_KEY
}

function io($: EngineInterface): LedgerIO {
  return {
    write: (path, text) => $.fs.write(path, text),
    onError: err => debug($, err),
  }
}

function debug($: EngineInterface, err: unknown): void {
  if (config.isDebug) $.ui.log(`omnigraph-viz: ${err instanceof Error ? err.message : String(err)}`)
}

/** The pane shows the replay while one is on, else the live session. */
function shown(): Show | undefined {
  return replay ?? (isStoreLive() || !activity ? session : activity)
}

/** The one path every line takes, live or replayed: the reducer, then the scene. */
function feed(show: Show, line: LedgerLine): void {
  const before = show.viz.ghost
  show.viz = reduce(show.viz, line)
  show.scene.onLine(line, before, show.viz.ghost)
}

/** Every live change goes through here: ledger, then reducer and scene, then animation. */
function apply($: EngineInterface, s: Session, line: LedgerLine): void {
  s.ledger?.append(line, io($))
  if (line.t === 'graph') graphKey = targetKey(line.target, line.cwd)
  feed(s, line)
  if (shown() === s && (line.t === 'graph' || line.t === 'diff' || line.t === 'touch')) startAnimation($)
}

/** The view and status line of whatever the pane shows. */
async function publish($: EngineInterface): Promise<void> {
  const r = replay
  const view = r
    ? toView(r.viz, r.viz.ghost ? 'ready' : r.hasGraph ? 'loading' : 'none', null, {
        speed: r.player.speed,
        progress: r.player.progress,
        isDone: r.player.isDone,
      })
    : activity && !isStoreLive()
      ? toView(activity.viz, 'ready', null)
      : session
        ? toView(session.viz, graphState, graphMessage)
        : INITIAL_VIEW
  await update($, viewAtom, () => view)
  // as upstream: the status line counts omnigraph ops (live or replayed), never the activity graph's calls
  $.ui.status((r || isStoreLive()) && view.counters.ops > 0 && !session?.isEnded ? statusText(view) : undefined)
}

/** On the first op: the ledger file, a `.gitignore` beside it, and the session line. */
async function ensureLedger($: EngineInterface, s: Session, now: number): Promise<void> {
  if (s.ledger) return
  const path = ledgerPathFor(s.cwd, config.ledgerDir, now)
  const ignore = `${path.slice(0, path.lastIndexOf('/'))}/.gitignore`
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
  await update($, ledgerPathAtom, () => path)
  s.ledger = new LedgerWriter(path)
  apply($, s, { v: 1, t: 'session', at: now, cwd: s.cwd, mod: MOD_VERSION })
}

/**
 * Rehydrates from the ledger `$.state` remembers (a hot reload), else starts
 * a new one. The scene is laid out once from the final graph: replaying every
 * diff's layout would make a reload as slow as the session was long.
 */
async function openSession($: EngineInterface, cwd: string): Promise<Session> {
  const s: Session = { cwd, ledger: undefined, viz: emptyViz(), scene: new Scene() }
  const previous = await read($, ledgerPathAtom)
  if (previous === null) return s
  try {
    const { lines } = decodeLedger(await $.fs.read(previous))
    let graphLine: Extract<LedgerLine, { t: 'graph' }> | undefined
    for (const line of lines) {
      s.viz = reduce(s.viz, line)
      if (line.t === 'graph') graphLine = line
    }
    if (graphLine && s.viz.ghost) {
      graphKey = targetKey(graphLine.target, graphLine.cwd)
      graphState = 'ready'
      s.scene.onLine({ ...graphLine, at: await $.clock.now(), graph: s.viz.ghost }, null, s.viz.ghost)
    }
    s.ledger = new LedgerWriter(previous, lines)
    return s
  } catch {
    // file gone: start over
    return { cwd, ledger: undefined, viz: emptyViz(), scene: new Scene() }
  }
}

/**
 * Finds `omnigraph` the way the person's terminal does: their login shell
 * (whose profile usually adds ~/.local/bin and the like), then the usual
 * install folders. Claude Code's own PATH may lack what its Bash tool has.
 */
async function locateOmnigraph($: EngineInterface): Promise<string | undefined> {
  if (!isPlainName(config.bin)) return undefined
  const shell = (await $.env.get('SHELL')) ?? '/bin/sh'
  const viaShell = await $.process
    .run([shell, '-lic', `command -v ${config.bin}`], { timeoutMs: 5000 })
    .then(r => pathFromShell(r.stdout, config.bin))
    .catch(() => undefined)
  if (viaShell !== undefined) return viaShell
  for (const path of binCandidates(await $.env.get('HOME'), config.bin)) {
    if (await $.fs.exists(path)) return path
  }
  return undefined
}

/** Runs `omnigraph <args>`; if the binary does not start, locates it once and retries. */
async function runOmnigraph($: EngineInterface, args: readonly string[], cwd: string) {
  const run = (bin: string) => $.process.run([bin, ...args], { cwd, timeoutMs: 20_000 })
  if (resolvedBin !== undefined) return run(resolvedBin)
  try {
    return await run(config.bin)
  } catch (err) {
    const found = await locateOmnigraph($)
    if (found === undefined) {
      throw new Error(
        `can't find \`${config.bin}\` on Claude Code's PATH: set the omnigraphBin option to its full path (\`which ${config.bin}\`)`,
      )
    }
    resolvedBin = found
    return run(found)
  }
}

function enqueue($: EngineInterface, at: number, run: () => Promise<void>): void {
  queue ??= new JobQueue(() => $.clock.now(), err => debug($, err))
  queue.push({ at, run })
}

/** Schema (for edge endpoint types) and export of the graph the op ran against → a `graph` line. */
async function bootstrap($: EngineInterface, s: Session, intent: OpIntent): Promise<void> {
  const run = (argv: string[]) => runOmnigraph($, argv.slice(1), intent.cwd)
  try {
    const schema = await run(schemaArgv(config.bin, intent.target)).catch(() => undefined)
    const edgeEnds = parseEdgeEnds(schemaSourceOf(schema?.stdout ?? '') ?? '')
    const out = await run(exportArgv(config.bin, intent.target))
    if (out.exitCode !== 0) {
      const failure = parseOutput(out.stdout, out.stderr, true)
      throw new Error(failure.kind === 'error' ? failure.message : `exit ${out.exitCode}`)
    }
    // Over `$.process.run`'s 4 MiB cap the export is cut: start touched-only instead.
    const graph = out.isStdoutTruncated
      ? { nodes: [], edges: [], truncated: true, edgeEnds }
      : foldExport(out.stdout, edgeEnds, config.maxGhostNodes)
    apply($, s, { v: 1, t: 'graph', at: await $.clock.now(), target: intent.target, cwd: intent.cwd, graph })
    graphState = 'ready'
    graphMessage = null
  } catch (err) {
    graphState = 'failed'
    graphMessage = (err instanceof Error ? err.message : String(err)).slice(0, 160)
  }
  await publish($)
}

/** The commit a write op made → its changes → a `diff` line. */
async function enrichWrite($: EngineInterface, s: Session, op: OpEvent, branch: string, endedAt: number): Promise<void> {
  if (!s.viz.ghost) return
  const run = (argv: string[]) => runOmnigraph($, argv.slice(1), op.intent.cwd)
  const list = await run(commitListArgv(config.bin, op.intent.target, branch))
  const consumed = new Set((s.ledger?.lines ?? []).flatMap(l => (l.t === 'diff' ? [l.commitId] : [])))
  const commitId = pickCommit(parseCommits(list.stdout), op.startedAt, endedAt, consumed)
  if (commitId === undefined) return
  const changes = await run(commitChangesArgv(config.bin, op.intent.target, commitId))
  const parsed = parseChanges(changes.stdout)
  if (parsed.changes.length === 0) return
  apply($, s, { v: 1, t: 'diff', at: await $.clock.now(), opId: op.id, commitId, ...parsed })
}

/** After an op ends: bootstrap the graph once, light a read's nodes, fetch a write's diff. */
function enrich($: EngineInterface, s: Session, op: OpEvent, end: LedgerLine): void {
  if (!config.isEnriching || end.t !== 'op.end') return
  const key = targetKey(op.intent.target, op.intent.cwd)
  const o = end.outcome
  const isWrite = end.status === 'ok' && (o.kind === 'change' || o.kind === 'load')
  // Bootstrap once; after a failure, retry for another graph or once a write on this one succeeded.
  if (graphState === 'none' || (graphState === 'failed' && (key !== graphKey || isWrite))) {
    graphState = 'loading'
    graphKey = key
    enqueue($, end.at, () => bootstrap($, s, op.intent))
  }
  // Only the session's graph is drawn: another graph's ops stay in the Feed alone.
  if (end.status !== 'ok' || key !== graphKey) return
  if (o.kind === 'read' && o.cells.length > 0) {
    enqueue($, end.at, async () => {
      if (!s.viz.ghost) return
      const { nodeIds, isExact } = matchCells(o.cells, buildMatchIndex(s.viz.ghost))
      if (nodeIds.length > 0) apply($, s, { v: 1, t: 'touch', at: await $.clock.now(), opId: op.id, nodeIds, isExact })
    })
  }
  const branch = o.kind === 'change' || o.kind === 'load' ? o.branch : o.kind === 'branch' && o.action === 'merged' ? o.into : undefined
  if (branch) enqueue($, end.at, () => enrichWrite($, s, op, branch, end.at))
}

async function startCapture($: EngineInterface, command: string, toolUseId: string, agentId: string | undefined): Promise<OpEvent[]> {
  const s = session
  // Tokenize before any $ call: most Bash commands are not omnigraph.
  if (!s || findInvocations(command, '/', config.bin).length === 0) return []
  const now = await $.clock.now()
  await ensureLedger($, s, now)
  if (homeCache === null) homeCache = await $.env.get('HOME')
  const home = homeCache
  const ops = beginOps({
    command,
    toolUseId,
    cwd: await $.session.cwd(),
    bin: config.bin,
    now,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(home !== undefined ? { home } : {}),
  })
  for (const op of ops) apply($, s, { v: 1, t: 'op.start', at: op.startedAt, op })
  if (ops.length > 0) await publish($)
  return ops
}

async function finishCapture($: EngineInterface, ops: readonly OpEvent[], r: Parameters<typeof endLines>[1]): Promise<void> {
  const s = session
  if (!s || ops.length === 0) return
  const ends = endLines(ops, r, await $.clock.now())
  for (const line of ends) apply($, s, line)
  ops.forEach((op, i) => enrich($, s, op, ends[i]!))
  await publish($)
}

function stopAnimation(): void {
  frameTimer?.cancel()
  frameTimer = undefined
}

/** Runs frames while the Graph tab is on screen and something moves; idles otherwise. */
function startAnimation($: EngineInterface): void {
  if (frameTimer || !canvas) return
  frameTimer = $.clock.every(FRAME_MS, () => void frame($))
}

async function frame($: EngineInterface): Promise<void> {
  if (isFrameBusy) return
  const c = canvas
  if (!c) {
    stopAnimation()
    return
  }
  isFrameBusy = true
  try {
    const now = await $.clock.now()
    // Replay lines due by now play first, so a frame never steps the layout past one.
    const isNewLines = playDue(now)
    const show = shown()
    if (!show) {
      stopAnimation()
      return
    }
    show.scene.tick(now)
    // The browser is a Client: its pane redraws it, and the pane's draw renders the frame.
    $.ui.invalidate('ui.render')
    if (isNewLines) await publish($)
    if (!show.scene.isAnimating(now)) stopAnimation()
  } catch (err) {
    debug($, err)
    stopAnimation()
  } finally {
    isFrameBusy = false
  }
}

/** The selection link: the op's nodes light up again on the graph and keep their labels. */
async function selectOp($: EngineInterface, id: string): Promise<void> {
  const ui = await update($, uiAtom, u => ({ ...u, selectedOpId: u.selectedOpId === id ? null : id }))
  const show = shown()
  const ghost = show?.viz.ghost
  if (!show || ui.selectedOpId === null || !ghost) {
    if (show && ghost) {
      show.scene.unfocus(ghost, await $.clock.now())
      startAnimation($)
    } else if (show) show.scene.pinned = []
    return
  }
  const op = show.viz.ops.find(o => o.id === ui.selectedOpId)
  show.scene.focus(show.viz.touches[ui.selectedOpId] ?? [], ghost, await $.clock.now(), op ? opName(op.intent) : undefined)
  startAnimation($)
}

/** The Graph tab's browser: a canvas sized to the pane, drawn now. */
async function graphView($: EngineInterface, show: Show | undefined, columns: number, bodyRows: number, ghost: GraphViewData['ghost']): Promise<GraphViewData> {
  // A truncated graph says so in a row of its own under the browser.
  const rows = browserRowsFor(bodyRows) - (ghost.truncated ? 1 : 0)
  let runs: GraphViewData['runs'] = null
  if (show?.viz.ghost) {
    if (!canvas || canvas.cols !== columns || canvas.rows !== rows) canvas = new BrailleCanvas(columns, rows)
    const now = await $.clock.now()
    canvas.clear()
    show.scene.drawFrame(canvas, show.viz.ghost, now)
    runs = canvas.runs()
    // Only while something moves: each frame redraws the pane, and this draw must not restart a loop that just stopped.
    if (show.scene.isAnimating(now)) startAnimation($)
  } else {
    canvas = null
  }
  return { ghost, columns, rows, runs, isBrowsing: show ? !show.scene.isFollowing : false, recent: show?.viz.ops.slice(-3) ?? [] }
}

/** Plays every replay line now due; true when any did. */
function playDue(now: number): boolean {
  const r = replay
  if (!r) return false
  const lines = r.player.due(now)
  for (const line of lines) feed(r, line)
  return lines.length > 0
}

/** The replay's clock: plays what is due, publishes, and sleeps until the next line. A failure ends the replay. */
async function pumpReplay($: EngineInterface, r: Replay): Promise<void> {
  r.timer = undefined
  if (replay !== r) return
  try {
    const now = await $.clock.now()
    if (playDue(now)) {
      startAnimation($)
      await publish($)
    }
    const next = r.player.nextAt
    if (replay === r && next !== undefined) r.timer = $.clock.after(Math.max(0, next - now), () => void pumpReplay($, r))
  } catch (err) {
    debug($, err)
    if (replay === r) {
      stopReplay()
      await publish($).catch(() => undefined)
    }
  }
}

function stopReplay(): void {
  replay?.timer?.cancel()
  replay = undefined
}

/** `/og replay <path> [speed]`: reads and checks the ledger, then plays it in the pane's Graph tab. */
async function startReplay($: EngineInterface, path: string, speed: number): Promise<string> {
  if (homeCache === null) homeCache = await $.env.get('HOME')
  const file = resolvePath(session?.cwd ?? (await $.session.cwd()), path, homeCache)
  let text: string
  try {
    text = await $.fs.read(file)
  } catch (err) {
    return `Can't read ${path}: ${err instanceof Error ? err.message : String(err)}`
  }
  const loaded = readReplay(text)
  if ('error' in loaded) return `Can't replay ${path}: ${loaded.error}`
  // Everything that can fail before the switch happens first, so a running replay is never left half-stopped.
  const r: Replay = {
    name: basename(file),
    player: new Player(loaded.lines, speed, Math.round(await $.clock.now())),
    hasGraph: loaded.lines.some(line => line.t === 'graph'),
    viz: emptyViz(),
    scene: new Scene(),
    timer: undefined,
  }
  stopReplay()
  if (session) session.scene.pinned = []
  replay = r
  try {
    await update($, uiAtom, (u): UiState => ({ ...u, tab: 'graph', selectedOpId: null }))
    await $.ui.open({ id: PANE, title: 'omnigraph', focus: true })
    await pumpReplay($, r)
    await publish($)
  } catch (err) {
    debug($, err)
    if (replay === r) stopReplay()
    await publish($).catch(() => undefined)
    return `Couldn't replay ${path}: ${err instanceof Error ? err.message : String(err)}`
  }
  return `Replaying ${r.name} at ${speed}×, about ${Math.round(r.player.durationMs / 1000)} s. /og stop ends it.`
}

export const register: Register = (on, options) => {
  config = {
    bin: typeof options.omnigraphBin === 'string' ? options.omnigraphBin : 'omnigraph',
    ledgerDir: typeof options.ledgerDir === 'string' ? options.ledgerDir : '.omnigraph-viz',
    maxGhostNodes: typeof options.maxGhostNodes === 'number' ? options.maxGhostNodes : 2000,
    isEnriching: options.enrich !== false,
    isDebug: options.debug === true,
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'og',
        description: 'Omnigraph viz: toggle the pane, replay a recorded session, or reset the view',
        argumentHint: OG_HINT,
      })
      // fork: on/off switches that /mod-on and /mod-off call
      await $.command.register({ name: 'og-on', description: 'Open the omnigraph pane on the right (part of /mod-on)' })
      lastMods = null
      await followMods($)
      $.clock.every(1000, () => void followMods($))
      await $.command.register({ name: 'og-off', description: 'Close the omnigraph pane (part of /mod-off)' })
      stopReplay()
      graphState = 'none'
      graphMessage = null
      graphKey = null
      session = await openSession($, e.cwd)
      await publish($)
    } catch (err) {
      debug($, err)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // `/clear` raises session.end but no session.start follows: the session goes on.
    if (e.reason !== 'clear') {
      if (session) session.isEnded = true
      stopReplay()
    }
    stopAnimation()
    $.ui.status(undefined)
    return next(e)
  })

  on('command.run', { command: 'og-on' }, async $ => {
    // not focused: the prompt keeps the keys, a click on the pane hands them over
    await $.ui.open({ id: PANE, title: 'omnigraph' })
    return { text: 'Omnigraph pane on.' }
  })

  on('command.run', { command: 'og-off' }, async $ => {
    await $.ui.close({ id: PANE })
    return { text: 'Omnigraph pane off.' }
  })

  on('command.run', { command: 'og' }, async ($, e) => {
    const cmd = parseOgArgs(e.args)
    if (cmd.kind === 'usage') return { text: cmd.message }
    if (cmd.kind === 'replay') return { text: await startReplay($, cmd.path, cmd.speed) }
    if (cmd.kind === 'stop') {
      if (!replay) return { text: 'No replay is running.' }
      stopReplay()
      if (session) session.scene.pinned = []
      await update($, uiAtom, u => ({ ...u, selectedOpId: null }))
      await publish($)
      return { text: 'Replay stopped; back to the live session.' }
    }
    if (cmd.kind === 'clear') {
      stopReplay()
      if (session) {
        // The Feed starts over; the graph stays, so the Graph tab keeps working.
        session.viz = { ...emptyViz(), ghost: session.viz.ghost }
      }
      activity = undefined
      await publish($)
      return { text: 'Omnigraph viz cleared.' }
    }
    const isShown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Omnigraph viz closed.' }
    }
    // Focused, so g / f / Tab / Enter work at once; Esc hands the keys back to the prompt.
    await $.ui.open({ id: PANE, title: 'omnigraph', focus: true })
    return { text: 'Omnigraph viz opened.' }
  })

  // Observer only: the command and the result pass through untouched. Every
  // Bash call comes through (a custom omnigraphBin need not say "omnigraph");
  // startCapture tokenizes before touching $.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let ops: OpEvent[] = []
    try {
      ops = await startCapture($, e.command, e.tool_use_id, e.agentId)
    } catch (err) {
      debug($, err)
    }
    const r = await next(e)
    try {
      await finishCapture($, ops, r)
    } catch (err) {
      debug($, err)
    }
    return r
  }).catch(($, e, next) => next(e))

  // fork: every tool call by Claude or an agent becomes an op in the Feed and a link in the graph
  on('tool.call', async ($, e, next) => {
    const s = session
    const input = e as unknown as Record<string, unknown>
    const isOmnigraph = e.tool === 'Bash' && findInvocations(String(input.command ?? ''), '/', config.bin).length > 0
    if (!s || isOmnigraph || isStoreLive()) return next(e)
    const id = e.tool_use_id ?? `call-${await $.clock.now()}`
    const detail = detailOf(input)
    let a: Session | undefined
    try {
      a = await ensureActivity($)
      const at = await $.clock.now()
      callStarts.set(id, { at, detail })
      apply($, a, startLine(at, id, e.tool, whoIs(e.agentId), detail, s.cwd, e.agentId))
      await publish($)
    } catch (err) {
      debug($, err)
    }
    const r = await next(e)
    if (!a) return r
    try {
      const at = await $.clock.now()
      const start = callStarts.get(id)
      callStarts.delete(id)
      const isError = r.deny !== undefined || r.isError === true
      apply($, a, endLine(at, id, start?.at ?? at, isError, detail))
      apply($, a, callDiff(at, id, e.tool, e.agentId, fileOf(e.tool, input)))
      await publish($)
    } catch (err) {
      debug($, err)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const s = session
    if (!s || !('agentId' in started) || !started.agentId) return started
    try {
      agentLabels.set(started.agentId, e.subagentType || 'agent')
      const a = await ensureActivity($)
      const label = `${e.subagentType || 'agent'}: ${e.description || ''}`
      apply($, a, spawnDiff(await $.clock.now(), `spawn-${started.agentId}`, started.agentId, label, e.parentAgentId))
      await publish($)
    } catch (err) {
      debug($, err)
    }
    return started
  }).catch(($, e, next) => next(e))

  // The browser Client's keys: select, open, go back, follow live, switch tabs. The answer is its next rows.
  on('ui.message', { requestId: 'omnigraph' }, async ($, e) => {
    const show = shown()
    const ghost = show?.viz.ghost
    const data = e.data as { key?: unknown; meta?: unknown; shift?: unknown; ctrl?: unknown } | null
    if (!show || !ghost || !canvas || e.element !== 'explore' || typeof data?.key !== 'string') return {}
    const action = actionFor({ key: data.key, meta: data.meta === true, shift: data.shift === true, ctrl: data.ctrl === true })
    if (action.kind === 'tab') {
      await update($, uiAtom, (u): UiState => ({ ...u, tab: action.tab }))
      return {}
    }
    const wasFollowing = show.scene.isFollowing
    const now = await $.clock.now()
    show.scene.key(action, ghost, now)
    // The tab row's hint changes when browsing starts or stops: redraw the pane for it.
    if (show.scene.isFollowing !== wasFollowing) $.ui.invalidate('ui.render')
    if (show.scene.isAnimating(now)) startAnimation($)
    canvas.clear()
    show.scene.drawFrame(canvas, ghost, now)
    return { props: { rows: canvas.runs() } }
  })

  on('ui.render', { component: 'Pane', requestId: 'omnigraph' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const [view, ui] = await Promise.all([read($, viewAtom), read($, uiAtom)])
    const show = shown()
    const selectedOutput = show?.viz.ops.find(op => op.id === ui.selectedOpId)?.output
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    let graph: GraphViewData | undefined
    if (ui.tab !== 'feed') {
      graph = await graphView($, show, columns, rows, view.ghost)
    } else {
      canvas = null
    }
    return drawPane(
      $.ui.resolve(e),
      {
        view,
        ui,
        columns,
        rows,
        ...(selectedOutput !== undefined ? { selectedOutput } : {}),
        ...(graph !== undefined ? { graph } : {}),
      },
      {
        setTab: tab => void update($, uiAtom, u => ({ ...u, tab })),
        select: id => void selectOp($, id),
      },
    )
  })
}
