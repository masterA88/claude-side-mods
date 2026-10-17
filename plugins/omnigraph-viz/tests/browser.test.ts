import { describe, expect, test } from 'claude-code/testing'

import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'
import { egoLayout } from '../src/browse/ego'
import type { EgoLayout } from '../src/browse/ego'
import { deeper, move, pathForNodes, TOP } from '../src/browse/model'
import type { Browse } from '../src/browse/model'
import { foldExport, parseEdgeEnds } from '../src/graph/ghost'
import { BrailleCanvas } from '../src/render/braille'
import { drawBrowser, layoutOf, pictureOf, regions } from '../src/render/browser'
import type { BrowserLook } from '../src/render/browser'

const DEV = foldExport(EXPORT_JSONL, parseEdgeEnds(SCHEMA_SOURCE), 2000)
const EPIC = 'Epic:epc-offline-sync'
const LOOK: BrowserLook = { colorOf: () => 0x7aa2f7, lit: new Set(), fresh: new Set(), isFollowing: false }

const star = (n: number, groups = 3) =>
  Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `neighbour number ${i}`, priority: 0, group: `g${i % groups}` }))

/** Every cell span a layout writes text into, by row: the centre, each dot + label (+ tag), each relation label. */
function spans(l: EgoLayout): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>()
  const add = (row: number, a: number, b: number) => out.set(row, [...(out.get(row) ?? []), [a, b]])
  add(l.centre.row, l.centre.col, l.centre.tagCol !== undefined ? l.centre.tagCol + 2 : l.centre.textCol + l.centre.text.length - 1)
  for (const n of l.nodes) {
    const ends = [n.col, n.textCol, n.textCol + n.text.length - 1, ...(n.tagCol !== undefined ? [n.tagCol + 2] : [])]
    add(n.row, Math.min(...ends), Math.max(...ends))
  }
  for (const g of l.labels) add(g.row, g.col, g.col + g.text.length - 1)
  if (l.more) add(l.more.row, l.more.col, l.more.col + l.more.text.length - 1)
  return out
}

function rows(b: Browse, look: BrowserLook = LOOK, cols = 83, height = 30) {
  const canvas = new BrailleCanvas(cols, height)
  drawBrowser(canvas, DEV, b, look)
  const runs = canvas.runs()
  return {
    lines: runs.map(r => r.map(x => x.t).join('')),
    selected: runs.map(r => r.filter(x => x.i).map(x => x.t).join('')).filter(Boolean),
  }
}

describe('ego layout', () => {
  test('the centre sits in the middle; labels never overlap and stay on the canvas', () => {
    for (const n of [1, 2, 5, 12, 30, 60]) {
      const l = egoLayout('Offline editing & sync', star(n), [{ key: 'g0', label: 'contains ×4' }], 83, 15, n % 2 === 0 ? 'NEW' : undefined)
      expect(l.centre.row).toBe(7)
      const width = l.centre.tagCol !== undefined ? l.centre.tagCol + 3 - l.centre.col : l.centre.text.length + 2
      expect(Math.abs(l.centre.col + width / 2 - 41.5)).toBeLessThan(2)
      for (const [row, list] of spans(l)) {
        expect(row >= 0 && row < 15).toBe(true)
        const sorted = [...list].sort((a, b) => a[0] - b[0])
        sorted.forEach(([a, b], i) => {
          expect(a >= 0 && b < 83).toBe(true)
          if (i > 0) expect(a).toBeGreaterThan(sorted[i - 1]![1])
        })
      }
      expect(l.nodes.length + l.hidden).toBe(n)
      // What didn't fit is counted where it covers nothing.
      if (l.hidden > 0) expect(l.more?.text).toBe(`+${l.hidden} more`)
    }
  })

  test('labels point away from the centre: right of their dot on the right, left of it on the left', () => {
    const l = egoLayout('c', star(8), [], 83, 15)
    for (const n of l.nodes) {
      if (n.side === 'right') expect(n.textCol).toBe(n.col + 2)
      else expect(n.textCol + n.text.length).toBe(n.col - 1)
    }
    expect(new Set(l.nodes.map(n => n.side))).toEqual(new Set(['left', 'right']))
  })

  test('when not all fit, the selected and lit ones keep their place', () => {
    const nodes = star(40).map((n, i) => (i === 37 ? { ...n, priority: 3 } : i === 39 ? { ...n, priority: 2 } : n))
    const l = egoLayout('c', nodes, [], 83, 8)
    expect(l.hidden).toBeGreaterThan(20)
    expect(l.nodes.map(n => n.id)).toEqual(expect.arrayContaining(['n37', 'n39']))
  })

  test('a relation keeps one arc: its members are neighbours in clockwise order', () => {
    const nodes = star(9, 3).sort((a, b) => a.group.localeCompare(b.group))
    const l = egoLayout('c', nodes, [], 83, 15)
    expect(l.nodes.map(n => n.id)).toEqual(nodes.map(n => n.id))
  })
})

describe('browser drawing', () => {
  test('short panes still show the selected row in every column', () => {
    let b = TOP
    for (let i = 0; i < 8; i++) b = move(b, DEV, 1)
    b = move(deeper(b, DEV), DEV, 2)
    for (const height of [8, 9, 10, 11, 13, 16]) {
      const { selected } = rows(b, LOOK, 83, height)
      // The picture's centre plus the two columns' selections.
      expect(selected.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('an empty graph says the type list is empty, not that it has no links', () => {
    const { lines } = rows(TOP, LOOK, 83, 30)
    expect(lines.join('\n')).not.toMatch(/\(empty\)/)
    const canvas = new BrailleCanvas(83, 30)
    drawBrowser(canvas, foldExport('', {}, 10), TOP, LOOK)
    expect(canvas.runs().map(r => r.map(x => x.t).join('')).join('\n')).toMatch(/^Types\s+│.*\n\(empty\)/m)
  })

  test('the top level: the breadcrumb, the type picked, its linked types around it, the type list', () => {
    const { lines, selected } = rows(TOP)
    expect(lines[0]).toMatch(/^Issue/)
    const picture = lines.slice(1, 1 + regions(30).pictureRows).join('\n')
    expect(picture).toMatch(/◉ Issue 18/)
    expect(picture).toMatch(/● Component 8|Component 8 ●/)
    expect(picture).toMatch(/owned by ×18/)
    expect(lines[regions(30).rule]).toMatch(/^─+$/)
    expect(lines[regions(30).columnsTop]).toMatch(/^Types\s+│Issue 18\s+│/)
    expect(selected[0]).toMatch(/^Issue 18$/)
    expect(selected[1]).toMatch(/^ {2}Issue\s+18$/)
  })

  test("a node's links: the node in the middle, the selected neighbour picked out in the picture and its column", () => {
    let b = TOP
    while (b.path[0]!.selected !== 'type:Epic') b = move(b, DEV, 1)
    b = move(deeper(move(deeper(b, DEV), DEV, 1), DEV), DEV, 2)
    const { lines, selected } = rows(b)
    // Too long for the row: cut from the left, so the latest step stays readable.
    expect(lines[0]).toBe('…c › Offline editing & sync › contains › Property test for offline replay ordering')
    const picture = lines.slice(1, 1 + regions(30).pictureRows).join('\n')
    expect(picture).toMatch(/◉ Offline editing & sync/)
    expect(picture).toMatch(/Nadia Okonkwo/)
    expect(picture).toMatch(/contains ×4/)
    expect(selected).toEqual(['Property test for off…', '  Offline editing & sync   ', '  Property test for offlin…'])
    // The last three columns: Epic's nodes, the epic's links, the selected issue's links (preview).
    expect(lines[regions(30).columnsTop]).toMatch(/^Epic 4\s+│Offline editing & sync\s+│Property test/)
  })

  test("the latest op's nodes are marked ▶ and new ones say NEW, in the picture and the columns", () => {
    const look = { ...LOOK, lit: new Set([EPIC, 'Issue:iss-offline-queue']), fresh: new Set(['Issue:iss-offline-queue']), isFollowing: true }
    const b: Browse = { path: [{ column: { kind: 'links', node: EPIC }, selected: null }] }
    const { lines } = rows(b, look)
    expect(lines[0]).toMatch(/● live$/)
    expect(lines.join('\n')).toMatch(/● Offline edit queue wi… NEW/)
    expect(lines.join('\n')).toMatch(/▶ Offline edit queue w… NEW/)
  })

  test('a wide read centres on the op, its results around it', () => {
    const ids = DEV.nodes.filter(n => n.type === 'Issue').slice(0, 6).map(n => n.id)
    const { lines } = rows(pathForNodes(DEV, ids, 'query ready')!)
    expect(lines[0]).toMatch(/^◆ query ready · 6 nodes/)
    const picture = lines.slice(1, 1 + regions(30).pictureRows).join('\n')
    expect(picture).toMatch(/◆ query ready · 6/)
    expect((picture.match(/●/g) ?? []).length).toBe(6)
  })

  test("a node with many relations names only five, the selected neighbour's first", () => {
    const sync = DEV.nodes.find(n => n.label === 'sync-core')!
    const storage = DEV.nodes.find(n => n.label === 'storage')!
    const pic = pictureOf(DEV, { kind: 'node', node: sync.id, selected: storage.id }, LOOK)!
    expect(pic.groups.length).toBeGreaterThan(5)
    const labels = layoutOf(pic, 83, 15).labels
    expect(labels.length).toBeLessThanOrEqual(5)
    expect(labels.map(l => l.group)).toContain(pic.nodes.find(n => n.node === storage.id)!.group)
  })

  test('a hub with more links than rows shows the most it can and says how many more', () => {
    const ravi = DEV.nodes.find(n => n.label === 'Ravi Menon')!
    const { lines } = rows({ path: [{ column: { kind: 'links', node: ravi.id }, selected: null }] }, LOOK, 83, 20)
    const picture = lines.slice(1, 1 + regions(20).pictureRows).join('\n')
    expect(picture).toMatch(/(^|  )\+\d+ more( {2}|$)/m)
  })
})
