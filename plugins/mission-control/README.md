# Mission Control

A pane on the right of your Claude Code chat that shows what Claude and each of its agents is doing while it works.

Author: Hilmi, https://master-hilmi.vercel.app/

- **Plan**: one row per plan bar, with a fill meter, the percentage and the current step (needs side-plan-progress).
- **Agents**: Claude and every agent it spawns, with state, a sliding bar and a timer. Click an agent's row to open a panel above the prompt that shows its tool calls and replies, with an `@agent` field to message it. A finished agent resumes with your message.
- **Usage**: the 5-hour and weekly limits with reset times, context fill and session cost, kept live.
- **Now** and **Activity**: what each agent runs at this moment, and a feed of recent tool calls.

`/mod-on` and `/mod-off` turn the right side on and off for all the side mods. `/mc` shows or hides this pane.

It works on its own. With side-plan-progress and side-omnigraph-viz from the same marketplace installed, `/mod-on` brings up all three: https://github.com/masterA88/claude-side-mods

MIT license.
