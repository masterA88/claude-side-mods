# Mission Control

A pane on the right of your Claude Code chat that shows what Claude and each of its agents is doing while it works.

Author: Hilmi, https://master-hilmi.vercel.app/

- **Plan**: one row per plan bar, with a fill meter, the percentage and the current step (needs side-plan-progress).
- **Agents**: Claude and every agent it spawns, with state, a sliding bar and a timer. Click an agent's row to open a panel above the prompt that shows its tool calls and replies, with an `@agent` field to message it. A finished agent resumes with your message.
- **Usage**: the 5-hour and weekly limits with reset times, context fill and session cost, kept live.
- **Now** and **Activity**: what each agent runs at this moment, and a feed of recent tool calls.

`/mod-on` and `/mod-off` turn the right side on and off for all the side mods. `/mc` shows or hides this pane.

It works on its own. With side-plan-progress and side-omnigraph-viz from the same marketplace installed, `/mod-on` brings up all three: https://github.com/masterA88/claude-side-mods

## What it runs, reads, writes and sends

Mission Control makes no network requests and asks for no credentials or tokens.

- **Programs it runs:** `df -k` on `/System/Volumes/Data` or `/` and `hostname -s`, once a minute, to draw the disk row (free space and the machine's short name). Nothing else is run. Where `df` is missing, as on Windows, the row is left out.
- **What it reads:** the tool calls Claude and its agents make (the tool's name and a short detail such as a file path or command), the prompt each agent is spawned with, the visible text of each agent's replies, the session's usage figures (limits, context, cost) through Claude Code's own usage call, the plan bars that side-plan-progress keeps (if installed), and the `HOME` environment variable to find the switch file below. All of it is shown in the pane and stays on your machine.
- **What it writes:** one file, `~/.claude/side-mods/mods-on.json`, holding `{"on": true}` or `{"on": false}`. `/mod-on` and `/mod-off` write it, and the side mods read it to open or close their panes. It is not a settings or instructions file for Claude Code or any other tool.
- **What it sends:** only a message you type into an agent's panel and send with Enter, delivered to that agent in your own session through Claude Code's agent messaging (the same path as the SendMessage tool). Nothing is sent anywhere else.
- **Hooks:** `tool.call`, `agent.spawn` and `turn.step` record what they see for the pane and pass every call on unchanged. `turn.start` and `turn.complete` mark rows running and done, and `session.measure` reads the usage figures; both pass on unchanged. The permission hook (`classic.PermissionRequest`) only marks the asking agent's row "needs you" and passes the request on unchanged: the decision is always yours. "Open full transcript" uses Claude Code's own `$.ui.view` to open the agent's transcript.

MIT license.
