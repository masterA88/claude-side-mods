import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../src/capture/classify'
import { formatArgv, formatDuration, formatOpLine, headerText, outcomeSummary, statusText } from '../src/render/format'
import type { OpEvent } from '../types'

const at = new Date(2026, 9, 6, 12, 3, 41).getTime()
const op = (over: Partial<OpEvent> = {}): OpEvent => ({
  id: 'x#0', startedAt: at, status: 'ok', durationMs: 84,
  intent: classify({ argv: ['omnigraph', 'mutate', 'create_issue', '--branch', 'main'], cwd: '/w', index: 0 }),
  outcome: { kind: 'change', branch: 'main', queryName: 'create_issue', nodes: 1, edges: 0 },
  ...over,
})

describe('format', () => {
  test('op line at 100 columns', () => {
    const line = formatOpLine(op(), 100)
    expect(line).toHaveLength(100)
    expect(line).toMatch(/^12:03:41 ▸ mutate  create_issue\s+main\s+\+1n \+0e\s+84ms ✓$/)
  })
  test('narrow lines drop the branch column and still fit', () => {
    const line = formatOpLine(op(), 60)
    expect(line).toHaveLength(60)
    expect(line).not.toMatch(/main/)
  })
  test('very narrow panes get a compact line that still fits', () => {
    for (const width of [20, 40, 55]) {
      const line = formatOpLine(op(), width)
      expect(line).toHaveLength(width)
      expect(line.startsWith('✓ mutate')).toBe(true)
    }
  })
  test('running and failed marks', () => {
    expect(formatOpLine(op({ status: 'running', durationMs: undefined, outcome: undefined }), 80)).toMatch(/…$/)
    expect(formatOpLine(op({ status: 'error', outcome: { kind: 'error', message: 'unknown query' } }), 80)).toMatch(/unknown query.* ✗$/)
  })
  test('summaries', () => {
    expect(outcomeSummary({ kind: 'read', queryName: 'q', rowCount: 4, columns: [], cells: [] })).toBe('4 rows')
    expect(outcomeSummary({ kind: 'branch', action: 'merged', name: 'r', into: 'main', merge: 'fast_forward' })).toBe('r → main (fast_forward)')
    expect(outcomeSummary({ kind: 'load', branch: 'm', mode: 'merge', total: 12, nodeTypes: 1, edgeTypes: 0 })).toBe('12 entities')
  })
  test('durations', () => {
    expect([formatDuration(undefined), formatDuration(84.4), formatDuration(1234)]).toEqual(['', '84ms', '1.2s'])
  })
  test('status and header', () => {
    const view = { counters: { ops: 14, errors: 0, nodes: 3, edges: 1 }, graph: 'dev', branch: 'main' }
    expect(statusText(view)).toBe('◉ og · main · 14 ops · +3n')
    expect(statusText({ ...view, counters: { ops: 2, errors: 1, nodes: 0, edges: 0 }, branch: null })).toBe('◉ og · 2 ops · 1 ✗')
    expect(headerText(view)).toBe('◉ omnigraph · dev · main   14 ops · +3n +1e · 0 ✗')
  })
  test('a replay shows in the status line and the header', () => {
    const view = { counters: { ops: 3, errors: 0, nodes: 1, edges: 0 }, graph: 'dev', branch: 'main' }
    const replay = { speed: 2, progress: 0.456, isDone: false }
    expect(statusText({ ...view, replay })).toBe('◉ og · main · 3 ops · +1n · ⟳ replay 2× 45%')
    expect(statusText({ ...view, replay: { ...replay, isDone: true } })).toBe('◉ og · main · 3 ops · +1n · ⟳ replay done')
    expect(headerText({ ...view, replay })).toBe('◉ omnigraph · dev · main · ⟳ replay 2× 45%   3 ops · +1n +0e · 0 ✗')
  })
  test('the header is cut to the pane, never wrapped', () => {
    const view = { counters: { ops: 14, errors: 0, nodes: 3, edges: 1 }, graph: 'a-long-graph-name.omni', branch: 'feature/x' }
    const line = headerText(view, 40)
    expect(line).toHaveLength(40)
    expect(line.endsWith('…')).toBe(true)
  })
  test('argv quoting', () => {
    expect(formatArgv(['omnigraph', 'mutate', 'x', '--params', '{"a": "b c"}'])).toBe(`omnigraph mutate x --params '{"a": "b c"}'`)
  })
})
