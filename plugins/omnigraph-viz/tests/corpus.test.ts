import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../src/capture/classify'
import { parseOutput } from '../src/capture/parse-output'
import { CLI_OUTPUTS } from '../fixtures/cli-outputs'
import type { OpOutcome, Verb } from '../types'

/** What a recorded call should parse to, for the verbs the Feed cares most about. */
const EXPECTED: Partial<Record<Verb, OpOutcome['kind'][]>> = {
  query: ['read'],
  alias: ['read'],
  mutate: ['change', 'branch'],
  load: ['load'],
}

describe('recorded agent runs', () => {
  test('every fixture classifies and parses without throwing', () => {
    for (const f of CLI_OUTPUTS) {
      const intent = classify({ argv: f.argv, cwd: '/w', index: 0 })
      parseOutput(f.stdout, '', f.exit !== 0)
      expect(intent.argv).toBe(f.argv)
    }
  })

  test('≥ 95% of successful query/alias/mutate/load calls are recognized', () => {
    const misses: string[] = []
    let total = 0
    for (const f of CLI_OUTPUTS) {
      if (f.exit !== 0) continue
      const intent = classify({ argv: f.argv, cwd: '/w', index: 0 })
      const want = EXPECTED[intent.verb]
      if (!want) continue
      total++
      const got = parseOutput(f.stdout, '', false)
      if (!want.includes(got.kind)) misses.push(`${f.argv.slice(0, 4).join(' ')} → ${got.kind}: ${f.stdout.slice(0, 80)}`)
    }
    expect(total).toBeGreaterThan(100)
    if (misses.length / total > 0.05) throw new Error(`${misses.length}/${total} missed:\n${misses.slice(0, 15).join('\n')}`)
  })

  test('failed calls are errors', () => {
    for (const f of CLI_OUTPUTS.filter(f => f.exit !== 0)) {
      expect(parseOutput(f.stdout, '', true).kind).toBe('error')
    }
  })
})
