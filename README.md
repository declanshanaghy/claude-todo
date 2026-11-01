# todo — a per-directory backlog for Claude Code that turns titles into subagent work

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

- **Keys.** `ctrl+x tab` (or a click) moves the keys into the pane, `tab`/arrows move the focus ring (even when the tree is taller than the pane, which scrolls to keep the focused item in view; a trackpad swipe scrolls), `enter` presses, `esc` returns to the prompt. Confirmations put the ring on the safe choice first.
- **Focus.** While the pane holds the keys, Claude Code's own focus ring (the inverted element) sits on the selected row, so that is where your typing goes. Inversion alone is hard to see, so whatever holds the ring (the add input, a todo or agent row, an action chip, the rename input) also gets a rounded border in Claude's color. The other items keep a blank cell on every side in the border's place, so moving the ring never shifts anything. The background is transparent, so your terminal's own shows through.
- **Dialog.** It has nothing to press: the arrows (or a trackpad swipe) scroll it, and `esc` (or clicking elsewhere) closes it. It replaces the tree in the same pane rather than opening a second one, because a pane can't take the keyboard from another pane, and that would cost a second `esc`. Commands read as bash, file bodies are highlighted by their file type, an `Edit` shows as a diff and JSON responses are pretty-printed.
- **Look.** Rows borrow Claude Code's transcript style so the pane reads like the chat beside it: Claude's spinner (· ✢ ✳ ✶ ✻ ✽) on running work, `⏺ Tool` rows in the dialog that are green, red or yellow for success, error or interrupted, and filled chips for the action buttons. A dim rule above each todo, with its number (in its status color) and title set into it, keeps a long tree's todos apart; the title is cut with … to the pane's width so the rule never wraps, and it is never a focus stop, so the arrows and the spacing are as without it. Every color is a theme key, so the pane follows `/theme`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Done todo lifetime (minutes)**: `doneTtlMinutes` in `/config`, or the `CLAUDE_TODO_DONE_TTL_MINUTES` environment variable, which wins | 5 | How long a done todo stays in the tree after it finishes. `0` keeps them. Hidden todos stay in the database and in `mcp__todo__list`; a failed todo is never hidden. |
| **Todo dividers**: `todoDividers` in `/config`, or the `CLAUDE_TODO_DIVIDERS` environment variable, which wins | `titled` | What the pane draws above each todo: `titled` a dim rule with the todo's number and title, `line` a plain dim rule, `none` nothing (the most rows for todos in a short pane). An unknown value means `titled`. |

A dev copy loaded with `--plugin-dir` gets no `/config` row, so use the environment variable there.

## Troubleshooting

- **Pane not visible.** Run `/todo show`. It always places the pane when asked and, if it can't, says why. If you ran `/todo noshow` earlier, the pane stays closed until you do.
- **Narrow terminal or fullscreen TUI.** At session start the pane only seats itself when there's room; widen the terminal or use `/todo show`, which places it at any width.
- **Todos from another session missing.** A list belongs to the git repo the session is in (any subdirectory of it), or to your home directory outside a repo. A linked worktree is its own repo, so it has its own list.
- **⚠ sqlite3 was not found.** The mod drives the `sqlite3` command-line tool (macOS ships it; on Linux install your distribution's `sqlite3` package). Until it's found, the pane is read-only and an older session's todos stay where they were.
- **A todo is running in another session.** Only the session that launched it can pause or resume it. If that session is gone, **⇄ Take over** marks the todo stopped here so you can restart it; it doesn't stop a run that is still going there.
- **Two copies loaded.** Don't run the installed `todo@claude-todo` and a dev copy in the same session: both register the same `/todo` command, `mcp__todo__*` tools and pane, and they fight over them. Disable one first.

## How it works

[Architecture](docs/architecture.md) has the diagrams: how the pieces fit, where state lives, how writes from parallel sessions stay safe, how a todo runs, and how parallel todos land.

- **Scope.** Todos belong to a directory: the repo the session is in, else your home directory. Every session there, now or later, shares one list. If a session moves to another repo (`/cd`, a worktree move), the pane switches to that repo's list.
- **Storage.** Todos, their agents, and every tool call those agents made (input, response, timing, outcome, and the session that recorded it) live in one SQLite file in Claude Code's plugin data folder. It's shared by every session and by both the installed and a dev copy of the mod, so a restarted session can still browse past runs. The mod drives it through the `sqlite3` CLI (see `hooks/db.ts`). A todo write names the list revision it was based on. If another session changed the list in between, the write is refused inside the same transaction, and the mod re-reads and applies the change again, so no edit is lost. The pane re-reads only when the file changes.
- **Ownership.** A todo in flight (drafting, planning, running, paused) belongs to the session that launched it. Other sessions show it, won't pause or resume it (its task ids aren't theirs), and offer **⇄ Take over** instead. Nothing is taken over automatically, so a session waking from sleep keeps its work.
- **Upgrading from 0.2.** Earlier versions kept todos in session state, which ends with the session, so only sessions still open can be moved. Reload them once 0.3 is installed. On its first start, each one moves its todos into the directory's list, in one transaction with a backup row and a run-once marker, so a retry never adds them twice. Never-run todos whose title the list already has are merged into that todo. Others keep their number unless it's taken, and the pane follows any renumbering. Its agents and calls are written out too. Only after the import commits is the old copy cleared. The backup is deleted at the next start.
- **Model-driven, mod-tracked.** The mod never plans or launches work itself. `exec`, *refine*, *restart* and *resume* submit a short protocol prompt (see `hooks/protocol.ts`), and Claude does the asking, planning and launching. Claude reports progress through the mod's `mcp__todo__update` tool and can read the backlog with `mcp__todo__list`; both answer in plain text, like any MCP tool.
- **Linking.** A todo's Agent is tagged `[todo:N]` and its Workflow is named `todo-N-…`. The mod hooks `tool.call` and `agent.spawn` to tie every spawned agent (nested ones through their parent) back to the todo, and then records each of those agents' tool calls with an input and response preview.
- **Control.** Pause and stop call `TaskStop` directly. Resume asks Claude to re-run the Workflow with `resumeFromRunId`, or to `SendMessage` the stopped agent.
- **Parallelism.** Every todo works on its own branch in its own git worktree, never in your checkout, and commits as it goes; a Workflow's writers each get one, and its merge agent combines them. The total agents per todo is capped at CPU count − 4.
- **Landing.** Once the project's own checks pass (what its README, scripts or CI run), the todo rebases onto the base branch on `origin` (the branch your checkout was on when it started) and pushes there. Your checkout isn't touched: pull to pick the work up. Uncommitted changes in your checkout aren't seen by a todo, and Claude says so when it starts one. A todo is done only once it landed; its worktree and branch are then removed, and **Details** shows the branch and the pushed commit.
- **Parallel todos.** They meet at the push. A rejected push means another todo landed first, so the later one fetches, rebases and resolves the conflicts keeping both changes, runs the checks again and retries. It never force-pushes. A conflict it can't resolve with confidence aborts the rebase and fails the todo, naming the files and keeping the branch for you.

## Developing

- **Types first.** Lint and typecheck read the API declarations Claude Code writes into the mod's folder when an interactive session loads it with `claude --plugin-dir .`. Start one once, and again after updating Claude Code, before running them. A `-p` session, `validate` and `test` don't write them.
- **Checks.** After `npm ci`: `npm run lint`, `npm run typecheck`, `claude plugin validate .` and `claude plugin test .`. The TypeScript and ESLint configs turn on every strictness option and typescript-eslint's strict, type-checked sets. Each rule that's tuned or off has its reason beside it in the config.
- **Tests.** `claude plugin test` runs them in a sandbox with no processes or files, so the test file's `engine()` stands in for the host. It includes an in-memory SQLite that answers each script from its `-- op` header, plus hooks for a test to fail a write or move another session's revision between a read and a write. [docs/test-cases.md](docs/test-cases.md) lists every behaviour worth testing and the test that covers it.
- **CI.** Every push and pull request runs the same four checks against a pinned Claude Code version (bump it in the workflow alongside your own). To get the declarations, CI starts an interactive session under a pseudo-terminal, with onboarding done, the checkout trusted and a placeholder API key. The mod loads before anything would be sent, so no secret is needed.

## License

MIT
