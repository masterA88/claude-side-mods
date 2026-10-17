import { lex } from '../capture/tokenize'

export type OgCommand =
  | { kind: 'toggle' }
  | { kind: 'clear' }
  | { kind: 'stop' }
  | { kind: 'replay'; path: string; speed: number }
  | { kind: 'usage'; message: string }

export const OG_HINT = '[replay <ledger.jsonl> [speed] | stop | clear]'

const USAGE = 'Usage: /og (toggle the pane) · /og replay <ledger.jsonl> [speed] · /og stop · /og clear'

/** `/og`'s arguments: `replay <path> [speed]` (speed like 2, 2x or 0.5), `stop`, `clear`, or nothing. */
export function parseOgArgs(args: string): OgCommand {
  const words = lex(args).flatMap(t => (t.kind === 'word' ? [t.value] : []))
  const [verb, ...rest] = words
  if (verb === undefined) return { kind: 'toggle' }
  if (verb === 'clear' && rest.length === 0) return { kind: 'clear' }
  if (verb === 'stop' && rest.length === 0) return { kind: 'stop' }
  if (verb !== 'replay') return { kind: 'usage', message: USAGE }
  const [path, speedArg, ...extra] = rest
  if (path === undefined || extra.length > 0) return { kind: 'usage', message: USAGE }
  if (speedArg === undefined) return { kind: 'replay', path, speed: 1 }
  const speed = Number(speedArg.replace(/[x×]$/i, ''))
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 20) {
    return { kind: 'usage', message: `Speed must be a number from 0.1 to 20 (got ${speedArg}).` }
  }
  return { kind: 'replay', path, speed }
}
