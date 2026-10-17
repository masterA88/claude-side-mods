import { describe, expect, test } from 'claude-code/testing'

import { assignColors, dim, hash32, mix, PALETTE } from '../src/graph/palette'
import { BrailleCanvas, glyphSafe, quantize } from '../src/render/braille'

/** The canvas as plain text, one string per row. */
const text = (c: BrailleCanvas) => c.runs().map(r => r.map(x => x.t).join(''))

describe('palette', () => {
  test('hash is stable FNV-1a', () => {
    expect(hash32('')).toBe(0x811c9dc5)
    expect(hash32('Issue')).toBe(hash32('Issue'))
  })
  test('the first 12 types get distinct colors, in a stable way', () => {
    const types = ['Issue', 'Epic', 'PR', 'Actor', 'Component', 'Repo', 'Release', 'Incident', 'Decision', 'Spec', 'Comment', 'Commit']
    const a = assignColors(types)
    expect(new Set(a.values()).size).toBe(12)
    expect(assignColors(types)).toEqual(a)
    expect(assignColors([...types, 'Extra']).get('Extra')).toBe(PALETTE[hash32('Extra') % 12])
  })
  test('mix and dim', () => {
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080)
    expect(mix(0x102030, 0x405060, 0)).toBe(0x102030)
    expect(dim(0x808080, 0.5)).toBe(0x404040)
  })
})

describe('BrailleCanvas', () => {
  test('a dot sets its bit and color; empty cells carry nothing', () => {
    const c = new BrailleCanvas(3, 1)
    c.plot(1, 3, 0xff0000, 1) // column 1 of cell 0, bottom row → 0x80
    expect(c.runs()).toEqual([[{ t: '\u2880', c: '#ff0000' }]])
  })
  test('the highest-priority dot colors the cell', () => {
    const c = new BrailleCanvas(1, 1)
    c.plot(0, 0, 0x0000ff, 1)
    c.plot(1, 1, 0x00ff00, 3)
    c.plot(0, 2, 0xff0000, 2)
    expect(c.runs()[0]![0]!.c).toBe(`#${quantize(0x00ff00).toString(16).padStart(6, '0')}`)
  })
  test('lines connect their ends; out-of-bounds dots are dropped', () => {
    const c = new BrailleCanvas(4, 1)
    c.line(0, 0, 7, 3, 0xffffff, 1)
    c.plot(-1, 0, 0xffffff, 1)
    c.plot(100, 100, 0xffffff, 1)
    expect([...text(c)[0]!].every(ch => ch.charCodeAt(0) >= 0x2801 && ch.charCodeAt(0) <= 0x28ff)).toBe(true)
  })
  test('text covers dots', () => {
    const c = new BrailleCanvas(4, 1)
    c.disc(3, 2, 2, 0x00ff00, 2)
    c.text(1, 0, 'ab', 0xffffff)
    expect(text(c)[0]!.slice(1, 3)).toBe('ab')
  })
  test('a clip keeps dots inside its rows', () => {
    const c = new BrailleCanvas(2, 3)
    c.clip(1, 1)
    c.line(0, 0, 3, 11, 0xffffff, 1)
    c.clip()
    expect(text(c).map(r => r.trim() !== '')).toEqual([false, true, false])
  })
  test('reverse video marks the cells it covers', () => {
    const c = new BrailleCanvas(6, 1)
    c.text(0, 0, 'abcdef', 0xffffff)
    c.invert(2, 0, 2)
    expect(c.runs()[0]!.map(r => [r.t, r.i === true])).toEqual([['ab', false], ['cd', true], ['ef', false]])
  })
  test('quantized colors stay within 512', () => {
    const seen = new Set<number>()
    for (let v = 0; v < 0x1000000; v += 0x010203) seen.add(quantize(v))
    expect(seen.size).toBeLessThanOrEqual(512)
  })
})

describe('glyph safety (a cell must hold one printable, width-1 BMP character)', () => {
  test('emoji, CJK, controls and combining marks never reach a cell', () => {
    expect(glyphSafe('🐛 Fix login')).toBe('? Fix login')
    expect(glyphSafe('修复登录')).toBe('????')
    expect(glyphSafe('a\tb\u0007')).toBe('a?b?')
    expect(glyphSafe('cafe\u0301 Δ Ж …')).toBe('café Δ Ж …') // NFC composes é: one cell
    expect(glyphSafe('x\u20dd')).toBe('x') // a mark with no composed form is dropped
  })
  test('text() only writes safe glyphs, one cell per character', () => {
    const c = new BrailleCanvas(8, 1)
    c.text(0, 0, '🐛修\tok', 0xffffff)
    expect(text(c)[0]).toBe('???ok')
  })
})
