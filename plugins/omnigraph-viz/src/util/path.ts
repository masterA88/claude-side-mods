export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function normalizePath(p: string): string {
  const isAbsolute = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!isAbsolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  if (isAbsolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/** `~` and `~/…` as the shell expands them, given HOME; `~user` and the rest stay as written. */
export function expandHome(p: string, home: string | undefined): string {
  if (home === undefined) return p
  if (p === '~') return normalizePath(home)
  if (p.startsWith('~/')) return normalizePath(`${home}/${p.slice(2)}`)
  return p
}

/** Resolves `p` against `cwd`, expanding `~` when HOME is known (else `~` paths stay as written). */
export function resolvePath(cwd: string, p: string, home?: string): string {
  p = expandHome(p, home)
  if (p.startsWith('~')) return p
  if (p.startsWith('/')) return normalizePath(p)
  return normalizePath(`${cwd}/${p}`)
}
