import { describe, expect, mock, test } from 'claude-code/testing'

import {
  commitChangesArgv, commitListArgv, exportArgv, parseChanges, parseCommits, pickCommit, schemaArgv, schemaSourceOf, targetKey,
} from '../src/enrich/cli'
import { buildMatchIndex, matchCells } from '../src/enrich/highlight'
import { JobQueue } from '../src/enrich/queue'
import { foldExport } from '../src/graph/ghost'

describe('cli argv', () => {
  test('a local store passes --store; a uri goes where each command wants it', () => {
    const store = { store: 'graphs/dev.omni' }
    expect(exportArgv('omnigraph', store)).toEqual(['omnigraph', 'export', '--store', 'graphs/dev.omni'])
    expect(schemaArgv('og', { uri: 'g.omni' })).toEqual(['og', 'schema', 'show', 'g.omni', '--json'])
    expect(commitListArgv('og', { uri: 'g.omni' }, 'main')).toEqual(['og', 'commit', 'list', 'g.omni', '--branch', 'main', '--json'])
    expect(commitChangesArgv('og', { uri: 'g.omni' }, 'c1')).toEqual(['og', 'commit', 'changes', 'c1', '--uri', 'g.omni', '--json'])
  })
  test('served graphs pass their flags through', () => {
    expect(exportArgv('og', { server: 'http://h:8080', graph: 'dev', profile: 'p' })).toEqual([
      'og', 'export', '--server', 'http://h:8080', '--graph', 'dev', '--profile', 'p',
    ])
  })
  test('targetKey tells graphs apart, including by directory', () => {
    expect(targetKey({ store: 'g' }, '/a')).not.toBe(targetKey({ store: 'g' }, '/b'))
    expect(targetKey({ store: 'g' }, '/a')).toBe(targetKey({ store: 'g' }, '/a'))
    expect(targetKey({ graph: 'dev' }, '/a')).not.toBe(targetKey({ graph: 'dev' }, '/b'))
  })
  test('targetKey sees one store through any relative path', () => {
    expect(targetKey({ store: 'graphs/dev.omni' }, '/w/dev')).toBe(targetKey({ store: 'dev/graphs/dev.omni' }, '/w'))
    expect(targetKey({ uri: 'g.omni' }, '/w')).toBe(targetKey({ uri: '/w/g.omni' }, '/elsewhere'))
    expect(targetKey({ store: 's3://b/g' }, '/a')).toBe(targetKey({ store: 's3://b/g' }, '/b'))
  })
})

describe('cli output', () => {
  test('schema source', () => {
    expect(schemaSourceOf('{"schema_source":"node A {}"}')).toBe('node A {}')
    expect(schemaSourceOf('nope')).toBeUndefined()
  })
  test('commits newest first; pick the newest made after the op started', () => {
    const commits = parseCommits(JSON.stringify({ commits: [
      { graph_commit_id: 'new', created_at: 10_000_000_000 },
      { graph_commit_id: 'old', created_at: 1_000_000_000 },
    ] }))
    expect(commits.map(c => c.id)).toEqual(['new', 'old'])
    expect(pickCommit(commits, 9_000_000, 10_000_000)).toBe('new')
    expect(pickCommit(commits, 99_000_000, 99_000_100)).toBeUndefined()
  })
  test('chained writes: the oldest unconsumed commit inside the op window', () => {
    const commits = parseCommits(JSON.stringify({ commits: [
      { graph_commit_id: 'c-b', created_at: 5_000_200_000 },
      { graph_commit_id: 'c-a', created_at: 5_000_100_000 },
      { graph_commit_id: 'c-later', created_at: 9_000_000_000 },
    ] }))
    expect(pickCommit(commits, 5_000_000, 5_000_300)).toBe('c-a')
    expect(pickCommit(commits, 5_000_000, 5_000_300, new Set(['c-a']))).toBe('c-b')
    expect(pickCommit(commits, 5_000_000, 5_000_300, new Set(['c-a', 'c-b']))).toBeUndefined()
    expect(parseCommits('garbage')).toEqual([])
  })
  test('changes: nodes, edges with endpoints, labels; capped at 500', () => {
    const node = { kind: 'node', type: { id: 't', name: 'Issue' }, id: 'i1', op: 'insert', after: { properties: { title: 'One', slug: 'i1' } } }
    const edge = { kind: 'edge', type: { id: 'u', name: 'EpicContainsIssue' }, id: 'e1', op: 'delete', before: { properties: {}, endpoints: { from: 'ep', to: 'i1' } } }
    expect(parseChanges(JSON.stringify({ changes: [node, edge] }))).toEqual({
      changes: [
        { kind: 'node', type: 'Issue', id: 'i1', op: 'insert', label: 'One' },
        { kind: 'edge', type: 'EpicContainsIssue', id: 'e1', op: 'delete', from: 'ep', to: 'i1' },
      ],
      more: 0,
    })
    const many = parseChanges(JSON.stringify({ changes: Array.from({ length: 505 }, () => node) }))
    expect([many.changes.length, many.more]).toEqual([500, 5])
  })
})

describe('JobQueue', () => {
  test('runs jobs one at a time in order and keeps going after a failure', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const log: string[] = []
    const errors: unknown[] = []
    const q = new JobQueue(async () => clock.now(), err => void errors.push(err))
    q.push({ at: 0, run: async () => void log.push('a') })
    q.push({ at: 0, run: async () => { throw new Error('boom') } })
    q.push({ at: 0, run: async () => void log.push('c') })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(log).toEqual(['a', 'c'])
    expect(errors).toHaveLength(1)
    expect(q.size).toBe(0)
  })
  test('drops jobs that waited too long', async () => {
    let now = 0
    const log: string[] = []
    const q = new JobQueue(async () => now, () => undefined, 1000)
    q.push({ at: 0, run: async () => { now = 5000; log.push('slow') } })
    q.push({ at: 0, run: async () => void log.push('stale') })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(log).toEqual(['slow'])
  })
})

describe('matchCells', () => {
  const graph = foldExport([
    '{"type":"Issue","id":"iss-101","data":{"title":"Fix login"}}',
    '{"type":"Issue","id":"iss-102","data":{"title":"Ship the viz mod"}}',
    '{"type":"Epic","id":"epc-sync","data":{"title":"Offline sync"}}',
  ].join('\n'), {}, 10)
  const index = buildMatchIndex(graph)
  test('cells equal to a key or a label match', () => {
    expect(matchCells([['iss-101', 'whatever'], ['x', 'Offline sync']], index)).toEqual({ nodeIds: ['Issue:iss-101', 'Epic:epc-sync'], isExact: false })
  })
  test('a truncated cell matches one unique prefix', () => {
    expect(matchCells([['Ship the vi…']], index).nodeIds).toEqual(['Issue:iss-102'])
    expect(matchCells([['iss-10…']], index).nodeIds).toEqual([])
  })
  test('@id cells are exact', () => {
    expect(matchCells([['{"@id":"iss-102","title":"Ship the viz mod"}']], index)).toEqual({ nodeIds: ['Issue:iss-102'], isExact: true })
  })
  test('numbers, booleans, null and short cells never match', () => {
    const tiny = foldExport('{"type":"N","id":"42","data":{"title":"true"}}\n{"type":"N","id":"ab","data":{}}', {}, 10)
    expect(matchCells([['42', 'true', 'null', 'ab']], buildMatchIndex(tiny)).nodeIds).toEqual([])
  })
  test('at most 50 nodes', () => {
    const big = foldExport(Array.from({ length: 80 }, (_, i) => `{"type":"N","id":"node-${i}","data":{}}`).join('\n'), {}, 100)
    expect(matchCells([Array.from({ length: 80 }, (_, i) => `node-${i}`)], buildMatchIndex(big)).nodeIds).toHaveLength(50)
  })
})
