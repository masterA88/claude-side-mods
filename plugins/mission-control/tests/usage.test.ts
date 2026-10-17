import { expect, test } from 'claude-code/testing'

import { planPct, resetIn, toUsage } from '../hooks/register'

test('toUsage carries the limit windows, context fill and cost', () => {
  const u = toUsage({
    context: { tokens: 54_000, window: 200_000, percent: 27 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-10-17T06:00:00Z' }, { kind: 'seven_day', percentUsed: 12 }],
    cost: { usd: 3.2 },
  })
  expect(u.limits).toEqual([
    { kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-10-17T06:00:00Z' },
    { kind: 'seven_day', percentUsed: 12, resetsAt: null },
  ])
  expect(u.contextPct).toBe(27)
  expect(u.costUsd).toBe(3.2)
})

test('resetIn reads minutes, hours and days', () => {
  const now = Date.parse('2026-10-17T04:00:00Z')
  expect(resetIn('2026-10-17T04:25:00Z', now)).toBe('resets in 25m')
  expect(resetIn('2026-10-17T06:10:00Z', now)).toBe('resets in 2h 10m')
  expect(resetIn('2026-10-20T04:00:00Z', now)).toBe('resets in 3d')
  expect(resetIn(null, now)).toBe('')
})

test('planPct counts done and skipped steps', () => {
  const plan = { id: 'p', title: 'x', state: 'running', note: null, stages: [{ name: 's', steps: [{ title: 'a', status: 'done' }, { title: 'b', status: 'skipped' }, { title: 'c', status: 'active' }, { title: 'd', status: 'pending' }] }] }
  expect(planPct(plan)).toBe(50)
})
