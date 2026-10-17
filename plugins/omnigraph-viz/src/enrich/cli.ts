import type { EntityChange, Target } from '../../types'
import { resolvePath } from '../util/path'

/** Global flags that choose the graph, passed through as the agent gave them. */
export function targetFlags(t: Target): string[] {
  const flags: string[] = []
  for (const name of ['server', 'graph', 'store', 'profile', 'cluster'] as const) {
    const value = t[name]
    if (value !== undefined) flags.push(`--${name}`, value)
  }
  return flags
}

const uri = (t: Target): string[] => (t.uri !== undefined ? [t.uri] : [])

export const schemaArgv = (bin: string, t: Target): string[] => [bin, 'schema', 'show', ...uri(t), '--json', ...targetFlags(t)]

export const exportArgv = (bin: string, t: Target): string[] => [bin, 'export', ...uri(t), ...targetFlags(t)]

export const commitListArgv = (bin: string, t: Target, branch: string): string[] => [
  bin, 'commit', 'list', ...uri(t), '--branch', branch, '--json', ...targetFlags(t),
]

export const commitChangesArgv = (bin: string, t: Target, commitId: string): string[] => [
  bin, 'commit', 'changes', commitId, ...(t.uri !== undefined ? ['--uri', t.uri] : []), '--json', ...targetFlags(t),
]

const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p)
const absolute = (cwd: string, p: string | undefined) => (p === undefined ? '' : isUrl(p) ? p : resolvePath(cwd, p))

/**
 * Which graph an op ran against. Paths resolve against the op's directory,
 * so `cd dev && … --store graphs/x` and `… --store dev/graphs/x` are one
 * graph; with no path at all the directory itself (its config) decides.
 */
export function targetKey(t: Target, cwd: string): string {
  const hasPath = t.store !== undefined || t.uri !== undefined || t.cluster !== undefined
  return JSON.stringify([
    hasPath ? '' : cwd,
    t.server ?? '', t.graph ?? '', t.profile ?? '',
    absolute(cwd, t.store), absolute(cwd, t.cluster), absolute(cwd, t.uri),
  ])
}

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export function schemaSourceOf(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return isRecord(parsed) && typeof parsed.schema_source === 'string' ? parsed.schema_source : undefined
  } catch {
    return undefined
  }
}

export interface CommitRef {
  id: string
  /** µs since the epoch. */
  createdAt: number
}

/** `commit list --json`: newest first. */
export function parseCommits(stdout: string): CommitRef[] {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const list = isRecord(parsed) && Array.isArray(parsed.commits) ? parsed.commits : Array.isArray(parsed) ? parsed : []
    return list.flatMap(c =>
      isRecord(c) && typeof c.graph_commit_id === 'string' && typeof c.created_at === 'number'
        ? [{ id: c.graph_commit_id, createdAt: c.created_at }]
        : [],
    )
  } catch {
    return []
  }
}

/** Clock slack between the agent's shell and the store, in ms. */
export const COMMIT_SLACK_MS = 5000

/**
 * The op's commit: the oldest one made while it ran (with slack) that no
 * earlier diff took. Chained writes in one Bash call share a window, so each
 * takes the next commit in order instead of all taking the newest.
 */
export function pickCommit(
  commits: readonly CommitRef[],
  opStartedAtMs: number,
  opEndedAtMs: number,
  consumed: ReadonlySet<string> = new Set(),
): string | undefined {
  const inWindow = commits.filter(c => {
    const ms = c.createdAt / 1000
    return ms >= opStartedAtMs - COMMIT_SLACK_MS && ms <= opEndedAtMs + COMMIT_SLACK_MS && !consumed.has(c.id)
  })
  return inWindow[inWindow.length - 1]?.id // newest first: the oldest is last
}

export const MAX_CHANGES = 500

const labelIn = (image: unknown): string | undefined => {
  if (!isRecord(image) || !isRecord(image.properties)) return undefined
  for (const field of ['name', 'title', 'slug']) {
    const value = image.properties[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** `commit changes --json` → entity changes (at most 500) and how many more there were. */
export function parseChanges(stdout: string): { changes: EntityChange[]; more: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { changes: [], more: 0 }
  }
  const raw = isRecord(parsed) && Array.isArray(parsed.changes) ? parsed.changes : []
  const changes: EntityChange[] = []
  for (const c of raw) {
    if (!isRecord(c) || !isRecord(c.type) || typeof c.type.name !== 'string' || typeof c.id !== 'string') continue
    if (c.kind !== 'node' && c.kind !== 'edge') continue
    if (c.op !== 'insert' && c.op !== 'update' && c.op !== 'delete') continue
    const image = c.after ?? c.before
    const change: EntityChange = { kind: c.kind, type: c.type.name, id: c.id, op: c.op }
    const ends = isRecord(image) && isRecord(image.endpoints) ? image.endpoints : undefined
    if (typeof ends?.from === 'string') change.from = ends.from
    if (typeof ends?.to === 'string') change.to = ends.to
    const label = labelIn(image)
    if (label !== undefined) change.label = label
    changes.push(change)
  }
  return { changes: changes.slice(0, MAX_CHANGES), more: Math.max(0, changes.length - MAX_CHANGES) }
}
