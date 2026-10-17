# side-plan-progress

Live plan progress bars for Claude Code. Claude fills them through its `plan_progress` tool, and a "Tasks" bar fills by itself from Claude's own task list. Mission Control shows the bars in its Plan section, and `/progress-on` opens them in a pane of their own.

This is a fork of the plan-progress mod in [zycck/claude-mods](https://github.com/zycck/claude-mods) by Kirill Serditov, under the MIT license (see `LICENSE`, which keeps his copyright). The bars, the pixel fill, the agent strips, the sounds and the `plan_progress` tool are his work. The fork, maintained by Hilmi (https://master-hilmi.vercel.app/), moves the bars into a pane on the right, puts them under the shared `/mod-on` switch, and fills a bar from Claude's task list.

Commands: `/progress`, `/progress-on`, `/progress-off`, `/progress-clear`, `/progress-agents`, `/plan-progress-autoclose`, `/plan-progress-settings`.

Part of https://github.com/masterA88/claude-side-mods
