import type { Elements } from 'claude-code'

import type { Tab, UiState, ViewState } from '../../types'
import { formatArgv, formatOpLine, headerText } from './format'
import { drawGraphTab } from './graph-view'
import type { GraphViewData } from './graph-view'

type El = Elements['terminal']

export interface PaneData {
  view: ViewState
  ui: UiState
  columns: number
  rows: number
  /** The selected op's output, from module memory: `$.state` carries no raw output. */
  selectedOutput?: string
  /** The Graph tab's browser, when that tab is shown. */
  graph?: GraphViewData
}

export interface PaneActions {
  setTab: (tab: Tab) => void
  select: (opId: string) => void
}

/** Rows the header, tab bar and detail box take besides the op list. */
const CHROME_ROWS = 3
const DETAIL_ROWS = 14

function drawFeed(el: El, data: PaneData, act: PaneActions) {
  const { Box, Text, Button, Code } = el
  const ops = data.view.recentOps
  if (ops.length === 0) {
    return (
      <Text dimColor>
        Waiting for omnigraph operations…
      </Text>
    )
  }
  const selected = ops.find(op => op.id === data.ui.selectedOpId)
  const room = Math.max(3, data.rows - CHROME_ROWS - (selected ? DETAIL_ROWS : 0))
  const shown = ops.slice(-room)
  return (
    <Box key="feed" flexDirection="column">
      {/* Plain Buttons: each op is a visible line the focus ring walks; Enter shows its details. */}
      {shown.map(op => (
        <Button
          key={`op:${op.id}`}
          plain
          label={formatOpLine(op, data.columns - 2)}
          dimColor={selected !== undefined && op.id !== selected.id}
          onPress={() => act.select(op.id)}
        />
      ))}
      {selected && (
        <Box key="detail" flexDirection="column" borderStyle="single" borderColor="gray">
          <Code language="bash" source={formatArgv(selected.intent.argv)} wrap="wrap" />
          <Code source={data.selectedOutput ?? '(running…)'} wrap="truncate-end" />
        </Box>
      )}
    </Box>
  )
}

export function drawPane(el: El, data: PaneData, act: PaneActions) {
  const { Box, Text, Button } = el
  const tab = data.ui.tab === 'feed' ? 'feed' : 'graph'
  return (
    <Box flexDirection="column" width={data.columns}>
      <Text bold wrap="truncate-end">
        {headerText(data.view, data.columns)}
      </Text>
      <Box key="tabs" gap={1}>
        <Button key="tab-graph" label="Graph" hotkey="g" dimColor={tab !== 'graph'} onPress={() => act.setTab('graph')} />
        <Button key="tab-feed" label="Feed" hotkey="f" dimColor={tab !== 'feed'} onPress={() => act.setTab('feed')} />
        <Text dimColor wrap="truncate-end">
          {tab === 'graph'
            ? data.graph?.isBrowsing
              ? 'browsing · ↑↓ select · → open · ← back · l follow live'
              : 'following ops · click the graph to browse with ↑↓←→'
            : 'enter: details · esc: back to the prompt'}
        </Text>
      </Box>
      {tab === 'feed' || !data.graph ? drawFeed(el, data, act) : drawGraphTab(el, data.graph)}
    </Box>
  )
}
