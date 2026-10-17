# side-omnigraph-viz

Draws your Claude Code session as a live graph: Claude in the centre, each agent linked to whoever spawned it, and every tool call and file it touched. A Feed tab lists each call with who made it, how long it took and whether it failed. The activity graph is kept in memory and writes no files.

If you run the `omnigraph` CLI against a graph store, the first `omnigraph` command hands the pane to that store's graph, and the mod then behaves as the original does.

This is a fork of [pronskiy/omnigraph-claude-mod](https://github.com/pronskiy/omnigraph-claude-mod) by Roman Pronskiy, under the MIT license (see `LICENSE`, which keeps his copyright). The graph drawing, the layout and the omnigraph command handling are his work. The fork, maintained by Hilmi (https://master-hilmi.vercel.app/), adds the activity graph and the `/og-on`, `/og-off` and `/mod-on` switches.

Commands: `/og`, `/og-on`, `/og-off`.

Part of https://github.com/masterA88/claude-side-mods
