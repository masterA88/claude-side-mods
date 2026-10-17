import { describe, expect, test } from 'claude-code/testing'

import { binCandidates, isPlainName, pathFromShell } from '../src/enrich/locate'

describe('locating omnigraph when Claude Code\'s PATH lacks it', () => {
  test('the usual install folders, home first', () => {
    expect(binCandidates('/Users/r', 'omnigraph')).toEqual([
      '/Users/r/.local/bin/omnigraph',
      '/Users/r/.cargo/bin/omnigraph',
      '/opt/homebrew/bin/omnigraph',
      '/usr/local/bin/omnigraph',
    ])
    expect(binCandidates(undefined, 'omnigraph')).toEqual(['/opt/homebrew/bin/omnigraph', '/usr/local/bin/omnigraph'])
  })
  test('the path a login shell prints, past any shell noise', () => {
    expect(pathFromShell('zsh: no job control in this shell\n/Users/r/.local/bin/omnigraph\n', 'omnigraph')).toBe('/Users/r/.local/bin/omnigraph')
    expect(pathFromShell('omnigraph: aliased to foo\n', 'omnigraph')).toBeUndefined()
    expect(pathFromShell('', 'omnigraph')).toBeUndefined()
  })
  test('only a plain command name is looked up through the shell', () => {
    expect([isPlainName('omnigraph'), isPlainName('og-1.2'), isPlainName('og; rm -rf ~'), isPlainName('/opt/og')]).toEqual([true, true, false, false])
  })
})
