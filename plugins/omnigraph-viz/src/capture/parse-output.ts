import type { MergeKind, OpOutcome } from '../../types'

// Human formats from crates/omnigraph-cli/src/output.rs and read_format.rs.
const READ_HEADER = /^(\d+) rows(?: from (branch|snapshot) (\S+))? via (\S+)$/m
const CHANGE = /^changed (\S+) via (\S+): (\d+) nodes, (\d+) edges$/m
const BRANCH_CREATED = /^created branch (\S+) from (\S+)$/m
const BRANCH_DELETED = /^deleted branch (\S+)$/m
const BRANCH_MERGED = /^merged (\S+) into (\S+): (already_up_to_date|fast_forward|merged)$/m
const LOADED =
  /^loaded (\S+) on branch (\S+) with (\w+): (\d+) entities across (\d+) node types and (\d+) edge types$/m
const LOAD_BRANCH = /^branch (\S+) created from (\S+)$/m
/** `snapshot`'s human output starts with this line. */
const SNAPSHOT_HEAD = /^graph_branch: \S+$/

/** The target echo a write prints on stderr; Claude's Bash merges it into stdout. */
const TARGET_ECHO = /^omnigraph \S+ → .+ \((?:direct|served)[^)]*\)$/
/**
 * clap's `error: …` and color-eyre's `Error:` (message on the next line, as `   0: …`).
 * Both print at column 0; an indented `error:` is data (a schema property, a cell).
 */
const ERROR_START = /^error:/i
/**
 * Terminal escapes a shell can wrap output in: CSI (colors, `ESC[?25h`), OSC
 * (titles, links), charset picks such as `ESC(B` (what `tput sgr0` prints;
 * seen before every result when Claude Code's sandbox is off) and the other
 * two-byte escapes.
 */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]+[0-~]|[0-~])/g

/** The first line of any result the CLI prints; used to split multi-invocation output. */
const RESULT_LINE = new RegExp(
  [READ_HEADER, CHANGE, BRANCH_CREATED, BRANCH_DELETED, BRANCH_MERGED, LOADED, SNAPSHOT_HEAD]
    .map(re => re.source)
    .join('|'),
)

export const MAX_ROWS = 200

type Json = Record<string, unknown>

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function lastLine(text: string): string | undefined {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1]
}

function firstLine(text: string): string {
  return (text.split('\n').find(l => l.trim() !== '') ?? '').trim().slice(0, 200)
}

/** As read_format.rs `stringify_value` prints a cell. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Control characters left after the escapes (tmux's sgr0 ends with SI); tabs and line breaks stay. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '')
}

/** No colors, no CRLF, no target echo lines. */
function clean(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !TARGET_ECHO.test(line))
    .join('\n')
}

/** The message of the first error block in `text`, if there is one. */
function errorIn(text: string): string | undefined {
  const lines = text.split('\n')
  const at = lines.findIndex(line => ERROR_START.test(line))
  if (at < 0) return undefined
  const inline = lines[at]!.replace(/^error:\s*/i, '').trim()
  if (inline !== '') return inline.slice(0, 200)
  const next = lines.slice(at + 1).find(line => line.trim() !== '')
  return next?.trim().replace(/^\d+:\s*/, '').slice(0, 200)
}

function errorMessage(stdout: string, stderr: string): string {
  return (errorIn(stderr) ?? errorIn(stdout) ?? lastLine(stderr) ?? lastLine(stdout) ?? 'command failed').slice(0, 200)
}

function parseTable(text: string, m: RegExpMatchArray): OpOutcome {
  const where =
    m[2] === 'branch' ? { branch: m[3]! } : m[2] === 'snapshot' ? { snapshot: m[3]! } : {}
  const base = { kind: 'read' as const, queryName: m[4]!, rowCount: Number(m[1]), ...where }
  const lines = text.slice((m.index ?? 0) + m[0].length).split('\n').slice(1)
  const head = lines[0]
  if (head === undefined || head.trim() === '' || head.trim() === '(no rows)') {
    return { ...base, columns: [], cells: [] }
  }
  const columns = head.split(' | ').map(c => c.trim())
  const firstRow = /^[-+]+$/.test(lines[1]?.trim() ?? '') ? 2 : 1
  const cells: string[][] = []
  for (const line of lines.slice(firstRow)) {
    if (line.trim() === '') break
    const parts = line.split(' | ')
    if (parts.length !== columns.length) break
    const row = parts.map(c => c.trimEnd())
    const prev = cells[cells.length - 1]
    // Wrap layout: a continuation line repeats the row with blanks where nothing wrapped.
    if (prev && row[0] === '' && row.some(c => c !== '')) {
      row.forEach((c, i) => {
        prev[i] = `${prev[i] ?? ''}${c}`
      })
      continue
    }
    if (cells.length >= MAX_ROWS) break
    cells.push(row)
  }
  return { ...base, columns, cells }
}

function parseJsonish(text: string): unknown[] | undefined {
  try {
    return [JSON.parse(text)]
  } catch {
    // maybe JSONL: metadata first, then one row per line
  }
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      return undefined
    }
  }
  return out.length > 0 ? out : undefined
}

function parseJson(text: string): OpOutcome | undefined {
  const values = parseJsonish(text)
  const head = values?.[0]
  if (!values || !isRecord(head)) return undefined

  if ('row_count' in head || 'rows' in head) {
    const rows = Array.isArray(head.rows) ? head.rows : values.slice(1)
    const first = rows[0]
    const columns = Array.isArray(head.columns)
      ? head.columns.filter((c): c is string => typeof c === 'string')
      : isRecord(first)
        ? Object.keys(first)
        : []
    const target = isRecord(head.target) ? head.target : {}
    const branch = str(target.branch)
    const snapshot = str(target.snapshot)
    return {
      kind: 'read',
      queryName: str(head.query_name) ?? '',
      rowCount: num(head.row_count) ?? rows.length,
      ...(branch !== undefined ? { branch } : {}),
      ...(snapshot !== undefined ? { snapshot } : {}),
      columns,
      cells: rows.slice(0, MAX_ROWS).map(r => columns.map(c => cellText(isRecord(r) ? r[c] : undefined))),
    }
  }

  const outcome = head.outcome
  if (isRecord(outcome) && typeof outcome.kind === 'string') {
    if (outcome.kind === 'created') {
      return { kind: 'branch', action: 'created', name: str(outcome.name) ?? '', from: str(outcome.from) ?? '' }
    }
    if (outcome.kind === 'deleted') return { kind: 'branch', action: 'deleted', name: str(outcome.name) ?? '' }
    if (outcome.kind === 'merged') {
      return {
        kind: 'branch', action: 'merged', name: str(outcome.source) ?? '',
        into: str(outcome.target) ?? '', merge: (str(outcome.merge) ?? 'merged') as MergeKind,
      }
    }
  }
  if ('affected_nodes' in head) {
    return {
      kind: 'change', branch: str(head.branch) ?? '', queryName: str(head.query_name) ?? '',
      nodes: num(head.affected_nodes) ?? 0, edges: num(head.affected_edges) ?? 0,
    }
  }
  if (typeof head.source === 'string' && typeof head.target === 'string' && typeof outcome === 'string') {
    return { kind: 'branch', action: 'merged', name: head.source, into: head.target, merge: outcome as MergeKind }
  }
  if ('total_entities' in head) {
    const base = str(head.base_branch)
    return {
      kind: 'load', branch: str(head.branch) ?? '', mode: str(head.mode) ?? '',
      total: num(head.total_entities) ?? 0,
      nodeTypes: Array.isArray(head.nodes) ? head.nodes.length : 0,
      edgeTypes: Array.isArray(head.edges) ? head.edges.length : 0,
      ...(head.branch_created === true && base !== undefined ? { branchCreatedFrom: base } : {}),
    }
  }
  return { kind: 'other', firstLine: firstLine(text) }
}

/** A read envelope cut off mid-way (long output gets truncated): keep the header facts. */
function parseCutJson(text: string): OpOutcome | undefined {
  const queryName = text.match(/"query_name"\s*:\s*"([^"]*)"/)?.[1]
  const rowCount = text.match(/"row_count"\s*:\s*(\d+)/)?.[1]
  if (queryName === undefined || rowCount === undefined) return undefined
  const branch = text.match(/"branch"\s*:\s*"([^"]*)"/)?.[1]
  return {
    kind: 'read', queryName, rowCount: Number(rowCount),
    ...(branch !== undefined ? { branch } : {}),
    columns: [], cells: [],
  }
}

export function parseOutput(stdout: string, stderr: string, isError: boolean): OpOutcome {
  const text = clean(stdout)
  const errors = clean(stderr)
  if (isError) return { kind: 'error', message: errorMessage(text, errors) }
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const fromJson = parseJson(trimmed) ?? parseCutJson(trimmed)
    if (fromJson) return fromJson
  }
  let m = text.match(READ_HEADER)
  if (m) return parseTable(text, m)
  if ((m = text.match(CHANGE))) {
    return { kind: 'change', branch: m[1]!, queryName: m[2]!, nodes: Number(m[3]), edges: Number(m[4]) }
  }
  if ((m = text.match(BRANCH_CREATED))) return { kind: 'branch', action: 'created', name: m[1]!, from: m[2]! }
  if ((m = text.match(BRANCH_DELETED))) return { kind: 'branch', action: 'deleted', name: m[1]! }
  if ((m = text.match(BRANCH_MERGED))) {
    return { kind: 'branch', action: 'merged', name: m[1]!, into: m[2]!, merge: m[3] as MergeKind }
  }
  if ((m = text.match(LOADED))) {
    const created = text.match(LOAD_BRANCH)
    return {
      kind: 'load', branch: m[2]!, mode: m[3]!, total: Number(m[4]),
      nodeTypes: Number(m[5]), edgeTypes: Number(m[6]),
      ...(created ? { branchCreatedFrom: created[2]! } : {}),
    }
  }
  // No result line, but an error block: a failure the shell's exit status hid (`a ; b`).
  const failure = errorIn(text) ?? errorIn(errors)
  if (failure !== undefined) return { kind: 'error', message: failure }
  return { kind: 'other', firstLine: firstLine(trimmed) }
}

type Boundary = 'echo' | 'result' | 'error'

function boundaryOf(line: string): Boundary | undefined {
  if (TARGET_ECHO.test(line)) return 'echo'
  if (RESULT_LINE.test(line)) return 'result'
  if (ERROR_START.test(line)) return 'error'
  return undefined
}

/**
 * Cuts one command's stdout into the outputs of the omnigraph calls in it.
 * A call's output starts at a write's target echo, a result line or an error
 * block; a result or error right after an echo belongs to that echo. Lines
 * before the first boundary join the first segment; no boundary, one segment.
 */
export function segmentOutput(stdout: string): string[] {
  const lines = stripAnsi(stdout).replace(/\r\n/g, '\n').split('\n')
  const starts: number[] = []
  let isEchoOpen = false
  lines.forEach((line, i) => {
    const boundary = boundaryOf(line)
    if (boundary === undefined) return
    if (boundary !== 'echo' && isEchoOpen) {
      isEchoOpen = false
      return
    }
    starts.push(i)
    isEchoOpen = boundary === 'echo'
  })
  if (starts.length === 0) return [stdout]
  starts[0] = 0
  return starts.map((start, k) => {
    const end = starts[k + 1] ?? lines.length
    return lines.slice(start, end).join('\n') + (end < lines.length ? '\n' : '')
  })
}
