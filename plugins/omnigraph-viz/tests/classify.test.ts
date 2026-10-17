import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../src/capture/classify'

const intent = (args: string[], cwd = '/work') => classify({ argv: ['omnigraph', ...args], cwd, index: 0 })

describe('classify', () => {
  test('stored read with global flags anywhere', () => {
    expect(intent(['query', 'ready', '--server', 'http://127.0.0.1:8080', '--graph', 'dev', '--branch', 'main'])).toEqual({
      verb: 'query',
      queryName: 'ready',
      isInline: false,
      branch: 'main',
      target: { server: 'http://127.0.0.1:8080', graph: 'dev' },
      isJson: false,
      argv: ['omnigraph', 'query', 'ready', '--server', 'http://127.0.0.1:8080', '--graph', 'dev', '--branch', 'main'],
      cwd: '/work',
    })
  })
  test('read alias and --format json', () => {
    const i = intent(['read', 'q', '--format', 'json'])
    expect([i.verb, i.queryName, i.isJson]).toEqual(['query', 'q', true])
  })
  test('change alias and --flag=value', () => {
    const i = intent(['change', 'create_issue', '--params={"slug":"x"}', '--graph=dev', '--json'])
    expect([i.verb, i.queryName, i.target, i.isJson]).toEqual(['mutate', 'create_issue', { graph: 'dev' }, true])
  })
  test('inline GQ names the query', () => {
    const i = intent(['query', '-e', 'query engineers($t: String) { match { $p: Person } return { $p.name } }'])
    expect([i.verb, i.queryName, i.isInline]).toEqual(['query', 'engineers', true])
  })
  test('inline explain', () => {
    expect(intent(['query', '-e', 'explain query q() { match { $p: P } return { $p } }']).queryName).toBe('explain')
  })
  test('query file names the query when no name is given', () => {
    expect(intent(['query', '--query', 'queries/ready.gq']).queryName).toBe('ready')
  })
  test('inline branch statement becomes a branch op', () => {
    const i = intent(['mutate', '-e', 'branch create "review" from main'])
    expect([i.verb, i.sub, i.queryName]).toEqual(['branch', 'create', undefined])
  })
  test('alias', () => {
    const i = intent(['alias', 'incident-cause', 'inc-presence-leak'])
    expect([i.verb, i.queryName]).toEqual(['alias', 'incident-cause'])
  })
  test('load with positional uri', () => {
    const i = intent(['load', '--data', 'seed.jsonl', '--mode', 'overwrite', 'graphs/dev.omni'])
    expect([i.verb, i.target]).toEqual(['load', { uri: 'graphs/dev.omni' }])
  })
  test('ingest is load', () => {
    expect(intent(['ingest', '--data', 'x.jsonl']).verb).toBe('load')
  })
  test('branch merge targets --into', () => {
    const i = intent(['branch', 'merge', 'review', '--into', 'main'])
    expect([i.verb, i.sub, i.branch]).toEqual(['branch', 'merge', 'main'])
  })
  test('commit list positional uri, commit changes --uri', () => {
    expect(intent(['commit', 'list', 'graphs/dev.omni']).target).toEqual({ uri: 'graphs/dev.omni' })
    expect(intent(['commit', 'changes', 'abc', '--uri', 'g.omni']).target).toEqual({ uri: 'g.omni' })
  })
  test('schema show uri', () => {
    const i = intent(['schema', 'show', 'g.omni', '--json'])
    expect([i.verb, i.sub, i.target, i.isJson]).toEqual(['schema', 'show', { uri: 'g.omni' }, true])
  })
  test('cluster flag value and store', () => {
    expect(intent(['queries', 'list', '--cluster', '.', '--graph', 'dev']).target).toEqual({ cluster: '.', graph: 'dev' })
    expect(intent(['snapshot', '--store', 's3://b/g']).target).toEqual({ store: 's3://b/g' })
  })
  test('unknown verb is other', () => {
    expect(intent(['cluster', 'apply', '--config', '.']).verb).toBe('other')
    expect(intent([]).verb).toBe('other')
  })
})
