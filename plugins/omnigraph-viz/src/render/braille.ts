/** Braille dot bits by [row 0..3][column 0..1] within a cell. */
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

export const LABEL_PRIO = 9

/**
 * Ranges a cell may hold: printable, one column wide, in the BMP
 * (Latin, Greek, Cyrillic, punctuation, arrows, box drawing, braille).
 * The engine refuses the whole tree over any other cell, which closes the pane.
 */
const CELL_RANGES: readonly [number, number][] = [
  [0x20, 0x7e], [0xa1, 0xac], [0xae, 0x24f], [0x370, 0x482], [0x48a, 0x52f],
  [0x2010, 0x2027], [0x2030, 0x205e], [0x2190, 0x21ff], [0x2500, 0x25ff], [0x2800, 0x28ff],
]

const isCellGlyph = (cp: number): boolean => CELL_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

/** Text a cell row can show: combining marks dropped, anything else unsafe as `?`; one cell per char. */
export function glyphSafe(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFC')) {
    if (/\p{M}/u.test(ch)) continue
    out += isCellGlyph(ch.codePointAt(0)!) ? ch : '?'
  }
  return out
}

/** Cell-safe text cut to `n` cells, with `…` when cut. */
export function fit(text: string, n: number): string {
  const safe = glyphSafe(text)
  if (n <= 0) return ''
  return safe.length <= n ? safe : `${safe.slice(0, n - 1)}…`
}

/** 3 bits per channel: at most 512 colors, inside the Raster's 1024 color pairs. */
export function quantize(rgb: number): number {
  const q = (v: number) => Math.round((Math.round((v / 255) * 7) * 255) / 7)
  return (q((rgb >> 16) & 0xff) << 16) | (q((rgb >> 8) & 0xff) << 8) | q(rgb & 0xff)
}

/**
 * A terminal cell grid drawn at braille resolution: each cell is 2×4 dots.
 * A cell takes the color of its highest-priority dot; text glyphs win over dots.
 */
export class BrailleCanvas {
  readonly width: number
  readonly height: number
  private readonly bits: Uint8Array
  private readonly color: Uint32Array
  private readonly prio: Uint8Array
  private readonly glyph: Uint32Array
  /** Cells drawn in reverse video: the browser's selection. */
  private readonly inv: Uint8Array
  /** Dots outside these dot rows are dropped (see `clip`). */
  private clipTop = 0
  private clipBottom = Infinity

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.width = cols * 2
    this.height = rows * 4
    const n = cols * rows
    this.bits = new Uint8Array(n)
    this.color = new Uint32Array(n)
    this.prio = new Uint8Array(n)
    this.glyph = new Uint32Array(n)
    this.inv = new Uint8Array(n)
  }

  clear(): void {
    this.bits.fill(0)
    this.color.fill(0)
    this.prio.fill(0)
    this.glyph.fill(0)
    this.inv.fill(0)
  }

  plot(x: number, y: number, rgb: number, prio: number): void {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height || py < this.clipTop || py > this.clipBottom) return
    const cell = (py >> 2) * this.cols + (px >> 1)
    this.bits[cell]! |= DOT_BITS[py & 3]![px & 1]!
    if (prio >= this.prio[cell]!) {
      this.prio[cell] = prio
      this.color[cell] = rgb
    }
  }

  /** Bresenham, clipped to the canvas; `every` > 1 draws a dotted line (every n-th dot). */
  line(x0: number, y0: number, x1: number, y1: number, rgb: number, prio: number, every = 1): void {
    // Liang–Barsky: a zoomed-in camera puts most edge ends far off the canvas.
    const ddx = x1 - x0
    const ddy = y1 - y0
    let t0 = 0
    let t1 = 1
    for (const [p, q] of [[-ddx, x0], [ddx, this.width - 1 - x0], [-ddy, y0], [ddy, this.height - 1 - y0]] as const) {
      if (p === 0) {
        if (q < 0) return
        continue
      }
      const r = q / p
      if (p < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
      if (t0 > t1) return
    }
    if (t1 < 1) {
      x1 = x0 + ddx * t1
      y1 = y0 + ddy * t1
    }
    if (t0 > 0) {
      x0 += ddx * t0
      y0 += ddy * t0
    }
    let ax = Math.round(x0)
    let ay = Math.round(y0)
    const bx = Math.round(x1)
    const by = Math.round(y1)
    const dx = Math.abs(bx - ax)
    const dy = -Math.abs(by - ay)
    const sx = ax < bx ? 1 : -1
    const sy = ay < by ? 1 : -1
    let err = dx + dy
    for (let guard = 0; guard < 4096; guard++) {
      if (guard % every === 0) this.plot(ax, ay, rgb, prio)
      if (ax === bx && ay === by) return
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        ax += sx
      }
      if (e2 <= dx) {
        err += dx
        ay += sy
      }
    }
  }

  disc(cx: number, cy: number, r: number, rgb: number, prio: number): void {
    const reach = Math.ceil(r)
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy <= r * r + r * 0.8) this.plot(cx + dx, cy + dy, rgb, prio)
      }
    }
  }

  ring(cx: number, cy: number, r: number, rgb: number, prio: number): void {
    const steps = Math.max(8, Math.ceil(2 * Math.PI * r * 1.5))
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI
      this.plot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rgb, prio)
    }
  }

  /** Keeps dots within cell rows `top`..`bottom` until the next call; no arguments: the whole canvas. */
  clip(top = 0, bottom = Infinity): void {
    this.clipTop = top * 4
    this.clipBottom = bottom === Infinity ? Infinity : bottom * 4 + 3
  }

  /** Plain glyphs from cell (col, row); they cover whatever dots are there. */
  text(col: number, row: number, s: string, rgb: number): void {
    if (row < 0 || row >= this.rows) return
    let c = col
    for (const ch of glyphSafe(s)) {
      if (c >= 0 && c < this.cols) {
        const cell = row * this.cols + c
        this.glyph[cell] = ch.codePointAt(0)!
        this.color[cell] = rgb
        this.prio[cell] = LABEL_PRIO
      }
      c++
    }
  }

  /** Reverse video for `width` cells of a row: how a selection shows. */
  invert(col: number, row: number, width: number): void {
    if (row < 0 || row >= this.rows) return
    for (let c = Math.max(0, col); c < Math.min(this.cols, col + width); c++) this.inv[row * this.cols + c] = 1
  }

  /**
   * The grid as rows of styled runs, for a `Client` to draw as `Text`: each run
   * one color (`#rrggbb`, absent for the default) and reverse video or not.
   */
  runs(): { t: string; c?: string; i?: true }[][] {
    const out: { t: string; c?: string; i?: true }[][] = []
    for (let r = 0; r < this.rows; r++) {
      const row: { t: string; c?: string; i?: true }[] = []
      for (let c = 0; c < this.cols; c++) {
        const cell = r * this.cols + c
        const glyph = this.glyph[cell]!
        const bits = this.bits[cell]!
        const ch = glyph !== 0 ? String.fromCharCode(glyph) : bits !== 0 ? String.fromCharCode(0x2800 | bits) : ' '
        const color = glyph === 0 && bits === 0 ? undefined : `#${quantize(this.color[cell]!).toString(16).padStart(6, '0')}`
        const isInv = this.inv[cell] === 1
        const last = row[row.length - 1]
        if (last && last.c === color && (last.i === true) === isInv) last.t += ch
        else row.push({ t: ch, ...(color ? { c: color } : {}), ...(isInv ? { i: true as const } : {}) })
      }
      // Trailing blanks carry nothing.
      const tail = row[row.length - 1]
      if (tail && !tail.c && !tail.i) {
        tail.t = tail.t.trimEnd()
        if (tail.t === '') row.pop()
      }
      out.push(row)
    }
    return out
  }
}
