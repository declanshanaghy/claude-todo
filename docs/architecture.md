# Architecture

The mod is a hooks module that runs inside every Claude Code session. It never plans or launches a todo's work itself: it keeps the backlog, draws the pane, and hands Claude a protocol prompt. Its one agent of its own is a small, read-only drafter it spawns when a todo is added, so the prompts are ready before you press ▶ Exec. Claude asks, plans and launches subagents. The mod watches what gets launched and records it in a database that every session shares.

## The pieces

```mermaid
flowchart LR
  subgraph S["A Claude Code session"]
    direction TB
    P["Pane<br/>tree · actions · call browser"]
    H["Hooks module<br/>commands · tools · tracing · sync"]
    M["Claude (main loop)"]
    A["Subagents<br/>an Agent or a Workflow,<br/>each in its own git worktree"]
    D["Drafter<br/>haiku, read-only,<br/>one per added todo"]
    P -- "press: exec, pause, stop…" --> H
    H -- "protocol prompt" --> M
    M -- "mcp__todo__update / list" --> H
    M -- "launches" --> A
    A -. "tool calls, turns<br/>(seen through hooks)" .-> H
    H -- "atoms: the session's copy" --> P
    H -- "$.agent.spawn on add, rename" --> D
    D -- "its answer: drafts as JSON" --> H
  end
  S2["Other sessions<br/>in the same repo"]
  DB[("SQLite<br/>todos · agents · calls<br/>migrated · backups")]
  G[("origin<br/>base branch")]
  H <-- "sqlite3 CLI,<br/>one script per write" --> DB
  S2 <-- "same file" --> DB
  A -- "rebase, validate, push" --> G
```

| Piece | Role | Source |
|---|---|---|
| Hooks module | Registers `/todo`, the `mcp__todo__*` tools, the drafter's agent type and the pane; spawns a drafter for each added or renamed todo; links launched agents to their todo; records every tool call and the text its agents write between them; keeps the session's copy of the list in sync | `hooks/register.tsx` |
| Database layer | Builds each SQL script, runs it through `sqlite3`, parses the answer | `hooks/db.ts` |
| Pane and call browser | Draw the tree, the action chips and the read-only dialog from the session's copy | `hooks/pane.tsx`, `hooks/detail.tsx` |
| Protocol | The prompts Claude follows for exec, restart and resume, including the git rules, and the drafter's task | `hooks/protocol.ts` |
| Contract | The todo, agent and call shapes, and the state the pane reads | `types/index.d.ts` |

## Where state lives

| State | Where | Why there |
|---|---|---|
| Todos, agents, tool calls and turns | One SQLite file in Claude Code's plugin data folder, keyed by directory | Shared by every session and every copy of the mod; survives restarts |
| The session's copy of its directory's rows | `$.state` atoms | The pane draws from them, and a write to one redraws it |
| Pane layout (open rows, confirmations, focus ring, the view) | `$.state` atoms | Per session; nothing else needs it. What's open and the view outlast a reload |
| A todo's drafts | On the todo's row, beside (never in) its chosen prompt | Ready for any session's ▶ Exec, and kept through restarts |
| Drafters in flight and their keys | `$.state` atoms | A drafter belongs to the session that spawned it; the todo's `prompting` status (with its owner and start time) is what other sessions see |
| Settings | `/config` (`pluginConfigs`) or environment variables | Claude Code's standard plugin options |

A list belongs to the git repo the session is in (each worktree is its own repo), or to the home directory outside one. If a session moves to another repo (`/cd`, a worktree move), the next sync loads that repo's list. A `/clear` or `/new` carries on under a new session id with the session's state reset and no `session.start`, so the mod sets itself up again at that `SessionStart` (and at any sync tick that finds no database handle), and the repo's list comes back from the database. Its todos stay its own: `session.end` notes the ending session id, and that boot takes over the todos it owned. A todo paused before it ever ran has no run to take, so it belongs to no session.

## Writing without losing edits

`sqlite3` runs one script per process, so a transaction can't stay open while the mod's own logic runs. Instead, each write says which revision of the list it was computed from:

```mermaid
sequenceDiagram
  participant H as Hooks module
  participant Q as sqlite3
  H->>Q: BEGIN IMMEDIATE · bump rev where rev = R · write rows · COMMIT
  alt rev was still R
    Q-->>H: exit 0, rev is now R+1
    H->>H: update the session's copy
  else another session wrote first
    Q-->>H: CHECK constraint failed (the guard row), nothing written
    H->>Q: re-read the list
    H->>H: apply the same edit again (up to 5 tries)
  end
```

Agents, calls and turns (an agent's text between calls, kept as rows of the calls table) are written through as they change: they're keyed by id and only ever written by the session that recorded them, so they need no revision check. Every two seconds the session re-reads when the database file's modification times change, picking up new calls by sequence number.

A failed run (most often a write the host aborts as the turn it served ends) is reported once and doesn't stop the next write. Only a missing `sqlite3` or data folder makes the pane read-only.

## A todo's life

A todo is always in one of nine states. `MARK` in `hooks/marks.tsx` gives each one its symbol and color, and every button is filled with the color of the state it leads to, so a button's color tells you where it takes the todo. ▶ Exec, ⚡ Auto, 🔥 Fire and ⏵ Resume launch a run, so they wear running's green although the todo passes through drafting on the way; ✨ Refine and ↻ Restart wear drafting's blue, as they draft it again. ☰ Details changes no status either, so it wears a teal of its own (the `details` tone, the theme's `ide` color, as planning owns the theme's one true teal) and stands apart from the statuses. ✎ Rename wears its own `edit` tone (the theme's `fastMode` orange), and the other buttons that change no status (✓ Leave, ↩ Keep/Cancel/Back, ↗ Full transcript) and ↺ Reset, which only hands the todo back, share the `stay` tone (the theme's `rainbow_violet` mauve). None is grey: grey and dim mean disabled (`GREYS` in `hooks/marks.tsx`), and a test walks every chip in every state to keep it so. A todo's button is drawn only while it can act, so only the header's 🔥 Fire is ever dimmed. While a todo is prompting, ▶ Exec and ⚡ Auto are left out of its row (level 1 says why), and 🔥 Fire is left out of the header while nothing is runnable. When the button the focus ring is on disappears, the ring moves to its todo's header (from Fire, to the header's last toggle).

```mermaid
%%{init: {"themeVariables": {"fontSize": "20px"}, "state": {"nodeSpacing": 60, "rankSpacing": 70}}}%%
stateDiagram-v2
  direction TB
  [*] --> pending: ＋ add
  pending --> prompting: drafter spawned (＋ add, ✎ Rename)
  prompting --> prompting: ✎ Rename
  prompting --> pending: drafts ready / drafter gone

  pending --> drafting: ▶ Exec · ⚡ Auto · 🔥 Fire
  drafting --> planning: multi-step
  drafting --> running: simple → one Agent
  planning --> running: plan approved → Workflow

  running --> paused: ⏸ Pause
  paused --> drafting: ⏵ Resume
  running --> stopped: ■ Stop
  paused --> stopped: ■ Stop
  running --> done: Claude reports landed
  running --> failed: Claude reports not landed

  stopped --> drafting: ✨ Refine · ↻ Restart · ⏵ Resume
  failed --> drafting: ✨ Refine · ↻ Restart · ⏵ Resume

  drafting --> pending: ↺ Reset (never ran)
  planning --> pending: ↺ Reset (never ran)
  drafting --> stopped: ↺ Reset (has run)
  planning --> stopped: ↺ Reset (has run)
  drafting --> paused: prompt refused · resume started nothing
  drafting --> failed: prompt refused · resume started nothing

  prompting --> [*]: ✕ Delete
  pending --> [*]: ✕ Delete (never ran)
  done --> [*]: expires
```

Edges are labeled with the button that takes them; ■ Stop and ✕ Delete ask first. A todo is prompting from the moment its drafter is spawned (an add, or a rename that changed its title) until the drafts are stored; it falls back to pending when the drafter ends without drafts, can't be spawned (then it never leaves pending), or isn't running in any session: the next sync tick hands back one this session prompts whose drafter it no longer tracks (a `/clear` or a restart lost it), and another session's after 2 minutes. A dismissed prompt question acts like ↺ Reset, an agent stopped outside the pane acts like ■ Stop, and `/todo exec` (with or without `auto`) is ▶ Exec or ⚡ Auto typed, which also starts a stopped or failed todo again, never a prompting one (`/todo auto` is short for `/todo exec auto`). `/todo resume` is ⏵ Resume typed, for the same todos; a todo paused before it ever ran starts as ▶ Exec would. Every other chip has a verb of its own name too (`/todo pause 3`, `/todo rename 3 <new title>`; see [Buttons by state](#buttons-by-state)). A dropped prompt (`drafting → paused/failed/pending/stopped`) puts the todo back where it was. A lone Agent's end leaves its todo running: only Claude knows whether the work landed, and reports done or failed.

`hooks/transitions.json` is the one table of the moves a todo may make. Every status write goes through one guard (`editTodos` in `hooks/register.tsx`), which reads the table's mirror in `hooks/transitions.ts` (a hooks module can't import JSON; `node scripts/transitions.mjs` checks the two are identical and `--write` regenerates the mirror). A move the table doesn't allow keeps the old status, says so once, and lets the rest of the write stand; `mcp__todo__update` answers such a move with an error naming the moves that are allowed, and writes nothing. A test drives every move and checks the code makes exactly the table's moves. `node scripts/state-check.mjs` model-checks this diagram against the table with TLA+'s TLC; [state-validation.md](state-validation.md) has why that tool, how to run it, and what it found.

| State | Mark | Meaning | Who moves it on |
|---|---|---|---|
| prompting | ◔ | Added (or renamed); its drafter is writing prompt drafts, so nothing may start it yet | The drafter's drafts or its end; the sync tick if it's gone |
| pending | ● | Ready to run: never run (or run, then reset before it started again) | You |
| drafting | ✎ | Claude is writing or refining the prompt, or resuming | Claude, via `mcp__todo__update` |
| planning | ◇ | Multi-step: plan-mode questions and the execution tree | Claude |
| running | ▶ (spins) | An Agent or Workflow is working | Claude's report once it ends (done, failed or stopped); an abort or refusal at once |
| paused | ⏸ | Halted with its run kept, so Resume picks up where it was | You |
| stopped | ■ | Halted for good; its worktree and branch are kept | You |
| done | ✓ | Landed (or committed, with no remote) | Expires after the keep period |
| failed | ✗ | Finished without landing; its worktree and branch are kept | You |

`drafting` and `planning` belong to the chat: the todo leaves them only when Claude reports, or when you press Reset.

### Buttons by state

Each button is filled with the color of the state it leads to (the launchers in running's, as above). Destructive buttons ask first, with the ring on the safe choice. A test ("each state draws exactly the chips docs/architecture.md lists for it") draws every row below and presses every button, so this table and the pane can't drift.

| State | Buttons | Leads to |
|---|---|---|
| prompting | ✎ Rename · ✕ Delete (only if it never ran) · ☰ Details, and the hint "no prompt yet: drafting prompts…"; no ▶ Exec or ⚡ Auto until its drafts turn it pending | prompting under a new drafter · confirm → removed · call browser |
| pending | ▶ Exec · ⚡ Auto · ✎ Rename · ✕ Delete (only if it never ran) · ☰ Details, and a hint: "3 drafts ready: ▶ Exec picks one" once its drafts are stored, else "no prompt yet: ▶ Exec drafts one" | drafting · drafting · prompting · confirm → removed · call browser |
| drafting / planning | ↺ Reset (and a hint: "answer the prompt question in the chat…" after ▶ Exec, "starting with the first draft…" after ⚡ Auto or 🔥 Fire with drafts, "drafting the prompt…" after one without, "continuing in the chat…" once it has run, "planning in the chat…"); level 1 shows the prompt, or "prompt being settled in the chat…" until Claude stores it, never "no prompt yet" | pending if it never ran, else stopped |
| running | ⏸ Pause · ■ Stop · ☰ Details | paused · confirm → stopped · call browser |
| paused | ⏵ Resume · ■ Stop · ☰ Details | drafting · confirm → stopped · call browser |
| stopped / failed | ⏵ Resume (if there's an agent or worktree to pick up) · ✨ Refine · ↻ Restart · ✓ Leave (right after a Stop) · ☰ Details, all on one row | drafting · drafting · drafting · collapses it · call browser |
| done | ☰ Details | call browser |
| in flight in another session | ⇄ Takeover · ☰ Details | confirm → stopped here · call browser |

Every chip is also a `/todo` verb of its own name taking `<n|title>` (`/todo rename <n> <new title>` takes the number, then the title): `exec`, `auto`, `rename`, `delete`, `reset`, `pause`, `stop`, `resume`, `refine`, `restart`, `leave`, `takeover`, `details`. The row and the verb read the same `offers()` (`hooks/moves.ts`) and call the same action function, so a verb works exactly where its chip is drawn; anywhere else it answers in one line with the todo's status and the verbs that do apply, and changes nothing. `exec` and `auto` keep their wider reach (a stopped or failed todo too). A verb whose chip asks first (Stop, Delete, Takeover) acts at once, since typing it is already the explicit request, and answers any confirmation the pane had open for that todo. A verb that submits a prompt (refine, restart, as exec and resume) does so from a timer once the command answered; `details` opens the dialog with the pane holding the keys, and Esc goes back.

The confirmations:

| Confirm for | Buttons |
|---|---|
| Stop | ■ Stop · ↩ Keep (back to running or paused) |
| Delete | ✕ Delete · ↩ Cancel (back to pending or prompting) |
| Takeover | ⇄ Takeover · ↩ Cancel (left in flight there) |

Pane-wide controls:

| Control | Where | Does |
|---|---|---|
| ＋ add todo… | top of the list | adds a pending todo |
| 🔥 Fire | header | `/todo exec auto` on the lowest-numbered pending todo (prompting ones are skipped); dimmed (disabled, never hidden) while none is pending or the agent cap is full, still a focus stop whose press only toasts why, and filled again once one is runnable |
| ↗ Full transcript | under an open subtask's latest calls | opens the call browser; Esc returns to the subtask |
| status toggles `▶ ◔ ● ✗ ⏸ ■ ✓` · all/none/default | header, before 🔥 Fire | each shows or hides its state's todos (drafting and planning go with ▶ running), drawn as its mark and count, dimmed and struck through while hidden. The default view is running, prompting, pending and failed (a view stored before prompting had a toggle shows it wherever it showed pending); done sorts last when shown. The last toggle cycles default → all → none → default and reads what its next press makes: `all` lights every one, then reads `none`; `none` turns every one off, so the tree shows no todo, then reads `default`, which restores the default. From none, lighting one status shows just that status. A footer counts what the view hides. The todo the ring is on, and one just stopped, stay in the list whatever the view, except none, which hides them too and moves a ring left on one to the toggle. The view is kept with the pane's layout; the counts and the status line always count the whole list |

## Running a todo

Drafting starts when the todo is added, so ▶ Exec has its prompts ready. Until they are, the todo is prompting and nothing starts it:

```mermaid
sequenceDiagram
  actor U as You
  participant H as Hooks module
  participant D as Drafter (haiku, read-only)
  U->>H: ＋ add (or ✎ Rename)
  H-->>U: added at once
  H->>D: from a timer: $.agent.spawn "[todo-drafts:N] …" with a fresh key
  H->>H: status prompting (owner, start time): Exec, Auto, Fire refuse it
  D->>D: a few Grep, Glob, Read calls
  D->>H: its answer: {n, key, 3 drafts} as JSON
  H->>H: store them on the todo, status pending (an older key's are stale and refused)
```

```mermaid
sequenceDiagram
  actor U as You
  participant P as Pane
  participant H as Hooks module
  participant M as Claude
  participant W as Subagent (worktree)
  participant O as origin
  U->>P: ▶ Exec
  P->>H: execTodo: status drafting
  H->>M: protocol prompt, carrying the drafts when there are any
  M->>U: pick a draft or write the prompt (auto: the first draft)
  M->>H: mcp__todo__update (prompt, mode, running)
  M->>W: Agent "[todo:N] …" or Workflow "todo-N-…"
  H->>H: tool.call / agent.spawn link it to #N
  loop its work
    W->>W: edit, commit
    W-->>H: each tool call recorded with input and response, and the text between them
  end
  W->>W: run the project's checks
  W->>O: fetch, rebase onto origin/base, push HEAD:base
  W-->>M: report: branch, commits, checks, landed hash
  M->>H: mcp__todo__update (done or failed, branch, landed)
```

Without drafts (the drafter ended with none, couldn't start, or was lost), the protocol has Claude draft 2–3 prompts in the chat. Drafts that arrive after the todo started are kept but change nothing. The drafter's tag is `[todo-drafts:N]`, which the linking hooks skip, so it never becomes the todo's run.

A dropped prompt (the host refusing it, a Stop standing) puts the todo back where it was and says why. An agent stopped outside the pane ends with an aborted turn, which marks its todo stopped and its agent as one that can't be woken. ⏵ Resume then has Claude start a fresh agent in the worktree the old one kept, briefed with its branch and the turns and calls already recorded; it does the same when a Workflow run belongs to another session, or after a takeover.

## Parallel todos meet at the push

Each todo works on its own branch and never touches your checkout. Two todos that change the same files only meet when the second one lands:

```mermaid
flowchart TD
  C["Checks pass on the todo's branch"] --> S["git fetch · squash the branch<br/>into one commit (Todo: #N)"]
  S --> F["git rebase origin/base"]
  F --> X{Conflict?}
  X -- no --> V["Run every check again on that commit;<br/>fixes amend it"]
  X -- yes --> R["Read the other side's commits;<br/>resolve keeping both intents"]
  R --> OK{Resolved with confidence?}
  OK -- yes --> V
  OK -- no --> A["git rebase --abort · push nothing ·<br/>todo failed, branch kept"]
  V --> P["git push origin HEAD:base"]
  P --> J{Rejected?}
  J -- "yes: another todo landed first" --> G["git fetch"] --> F
  J -- no --> D["Done: worktree and branch removed"]
```

Nothing ever force-pushes. Each todo lands as exactly one commit that passed every check on its own, so the base branch's history stays bisectable: work-in-progress commits stay on the todo's branch. In a Workflow, the writers each commit on their own branch and only the final merge agent squashes and lands.

## Upgrading from 0.2

0.2 kept each session's todos in that session's state. At its first start under 0.3, a session moves its todos into the directory's list in one transaction, together with a backup row and a run-once marker, so a retry never adds them twice. Never-run duplicates merge, clashing numbers are renumbered, and the session's own agents and calls are written out under the new numbers. The backup is dropped at a later start.
