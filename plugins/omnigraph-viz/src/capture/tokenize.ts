import type { Invocation } from '../../types'
import { basename, expandHome, resolvePath } from '../util/path'

type Token = { kind: 'word'; value: string } | { kind: 'op'; value: string }

const WRAPPERS = new Set(['env', 'time', 'command', 'exec', 'nohup'])
/** Words that open a compound command's body: `do omnigraph …`, `then omnigraph …`. */
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{'])
/** `timeout` options that take a value. */
const TIMEOUT_VALUE_FLAGS = new Set(['-s', '-k', '--signal', '--kill-after'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * A small POSIX-ish lexer: quotes, escapes, comments, `&&` `||` `;` `|` `&`,
 * newlines and parentheses as separators, and redirections (`>`, `>>`, `<`,
 * `2>`, `2>&1`, `&>`), whose targets are dropped.
 */
export function lex(src: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let isInWord = false
  const flush = () => {
    if (isInWord) tokens.push({ kind: 'word', value: word })
    word = ''
    isInWord = false
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      const stop = end < 0 ? src.length : end
      word += src.slice(i + 1, stop)
      isInWord = true
      i = stop + 1
      continue
    }
    if (c === '"') {
      isInWord = true
      i++
      while (i < src.length && src[i] !== '"') {
        const next = src[i + 1]
        if (src[i] === '\\' && next !== undefined && '"\\$`'.includes(next)) {
          word += next
          i += 2
          continue
        }
        word += src[i]
        i++
      }
      i++
      continue
    }
    if (c === '\\') {
      const next = src[i + 1]
      if (next !== undefined && next !== '\n') {
        word += next
        isInWord = true
      }
      i += 2
      continue
    }
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (c === '#' && !isInWord) {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '\n' || c === ';' || c === '(' || c === ')') {
      flush()
      tokens.push({ kind: 'op', value: ';' })
      i++
      continue
    }
    if (c === '&' || c === '|') {
      flush()
      const two = src.slice(i, i + 2)
      if (two === '&&' || two === '||') {
        tokens.push({ kind: 'op', value: two })
        i += 2
        continue
      }
      if (two === '&>') {
        tokens.push({ kind: 'op', value: '>' })
        i += 2
        continue
      }
      tokens.push({ kind: 'op', value: c })
      i++
      continue
    }
    if (c === '>' || c === '<') {
      if (isInWord && /^\d+$/.test(word)) {
        word = ''
        isInWord = false
      } else {
        flush()
      }
      let j = i + 1
      if (src[j] === c) j++
      if (src[j] === '&') {
        j++
        while (j < src.length && /[\d-]/.test(src[j]!)) j++
        i = j
        continue
      }
      tokens.push({ kind: 'op', value: '>' })
      i = j
      continue
    }
    word += c
    isInWord = true
    i++
  }
  flush()
  return tokens
}

/**
 * Strips compound-command keywords (`do`, `then`, `{`, …), `VAR=x`, and the
 * `env`, `time`, `command`, `exec`, `nohup`, `timeout <duration>` wrappers;
 * undefined for `command -v x`.
 */
function stripPrefixes(words: string[]): string[] | undefined {
  let k = 0
  for (;;) {
    const word = words[k]
    if (word === undefined) break
    if (KEYWORDS.has(word) || ASSIGNMENT.test(word)) {
      k++
      continue
    }
    if (word === 'timeout') {
      k++
      while (words[k]?.startsWith('-')) k += TIMEOUT_VALUE_FLAGS.has(words[k]!) ? 2 : 1
      k++ // the duration
      continue
    }
    if (WRAPPERS.has(word)) {
      k++
      if (word === 'command' && (words[k] === '-v' || words[k] === '-V')) return undefined
      while (k < words.length && (ASSIGNMENT.test(words[k]!) || words[k]!.startsWith('-'))) k++
      continue
    }
    break
  }
  return words.slice(k)
}

/**
 * Every `omnigraph` invocation in a Bash command line, with the directory it
 * runs in (`cd` segments move it). `bin` is the configured binary; matching is
 * by basename, so `/usr/local/bin/omnigraph` matches `omnigraph`. With `home`,
 * `~` in `cd` targets and leading `~/` in arguments expand as the shell would.
 */
export function findInvocations(command: string, cwd: string, bin: string, home?: string): Invocation[] {
  const want = basename(bin)
  const found: Invocation[] = []
  let dir = cwd
  let words: string[] = []
  let isSkippingTarget = false

  const endSegment = () => {
    const segment = stripPrefixes(words)
    words = []
    if (!segment || segment.length === 0) return
    if (segment[0] === 'cd') {
      const to = segment[1]
      if (to !== undefined && to !== '-') dir = resolvePath(dir, to, home)
      return
    }
    if (basename(segment[0]!) === want) {
      // The shell expands a leading `~`: record what omnigraph actually received.
      found.push({ argv: segment.map(word => expandHome(word, home)), cwd: dir, index: found.length })
    }
  }

  for (const token of lex(command)) {
    if (token.kind === 'word') {
      if (isSkippingTarget) {
        isSkippingTarget = false
        continue
      }
      words.push(token.value)
      continue
    }
    if (token.value === '>') {
      isSkippingTarget = true
      continue
    }
    endSegment()
  }
  endSegment()
  return found
}
