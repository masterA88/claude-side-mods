import type { Counters, OpEvent, OpOutcome, ReplayView } from '../../types'

export function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function outcomeSummary(o: OpOutcome | undefined): string {
  if (!o) return ''
  switch (o.kind) {
    case 'read':
      return `${o.rowCount} rows`
    case 'change':
      return `+${o.nodes}n +${o.edges}e`
    case 'branch':
      if (o.action === 'created') return `⎇ ${o.name} ← ${o.from ?? '?'}`
      if (o.action === 'deleted') return `✂ ${o.name}`
      return `${o.name} → ${o.into ?? '?'} (${o.merge ?? 'merged'})`
    case 'load':
      return `${o.total} entities`
    case 'error':
      return o.message
    case 'other':
      return o.firstLine
  }
}

export function statusMark(op: OpEvent): string {
  return op.status === 'running' ? '…' : op.status === 'ok' ? '✓' : '✗'
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text.padEnd(width)
  return `${text.slice(0, Math.max(0, width - 1))}…`
}

/** `12:03:41 ▸ mutate  create_issue       main       +1n +0e            84ms ✓`, exactly `width` long. */
export function formatOpLine(op: OpEvent, width: number): string {
  if (width < 56) {
    const compact = `${statusMark(op)} ${op.intent.verb} ${op.intent.queryName ?? op.intent.sub ?? ''} ${outcomeSummary(op.outcome)}`
    return fit(compact, width)
  }
  const verb = fit(op.intent.verb, 7)
  const name = fit(op.intent.queryName ?? op.intent.sub ?? '', 18)
  const branch = width >= 72 ? `${fit(op.intent.branch ?? '', 10)} ` : ''
  const tail = `${formatDuration(op.durationMs).padStart(6)} ${statusMark(op)}`
  const head = `${formatClock(op.startedAt)} ▸ ${verb} ${name} ${branch}`
  const room = width - head.length - tail.length - 1
  return `${head}${fit(outcomeSummary(op.outcome), room)} ${tail}`
}

/** `⟳ replay 2× 45%`, or `⟳ replay done` once every line has played. */
export function replayText(r: ReplayView): string {
  return r.isDone ? '⟳ replay done' : `⟳ replay ${r.speed}× ${Math.floor(r.progress * 100)}%`
}

export function statusText(view: { counters: Counters; branch: string | null; replay?: ReplayView | null }): string {
  const parts = ['◉ og']
  if (view.branch) parts.push(view.branch)
  parts.push(`${view.counters.ops} ops`)
  if (view.counters.nodes > 0) parts.push(`+${view.counters.nodes}n`)
  if (view.counters.errors > 0) parts.push(`${view.counters.errors} ✗`)
  if (view.replay) parts.push(replayText(view.replay))
  return parts.join(' · ')
}

/** One line, cut to `width`: a wrapped header would push the pane's last rows out of view. */
export function headerText(
  view: { counters: Counters; graph: string | null; branch: string | null; replay?: ReplayView | null },
  width = Infinity,
): string {
  const where = [view.graph ?? 'no graph yet', view.branch ?? 'main']
  if (view.replay) where.push(replayText(view.replay))
  const c = view.counters
  const text = `◉ omnigraph · ${where.join(' · ')}   ${c.ops} ops · +${c.nodes}n +${c.edges}e · ${c.errors} ✗`
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

/** argv back to a readable command line, quoting what needs it. */
export function formatArgv(argv: readonly string[]): string {
  return argv.map(a => (a === '' || /[\s"'$`\\|&;<>()]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ')
}
