import { describe, expect, test } from 'claude-code/testing'

import { parseOutput, segmentOutput } from '../src/capture/parse-output'

const ok = (stdout: string) => parseOutput(stdout, '', false)

describe('human output', () => {
  test('read table', () => {
    const out = [
      '2 rows from branch main via ready',
      'slug       | title',
      '-----------+------------------',
      'iss-101    | Fix login',
      'iss-102    | Ship viz',
      '',
    ].join('\n')
    expect(ok(out)).toEqual({
      kind: 'read', queryName: 'ready', rowCount: 2, branch: 'main',
      columns: ['slug', 'title'], cells: [['iss-101', 'Fix login'], ['iss-102', 'Ship viz']],
    })
  })
  test('read with no rows and snapshot target', () => {
    expect(ok('0 rows from snapshot abc123 via gaps\n(no rows)\n')).toEqual({
      kind: 'read', queryName: 'gaps', rowCount: 0, snapshot: 'abc123', columns: [], cells: [],
    })
  })
  test('wrapped cells are joined back', () => {
    const out = ['1 rows via q', 'slug | body', '-----+-----', 'a    | hello', '     | world'].join('\n')
    expect(ok(out)).toMatchObject({ cells: [['a', 'helloworld']] })
  })
  test('truncated cells keep the ellipsis', () => {
    const out = ['1 rows via q', 'slug', '----', 'pat-sovereign-…'].join('\n')
    expect(ok(out)).toMatchObject({ columns: ['slug'], cells: [['pat-sovereign-…']] })
  })
  test('long tables keep the header count but cap cells at 200 rows', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `n-${i}`)
    const out = ['300 rows from branch main via all', 'slug', '----', ...rows].join('\n')
    const parsed = ok(out)
    expect(parsed).toMatchObject({ kind: 'read', rowCount: 300 })
    expect(parsed.kind === 'read' ? parsed.cells.length : 0).toBe(200)
  })
  test('CRLF output and non-ASCII cells', () => {
    const out = '1 rows from branch main via q\r\nname | note\r\n-----+-----\r\nZoë  | 🚀 ok\r\n'
    expect(ok(out)).toMatchObject({ columns: ['name', 'note'], cells: [['Zoë', '🚀 ok']] })
  })
  test('mutation', () => {
    expect(ok('changed main via create_issue: 1 nodes, 2 edges\nactor_id: act-x\n')).toEqual({
      kind: 'change', branch: 'main', queryName: 'create_issue', nodes: 1, edges: 2,
    })
  })
  test('branch outcomes', () => {
    expect(ok('created branch review from main')).toEqual({ kind: 'branch', action: 'created', name: 'review', from: 'main' })
    expect(ok('deleted branch review')).toEqual({ kind: 'branch', action: 'deleted', name: 'review' })
    expect(ok('merged review into main: fast_forward')).toEqual({
      kind: 'branch', action: 'merged', name: 'review', into: 'main', merge: 'fast_forward',
    })
  })
  test('load, with a branch created from main', () => {
    const out = 'loaded file://g.omni on branch feat with merge: 120 entities across 3 node types and 2 edge types\nbranch feat created from main\n'
    expect(ok(out)).toEqual({
      kind: 'load', branch: 'feat', mode: 'merge', total: 120, nodeTypes: 3, edgeTypes: 2, branchCreatedFrom: 'main',
    })
  })
  test('anything else is other with its first line', () => {
    expect(ok('\n  mutation add_comment($slug: String)\n    description: x\n')).toEqual({
      kind: 'other', firstLine: 'mutation add_comment($slug: String)',
    })
  })
})

describe('json output', () => {
  test('read envelope', () => {
    const out = JSON.stringify({
      query_name: 'ready', target: { branch: 'main' }, row_count: 1, columns: ['slug', 'n'],
      rows: [{ slug: 'a', n: 3 }], graph_commit_id: 'c1',
    }, null, 2)
    expect(ok(out)).toEqual({ kind: 'read', queryName: 'ready', rowCount: 1, branch: 'main', columns: ['slug', 'n'], cells: [['a', '3']] })
  })
  test('read jsonl: metadata first, then rows', () => {
    const out = `${JSON.stringify({ query_name: 'q', target: { branch: 'main' }, row_count: 2 })}\n{"slug":"a"}\n{"slug":"b"}\n`
    expect(ok(out)).toMatchObject({ kind: 'read', rowCount: 2, columns: ['slug'], cells: [['a'], ['b']] })
  })
  test('change, branch outcome, merge, load', () => {
    expect(ok(JSON.stringify({ branch: 'main', query_name: 'add', affected_nodes: 2, affected_edges: 1 }))).toEqual({
      kind: 'change', branch: 'main', queryName: 'add', nodes: 2, edges: 1,
    })
    expect(ok(JSON.stringify({ branch: 'main', query_name: '', affected_nodes: 0, affected_edges: 0, outcome: { kind: 'created', from: 'main', name: 'x' } }))).toEqual({
      kind: 'branch', action: 'created', name: 'x', from: 'main',
    })
    expect(ok(JSON.stringify({ source: 'x', target: 'main', outcome: 'merged', commit: null }))).toEqual({
      kind: 'branch', action: 'merged', name: 'x', into: 'main', merge: 'merged',
    })
    expect(ok(JSON.stringify({ uri: 'g', branch: 'main', mode: 'append', total_entities: 5, nodes: [{}], edges: [], branch_created: false }))).toEqual({
      kind: 'load', branch: 'main', mode: 'append', total: 5, nodeTypes: 1, edgeTypes: 0,
    })
  })
  test('a cut-off read envelope keeps its header facts', () => {
    const cut = '{\n  "query_name": "decision_questions",\n  "target": {\n    "branch": "main"\n  },\n  "row_count": 42,\n  "rows": [{"slug": "d-1", "tit'
    expect(ok(cut)).toEqual({ kind: 'read', queryName: 'decision_questions', rowCount: 42, branch: 'main', columns: [], cells: [] })
  })
  test('broken json falls back to human parsing', () => {
    expect(ok('{ not json\nchanged main via q: 1 nodes, 0 edges')).toMatchObject({ kind: 'change' })
  })
})

describe('errors', () => {
  test('error: line wins', () => {
    expect(parseOutput('', 'warning: x\nerror: unknown query `redy`\n', true)).toEqual({ kind: 'error', message: 'unknown query `redy`' })
  })
  test('else the last stderr line, else stdout', () => {
    expect(parseOutput('', 'boom\nExit code 2\n', true)).toEqual({ kind: 'error', message: 'Exit code 2' })
    expect(parseOutput('only stdout\n', '', true)).toEqual({ kind: 'error', message: 'only stdout' })
    expect(parseOutput('', '', true)).toEqual({ kind: 'error', message: 'command failed' })
  })
})

describe('segmentOutput', () => {
  test('one part per result line when counts match', () => {
    const out = '1 rows via a\nx\n-\n1\nchanged main via b: 1 nodes, 0 edges\n'
    expect(segmentOutput(out)).toEqual(['1 rows via a\nx\n-\n1\n', 'changed main via b: 1 nodes, 0 edges\n'])
  })
  test('output without any boundary is one segment', () => {
    expect(segmentOutput('noise')).toEqual(['noise'])
  })
})

// Real output of `omnigraph load … ; omnigraph snapshot …` in one Bash call (stderr merged, ANSI kept).
const LOAD_FAILED =
  'omnigraph load → graphs/dev.omni (direct, local)\nError: \n   0: \x1b[91mstorage: Invalid user input: Schema error: No field named versiontag.\x1b[0m\n\nLocation:\n   \x1b[35mcrates/omnigraph-cli/src/client.rs\x1b[0m:\x1b[35m725\x1b[0m\n\nBacktrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.\n'
const SNAPSHOT = 'graph_branch: main\ngraph_manifest_version: 3\ninternal_schema_version: 9\nedge type \'A\' published_dataset_version=2 native_dataset_branch=main entities=2\n'

describe('real CLI output', () => {
  test('an Error: block is an error even when the shell exit was 0', () => {
    expect(parseOutput(LOAD_FAILED, '', false)).toEqual({
      kind: 'error', message: 'storage: Invalid user input: Schema error: No field named versiontag.',
    })
  })
  test('the same block on a failed exit gives the same clean message', () => {
    expect(parseOutput(LOAD_FAILED, '', true)).toEqual({
      kind: 'error', message: 'storage: Invalid user input: Schema error: No field named versiontag.',
    })
  })
  test('the write echo line is never an outcome', () => {
    expect(ok('omnigraph schema → graphs/dev.omni (direct, local)\nschema applied\n')).toEqual({ kind: 'other', firstLine: 'schema applied' })
    expect(ok('omnigraph load → g.omni (served)\nloaded g.omni on branch main with merge: 3 entities across 1 node types and 0 edge types\n')).toMatchObject({ kind: 'load', total: 3 })
  })
  test('ANSI colors are stripped before parsing', () => {
    expect(ok('\x1b[1m1 rows via q\x1b[0m\nslug\n----\n\x1b[32ma\x1b[0m\n')).toMatchObject({ kind: 'read', cells: [['a']] })
  })
  test("tmux's sgr0 (ESC[m then SI) and other stray control characters are stripped", () => {
    expect(ok('\x1b[m\x0f2 rows from branch main via blocked\ni.slug | b.slug\n-------+-------\na      | b\nc      | d\n')).toMatchObject({
      kind: 'read', rowCount: 2, cells: [['a', 'b'], ['c', 'd']],
    })
  })
  test('charset picks, titles and other escapes a shell adds are stripped too', () => {
    // Recorded with Claude Code's sandbox off: every result began with ESC(B.
    expect(ok('\x1b(B2 rows from branch main via blocked\ni.slug | b.slug\n-------+-------\na      | b\nc      | d\n')).toMatchObject({
      kind: 'read', queryName: 'blocked', rowCount: 2, cells: [['a', 'b'], ['c', 'd']],
    })
    expect(ok('\x1b]0;omnigraph\x07\x1b[?25h\x1b=changed main via create_issue: 1 nodes, 0 edges\x1b(B\n')).toMatchObject({
      kind: 'change', nodes: 1, edges: 0,
    })
  })
  test('a recognized result wins over a stray error word', () => {
    expect(ok('changed main via note: 1 nodes, 0 edges\nError: \n   0: unrelated\n')).toMatchObject({ kind: 'change' })
  })
})

describe('segmentOutput on real output', () => {
  test('failed load then snapshot: echo starts the load, graph_branch starts the snapshot', () => {
    const [load, snap] = segmentOutput(LOAD_FAILED + SNAPSHOT)
    expect(parseOutput(load ?? '', '', false).kind).toBe('error')
    expect(parseOutput(snap ?? '', '', false)).toEqual({ kind: 'other', firstLine: 'graph_branch: main' })
  })
  test('an error then a read', () => {
    const parts = segmentOutput('Error: \n   0: unknown query `redy`\n1 rows via ready\nslug\n----\na\n')
    expect(parts.map(p => parseOutput(p, '', false).kind)).toEqual(['error', 'read'])
  })
  test('an echo followed by its own result stays one segment', () => {
    const out = 'omnigraph load → g (direct, local)\nloaded g on branch main with merge: 3 entities across 1 node types and 0 edge types\n1 rows via q\n'
    expect(segmentOutput(out).map(p => parseOutput(p, '', false).kind)).toEqual(['load', 'read'])
  })
})

describe('false failures', () => {
  test('an indented `error:` property in schema output is not a failure', () => {
    expect(ok('node Incident {\n    slug: String @key\n    error: String?\n}\n')).toEqual({ kind: 'other', firstLine: 'node Incident {' })
  })
  test('an indented `error:` line does not start a new segment', () => {
    expect(segmentOutput('1 rows via q\nslug | note\n-----+-----\na    | x\n  error: nested\n')).toHaveLength(1)
  })
})
