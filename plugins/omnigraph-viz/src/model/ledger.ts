import { resolvePath } from '../util/path'
import type { LedgerLine } from '../../types'

/** The `$` calls the writer needs, bound to whichever hook is appending. */
export interface LedgerIO {
  write: (path: string, text: string) => Promise<void>
  onError?: (err: unknown) => void
}

export function encodeLedger(lines: readonly LedgerLine[]): string {
  return lines.map(line => `${JSON.stringify(line)}\n`).join('')
}

function isLedgerLine(v: unknown): v is LedgerLine {
  if (typeof v !== 'object' || v === null) return false
  const { v: version, t } = v as { v?: unknown; t?: unknown }
  return version === 1 && typeof t === 'string'
}

/** Parses a ledger; a cut-off last line (a crash mid-write) is dropped silently. */
export function decodeLedger(text: string): { lines: LedgerLine[]; errors: string[] } {
  const raw = text.split('\n')
  let last = raw.length - 1
  while (last >= 0 && raw[last]!.trim() === '') last--
  const lines: LedgerLine[] = []
  const errors: string[] = []
  raw.forEach((row, i) => {
    if (row.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(row)
    } catch {
      if (i !== last) errors.push(`line ${i + 1}: not JSON`)
      return
    }
    if (isLedgerLine(value)) lines.push(value)
    else errors.push(`line ${i + 1}: not a v1 ledger line`)
  })
  return { lines, errors }
}

export function ledgerFileName(nowMs: number): string {
  const d = new Date(nowMs)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-` +
    `${pad(d.getUTCMilliseconds(), 3)}.jsonl`
  )
}

/** Absolute: `$.fs` resolves relative paths against the process, not the session. */
export function ledgerPathFor(cwd: string, ledgerDir: string, nowMs: number): string {
  return resolvePath(cwd, `${ledgerDir.replace(/\/+$/, '')}/${ledgerFileName(nowMs)}`)
}

/**
 * Keeps every line in memory and writes through: each append rewrites the
 * file, and appends made while a write is in flight ride on the next one. No
 * timer, so a hot reload (which cancels pending waits) loses nothing.
 */
export class LedgerWriter {
  readonly lines: LedgerLine[] = []
  private isDirty = false
  private isWriting = false

  constructor(
    readonly path: string,
    initial: readonly LedgerLine[] = [],
  ) {
    this.lines.push(...initial)
  }

  append(line: LedgerLine, io: LedgerIO): void {
    this.lines.push(line)
    this.isDirty = true
    if (!this.isWriting) void this.drain(io)
  }

  private async drain(io: LedgerIO): Promise<void> {
    this.isWriting = true
    try {
      while (this.isDirty) {
        this.isDirty = false
        try {
          await io.write(this.path, encodeLedger(this.lines))
        } catch (err) {
          io.onError?.(err)
        }
      }
    } finally {
      this.isWriting = false
    }
  }
}
