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
| `/todo exec 1`, or **▶ Exec** in the pane | Claude asks for the prompt with 2–3 drafts (or type your own), then classifies it |
| simple | One background Agent |
| multi-step | Plan mode → questions until the subtasks are clear → an execution tree for you to approve → Workflow |
| **⏸ Pause** / **▶ Resume** | Stops the task; resuming a Workflow replays its finished agents from cache |
| **■ Stop** | Confirms, stops, and keeps the todo, then offers *Refine prompt & restart*, *Restart as-is*, *Resume* or *Leave stopped* |
| `/todo` | Opens and focuses the pane |

Keys in the pane: `ctrl+x tab` (or a click) to enter, `tab`/arrows to move, `enter` to press, `esc` back to the prompt. Open [docs/mockup.html](docs/mockup.html) in a browser for an interactive walkthrough of every flow (`#m1`–`#m6` jump to a scene).

## How it works

- **Scope.** Todos live in the mod's session state: they survive compaction and mod reloads, and end with the session.
- **Model-driven, mod-tracked.** The mod never plans or launches work itself. `exec`, *refine*, *restart* and *resume* submit a short protocol prompt (see `hooks/protocol.ts`), and Claude does the asking, planning and launching. Claude reports progress through the mod's `mcp__todo__update` tool.
- **Linking.** A todo's Agent is tagged `[todo:N]` and its Workflow is named `todo-N-…`. The mod hooks `tool.call` and `agent.spawn` to tie every spawned agent (nested ones through their parent) back to the todo, and then records each of those agents' tool calls with an input and response preview.
- **Control.** Pause and stop call `TaskStop` directly. Resume asks Claude to re-run the Workflow with `resumeFromRunId`, or to `SendMessage` the stopped agent.
- **Parallelism.** Writers run in their own worktrees and a final merge agent merges and commits (never pushes). The total agents per todo is capped at CPU count − 4.

## License

MIT
