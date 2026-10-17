/** A bare command name, safe to hand to a shell as `command -v <name>`. */
export function isPlainName(bin: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(bin)
}

/** Where installers usually put a CLI, for when neither PATH nor the shell knows it. */
export function binCandidates(home: string | undefined, bin: string): string[] {
  const homeDirs = home !== undefined ? [`${home}/.local/bin`, `${home}/.cargo/bin`] : []
  return [...homeDirs, '/opt/homebrew/bin', '/usr/local/bin'].map(dir => `${dir}/${bin}`)
}

/** The absolute path `command -v <bin>` printed, past any shell start-up noise. */
export function pathFromShell(stdout: string, bin: string): string | undefined {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  return last !== undefined && last.startsWith('/') && last.endsWith(`/${bin}`) ? last : undefined
}
