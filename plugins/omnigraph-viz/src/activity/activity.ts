// Fork: the session's own activity as a graph, so the browser has something to follow without the omnigraph CLI.
// Claude is one node; each agent, each tool and each file touched is another; links say who spawned, used or touched
// what. Every builder here returns ledger lines, so live activity takes the same path as omnigraph operations.
import type { EntityChange, GhostGraph, LedgerLine, OpEvent, Target, Verb } from '../../types'

export const ACTIVITY_TARGET: Target = { graph: 'this session' }
export const CLAUDE_KEY = 'claude'

const EDGE_ENDS: Record<string, [string, string]> = {
  spawned: ['Claude', 'Agent'],
  'spawned sub': ['Agent', 'Agent'],
  uses: ['Claude', 'Tool'],
  'agent uses': ['Agent', 'Tool'],
  touches: ['Claude', 'File'],
  'agent touches': ['Agent', 'File'],
}

const FILE_KEYS = ['file_path', 'notebook_path', 'path'] as const
const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path'] as const

export function seedGraph(): GhostGraph {
  return {
    nodes: [{ id: `Claude:${CLAUDE_KEY}`, type: 'Claude', key: CLAUDE_KEY, label: 'Claude' }],
    edges: [],
    truncated: false,
    edgeEnds: EDGE_ENDS,
  }
}

export function graphLine(at: number, cwd: string): LedgerLine {
  return { v: 1, t: 'graph', at, target: ACTIVITY_TARGET, cwd, graph: seedGraph() }
}

const short = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, width - 1)}…`)

const tidy = (text: string) => text.replace(/^\/Users\/[^/]+/, '~').replace(/\s+/g, ' ').trim()

export function detailOf(input: Record<string, unknown>): string {
  for (const key of DETAIL_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) return tidy(v)
  }
  return ''
}

export function fileOf(tool: string, input: Record<string, unknown>): string | null {
  if (tool === 'Bash' || tool === 'Agent') return null
  for (const key of FILE_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.startsWith('/')) return v
  }
  return null
}

export function verbOf(tool: string): Verb {
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|ToolSearch)$/.test(tool)) return 'query'
  if (/^(Edit|Write|NotebookEdit)$/.test(tool)) return 'mutate'
  if (tool === 'Agent') return 'branch'
  return 'other'
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

/** The start of one tool call, as the Feed lists it: `query  Explore:Read   ~/…/README.md`. */
export function startLine(at: number, id: string, tool: string, who: string, detail: string, cwd: string, agentId?: string): LedgerLine {
  const op: OpEvent = {
    id,
    startedAt: at,
    intent: {
      verb: verbOf(tool),
      sub: tool,
      queryName: short(`${who}:${tool.replace(/^mcp__[^_]+__/, '')}`, 18),
      isInline: false,
      target: ACTIVITY_TARGET,
      isJson: false,
      argv: [tool, detail],
      cwd,
    },
    status: 'running',
    ...(agentId ? { agentId } : {}),
  }
  return { v: 1, t: 'op.start', at, op }
}

export function endLine(at: number, id: string, startedAt: number, isError: boolean, detail: string): LedgerLine {
  return {
    v: 1,
    t: 'op.end',
    at,
    id,
    status: isError ? 'error' : 'ok',
    durationMs: Math.max(0, at - startedAt),
    outcome: isError ? { kind: 'error', message: short(detail || 'failed', 80) } : { kind: 'other', firstLine: short(detail, 80) },
    output: '',
  }
}

/** The nodes and links one finished tool call adds: its tool, and the file it touched. */
export function callDiff(at: number, opId: string, tool: string, agentId: string | undefined, file: string | null): LedgerLine {
  const actor = agentId ?? CLAUDE_KEY
  const isAgent = agentId !== undefined
  const toolKey = tool.replace(/^mcp__[^_]+__/, '')
  const changes: EntityChange[] = [{ kind: 'node', type: 'Tool', id: toolKey, op: 'insert', label: toolKey }]
  const uses = isAgent ? 'agent uses' : 'uses'
  changes.push({ kind: 'edge', type: uses, id: `${uses}:${actor}>${toolKey}`, op: 'insert', from: actor, to: toolKey })
  if (file) {
    const touches = isAgent ? 'agent touches' : 'touches'
    changes.push({ kind: 'node', type: 'File', id: file, op: 'insert', label: baseName(file) })
    changes.push({ kind: 'edge', type: touches, id: `${touches}:${actor}>${file}`, op: 'insert', from: actor, to: file })
  }
  return { v: 1, t: 'diff', at, opId, commitId: opId, changes, more: 0 }
}

/** A new agent, linked from Claude or from the agent that spawned it. */
export function spawnDiff(at: number, opId: string, agentId: string, label: string, parentId: string | undefined): LedgerLine {
  const edge = parentId ? 'spawned sub' : 'spawned'
  const from = parentId ?? CLAUDE_KEY
  return {
    v: 1,
    t: 'diff',
    at,
    opId,
    commitId: opId,
    changes: [
      { kind: 'node', type: 'Agent', id: agentId, op: 'insert', label: short(label, 28) },
      { kind: 'edge', type: edge, id: `${edge}:${from}>${agentId}`, op: 'insert', from, to: agentId },
    ],
    more: 0,
  }
}
