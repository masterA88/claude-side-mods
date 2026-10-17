/** A key as a `Client` reports it. */
export interface ExploreKey {
  key: string
  meta?: boolean
  shift?: boolean
  ctrl?: boolean
}

/** What a key does in the browser. */
export type Action =
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'deeper' }
  | { kind: 'back' }
  | { kind: 'live' }
  | { kind: 'tab'; tab: 'graph' | 'feed' }
  | { kind: 'none' }

/**
 * Finder's column keys: ↑↓ select, → or ⏎ (or ⌥↓) opens the selection as a
 * new column, ← or ⌫ (or ⌥↑) goes back one; `l` follows live ops again; g and
 * f switch tabs. ⌘↑/⌘↓ stay with the terminal, but iTerm2 can send ⌥↑/⌥↓ for them.
 */
export function actionFor(k: ExploreKey): Action {
  if (k.meta && k.key === 'down') return { kind: 'deeper' }
  if (k.meta && k.key === 'up') return { kind: 'back' }
  if (k.key === 'up') return { kind: 'move', delta: -1 }
  if (k.key === 'down') return { kind: 'move', delta: 1 }
  if (k.key === 'right' || k.key === 'return') return { kind: 'deeper' }
  if (k.key === 'left' || k.key === 'backspace' || k.key === 'delete') return { kind: 'back' }
  if (k.key === 'l') return { kind: 'live' }
  if (k.key === 'g') return { kind: 'tab', tab: 'graph' }
  if (k.key === 'f') return { kind: 'tab', tab: 'feed' }
  return { kind: 'none' }
}
