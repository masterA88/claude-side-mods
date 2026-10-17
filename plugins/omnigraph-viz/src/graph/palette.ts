/** 12 type colors that read well on a dark terminal (Tokyo Night family). */
export const PALETTE = [
  0x7aa2f7, 0xbb9af7, 0x9ece6a, 0xe0af68, 0xf7768e, 0x7dcfff,
  0xff9e64, 0x73daca, 0xc0caf5, 0x2ac3de, 0xd4b8ff, 0xb9f27c,
] as const

/** The Omnigraph brand accent. */
export const ACCENT = 0x0044ff
/** The accent lifted toward white: the latest op's ring, readable on a dark terminal (#0044ff alone is not). */
export const ACCENT_RING = 0x5c8aff
export const EDGE = 0x3b4261
export const WHITE = 0xffffff
export const DELETE = 0xff5f5f

/** FNV-1a, 32-bit: stable across runs and machines. */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * A color per type: `hash % 12`, moving to the next free slot on a
 * collision, in the order given. Past 12 types, colors repeat by hash.
 */
export function assignColors(types: readonly string[]): Map<string, number> {
  const colors = new Map<string, number>()
  const used = new Set<number>()
  for (const type of types) {
    if (colors.has(type)) continue
    let slot = hash32(type) % PALETTE.length
    if (used.size < PALETTE.length) {
      while (used.has(slot)) slot = (slot + 1) % PALETTE.length
      used.add(slot)
    }
    colors.set(type, PALETTE[slot]!)
  }
  return colors
}

const channels = (rgb: number): [number, number, number] => [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff]
const pack = (r: number, g: number, b: number): number =>
  (Math.round(Math.max(0, Math.min(255, r))) << 16) | (Math.round(Math.max(0, Math.min(255, g))) << 8) | Math.round(Math.max(0, Math.min(255, b)))

/** `a` at t=0 to `b` at t=1. */
export function mix(a: number, b: number, t: number): number {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  const k = Math.max(0, Math.min(1, t))
  return pack(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k)
}

/** Scales brightness: 0 is black, 1 the color itself. */
export function dim(rgb: number, factor: number): number {
  const [r, g, b] = channels(rgb)
  return pack(r * factor, g * factor, b * factor)
}
