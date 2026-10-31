# todo — a per-session backlog for Claude Code that turns titles into subagent work

Jot a todo down with just a title. Later, `exec` it: Claude drafts prompts for you to pick from, judges how big the job is, and either fires one background subagent or plans with you and runs a Workflow, a dependency tree of subagents, with parallel writers isolated in git worktrees. A right-hand pane shows everything live and lets you control it: launch, pause, resume, stop, refine, delete, and drill into every agent's tool calls and responses.

## Install

```
/plugin marketplace add declanshanaghy/claude-todo
/plugin install todo@claude-todo
```

Or declare it in your settings so every machine picks it up:

```json
{
  "extraKnownMarketplaces": { "claude-todo": { "source": { "source": "github", "repo": "declanshanaghy/claude-todo" } } },
  "enabledPlugins": { "todo@claude-todo": true }
}
```

## Use

| You | What happens |
|---|---|
| `/todo add Fix kitty tab titles`, or type in the pane's **＋ add todo…** | The todo is stored with its title only; no model turn |
| `/todo exec 1` (or a title fragment), or **▶ Exec** in the pane | Claude asks for the prompt with 2–3 drafts (or type your own), then classifies it |
| simple | One background Agent |
| multi-step | Plan mode → questions until the subtasks are clear → an execution tree for you to approve → Workflow |
| **⏸ Pause** / **▶ Resume** | Stops the task; resuming a Workflow replays its finished agents from cache, a lone Agent is sent a message to continue |
| **■ Stop** | Confirms, stops, and keeps the todo, then offers *Refine prompt & restart*, *Restart as-is*, *Resume* or *Leave stopped* |
| **✕ Delete** | Confirms, then removes the todo; only offered for todos that have never run |
| `/todo show` (or bare `/todo`, `/todo list`) | Opens and focuses the pane, or tells you why it can't be placed |
| `/todo noshow` | Closes the pane and keeps it closed for the rest of the session, until `/todo show` |

![Adding todos from the prompt and from the pane](docs/screenshots/m1-add.png)
*Adding: `/todo add` and the pane's input both store just a title.*

![The action row of a pending todo, ring on Exec](docs/screenshots/m2-launch.png)
*Launching: ▶ Exec hands the todo to Claude, which drafts prompts and asks you to pick one.*

![A pane with a pause-able running Workflow](docs/screenshots/m4-pause.png)
*Pausing: TaskStop halts the run but keeps its run id, so ▶ Resume picks up from cache.*

![The Stop button with its inline confirmation](docs/screenshots/m5-stop.png)
*Stopping: an inline confirmation starts on the safe choice; the todo stays, with follow-up options.*

![Delete offered only on a todo that has never run](docs/screenshots/m6-delete.png)
*Deleting: only never-run todos can be deleted, again behind a confirmation.*

Open [docs/mockup.html](docs/mockup.html) in a browser for an interactive walkthrough of every flow (`#m1`–`#m6` jump to a scene). The mockup sketches layout and flow; the live pane uses the styling described below.

## The pane

The pane opens on the right at session start and keeps the tree short: each todo, and under it one line per subtask (its agents, grouped by wave for a Workflow, worktree writers marked ⎇, with a count of their tool calls). The detail lives in a dialog: press a subtask and the pane becomes a read-only browser of every tool call that agent made in its turn, each with its formatted input and response; **Details** on a todo shows its full prompt, run ids and agents. `esc` closes the dialog.

![A running Workflow expanded down to one tool call's input and response](docs/screenshots/m3-browse.png)
*Browsing: expand a todo to see its subtasks; press one to read every tool call it made.*

- **Keys.** `ctrl+x tab` (or a click) moves the keys into the pane, `tab`/arrows move the focus ring, `enter` presses, `esc` returns to the prompt. Confirmations put the ring on the safe choice first.
- **Focus.** The pane draws no frame or focus colors of its own: while it holds the keys, Claude Code's own focus ring (the inverted element) sits on the selected row, so that is where your typing goes. The background is transparent, so your terminal's own shows through.
- **Dialog.** It has nothing to press: the arrows and page keys scroll it, and `esc` (or clicking elsewhere) closes it. It replaces the tree in the same pane rather than opening a second one, because a pane can't take the keyboard from another pane, and that would cost a second `esc`. Commands read as bash, file bodies are highlighted by their file type, an `Edit` shows as a diff and JSON responses are pretty-printed.
- **Look.** Rows borrow Claude Code's transcript style so the pane reads like the chat beside it: Claude's spinner (· ✢ ✳ ✶ ✻ ✽) on running work, `⏺ Tool` rows in the dialog that are green, red or yellow for success, error or interrupted, and filled chips for the action buttons. Every color is a theme key, so the pane follows `/theme`.

## Troubleshooting

- **Pane not visible.** Run `/todo show`. It always places the pane when asked and, if it can't, says why. If you ran `/todo noshow` earlier, the pane stays closed until you do.
- **Narrow terminal or fullscreen TUI.** At session start the pane only seats itself when there's room; widen the terminal or use `/todo show`, which places it at any width.
- **Two copies loaded.** Don't run the installed `todo@claude-todo` and a dev copy in the same session: both register the same `/todo` command, `mcp__todo__*` tools and pane, and they fight over them. Disable one first.

## How it works

- **Scope.** Todos live in the mod's session state: they survive compaction and mod reloads, and end with the session.
- **Model-driven, mod-tracked.** The mod never plans or launches work itself. `exec`, *refine*, *restart* and *resume* submit a short protocol prompt (see `hooks/protocol.ts`), and Claude does the asking, planning and launching. Claude reports progress through the mod's `mcp__todo__update` tool and can read the backlog with `mcp__todo__list`; both answer in plain text, like any MCP tool.
- **Linking.** A todo's Agent is tagged `[todo:N]` and its Workflow is named `todo-N-…`. The mod hooks `tool.call` and `agent.spawn` to tie every spawned agent (nested ones through their parent) back to the todo, and then records each of those agents' tool calls with an input and response preview.
- **Control.** Pause and stop call `TaskStop` directly. Resume asks Claude to re-run the Workflow with `resumeFromRunId`, or to `SendMessage` the stopped agent.
- **Parallelism.** Writers run in their own worktrees and a final merge agent merges and commits (never pushes). The total agents per todo is capped at CPU count − 4.

## License

MIT
