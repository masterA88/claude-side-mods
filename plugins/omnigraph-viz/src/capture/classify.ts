import type { Invocation, OpIntent, Target, Verb } from '../../types'
import { basename } from '../util/path'

const VERBS: Readonly<Record<string, Verb>> = {
  query: 'query', read: 'query',
  mutate: 'mutate', change: 'mutate',
  alias: 'alias',
  load: 'load', ingest: 'load',
  branch: 'branch', commit: 'commit', changes: 'changes',
  snapshot: 'snapshot', export: 'export', schema: 'schema',
  queries: 'queries', lint: 'lint',
}

const HAS_SUBCOMMAND = new Set<Verb>(['branch', 'commit', 'changes', 'schema', 'queries'])

/** Flags that take a value (from crates/omnigraph-cli/src/cli.rs). */
const VALUE_FLAGS = new Set([
  '--server', '--graph', '--store', '--profile', '--cluster', '--as',
  '--query', '--query-string', '-e', '--params', '--params-file',
  '--branch', '--snapshot', '--set', '--format', '--if-commit',
  '--data', '--mode', '--from', '--into', '--type', '--kind', '--op',
  '--limit', '--page-token', '--uri', '--start', '--cursor', '--out',
  '--config', '--rev', '--schema',
])

const TARGET_FLAGS = ['server', 'graph', 'store', 'profile', 'cluster'] as const

export interface ParsedArgs {
  flags: Map<string, string>
  switches: Set<string>
  positionals: string[]
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=')
      const name = arg.slice(0, eq)
      if (!flags.has(name)) flags.set(name, arg.slice(eq + 1))
      continue
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1]
      if (value !== undefined) {
        if (!flags.has(arg)) flags.set(arg, value)
        i++
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      switches.add(arg)
      continue
    }
    positionals.push(arg)
  }
  return { flags, switches, positionals }
}

function targetOf(verb: Verb, sub: string | undefined, parsed: ParsedArgs): Target {
  const target: Target = {}
  for (const name of TARGET_FLAGS) {
    const value = parsed.flags.get(`--${name}`)
    if (value !== undefined) target[name] = value
  }
  const { positionals } = parsed
  const uri =
    parsed.flags.get('--uri') ??
    (verb === 'load' || verb === 'snapshot' || verb === 'export'
      ? positionals[1]
      : verb === 'schema' || (verb === 'commit' && sub === 'list')
        ? positionals[2]
        : undefined)
  if (uri !== undefined) target.uri = uri
  return target
}

function inlineQueryName(gq: string): string | undefined {
  if (/^\s*explain\b/.test(gq)) return 'explain'
  return gq.match(/\bquery\s+(\w+)/)?.[1]
}

export function classify(inv: Invocation): OpIntent {
  const parsed = parseArgs(inv.argv.slice(1))
  const { flags, switches, positionals } = parsed
  let verb: Verb = VERBS[positionals[0] ?? ''] ?? 'other'
  let sub = HAS_SUBCOMMAND.has(verb) ? positionals[1] : undefined
  const gq = flags.get('-e') ?? flags.get('--query-string')
  const queryFile = flags.get('--query')
  let queryName: string | undefined

  if (verb === 'query' || verb === 'mutate') {
    const statement = gq?.match(/^\s*branch\s+(create|delete|merge|list)\b/)
    if (statement) {
      verb = 'branch'
      sub = statement[1]
    } else {
      queryName =
        positionals[1] ??
        (gq !== undefined ? inlineQueryName(gq) : undefined) ??
        (queryFile !== undefined ? basename(queryFile).replace(/\.gq$/, '') : undefined)
    }
  } else if (verb === 'alias') {
    queryName = positionals[1]
  }

  const format = flags.get('--format')
  const intent: OpIntent = {
    verb,
    isInline: gq !== undefined || queryFile !== undefined,
    target: targetOf(verb, sub, parsed),
    isJson: switches.has('--json') || format === 'json' || format === 'jsonl',
    argv: inv.argv,
    cwd: inv.cwd,
  }
  if (sub !== undefined) intent.sub = sub
  if (queryName !== undefined) intent.queryName = queryName
  const branch = flags.get('--branch') ?? flags.get('--into')
  if (branch !== undefined) intent.branch = branch
  return intent
}
