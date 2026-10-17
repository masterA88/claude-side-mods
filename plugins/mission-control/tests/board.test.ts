import { expect, test } from 'claude-code/testing'

import { bar, clock, fit, meter } from '../hooks/register'

test('the bar keeps its width in every state', () => {
  for (const state of ['running', 'done', 'needs', 'failed'] as const) {
    for (const frame of [0, 3, 17, 40]) expect(bar(state, 20, frame).join('').length).toBe(20)
  }
})

test('a running block slides and comes back', () => {
  const at = (f: number) => bar('running', 20, f)[0].length
  expect(at(0)).toBe(0)
  expect(at(5)).toBe(5)
  expect(at(11)).toBe(11)
  expect(at(13)).toBe(9)
})

test('done is a solid bar, needs you a short block on dots', () => {
  expect(bar('done', 10, 0).join('')).toBe('██████████')
  expect(bar('needs', 10, 0)[2]).toBe('········')
})

test('elapsed time reads like the screenshot', () => {
  expect(clock(26_000)).toBe('0:26')
  expect(clock(61_000)).toBe('1:01')
  expect(clock(3_725_000)).toBe('1:02:05')
})

test('titles are cut to their column', () => {
  expect(fit('Review Tier-Badge', 10)).toBe('Review Ti…')
  expect(fit('Scan', 6)).toBe('Scan  ')
})

test('the disk meter fills by percent', () => {
  expect(meter(50, 10).join('')).toBe('▓▓▓▓▓·····')
})
