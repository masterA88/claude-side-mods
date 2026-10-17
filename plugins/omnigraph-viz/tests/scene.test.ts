import { describe, expect, test } from 'claude-code/testing'

import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'
import { centreOf } from '../src/browse/model'
import { effectsFor } from '../src/graph/effects'
import { foldExport, parseEdgeEnds } from '../src/graph/ghost'
import { ACCENT, ACCENT_RING } from '../src/graph/palette'
import { reduce, emptyViz } from '../src/model/reduce'
import { BrailleCanvas, quantize } from '../src/render/braille'
import { Scene } from '../src/render/scene'
import type { GhostGraph, LedgerLine, VizState } from '../types'

const GRAPH: GhostGraph = foldExport(
  [
    '{"type":"Epic","id":"ep","data":{"title":"Offline sync"}}',
    '{"type":"Issue","id":"i1","data":{"title":"Fix login"}}',
    '{"type":"Issue","id":"i2","data":{"title":"Ship viz"}}',
    '{"edge":"EpicContainsIssue","id":"e1","from":"ep","to":"i1","data":{}}',
  ].join('\n'),
  { EpicContainsIssue: ['Epic', 'Issue'] },
  10,
)
const DEV = foldExport(EXPORT_JSONL, parseEdgeEnds(SCHEMA_SOURCE), 2000)
const T = 1_000_000

/** Feeds lines through reduce and the scene, as register.tsx does. */
function feed(scene: Scene, lines: LedgerLine[], from: VizState = emptyViz()): VizState {
  let viz = from
  for (const line of lines) {
    const before = viz.ghost
    viz = reduce(viz, line)
    scene.onLine(line, before, viz.ghost)
  }
  return viz
}

function loaded(graph = GRAPH): { scene: Scene; viz: VizState } {
  const scene = new Scene()
  const viz = feed(scene, [{ v: 1, t: 'graph', at: T - 60_000, target: {}, cwd: '/w', graph }])
  return { scene, viz }
}

/** The browser as text rows, drawn at `now`. */
function text(scene: Scene, viz: VizState, now: number, cols = 83, rows = 30): string[] {
  const canvas = new BrailleCanvas(cols, rows)
  scene.drawFrame(canvas, viz.ghost, now)
  return canvas.runs().map(r => r.map(x => x.t).join(''))
}

const opStart = (at: number, id = `p${at}`, queryName = 'ready'): LedgerLine => ({
  v: 1, t: 'op.start', at,
  op: { id, startedAt: at, status: 'running', intent: { verb: 'query', queryName, isInline: false, target: {}, isJson: false, argv: [], cwd: '/' } },
})

/** WCAG contrast ratio of two colors. */
function contrast(a: number, b: number): number {
  const luminance = (rgb: number) => {
    const [r, g, bl] = [16, 8, 0].map(shift => {
      const v = ((rgb >> shift) & 0xff) / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('effectsFor', () => {
  test('inserts flash, updates glow, deletes fade, new edges draw; reads glow and pulse', () => {
    const diff: LedgerLine = { v: 1, t: 'diff', at: 5, opId: 'o', commitId: 'c', more: 0, changes: [
      { kind: 'node', type: 'Issue', id: 'i3', op: 'insert' },
      { kind: 'node', type: 'Issue', id: 'i1', op: 'update' },
      { kind: 'node', type: 'Issue', id: 'i2', op: 'delete' },
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e2', op: 'insert', from: 'ep', to: 'i3' },
    ] }
    expect(effectsFor(diff, GRAPH).map(e => [e.kind, e.target])).toEqual([
      ['flash', 'Issue:i3'], ['glow', 'Issue:i1'], ['fade', 'Issue:i2'], ['draw', 'e2'],
    ])
    const touch: LedgerLine = { v: 1, t: 'touch', at: 5, opId: 'o', nodeIds: ['Epic:ep', 'Issue:i1'], isExact: false }
    expect(effectsFor(touch, GRAPH).map(e => [e.kind, e.target])).toEqual([['glow', 'Epic:ep'], ['glow', 'Issue:i1'], ['pulse', 'e1']])
  })
})

describe('Scene', () => {
  test('a loaded graph opens at the top level: its types', () => {
    const { scene, viz } = loaded()
    const rows = text(scene, viz, T)
    expect(rows[0]).toMatch(/^Issue\s+● live$/)
    expect(rows.join('\n')).toMatch(/◉ Issue 2/)
    expect(scene.isAnimating(T)).toBe(false)
  })

  test("a read goes to its node and keeps it lit until another op lights something", () => {
    const { scene, viz } = loaded()
    const next = feed(scene, [opStart(T), { v: 1, t: 'touch', at: T + 10, opId: `p${T}`, nodeIds: ['Issue:i1'], isExact: false }], viz)
    expect(centreOf(scene.browse, next.ghost!)).toEqual({ kind: 'node', node: 'Issue:i1', selected: null })
    expect(scene.isAnimating(T + 10)).toBe(true)
    scene.tick(T + 5000)
    expect(scene.isAnimating(T + 5000)).toBe(false)
    expect(text(scene, next, T + 5000).join('\n')).toMatch(/▶ Fix login/)
    // The next op starting changes nothing; an op that lights nothing neither.
    feed(scene, [opStart(T + 6000), { v: 1, t: 'touch', at: T + 6100, opId: 'x', nodeIds: ['Issue:gone'], isExact: false }], next)
    expect(text(scene, next, T + 6100)[0]).toMatch(/^Issue › Fix login/)
    feed(scene, [{ v: 1, t: 'touch', at: T + 7000, opId: 'p', nodeIds: ['Issue:i2'], isExact: false }], next)
    expect(text(scene, next, T + 7000)[0]).toMatch(/^Issue › Ship viz/)
  })

  test("a new link shows its source's links with the new node selected and marked NEW", () => {
    const { scene, viz } = loaded()
    const next = feed(scene, [{ v: 1, t: 'diff', at: T + 10, opId: 'o', commitId: 'c', more: 0, changes: [
      { kind: 'node', type: 'Issue', id: 'i9', op: 'insert', label: 'Brand new' },
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e9', op: 'insert', from: 'ep', to: 'i9' },
    ] }], viz)
    expect([...scene.accent]).toEqual(['Issue:i9', 'Epic:ep'])
    // Drawn once the picture has moved there.
    const rows = text(scene, next, T + 1000)
    expect(rows[0]).toMatch(/^Epic › Offline sync › contains › Brand new/)
    expect(rows.join('\n')).toMatch(/◉ Offline sync/)
    expect(rows.join('\n')).toMatch(/● Brand new NEW/)
  })

  test("a wide read centres on the op, named as it started", () => {
    const { scene, viz } = loaded(DEV)
    const ids = DEV.nodes.filter(n => n.type === 'Issue').slice(0, 4).map(n => n.id)
    feed(scene, [opStart(T, 'q1', 'blocked'), { v: 1, t: 'touch', at: T + 10, opId: 'q1', nodeIds: ids, isExact: false }], viz)
    expect(text(scene, viz, T + 10)[0]).toMatch(/^◆ query blocked · 4 nodes/)
  })

  test('a key stops following; ops still light up but stay put; l goes to the latest op', () => {
    const { scene, viz } = loaded()
    scene.key({ kind: 'move', delta: 1 }, viz.ghost!, T)
    expect(scene.isFollowing).toBe(false)
    expect(text(scene, viz, T)[0]).toBe('Epic')
    const next = feed(scene, [{ v: 1, t: 'touch', at: T + 10, opId: 'o', nodeIds: ['Issue:i2'], isExact: false }], viz)
    const rows = text(scene, next, T + 10)
    expect(rows[0]).toBe('Epic')
    expect(rows.join('\n')).toMatch(/▶ Issue/)
    scene.key({ kind: 'live' }, next.ghost!, T + 20)
    expect(scene.isFollowing).toBe(true)
    expect(text(scene, next, T + 20)[0]).toMatch(/^Issue › Ship viz\s+● live$/)
  })

  test("the Feed's selection goes to that op's nodes and glows them", () => {
    const { scene, viz } = loaded()
    scene.focus(['Issue:i2'], viz.ghost!, T + 5000, 'query ready')
    expect(scene.isAnimating(T + 5000)).toBe(true)
    expect(text(scene, viz, T + 5000)[0]).toMatch(/^Issue › Ship viz$/)
  })

  test('the accent reads on a dark terminal; the brand blue alone does not', () => {
    const TOKYO_NIGHT = 0x1a1b26
    expect(contrast(ACCENT_RING, TOKYO_NIGHT)).toBeGreaterThan(4.5)
    expect(contrast(ACCENT, TOKYO_NIGHT)).toBeLessThan(3)
  })
})

describe('deletes', () => {
  const del = (at: number, type: string, id: string): LedgerLine => ({ v: 1, t: 'diff', at, opId: `d${at}`, commitId: 'c', more: 0, changes: [{ kind: 'node', type, id, op: 'delete' }] })

  test("deleting the node the browser is on falls back to its type's list, and the breadcrumb names what is shown", () => {
    const { scene, viz } = loaded(DEV)
    let next = feed(scene, [{ v: 1, t: 'diff', at: T, opId: 'a', commitId: 'c', more: 0, changes: [
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e-x', op: 'insert', from: 'epc-offline-sync', to: 'iss-auth-mfa' },
    ] }], viz)
    expect(text(scene, next, T + 1000)[0]).toMatch(/^Epic › Offline editing & sync › contains/)
    next = feed(scene, [del(T + 2000, 'Epic', 'epc-offline-sync')], next)
    const rows = text(scene, next, T + 4000)
    expect(rows[0]).toMatch(/^Epic › Hard tenant isolation/)
    expect(rows.join('\n')).toMatch(/◉ Hard tenant isolation/)
    expect(rows.join('\n')).not.toMatch(/\(gone\)/)
    // `l` goes to the latest op, which no longer points at the deleted epic.
    scene.key({ kind: 'move', delta: 1 }, next.ghost!, T + 5000)
    scene.key({ kind: 'live' }, next.ghost!, T + 6000)
    expect(text(scene, next, T + 7000).join('\n')).not.toMatch(/\(gone\)/)
  })

  test("a hub drops deleted results, and its count matches what it shows", () => {
    const { scene, viz } = loaded(DEV)
    const ids = DEV.nodes.filter(n => n.type === 'Issue').slice(0, 5).map(n => n.id)
    let next = feed(scene, [opStart(T, 'q', 'ready'), { v: 1, t: 'touch', at: T + 10, opId: 'q', nodeIds: ids, isExact: false }], viz)
    next = feed(scene, [del(T + 20, 'Issue', ids[0]!.slice('Issue:'.length))], next)
    expect(scene.isFollowing).toBe(true)
    // A delete alone goes to the deleted node's type.
    expect(text(scene, next, T + 1000)[0]).toMatch(/^Issue › /)
    scene.key({ kind: 'live' }, next.ghost!, T + 2000)
    const browsing = new Scene()
    feed(browsing, [{ v: 1, t: 'graph', at: T - 60_000, target: {}, cwd: '/w', graph: DEV }, opStart(T, 'q', 'ready'), { v: 1, t: 'touch', at: T + 10, opId: 'q', nodeIds: ids, isExact: false }])
    browsing.key({ kind: 'none' }, DEV, T + 15)
    browsing.isFollowing = false
    const after = feed(browsing, [del(T + 20, 'Issue', ids[0]!.slice('Issue:'.length))], { ...emptyViz(), ghost: DEV })
    const rows = text(browsing, after, T + 1000)
    expect(rows[0]).toMatch(/^◆ query ready · 4 nodes/)
    expect(rows.join('\n')).toMatch(/◆ query ready · 4/)
  })
})

describe('moves and effects', () => {
  test('quick keys jump straight to the new picture, and a key that keeps the centre moves nothing', () => {
    const { scene, viz } = loaded(DEV)
    scene.key({ kind: 'deeper' }, DEV, T) // Issue's nodes: the picture moves from the type to the first issue
    expect(scene.isAnimating(T + 100)).toBe(true)
    // Its links, then another row in them: the same centre, so nothing moves.
    scene.key({ kind: 'deeper' }, DEV, T + 600)
    expect(scene.isAnimating(T + 700)).toBe(false)
    scene.key({ kind: 'move', delta: 1 }, DEV, T + 2000)
    expect(scene.isAnimating(T + 2000)).toBe(false)
    // Two hops 150 ms apart: the second lands at once, never over the first one's picture.
    scene.key({ kind: 'deeper' }, DEV, T + 3000)
    scene.key({ kind: 'back' }, DEV, T + 3150)
    expect(scene.isAnimating(T + 3200)).toBe(false)
    const still = new Scene()
    feed(still, [{ v: 1, t: 'graph', at: T - 60_000, target: {}, cwd: '/w', graph: DEV }])
    still.browse = scene.browse
    still.isFollowing = false
    expect(text(scene, viz, T + 3200)).toEqual(text(still, viz, T + 3200))
  })

  const epic = (scene: Scene, viz: VizState, at: number) =>
    feed(scene, [{ v: 1, t: 'touch', at, opId: 'a', nodeIds: ['Epic:epc-offline-sync'], isExact: false }], viz)
  /** The cell (col, row) where `text` starts in the browser drawn at `now`, or null. */
  function find(scene: Scene, viz: VizState, now: number, text: string): [number, number] | null {
    const rows = textAt(scene, viz, now)
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r]!.indexOf(text)
      if (c >= 0) return [c, r + 1]
    }
    return null
  }
  /** The picture's rows (below the breadcrumb, above the rule). */
  const textAt = (scene: Scene, viz: VizState, now: number) => text(scene, viz, now).slice(1, 17)
  /** The color of the run holding `needle` in the browser drawn at `now`. */
  function colorOf(scene: Scene, viz: VizState, now: number, needle: string): string | undefined {
    const canvas = new BrailleCanvas(83, 30)
    scene.drawFrame(canvas, viz.ghost, now)
    return canvas.runs().slice(1, 17).flat().find(r => r.t.includes(needle))?.c
  }

  test('a move slides shared nodes from their old place to their new one, then rests on the static picture', () => {
    const { scene, viz } = loaded(DEV)
    let next = epic(scene, viz, T)
    scene.tick(T + 5000)
    // Open the epic's first link (an issue): the issue slides to the middle, the epic out to a slot.
    scene.key({ kind: 'deeper' }, next.ghost!, T + 5000)
    scene.key({ kind: 'deeper' }, next.ghost!, T + 5000)
    const start = find(scene, next, T + 5000, 'Conflict-resolution UI')!
    const mid = find(scene, next, T + 5000 + 200, 'Conflict-resolution UI')!
    const end = find(scene, next, T + 5000 + 1000, 'Conflict-resolution UI')!
    expect(scene.isAnimating(T + 5200)).toBe(true)
    expect(scene.isAnimating(T + 6000)).toBe(false)
    expect(mid).not.toEqual(start)
    expect(mid).not.toEqual(end)
    // Done moving, the picture is the one a scene that never moved draws.
    const still = new Scene()
    next = feed(still, [{ v: 1, t: 'graph', at: T - 60_000, target: {}, cwd: '/w', graph: DEV }])
    still.browse = scene.browse
    still.isFollowing = false
    still.accent = scene.accent
    expect(text(scene, next, T + 7000)).toEqual(text(still, next, T + 7000))
  })

  test('a new node flashes white, then takes its type color', () => {
    const { scene, viz } = loaded(DEV)
    const next = feed(scene, [{ v: 1, t: 'diff', at: T, opId: 'b', commitId: 'c', more: 0, changes: [
      { kind: 'node', type: 'Issue', id: 'iss-new', op: 'insert', label: 'Brand new issue' },
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e-new', op: 'insert', from: 'epc-offline-sync', to: 'iss-new' },
    ] }], viz)
    const issue = scene.colors.get('Issue')!
    const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`
    expect(colorOf(scene, next, T + 500, 'Brand new issue')).not.toBe(colorOf(scene, next, T + 2000, 'Brand new issue'))
    expect(parseInt(colorOf(scene, next, T + 500, 'Brand new issue')!.slice(1), 16)).toBeGreaterThan(quantize(issue))
    expect(colorOf(scene, next, T + 2000, 'Brand new issue')).toBe(hex(quantize(issue)))
    expect(scene.isAnimating(T + 400)).toBe(true)
    scene.tick(T + 2000)
    expect(scene.isAnimating(T + 2000)).toBe(false)
  })
})

describe('replay determinism', () => {
  const issues = DEV.nodes.filter(n => n.type === 'Issue').map(n => n.id)
  /** A session on the dev graph: bootstrap, a read, a write that adds an issue to an epic, a read, a delete. */
  const LINES: LedgerLine[] = [
    { v: 1, t: 'graph', at: T, target: {}, cwd: '/w', graph: DEV },
    opStart(T + 20, 'a'),
    { v: 1, t: 'touch', at: T + 40, opId: 'a', nodeIds: issues.slice(0, 5), isExact: false },
    opStart(T + 900),
    { v: 1, t: 'diff', at: T + 1700, opId: 'b', commitId: 'c1', more: 0, changes: [
      { kind: 'node', type: 'Issue', id: 'iss-new', op: 'insert', label: 'New issue' },
      { kind: 'edge', type: 'EpicContainsIssue', id: 'e-new', op: 'insert', from: 'epc-offline-sync', to: 'iss-new' },
    ] },
    opStart(T + 2500),
    { v: 1, t: 'touch', at: T + 2600, opId: 'c', nodeIds: ['Issue:iss-new', ...issues.slice(5, 8)], isExact: false },
    opStart(T + 5100),
    { v: 1, t: 'diff', at: T + 5900, opId: 'd', commitId: 'c2', more: 0, changes: [{ kind: 'node', type: 'Issue', id: 'iss-new', op: 'delete' }] },
  ]

  /** The browser as each line lands and at fixed moments after, with frames `gap(k)` ms apart in between (0: none). */
  function pictures(gap: (k: number) => number): string[] {
    const scene = new Scene()
    let viz = emptyViz()
    let now = T
    let k = 0
    const out: string[] = []
    const draw = (at: number) => {
      const canvas = new BrailleCanvas(120, 30)
      scene.drawFrame(canvas, viz.ghost, at)
      out.push(JSON.stringify(canvas.runs()))
    }
    for (const line of LINES) {
      while (gap(k) > 0 && now + gap(k) < line.at) {
        now += gap(k++)
        scene.tick(now)
      }
      viz = feed(scene, [line], viz)
      if (line.t === 'graph' || line.t === 'diff' || line.t === 'touch') {
        draw(line.at)
        draw(line.at + 200)
      }
    }
    scene.tick(T + 60_000)
    draw(T + 60_000)
    return out
  }

  test('frames between lines never change what a line draws', () => {
    const none = pictures(() => 0)
    expect(new Set(none).size).toBeGreaterThan(4)
    expect(pictures(() => 33)).toEqual(none)
    expect(pictures(k => [7, 200, 33, 1, 64][k % 5]!)).toEqual(none)
  })
})

// A regression catch, not the guardrail: test files run in parallel, so timings here are noisy.
describe('frame budget', () => {
  test("a frame of a 2,000-node graph, on a hub's 1,000 links, draws in under 8 ms (median)", () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => `{"type":"T${i % 12}","id":"n${i}","data":{}}`)
    const edges = Array.from({ length: 3000 }, (_, i) => `{"edge":"E","id":"e${i}","from":"n${(i * 7919) % 2000}","to":"n${(i * 104729 + 1) % 2000}","data":{}}`)
    // n0 is a hub with 1,000 links, the costliest picture and column.
    const spokes = Array.from({ length: 1000 }, (_, i) => `{"edge":"H","id":"h${i}","from":"n0","to":"n${i + 1}","data":{}}`)
    const big = foldExport([...nodes, ...edges, ...spokes].join('\n'), {}, 2000)
    const { scene, viz } = loaded(big)
    scene.browse = { path: [{ column: { kind: 'links', node: 'T0:n0' }, selected: null }] }
    const canvas = new BrailleCanvas(100, 40)
    const times: number[] = []
    for (let f = 0; f < 40; f++) {
      const t0 = performance.now()
      canvas.clear()
      scene.drawFrame(canvas, viz.ghost, T + f * 33)
      canvas.runs()
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(8)
  })
})
