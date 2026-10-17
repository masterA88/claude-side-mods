import type { ClientModule, JsonValue } from 'claude-code'

/** One styled run of a row: text, its color (`#rrggbb`), reverse video for the selection. */
type Run = { t: string; c?: string; i?: true }

/**
 * The Graph tab's browser: draws the rows the hooks module rendered and, once
 * a click has given it the keyboard, posts every key back to it (arrows,
 * return, backspace, letters, with ⌥ as `meta`). The answer to each post is
 * the next rows.
 */
const Explore: ClientModule = (props, surface) => {
  if (surface.state === undefined) {
    surface.onKey(e => surface.post({ key: e.key, meta: e.meta === true, shift: e.shift === true, ctrl: e.ctrl === true }))
    surface.setState({ ready: true })
  }
  const { Box, Text } = surface.elements
  const rows = ((props as { rows?: JsonValue } | null)?.rows ?? []) as Run[][]
  return Box({
    flexDirection: 'column',
    children: rows.map((row, r) =>
      Box({
        key: `r${r}`,
        children: row.length === 0 ? [Text({ children: ' ' })] : row.map(run => Text({ ...(run.c !== undefined ? { color: run.c } : {}), ...(run.i === true ? { inverse: true } : {}), children: run.t })),
      }),
    ),
  })
}

export default Explore
