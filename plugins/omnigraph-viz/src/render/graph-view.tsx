import type { Elements } from 'claude-code'

import type { OpEvent, ViewState } from '../../types'
import { formatOpLine } from './format'

type El = Elements['terminal']

/** Rows besides the browser: header, tabs and a 3-line mini-feed. */
export const GRAPH_CHROME_ROWS = 5
export const MIN_BROWSER_ROWS = 8

export const browserRowsFor = (bodyRows: number): number => Math.max(MIN_BROWSER_ROWS, bodyRows - GRAPH_CHROME_ROWS)

export interface GraphViewData {
  ghost: ViewState['ghost']
  columns: number
  rows: number
  /** The browser as styled rows, for its `Client` to draw (it takes the keys); null until the graph is ready. */
  runs: { t: string; c?: string; i?: true }[][] | null
  /** Whether a key has taken the browser off the live ops. */
  isBrowsing: boolean
  recent: OpEvent[]
}

function status(ghost: ViewState['ghost']): string {
  if (ghost.state === 'loading') return 'Loading the graph…'
  if (ghost.state === 'failed') return `Couldn't load the graph: ${ghost.message ?? 'unknown error'}`
  return 'Waiting for omnigraph operations… the graph appears after the first command that names a graph.'
}

export function drawGraphTab(el: El, data: GraphViewData) {
  const { Box, Text, Client } = el
  return (
    <Box key="graph" flexDirection="column">
      {data.ghost.state === 'ready' && data.runs !== null ? (
        <Client key="explore" module="../../hooks/explore.tsx" props={{ rows: data.runs }} width={data.columns} height={data.rows} />
      ) : (
        <Text dimColor>{status(data.ghost)}</Text>
      )}
      {data.ghost.truncated && <Text dimColor>(largest {data.ghost.nodes} nodes)</Text>}
      <Box key="mini-feed" flexDirection="column">
        {data.recent.slice(-3).map(op => (
          <Text dimColor>{formatOpLine(op, Math.max(20, data.columns - 2))}</Text>
        ))}
      </Box>
    </Box>
  )
}
