import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

/** 2026-10-06 12:00:00 UTC */
export const T0 = Date.UTC(2026, 9, 6, 12, 0, 0)

/** What `$.process.run` answers: by default no omnigraph is reachable. */
/** What `$.process.run` answers; `null` means the program could not start (ENOENT). */
export type Processes = (
  argv: readonly string[],
  cwd: string | undefined,
) => { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean } | null

export interface World {
  cwd: string
  clock: MockClock
  files: Map<string, string>
  statuses: (string | undefined)[]
  logs: string[]
  shown: Set<string>
  /** How many times the plugin asked `$.session.cwd()`. */
  cwdCalls: number
  /** Every `$.process.run` the plugin made: argv and cwd. */
  runs: { argv: string[]; cwd: string | undefined }[]
  /** Every `$.ui.open` the plugin made: the pane id and whether it took the keyboard. */
  opens: { id: string; focus: boolean }[]
  /** How many times the plugin asked for a redraw (`$.ui.invalidate`): the browser's animation frames. */
  invalidations: number
}

/**
 * Stands in for everything beneath the plugin that its hooks call: the
 * session, files, status line, panes and a clock that only moves on `advance`.
 */
/** `cwd: null` makes `$.session.cwd()` refuse, to exercise the viz's own failure path. */
export function world(
  on: On,
  init: { cwd?: string | null; files?: Record<string, string>; processes?: Processes; env?: Record<string, string> } = {},
): World {
  const w: World = {
    cwd: init.cwd ?? '/work',
    clock: mock.clock(on, { now: T0 }),
    files: new Map(Object.entries(init.files ?? {})),
    statuses: [],
    logs: [],
    shown: new Set(),
    cwdCalls: 0,
    runs: [],
    opens: [],
    invalidations: 0,
  }
  mock.env(on, init.env ?? { HOME: '/home/u', SHELL: '/bin/zsh' })
  const processes: Processes = init.processes ?? (() => ({ exitCode: 1, stdout: '', stderr: 'error: no store here' }))
  on('process.run', async (_$, e) => {
    w.runs.push({ argv: [...e.argv], cwd: e.init?.cwd })
    const answer = processes(e.argv, e.init?.cwd)
    if (answer === null) return { deny: `ENOENT: no such file or directory, posix_spawn '${e.argv[0]}'` }
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, ...answer } }
  })
  on('ui.invalidate', async (_$, e, next) => {
    w.invalidations++
    return next(e)
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => {
    w.cwdCalls++
    return init.cwd === null ? { deny: 'no cwd' } : { value: w.cwd }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('fs.write', async (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_$, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('ui.status', async (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async (_$, e) => {
    w.opens.push({ id: e.id, focus: e.focus === true })
    w.shown.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', async (_$, e) => {
    w.shown.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: [...w.shown].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  return w
}

export const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

export const END = { reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as const

export function bashAnswer(stdout: string, stderr = '', isError = false) {
  return isError
    ? { isError: true as const, result: { stdout, stderr, interrupted: false }, text: `${stdout}${stderr}` }
    : { result: { stdout, stderr, interrupted: false }, text: stdout }
}

export function paneProps(columns = 100, bodyRows = 30) {
  return {
    title: 'omnigraph',
    isFocused: false,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  }
}

/** The Feed's op lines (it switches to the Feed tab first): plain Buttons keyed `op:<id>`, drawn as visible text. */
export async function feedLines(ui: {
  press: (q: { key: string }) => Promise<unknown>
  findAll: (q: { type: string }) => Promise<{ key: string | undefined; props: Record<string, unknown> }[]>
}) {
  await ui.press({ key: 'tab-feed' })
  return (await ui.findAll({ type: 'Button' }))
    .filter(b => b.key?.startsWith('op:'))
    .map(b => ({ key: b.key!, label: String(b.props.label), plain: b.props.plain === true }))
}

interface DrawnNode {
  props?: Record<string, unknown>
  children?: (DrawnNode | string)[]
}

/** The Graph tab's browser as drawn: its rows as plain text, and the selected (reverse-video) runs. */
export async function exploreView(ui: { drawn: (scope?: { in?: string }) => Promise<unknown> }) {
  const tree = (await ui.drawn({ in: 'explore' })) as DrawnNode
  const text = (t: DrawnNode | string): string => (typeof t === 'string' ? t : (t.children ?? []).map(text).join(''))
  const rows = (tree.children ?? []) as DrawnNode[]
  return {
    text: rows.map(row => text(row)).join('\n'),
    /** Per row with any, its reverse-video text: the selection in the picture and in each column. */
    selected: rows.map(row => ((row.children ?? []) as DrawnNode[]).filter(t => t.props?.inverse === true).map(text).join('')).filter(Boolean),
  }
}
