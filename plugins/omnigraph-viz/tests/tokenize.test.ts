import { describe, expect, test } from 'claude-code/testing'

import { findInvocations, lex } from '../src/capture/tokenize'

const find = (command: string, bin = 'omnigraph') =>
  findInvocations(command, '/work', bin).map(i => ({ argv: i.argv, cwd: i.cwd }))

describe('lex', () => {
  test('quotes, escapes and operators', () => {
    expect(lex(`a 'b c' "d \\"e\\"" f\\ g && h || i; j | k & l`)).toEqual([
      { kind: 'word', value: 'a' },
      { kind: 'word', value: 'b c' },
      { kind: 'word', value: 'd "e"' },
      { kind: 'word', value: 'f g' },
      { kind: 'op', value: '&&' },
      { kind: 'word', value: 'h' },
      { kind: 'op', value: '||' },
      { kind: 'word', value: 'i' },
      { kind: 'op', value: ';' },
      { kind: 'word', value: 'j' },
      { kind: 'op', value: '|' },
      { kind: 'word', value: 'k' },
      { kind: 'op', value: '&' },
      { kind: 'word', value: 'l' },
    ])
  })
  test('redirections drop their target and 2>&1 vanishes', () => {
    expect(lex('a > out.txt 2>&1')).toEqual([
      { kind: 'word', value: 'a' },
      { kind: 'op', value: '>' },
      { kind: 'word', value: 'out.txt' },
    ])
  })
  test('empty quotes are an empty word', () => {
    expect(lex(`a ''`)).toEqual([
      { kind: 'word', value: 'a' },
      { kind: 'word', value: '' },
    ])
  })
})

describe('findInvocations', () => {
  const cases: [string, string, { argv: string[]; cwd: string }[]][] = [
    ['plain', 'omnigraph query ready', [{ argv: ['omnigraph', 'query', 'ready'], cwd: '/work' }]],
    ['absolute binary', '/usr/local/bin/omnigraph alias ready', [{ argv: ['/usr/local/bin/omnigraph', 'alias', 'ready'], cwd: '/work' }]],
    ['cd then run', 'cd dev-graph && omnigraph query ready', [{ argv: ['omnigraph', 'query', 'ready'], cwd: '/work/dev-graph' }]],
    ['cd .. then run', 'cd ../x && omnigraph lint', [{ argv: ['omnigraph', 'lint'], cwd: '/x' }]],
    ['cd absolute', 'cd /srv/g; omnigraph snapshot', [{ argv: ['omnigraph', 'snapshot'], cwd: '/srv/g' }]],
    ['two invocations', 'omnigraph query a && omnigraph query b', [
      { argv: ['omnigraph', 'query', 'a'], cwd: '/work' },
      { argv: ['omnigraph', 'query', 'b'], cwd: '/work' },
    ]],
    ['piped to jq', 'omnigraph query a --json | jq .rows', [{ argv: ['omnigraph', 'query', 'a', '--json'], cwd: '/work' }]],
    ['piped from echo', 'echo x | omnigraph load --data - --mode merge', [{ argv: ['omnigraph', 'load', '--data', '-', '--mode', 'merge'], cwd: '/work' }]],
    ['env prefix', 'RUST_LOG=info omnigraph query a', [{ argv: ['omnigraph', 'query', 'a'], cwd: '/work' }]],
    ['env wrapper', 'env A=1 B=2 omnigraph query a', [{ argv: ['omnigraph', 'query', 'a'], cwd: '/work' }]],
    ['time wrapper', 'time omnigraph query a', [{ argv: ['omnigraph', 'query', 'a'], cwd: '/work' }]],
    ['single-quoted params', `omnigraph mutate add --params '{"slug":"a b"}'`, [{ argv: ['omnigraph', 'mutate', 'add', '--params', '{"slug":"a b"}'], cwd: '/work' }]],
    ['multi-line inline GQ', "omnigraph query -e 'query q() {\n  match { $p: Person }\n  return { $p.name }\n}'", [
      { argv: ['omnigraph', 'query', '-e', 'query q() {\n  match { $p: Person }\n  return { $p.name }\n}'], cwd: '/work' },
    ]],
    ['redirect to file', 'omnigraph export > dump.jsonl', [{ argv: ['omnigraph', 'export'], cwd: '/work' }]],
    ['stderr merged', 'omnigraph query a 2>&1 | head', [{ argv: ['omnigraph', 'query', 'a'], cwd: '/work' }]],
    ['subshell', '(cd g && omnigraph lint)', [{ argv: ['omnigraph', 'lint'], cwd: '/work/g' }]],
    ['newline separated', 'cd g\nomnigraph query a', [{ argv: ['omnigraph', 'query', 'a'], cwd: '/work/g' }]],
    ['comment ignored', 'omnigraph query a # omnigraph query b', [{ argv: ['omnigraph', 'query', 'a'], cwd: '/work' }]],
    ['mention only: cat', 'cat omnigraph.yaml', []],
    ['mention only: grep', 'grep -r omnigraph src', []],
    ['which', 'which omnigraph', []],
    ['command -v', 'command -v omnigraph', []],
    ['different binary name', 'omnigraph-server --cluster .', []],
    ['custom bin', 'og query a', [{ argv: ['og', 'query', 'a'], cwd: '/work' }]],
    ['cd home is kept as written', 'cd ~/g && omnigraph lint', [{ argv: ['omnigraph', 'lint'], cwd: '~/g' }]],
  ]
  for (const [name, command, expected] of cases) {
    test(name, () => {
      expect(find(command, name === 'custom bin' ? '/opt/og' : 'omnigraph')).toEqual(expected)
    })
  }
  test('invocation indexes count omnigraph calls only', () => {
    expect(findInvocations('ls && omnigraph a && pwd && omnigraph b', '/w', 'omnigraph').map(i => i.index)).toEqual([0, 1])
  })
})

describe('compound commands', () => {
  test('a for loop body', () => {
    expect(find('for q in a b; do omnigraph query $q; done')).toEqual([{ argv: ['omnigraph', 'query', '$q'], cwd: '/work' }])
  })
  test('if / then / else', () => {
    expect(find('if omnigraph query a; then omnigraph mutate b; else omnigraph lint; fi').map(i => i.argv[1])).toEqual(['query', 'mutate', 'lint'])
  })
  test('while and until loops', () => {
    expect(find('while true; do omnigraph lint; done; until false; do omnigraph snapshot; done').map(i => i.argv[1])).toEqual(['lint', 'snapshot'])
  })
  test('a brace group and negation', () => {
    expect(find('{ omnigraph query a; } && ! omnigraph lint').map(i => i.argv[1])).toEqual(['query', 'lint'])
  })
  test('timeout with flags and a duration', () => {
    expect(find('timeout -k 5 30s omnigraph query a').map(i => i.argv)).toEqual([['omnigraph', 'query', 'a']])
  })
})

describe('~ expansion (with HOME known)', () => {
  const withHome = (command: string) => findInvocations(command, '/work', 'omnigraph', '/Users/r').map(i => ({ argv: i.argv, cwd: i.cwd }))
  test('cd ~ and cd ~/dir', () => {
    expect(withHome('cd ~ && omnigraph lint')).toEqual([{ argv: ['omnigraph', 'lint'], cwd: '/Users/r' }])
    expect(withHome('cd ~/og-demo && omnigraph lint')).toEqual([{ argv: ['omnigraph', 'lint'], cwd: '/Users/r/og-demo' }])
  })
  test('unquoted ~/… arguments expand; ~user and mid-word ~ do not', () => {
    expect(withHome('omnigraph export --store ~/g.omni x~y ~bob/g')).toEqual([
      { argv: ['omnigraph', 'export', '--store', '/Users/r/g.omni', 'x~y', '~bob/g'], cwd: '/work' },
    ])
  })
})

