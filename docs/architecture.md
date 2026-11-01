# Architecture

The mod is a hooks module that runs inside every Claude Code session. It never plans or launches work itself: it keeps the backlog, draws the pane, and hands Claude a protocol prompt. Claude asks, plans and launches subagents. The mod watches what gets launched and records it in a database that every session shares.

## The pieces

```mermaid
flowchart LR
  subgraph S["A Claude Code session"]
    direction TB
    P["Pane<br/>tree · actions · call browser"]
    H["Hooks module<br/>commands · tools · tracing · sync"]
    M["Claude (main loop)"]
    A["Subagents<br/>an Agent or a Workflow,<br/>each in its own git worktree"]
    P -- "press: exec, pause, stop…" --> H
    H -- "protocol prompt" --> M
    M -- "mcp__todo__update / list" --> H
    M -- "launches" --> A
    A -. "tool calls, turns<br/>(seen through hooks)" .-> H
    H -- "atoms: the session's copy" --> P
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
| Hooks module | Registers `/todo`, the `mcp__todo__*` tools and the pane; links launched agents to their todo; records every tool call; keeps the session's copy of the list in sync | `hooks/register.tsx` |
| Database layer | Builds each SQL script, runs it through `sqlite3`, parses the answer | `hooks/db.ts` |
| Pane and call browser | Draw the tree, the action chips and the read-only dialog from the session's copy | `hooks/pane.tsx`, `hooks/detail.tsx` |
| Protocol | The prompts Claude follows for exec, restart and resume, including the git rules | `hooks/protocol.ts` |
| Contract | The todo, agent and call shapes, and the state the pane reads | `types/index.d.ts` |

## Where state lives

| State | Where | Why there |
|---|---|---|
| Todos, agents, tool calls | One SQLite file in Claude Code's plugin data folder, keyed by directory | Shared by every session and every copy of the mod; survives restarts |
| The session's copy of its directory's rows | `$.state` atoms | The pane draws from them, and a write to one redraws it |
| Pane layout (open rows, confirmations, focus ring) | `$.state` atoms | Per session; nothing else needs it |
| Settings | `/config` (`pluginConfigs`) or environment variables | Claude Code's standard plugin options |

A list belongs to the git repo the session is in (each worktree is its own repo), or to the home directory outside one. If a session moves to another repo (`/cd`, a worktree move), the next sync loads that repo's list.

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

Agents and calls are written through as they change: they're keyed by id and only ever written by the session that recorded them, so they need no revision check. Every two seconds the session re-reads when the database file's modification times change, picking up new calls by sequence number.

A failed run (most often a write the host aborts as the turn it served ends) is reported once and doesn't stop the next write. Only a missing `sqlite3` or data folder makes the pane read-only.

## Running a todo

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
  H->>M: protocol prompt
  M->>U: pick or write the prompt
  M->>H: mcp__todo__update (prompt, mode, running)
  M->>W: Agent "[todo:N] …" or Workflow "todo-N-…"
  H->>H: tool.call / agent.spawn link it to #N
  loop its work
    W->>W: edit, commit
    W-->>H: each tool call recorded with input and response
  end
  W->>W: run the project's checks
  W->>O: fetch, rebase onto origin/base, push HEAD:base
  W-->>M: report: branch, commits, checks, landed hash
  M->>H: mcp__todo__update (done or failed, branch, landed)
```

A dropped prompt (the host refusing it, a Stop standing) puts the todo back where it was and says why. An agent stopped outside the pane ends with an aborted turn, which marks its todo stopped and keeps its id for ▶ Resume.

## Parallel todos meet at the push

Each todo works on its own branch and never touches your checkout. Two todos that change the same files only meet when the second one lands:

```mermaid
flowchart TD
  C["Checks pass on the todo's branch"] --> F["git fetch · git rebase origin/base"]
  F --> X{Conflict?}
  X -- no --> V["Run the checks again"]
  X -- yes --> R["Read the other side's commits;<br/>resolve keeping both intents"]
  R --> OK{Resolved with confidence?}
  OK -- yes --> V
  OK -- no --> A["git rebase --abort · push nothing ·<br/>todo failed, branch kept"]
  V --> P["git push origin HEAD:base"]
  P --> J{Rejected?}
  J -- "yes: another todo landed first" --> F
  J -- no --> D["Done: worktree and branch removed"]
```

Nothing ever force-pushes. In a Workflow, the writers each commit on their own branch and only the final merge agent lands.

## Upgrading from 0.2

0.2 kept each session's todos in that session's state. At its first start under 0.3, a session moves its todos into the directory's list in one transaction, together with a backup row and a run-once marker, so a retry never adds them twice. Never-run duplicates merge, clashing numbers are renumbered, and the session's own agents and calls are written out under the new numbers. The backup is dropped at a later start.
