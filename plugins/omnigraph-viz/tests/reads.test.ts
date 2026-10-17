import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../src/capture/classify'
import { parseOutput } from '../src/capture/parse-output'
import { buildMatchIndex, matchCells } from '../src/enrich/highlight'
import { foldExport, parseEdgeEnds } from '../src/graph/ghost'
import { CLI_OUTPUTS } from '../fixtures/cli-outputs'
import { EXPORT_JSONL, SCHEMA_SOURCE } from '../fixtures/dev-graph'

describe('reads plausible (B2 guardrail) on recorded agent reads against dev-graph', () => {
  test('≥ 80% of reads whose rows hold a node key light at least one node', () => {
    const index = buildMatchIndex(foldExport(EXPORT_JSONL, parseEdgeEnds(SCHEMA_SOURCE), 2000))
    const keys = index.byKey
    let withKeys = 0
    let lit = 0
    for (const f of CLI_OUTPUTS) {
      const intent = classify({ argv: f.argv, cwd: '/w', index: 0 })
      if (f.exit !== 0 || (intent.verb !== 'query' && intent.verb !== 'alias')) continue
      const o = parseOutput(f.stdout, '', false)
      if (o.kind !== 'read' || !o.cells.some(row => row.some(cell => keys.has(cell.trim())))) continue
      withKeys++
      if (matchCells(o.cells, index).nodeIds.length > 0) lit++
    }
    expect(withKeys).toBeGreaterThan(10)
    expect(lit / withKeys).toBeGreaterThanOrEqual(0.8)
  })
})
