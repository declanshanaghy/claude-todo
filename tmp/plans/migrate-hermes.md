# Migrate claude-todo to Hermes ("hermes-todo")

Date: 2026-11-01
Source of truth for the spec: docs/architecture.md, hooks/transitions.json,
hooks/protocol.ts, docs/test-cases.md in this repo. Port the spec, not the code.

## Decision summary

- Hermes has every ingredient (durable SQLite task board, in-process subagent
  spawner with a public plugin API, worktree mode, TUI/Desktop widget
  surfaces) but NO plugin combines them. Nothing in the catalog has feature
  parity (checked: hermes-teammates, protean-subagent-viewer, operations,
  kanban core).
- Therefore: reimplement as a standalone Hermes plugin.
- NEW REPO, not this one. Zero code reuse is possible (Python vs TS/TSX,
  ctx API vs $ API, different host constraints, different CI/test engine,
  catalog wants a standalone repo to pin a sha). Copy the spec docs in.

## Parity gap (what exists vs what's missing)

| claude-todo feature          | closest Hermes thing                          |
|------------------------------|-----------------------------------------------|
| per-repo SQLite backlog      | kanban board (global, profile-oriented)       |
| rev-guarded multi-session    | none (kanban dispatcher reclaims instead)     |
| writes with retry            |                                               |
| 9-state machine, guarded     | kanban task states, no enforced transition    |
| transitions, model-checked   | table                                         |
| read-only drafter pre-writes | none (but ctx.llm can do it cheaper)          |
| exec prompts on add          |                                               |
| protocol prompts + landing   | none (no git rules anywhere)                  |
| rules (worktree per todo,    |                                               |
| squash to one commit, rebase |                                               |
| origin/main, never force-    |                                               |
| push)                        |                                               |
| per-call tracing + call      | terminal result + viewer output preview, no   |
| browser                      | per-call trace                                |
| pane with chips,             | read-only viewer pane only                    |
| confirmations, takeover,     |                                               |
| Fire                         |                                               |
| /todo verbs                  | kanban CLI only                               |

## Verified Hermes hook/API surface (from the shipped plugin-hook catalog)

Everything load-bearing exists:

- pre_tool_call (directive: block/approve/modify args)
  post_tool_call (observer: tool_name, args, result, task_id, session_id,
  tool_call_id, turn_id, duration_ms, status, error)
  -> call tracing with input+response. Richer than Claude hooks.
- on_session_start / on_session_end / on_session_finalize /
  on_session_reset / on_session_delete -> setup + takeover reconcile.
  Payloads are IDs only; resolve repo/cwd in-process.
- subagent_start / subagent_stop (child_session_id, child_goal,
  child_status, child_summary, tool_call_history, duration_ms)
  -> agent linking (the agent.spawn linking analog).
- ctx.subagent_lifecycle: launch/status/wait/cancel/steer/result with
  correlation_id, model override, allowed_toolsets, working_directory,
  timeout_seconds -> drafter + worker runner. steer() is better than what
  claude-todo has for a paused run.
- ctx.llm: drafter can be a plain structured LLM call, cheaper than an agent.
- ctx.register_system_prompt_section: cache-safe standing rules
  (caps: 4000 chars/section, 8000 aggregate, frozen per session).
- pre_llm_call (directive): return string / {"context": ...} injected into
  the user message next turn -> protocol-prompt handoff riding a turn.
- ctx.register_command() -> /todo verbs in CLI + gateway.
  ctx.register_cli_command() -> hermes todo.
  ctx.register_tool() -> todo_update / todo_list (mcp__todo__* analog).
- plugin_db() / plugin_data_dir() -> durable store, survives updates.
  ctx.state -> per-session runtime atoms.
- Human-input hooks (on_human_input_request, approval observers) for
  confirmations.

Caveats:
- Hot-path hooks are timeout-bounded (default 30s; pre_tool_call fails
  closed on overrun). Keep hook callbacks fast; SQLite writes are ms.
- on_session_start fires on the first turn, not at boot -> lazy setup.

## The one gap (resolved 2026-11-01, verified in source)

Launch context: `subagent_lifecycle.launch` fails closed outside an active
agent turn — `bind_subagent_parent` wraps only `run_conversation`
(agent/turn_facade.py:144), and a slash-command handler runs when the
session is idle. But `ctx.inject_message(content, role="user",
session_key=…)` queues a real user turn into the CLI/TUI/gateway session,
gated on the plugin's own `plugins.entries.<id>.allow_gateway_injection:
true` consent (hermes_cli/plugins_injection.py). So /todo exec has both
paths: launch in-process while a turn is live, or inject the protocol
prompt as a turn when idle (the $.clock.after(0, submit) analog the plan
first thought was missing). `post_message` is the toast analog for
answers streaming back into the chat.

## Architecture mapping

| claude-todo piece            | hermes-todo piece                                |
|------------------------------|--------------------------------------------------|
| hooks/register.tsx           | plugin.yaml + __init__.py register(ctx)           |
| mcp__todo__* tools           | native plugin tools (todo_add, todo_list, ...)    |
| hooks/db.ts (sqlite3 CLI,   | Python sqlite3, WAL + rev-guarded transactions    |
| one script per write)        | (keep the rev guard: sessions still share the     |
|                              | file; the one-script constraint disappears)       |
| drafter (haiku agent)        | ctx.llm structured call, or a cheap leaf          |
|                              | subagent with read-only allowed_toolsets          |
| worker per todo (worktree)  | subagent_lifecycle.launch with                    |
|                              | working_directory = per-todo worktree,            |
|                              | goal = ported protocol prompt                     |
| agent linking via [todo:N]  | correlation_id + subagent_start/stop hooks         |
| call tracing via hooks       | pre/post_tool_call (spike: confirm firing in       |
|                              | children; fallback: subagent_stop's                |
|                              | tool_call_history + child session rows in state.db)|
| transitions.json guard       | copy verbatim + guard; keep TLC model check as a   |
|                              | dev-time check                                    |
| session.end takeover        | on_session_end / on_session_finalize reconcile;   |
|                              | kanban-style stale-reclaim for cross-session       |
| protocol.ts prompts          | launch goal text + system_prompt_section           |
| pane (Ink inside Claude)     | TUI widget app (below) or Desktop pane            |
| /todo verbs                  | ctx.register_command()                            |

## Pane: TUI widget design (chosen surface)

Hermes TUI (hermes --tui, Ink/React) extension point: widget apps, plain
.mjs in ~/.hermes/tui-widgets/, hot-reloaded, no build step, no JSX
(h() from sdk). default-export register(sdk) -> defineWidgetApp.

- Ambient rail card, zone top-right, explicit width (~44 cols), ~6 rows:
  the tree's summary: counts per status with marks, lowest-numbered
  pending todo, latest activity line. Click-only (ambient captures no
  keys). Auto-open on load via sdk.openWidget.
- Modal app (/todo opens it): Overlay, owns every keypress -> the real
  pane: tree with focus ring, one-row chip sets per state, confirmation
  lines (focus on the safe choice), details dialog + call browser over
  recorded calls, Esc closes (reducer returns null).
- Data path (OPEN): widget is JS in the TUI process; the SQLite store is
  owned by the Python plugin half in the gateway process. Bridge via the
  local gateway API / plugin backend route; poll with init +
  sdk.updateWidget (it no-ops if closed). This seam is the main new
  plumbing versus claude-todo, where pane and module share one process.
- Sizing discipline: Dialog explicit width, pad dynamic numbers, constant
  row count per phase; a card must never resize while ticking.
- Colors: theme tones (t.color.*) only, must survive /skin and light/dark.
  The marks.tsx raw-hex 30-degrees palette either becomes theme tones or
  the todo palette deliberately ignores skins.
- Actions from the modal dispatch the same handlers as the /todo verbs
  (the offers() pattern): one code path for chips and typed verbs.
- Esc handoff semantics differ from Claude: here Esc simply closes the
  modal and returns keys to the composer.
- Verification: /widgets-reload lists the file under loaded:; a thrown
  register() is silently skipped, check
  ~/.hermes/logs/tui_gateway_crash.log.

Desktop pane (plugin.js via Desktop Plugin SDK) remains a later option;
the TUI widget is first because the workflow lives in the terminal.

## Spike items

1. ANSWERED 2026-11-01 (source): post_tool_call is emitted through the
   process-global hook registry (model_tools._emit_post_tool_call_hook →
   hermes_cli.lifecycle.invoke_hook) with the executing agent's
   session_id/tool_call_id/turn_id/duration_ms/status AND full args+result —
   subagent children are full in-process agent loops, so they fire it with
   the child's ids. Fallback also real: subagent_stop's tool_call_history.
2. OPEN, and now the only real gap: the TUI widget data path. Widgets are
   sdk-only .mjs (fetch is the only I/O — no imports, so no direct SQLite
   read) and the plugin's store lives in the gateway process. The
   `dashboard/plugin_api.py` route namespace (`/api/plugins/<name>`) is
   served by `hermes dashboard` / Desktop, NOT running for a plain
   `hermes --tui` user. Options: (a) Desktop pane first (first-class
   backend REST), (b) require/autostart the dashboard server and fetch it
   from the widget, (c) ask upstream for a plugin-served widget data
   route. Decide before Phase 5.
3. DROPPED: wake machinery is `ctx.inject_message` (see "The one gap").

## Phases

1. Core, no UI: plugin package, SQLite store (WAL + rev guard), todo_*
   tools, state machine ported from transitions.json + guard, pytest
   suite (port docs/test-cases.md rows).
2. Drafting: ctx.llm (or cheap leaf subagent) drafts on add/rename;
   drafts stored on the todo row; prompting/pending states.
3. Exec: worktree per todo, worker via subagent_lifecycle with ported
   protocol prompt (squash/rebase/no-force-push landing rules in the
   goal text), link via correlation_id, record branch/commits/landed.
4. Tracing: pre/post_tool_call into the calls table; takeover reconcile
   on session end; resume = fresh worker briefed from recorded calls.
5. TUI: ambient rail card, then modal pane with chips/confirmations/
   details dialog + call browser.
6. Ship: hermes plugins install, catalog PR (community tier, automation
   category).

## Repo

New repo, e.g. github.com/declanshanaghy/hermes-todo:
plugin.yaml, __init__.py, schemas.py, tools.py, db.py, transitions.json +
guard, docs/ (ported architecture + test-cases), tests/ (pytest).
Validate with: hermes plugins validate <path> --install-deps and
hermes plugins doctor <path>.

Do not couple the two repos: copy spec docs in; they will drift at
different speeds and shared-source coupling would fight both repos'
landing rules.

## Progress log

- **2026-11-01 — Phase 1 done** (repo: `~/src/github.com/declanshanaghy/hermes-todo`,
  initial commit `b296c6d`). plugin.yaml + register(ctx) with three tools;
  db.py (WAL via plugin_db, lists keyed by repo, rev guard with BEGIN
  IMMEDIATE + 5-try retry + GiveUp); transitions.json verbatim + guard
  (no mirror needed: Python imports JSON); pytest suite 40/40, rows in
  docs/test-cases.md; `hermes plugins validate .` and `doctor . --ci` pass.
  Findings recorded:
  - `todo_list` collides with a Hermes built-in tool → ours is
    `todo_backlog` (`todo_add`/`todo_update` are free).
  - pytest picks the repo root up as a Package (plugin.yaml needs
    `__init__.py` beside it) and imports it bare at setup — keep the
    relative imports inside `register()`, and tests load the hyphen-named
    package via `spec_from_file_location("hermes_todo", ...)`.
  - Run tests with `uv run --no-project --with pytest --python 3.12 python
    -m pytest tests/ -q` (no system pytest).
- **2026-11-01 — Phases 2–5 done, repo pushed** (commit `7569d46`, now
  public at https://github.com/declanshanaghy/hermes-todo, README links
  back to claude-todo). On top of phase 1:
  - drafter.py: ctx.llm complete_structured on add/rename, prompting
    lifecycle, stale draft keys (R rows).
  - exec.py + protocol.py + moves.py + commands.py: a worker per todo via
    subagent_lifecycle in its own worktree, git rules verbatim in the goal,
    pause/stop/resume, idle-session fallback via inject_message
    (consented allow_gateway_injection), /todo verb per chip over one
    shared offers().
  - trace.py: correlation-id linking, per-call recording with input and
    response, dead-worker settle, stale reclaim on session end/start.
  - dashboard/plugin_api.py + widgets/ (todo.mjs modal pane, todo-card.mjs
    rail card): the pane reads /api/plugins/hermes-todo/; run verbs answer
    with a note to type the /todo verb (the TUI-mode data seam stays open).
  - 93 tests / 93 test-cases rows; validate + doctor pass; the dashboard
    route smoke-tested; all 7 mermaid blocks parse; v0.2.0.
- **Remaining:** Phase 6 (catalog PR, community/automation tier); the
  upstream ask for a plugin-served widget data route (or a Desktop pane);
  the `planning` state has no code path yet (no Workflow analog — see
  architecture.md divergences); live end-to-end exercise against a real
  Hermes session (drafter LLM call, a real launch, the widget over the
  route) once installed.
