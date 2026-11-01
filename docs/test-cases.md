# Test cases

**Coverage: 220 of 224 cases (98.2%)** are covered by `claude plugin test .`.

Each row is one behaviour worth testing. "Covered by" names the test (by its title) that would fail if the behaviour broke. The tests run against `engine()`, the tests' stand-in for the host, which includes an in-memory SQLite that answers each script from its `-- op` header, so the rows below are about the mod's behaviour, not about the SQL text it sends.

## Commands and the pane's frame

| ID | Behaviour | Covered by |
|---|---|---|
| C1 | `/todo add` stores a title-only todo with no model turn, and the pane lists it | M1: /todo add stores a title-only todo and the pane lists it |
| C2 | The pane's add input adds a todo | M1: the pane input adds a todo |
| C3 | `/todo add` with no title answers with usage and stores nothing | /todo add with no title, a bare title, and an unplaceable pane each say so |
| C4 | A first word that is no verb adds the whole args as a title (`/todo frobnicate`) | /todo add with no title, a bare title, and an unplaceable pane each say so |
| C4a | `/todo <title>` stores the trimmed title as `/todo add <title>` does; a title whose first word is a verb (`list …`) runs that verb, and needs `/todo add` to be stored | /todo with a bare title adds it as /todo add does, and a title starting with a verb word needs the add |
| C5 | `/todo show` when the pane can't be placed gives the host's reason | /todo add with no title, a bare title, and an unplaceable pane each say so |
| C6 | `noshow` closes the pane and keeps it closed through later commands until `show` | show / noshow: noshow keeps the pane closed until show |
| C7 | The pane opens at session start, unless hidden, which outlasts a reload | the pane opens at start, stays closed across a reload once hidden, and offers the way back from a transcript |
| C8 | `/todo exec` finds a todo by number, `#n` or a case-insensitive title fragment; no match says so | /todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight |
| C9 | `/todo exec` submits its prompt from a timer once the command has answered (the host refuses a submit from inside `command.run`) | /todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight |
| C10 | `/todo exec` refuses a todo already in flight | /todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight |
| C11 | The status line counts todos by status while the pane isn't drawn, and clears when the list empties | the status line counts todos by status and clears with the last one |
| C12 | The agent cap shown is CPU count − 4 | M1: /todo add stores a title-only todo and the pane lists it |
| C13 | Viewing an agent's transcript offers the way back to the main conversation | the pane opens at start, stays closed across a reload once hidden, and offers the way back from a transcript |
| C14 | The header draws no session title, whatever the session is called | the header draws no session title; the title still follows each change, for the drafter's prompt |
| C15 | The session title the drafter's prompt names follows each change: set at session start, updated on each prompt, a hook's `sessionTitle` winning over the event's, cleared by a start with none | the header draws no session title; the title still follows each change, for the drafter's prompt |
| C16 | `/todo exec auto` takes the keyword before or after the target; with no target it runs the lowest-numbered pending todo, and says so when none is pending | /todo exec auto runs a named todo with the keyword before or after it, or the lowest-numbered pending one, and says when none is |
| C17 | The header is one row at any width: Todos and the toggles grow and clip, never wrapping, and 🔥 Fire, which never shrinks, sits flush at its right end | the header is one row at a narrow width, never wrapped, with 🔥 Fire flush at its right end |
| C17a | The header leads with the dim count and then the semibold word, `3 Todos` (`1 Todo` for one), and the view toggles' hover labels line up after it | the header leads with the count, "3 Todos" or "1 Todo", and its toggles' labels line up after it |
| C18 | `/todo resume` runs ⏵ Resume's own path from a timer once the command answered: a paused todo's agent is woken, the todo left drafting | /todo resume resumes a paused todo as the chip does, and one paused before it ever ran as an exec |
| C19 | `/todo resume` of a todo paused before it ever ran starts it as ▶ Exec would | /todo resume resumes a paused todo as the chip does, and one paused before it ever ran as an exec |
| C20 | `/todo resume` of a stopped todo whose agent is gone starts a fresh agent on the kept worktree | /todo resume picks up a stopped todo whose agent is gone with a fresh agent on the kept worktree |
| C21 | `/todo resume` refuses every state the chip isn't offered on (pending, done, in flight, stopped with nothing kept, paused in another session) in one line naming its status and the command that applies, and submits nothing | /todo resume refuses a todo the chip is not offered on, naming its status and the command that applies |
| C22 | `/todo resume` with no match says so, and with no target answers with its usage | /todo resume refuses a todo the chip is not offered on, naming its status and the command that applies |
| C23 | `/todo auto [<n\|title>]` is `/todo exec auto [<n\|title>]`; a bare `/todo exec` answers with its usage instead of running the first todo | /todo auto is short for /todo exec auto, with or without a target |
| C24 | Every chip (exec, auto, rename, delete, reset, pause, stop, resume, refine, restart, leave, takeover, details) has a `/todo` verb of its name that, in every state whose row draws the chip, leads where the chip does (a confirming chip to its yes) | every chip has a /todo verb that does what the chip does wherever it is drawn, and refuses it everywhere else |
| C25 | In every state whose row doesn't draw a chip, its verb refuses in one line naming the todo, changes nothing and submits nothing | every chip has a /todo verb that does what the chip does wherever it is drawn, and refuses it everywhere else |
| C26 | A refusal names the todo's status and the verbs it does take; deleting a todo that ran, leaving one not just stopped, taking over one not elsewhere and acting on another session's todo each say why | a chip verb refused names the todo, its status and the commands that do apply, and a bad target says so |
| C27 | A chip verb with no target, no match or (rename) no number and title answers with its usage or the miss; rename to the same title says so | a chip verb refused names the todo, its status and the commands that do apply, and a bad target says so |
| C28 | Every chip verb is in TODO_VERBS, so `/todo <verb> …` runs the verb and never adds a todo titled after it | a chip verb is a verb, never a title: /todo <verb> runs it rather than adding a todo |
| C29 | Stop, Delete and Takeover typed act at once, without the pane's question, and answer a confirmation the pane had open for that todo; Leave typed folds a just-stopped todo | a command acts without the question its chip asks, answering a confirmation the pane had open |
| C30 | `/todo help` and `/todo ?` answer with every verb of the dispatcher's own table and its meaning, then the pane keys, one non-blank line each, none over 80 columns | /todo help and /todo ? list every verb then the pane keys, one short line each |
| C31 | `help` and `?`, in any case and with words after, always answer with help and never become a todo title; other bare titles (`helpful hints`) are still added | help and ? are never a todo title: in any case and with words after, /todo answers with help and adds nothing |

## The counts: the pane's header or the status line

| ID | Behaviour | Covered by |
|---|---|---|
| K1 | A placed pane counts in its header and the status line stays clear; one that waits unplaced (`isPlaced` false) leaves the counts to the status line | open: a placed pane counts in its header and clears the status line; an unplaced one leaves the counts to it |
| K2 | `noshow` (its `ui.close`) hands the counts to the status line, and `show` takes them back | noshow hands the counts to the status line, and show takes them back |
| K3 | The person closing the pane with its × hands the counts to the status line; drawing it again takes them back | closing the pane with its × hands the counts to the status line; drawing it again takes them back (the kit can't raise the person's `ui.close`, so the test has the engine forget the pane and the sync tick notice; the hook itself is the one K2 runs) |
| K4 | A narrower terminal that unseats the pane hands the counts to the status line within a sync tick; a render of the pane takes them back | a narrower terminal that unseats the pane hands the counts to the status line until it is drawn again |
| K5 | The detail dialog covers the header, so the status line counts until it closes | the dialog covers the header, so the status line counts until it closes |
| K6 | The header, the status line and the rows show the same marks (▶ ◔ ● ✗ ⏸ ■ ✓) in the same order; the header and rows draw them in the same colors | the header, the status line and the rows draw the same marks in the same order and colors |
| K7 | The status line's counts are the whole list's, whatever the view hides; drafting and planning count as running | the default view shows running (drafting and planning too), pending, failed, paused and stopped, and hides done; the counts and the status line stay whole |

## Launching and prompts

| ID | Behaviour | Covered by |
|---|---|---|
| E10 | A prompt the host refuses after a Stop (nobody has typed since) is held: the todo stays in hand, its row and a toast say it's queued, and it goes in once after the person's next message | an exec the host refuses after a Stop is held, and goes in after the person's next message |
| E11 | Reset drops a held prompt; a plugin's or a notification's prompt doesn't release the hold | Reset drops a held prompt, and a prompt from a plugin or a notification doesn't lift the hold |
| E12 | A held prompt refused again for another reason puts the todo back as it was before it was queued | a held prompt the host refuses for another reason puts the todo back as it was before it was queued |
| E1 | ▶ Exec submits the exec protocol and marks the todo drafting | M2: Exec submits the exec protocol and marks the todo drafting |
| E1a | Exec, restart and resume all carry the git rules: own worktree branch, commit as it goes, the project's checks before landing, rebase onto `origin/<base>` resolving parallel todos' conflicts by keeping both sides, retry a rejected push, never force-push, abort and keep the branch on an unresolvable conflict; a lone Agent runs with `isolation: "worktree"` and a Workflow's merge agent is the only one that pushes | every protocol puts the work on its own worktree branch and lands it only after the checks pass |
| E1c | ⚡ Auto (in the running color) submits the auto protocol: Claude drafts the one best prompt and records it with no AskUserQuestion, and plans multi-step work on stated defaults with no plan mode or approval; plain Exec still asks | Auto drafts the one best prompt and runs it with no questions, planning multi-step work on defaults |
| E1d | 🔥 Fire in the header runs `/todo exec auto`'s no-target path: the lowest-numbered pending todo in auto mode, filled in the running color; it comes after the header's view toggles and before the add input in the arrow keys' order; while nothing is pending it stays drawn, dimmed (a grey fill under dim text), a ring on it stays there, the arrows still stop on it, and a press only toasts why; it fills again once a todo is pending | 🔥 Fire in the header auto-runs the lowest-numbered pending todo, and is dimmed while none is pending |
| E1e | 🔥 Fire is dimmed while the running agents fill the cap; a press toasts the cap and nothing launches | 🔥 Fire is dimmed while the running agents fill the cap, and a press says so |
| E1f | 🔥 Fire is never hidden, only dimmed, while every pending todo is still ◔ prompting: the person's focus reaches it and keeps it, and a press toasts that its prompts are still being drafted | Exec, Auto, 🔥 Fire and /todo exec never start a prompting todo, and say its prompts are still being drafted |
| E1g | 🔥 Fire's dimmed look and its press read one answer (`fireTarget`): dimmed with no todos, with only running or done ones, with only prompting ones, with only stopped or failed ones (which ▶ Exec restarts but Fire skips), and at the cap, each press toasting that answer; with one pending todo under the cap it is lit and launches the lowest-numbered pending | 🔥 Fire is dimmed whenever nothing is fireable, and its look and press read one answer |
| E1b | `mcp__todo__update` stores the todo's branch and landed commit, and Details shows them | mcp__todo__update reports a change and mcp__todo__list reads the backlog; a todo's Details shows its prompt, summary, run ids and agents, with nothing to press |
| D1 | A done todo leaves the tree its lifetime after it finished; a failed one stays; `mcp__todo__list` keeps both | a done todo leaves the tree 5 minutes after it finished; a failed one stays, and the list keeps both |
| D2 | `CLAUDE_TODO_DONE_TTL_MINUTES` overrides the option, and 0 keeps done todos | CLAUDE_TODO_DONE_TTL_MINUTES overrides the option; 0 keeps done todos |
| D3 | The `doneTtlMinutes` option sets the lifetime | the doneTtlMinutes option sets the time in the tree |
| D4 | A done todo with no finish time (from before it was kept) is stamped at the next start | a done todo from before its time was kept starts its time in the tree at the next start |
| E2 | A dropped exec prompt puts the todo back and toasts why | a dropped exec prompt puts the todo back and says why |
| E3 | A dropped restart puts the todo back, run ids included, with no "restarting" toast | a dropped restart puts the stopped todo back, run ids and all |
| E4 | A dropped resume puts the todo back to paused, with no "resuming" toast | a dropped resume puts the paused todo back |
| E5 | Reset sends a drafting todo back to pending, or to stopped once it has run | Reset puts a drafting todo back to pending, or to stopped once it has run |
| E6 | Rename trims and stores the new title | Rename stores the new title and puts the ring back on the row |
| E7 | Refine deletes the old run's agents and calls from the database and submits the refine protocol with the current prompt | Refine clears the old run from the database and asks for a refined prompt |
| E8 | Restart as-is clears the run ids and agents and submits the restart protocol | Restart as-is clears the run ids and its agents, then submits the restart protocol |

## Prompt drafts

| ID | Behaviour | Covered by |
|---|---|---|
| R1 | Adding a todo answers at once; then, from a timer, the plugin spawns the drafter itself: its own registered agent type (haiku, tools Read, Grep and Glob only), in the background, its description tagged `[todo-drafts:N]` and its prompt carrying the launch's key | adding a todo spawns a small read-only drafter in the background, whose drafts are stored and never linked as its run |
| R2 | The drafter's answer (its JSON, fenced or not), or a `mcp__todo__drafts` call, stores up to 3 drafts on the todo without touching its prompt or run, and a pending todo's level 1 says "3 drafts: ▶ Exec asks, ⚡/🔥 take the 1st" in place of "no prompt yet"; an unknown todo, or drafts without a label and a prompt, answer as errors | adding a todo spawns a small read-only drafter in the background, whose drafts are stored and never linked as its run |
| R3 | The drafter never links as a todo's run: its spawn, its tool calls and its end add no agent, call or tool-use id and change no status | adding a todo spawns a small read-only drafter in the background, whose drafts are stored and never linked as its run |
| R4 | With drafts stored, ▶ Exec asks ONE AskUserQuestion offering them (labels and whole prompts, plus Other) without drafting; ⚡ Auto takes the first; ✨ Refine still refines the chosen prompt | Exec offers the stored drafts without drafting, Auto takes the first, Refine is unchanged |
| R5 | A rename clears the drafts and launches a new drafter; drafts sent under the old launch's key are refused as stale; the same title again drafts nothing | a rename clears the drafts and drafts again; drafts the old drafter sends late are refused as stale |
| R6 | Drafts that arrive once the todo started are stored, its status and chosen prompt untouched | drafts that arrive once a todo is running are kept without touching its run or its chosen prompt |
| R7 | A todo turns prompting (◔, owned by this session, stamped with the time) once its drafter is spawned, and back to pending (owner and stamp cleared) when its drafts are stored; meanwhile level 1 says "no prompt yet: drafting prompts…" and ▶ Exec and ⚡ Auto are left out of its row (Rename, Delete and Details stay); the drafter's later end changes nothing | a todo is prompting from its drafter's spawn until its drafts are stored, Exec and Auto left out meanwhile |
| R8 | A prompting todo draws no ▶ Exec or ⚡ Auto, and `/todo exec` (named, auto or not), `/todo auto` and `/todo resume` refuse it, saying its prompts are still being drafted; `/todo exec auto` with no target skips it, saying so when nothing else is pending, and 🔥 Fire is dimmed then, its press saying the same; nothing is submitted | Exec, Auto, 🔥 Fire and /todo exec never start a prompting todo, and say its prompts are still being drafted |
| R9 | A drafter that ends without drafts or fails puts its todo back to pending with a toast, a refused spawn never holds it, and ▶ Exec then drafts in the chat; 🔥 Fire takes the lowest-numbered pending todo | a drafter that ends without drafts, fails or can't start leaves its todo pending, and Exec drafts in the chat |
| R11 | A prompting todo can be renamed (it stays prompting under the new drafter; the old one's end and late drafts don't release it) or deleted (its drafter's late drafts find nothing) | a prompting todo can be renamed, staying prompting under its new drafter, or deleted |
| R12 | A todo left prompting with no drafter goes back to pending at the next sync tick: this session's as soon as its drafter isn't tracked (a /clear or restart lost it), another session's once 2 minutes have passed | a prompting todo whose drafter isn't running goes back to pending at the next sync: this session's at once, another's after the wait |
| R13 | A drafter's answer stores drafts only under its own launch's key (an old one, after a rename, is stale), and an answer without JSON stores none and leaves the todo pending | a drafter's answer stores its drafts only under its own launch's key, and one without JSON stores none |
| R14 | A fired todo never says "no prompt yet" or invites another Exec: ⚡ Auto (or 🔥 Fire) with drafts stores the first as its prompt at once, so level 1 shows it, with the hint "starting with the first draft…"; ▶ Exec's hint is "answer the prompt question in the chat…" and Auto without drafts "drafting the prompt…", level 1 saying "prompt being settled in the chat…" until Claude stores one | a fired todo never says "no prompt yet": Auto stores its first draft as the prompt, and the hint names the mode |
| R10 | The drafter's agent type is hidden from the model's own agent listing (`agent.offer`); other types are offered as ever | adding a todo spawns a small read-only drafter in the background, whose drafts are stored and never linked as its run |

## Linking and tracing

| ID | Behaviour | Covered by |
|---|---|---|
| L1 | An Agent tagged `[todo:N]` links its spawn, and its tool calls show under the todo | M3: a tagged Agent links its spawn and its tool calls show under it |
| L2 | A Workflow named `todo-N-…` links and records its mode, task, run and script | a Workflow named todo-N- links, recording its mode, task, run and script |
| L3 | A Workflow with `resumeFromRunId` links to the todo with that run, keeping fields the result leaves out; an unknown run links nothing | a resumed Workflow links by its resumeFromRunId, keeping what the result leaves out |
| L4 | A refused launch records the call id and leaves the todo's status alone | a refused launch links the call but leaves the todo where it was |
| L5 | A Workflow's agents link by its call and nested agents through their parent; `w<K>:` sets the wave, `@wt` marks a worktree; a stray spawn isn't linked | a Workflow's agents link by its call and nested ones through their parent, grouped by wave |
| L6 | The tree groups a Workflow's agents under wave labels and marks worktree writers ⎇ | a Workflow's agents link by its call and nested ones through their parent, grouped by wave; level 2 is one row per subtask, grouped under its wave; level 3 its last 6 turns and calls, one line each |
| L7 | A todo agent's call is written with its preview, fields and response | agents and tool calls are kept, so a later session can browse them |
| L8 | A refused call is recorded as an error with its reason; an agent no todo owns isn't traced | a call's state follows its answer: a refusal is an error with its reason |
| L9 | The session keeps an agent's newest 200 calls; the database keeps them all | an agent keeps its newest 200 calls in the session |

## Control

| ID | Behaviour | Covered by |
|---|---|---|
| P20 | An agent stopped by the person (an aborted turn) leaves its todo stopped and its agent marked unwakeable; ⏵ Resume skips the message and starts a fresh agent in the kept worktree (found by agent id in `git worktree list`, others' left out), briefed with the prompt and the recorded calls; a newly linked agent clears the mark | an agent stopped by the person leaves Resume offered, which starts a fresh agent on the worktree and record it kept |
| P21 | Resuming a wakeable lone Agent messages it first and spells out the fallback; with nothing kept it says so; a failed resume restores the old status | a paused lone Agent is woken first, with the fallback spelled out if the wake is refused |
| P22 | A Workflow resume has its merge agent take the kept branches of interrupted writers, and falls back when the run is another session's | a Workflow resume merges the branches its interrupted writers kept, and falls back when the run is another session's |
| P23 | A taken-over todo keeps ⏵ Resume, which goes straight to a fresh agent on the kept worktree | a taken-over todo keeps Resume, which goes straight to a fresh agent |
| P24 | Resume leaves the todo in the chat's hands (drafting, ring on its row) until Claude reports it running | M4: Pause stops the task, Resume asks Claude to continue it; Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring |
| E9 | The run protocol has a stopped notification end as status stopped, never left running | the run protocol never leaves a stopped todo running |
| P1 | Pause calls TaskStop and writes the todo and its agents paused and their running calls interrupted | Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring |
| P2 | Resume of a lone Agent submits a SendMessage to it and writes the todo running | Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring |
| P3 | Resume of a Workflow submits a re-run with `resumeFromRunId` | M4: Pause stops the task, Resume asks Claude to continue it |
| P4 | Resume of a Workflow writes its paused agents stopped and leaves finished ones | resuming a Workflow marks its interrupted agents stopped, as the run respawns them |
| P5 | Stop asks first; Keep running cancels; confirming writes the todo and its agents stopped and keeps the todo | M5: Stop asks first, keeps the todo, and offers what next; Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring |
| P6 | Leave stopped folds the todo away | Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring |
| P7 | A refused TaskStop is toasted and the todo is still marked paused | a refused TaskStop says so, and the todo is still marked paused |
| P8 | Delete is offered only before a todo has run, behind a confirmation | M6: Delete is pre-exec only and confirms first |
| P9 | Delete removes the todo's row | Delete removes the row and puts the ring on the add input |
| P10 | Another session's in-flight todo offers Take over, not Pause | another session's running todo offers Take over, which stops it here |
| P11 | Take over writes the todo stopped and clears its task, run and owner | another session's running todo offers Take over, which stops it here |
| P12 | Take over writes the other session's agents stopped; Cancel leaves the todo running | Take over stops the other session's agents here and cancelling it puts the ring back |
| P13 | Pause and resume refuse a todo in flight in another session | not covered: the pane never offers those actions for such a todo and `/todo resume` refuses one before reaching it (C21), so the guard is unreachable from outside the mod |

## A turn's end

| ID | Behaviour | Covered by |
|---|---|---|
| T1 | An agent's completed turn writes it done; a lone Agent's todo stays running, with the answer's first line as summary, until Claude reports done or failed | an agent's turn ends it: a lone Agent's todo stays running until Claude reports, a refusal fails it, an abort stops it |
| T2 | A refused turn writes the agent and its lone-Agent todo failed | an agent's turn ends it: a lone Agent's todo stays running until Claude reports, a refusal fails it, an abort stops it |
| T3 | An aborted turn (stopped outside the pane) stops the agent and its lone-Agent todo, keeping the task id for ⏵ Resume, and interrupts its open calls | an agent's turn ends it: a lone Agent's todo stays running until Claude reports, a refusal fails it, an abort stops it |
| T3a | An agent stopped outside the pane stops its lone-Agent todo and keeps its id to resume | an agent stopped outside the pane stops its lone-Agent todo, keeping its id to resume |
| T4 | A Workflow agent's end doesn't end the Workflow's todo | an agent's turn ends it: a lone Agent's todo stays running until Claude reports, a refusal fails it, an abort stops it |

## The mod's MCP tools

| ID | Behaviour | Covered by |
|---|---|---|
| M1 | `mcp__todo__update` sets prompt, mode, status and summary, marks the todo run once running, and answers in plain text | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M2 | Done or failed is toasted | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M3 | An unknown todo number answers as an error | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M4 | `mcp__todo__list` answers the backlog as JSON text | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M5 | `mcp__todo__update` refuses a status move hooks/transitions.json doesn't allow with an error naming the allowed moves, and writes none of the report | mcp__todo__update refuses a status move the table does not allow, naming the moves it does, and writes nothing |
| M6 | Every internal status write passes the guard: a refused move keeps the old status, is said once, and the rest of the write stands | the guard keeps a todo's status when an internal move isn't in the table, saying so once, and the rest of the write stands |
| M7 | The moves the code writes are exactly the table's (bar its self-loop and the expiry, which write nothing), and the guard refuses none of them | every status move the code makes is in hooks/transitions.json, and every move there is one the code makes |

## Storage

| ID | Behaviour | Covered by |
|---|---|---|
| S1 | Todos are stored under the repo the session is in | todos are saved under the repo the session is in |
| S2 | Outside a repo they go under the home directory | outside a repo, todos go to the home directory |
| S3 | A session in the same repo sees the stored todos | a session in the same repo sees the stored todos |
| S4 | A session in another repo starts empty | a session in another repo starts empty |
| S5 | A write another session beat is re-read and applied on top | a write another session beat is re-read and applied on top |
| S6 | A write beaten 5 times gives up with a toast, and the command doesn't claim it was added | a write other sessions keep beating gives up after 5 tries and says so |
| S7 | Agents and calls are written through as they change | agents and tool calls are kept, so a later session can browse them |
| S8 | A restarted session browses the calls it kept | a restarted session browses the calls it kept |
| S9 | Calls are read in pages of 100 until a short page | calls are read in pages of 100 until a short page |
| S10 | A fresh read keeps only the directory's newest 1500 calls | a fresh read keeps only the newest 1500 calls of the directory |
| S11 | The database is under `CLAUDE_CONFIG_DIR` when it's set | the database lives in the plugin data folder, under CLAUDE_CONFIG_DIR when set |
| S12 | Otherwise it is under `~/.claude` | without CLAUDE_CONFIG_DIR the database is under ~/.claude |
| S14 | A `/clear` (or `/new`) resets the session's state without a `session.start`; the list loads again from the database at its `SessionStart` | a /clear resets the session state, and the list loads again from the database |
| S15 | A sync tick that finds no database handle sets the session up again | the sync tick sets the session up again when its state was reset under it |
| S16 | A failure in one of the mod's own tools (`update`, `drafts`, `list`) answers with what failed, rather than the host's "no hook answered" | a failure in one of the mod's own tools answers with what failed, not as a tool nobody answered |
| S17 | A todo paused before it ever ran belongs to no session: ▶ Exec, `/todo exec` and `/todo resume` start it from any | a todo paused before it ever ran belongs to no session: exec or resume starts it from any |
| S18 | A `/clear` hands the todos the ended session owned to the session that goes on; other sessions' stay theirs | a /clear hands the todos the ended session owned to the session that goes on |
| S13 | The SQL scripts do what the stand-in models (the rev guard, the run-once import, paging) against real sqlite3 | not covered: the test sandbox runs no processes, so the scripts never reach a real sqlite3 |

## Failures

| ID | Behaviour | Covered by |
|---|---|---|
| F1 | Without sqlite3 the pane says why, stays read-only and shows the 0.2 todos where they are | without sqlite3 the pane says why and stays read-only, keeping 0.2 todos in place |
| F2 | A refused add is not toasted or answered as added | without sqlite3 the pane says why and stays read-only, keeping 0.2 todos in place; a failed database run is said once and the next write goes through: the pane never turns read-only |
| F3 | A failed database run (an aborted write, a disk error) is toasted once until a write lands, the add isn't claimed, and the pane never turns read-only: only a missing sqlite3 or data folder does that | a failed database run is said once and the next write goes through: the pane never turns read-only |
| F4 | A failing `mkdir` of the data folder makes the pane read-only, saying why | a folder mkdir can't create makes the pane read-only, saying why |
| F5 | A `mkdir` that throws does the same, and no script runs | a mkdir that throws makes the pane read-only too |
| F6 | A failed write leaves the sync loop reading | a failed write leaves the sync loop reading |

## The sync loop

| ID | Behaviour | Covered by |
|---|---|---|
| Y1 | Every 2 s it re-reads only when the file's or WAL's mtime changed | every 2 s the copy re-reads only when the file changed, takes only new calls, and follows a new root |
| Y2 | A re-read asks only for calls after the copy's last seq | every 2 s the copy re-reads only when the file changed, takes only new calls, and follows a new root |
| Y3 | Another session's todos and calls appear after a re-read | every 2 s the copy re-reads only when the file changed, takes only new calls, and follows a new root |
| Y4 | When the session's root moves to another repo, that repo's list replaces this one, read from scratch | every 2 s the copy re-reads only when the file changed, takes only new calls, and follows a new root |

## Migration

| ID | Behaviour | Covered by |
|---|---|---|
| G1 | A 0.2 session's todos move in once, backed up; never-run title twins merge; clashing numbers are renumbered; the old copy is cleared | migration: session todos move in, backed up, deduped, renumbered on a clash, once |
| G2 | An import a concurrent write beat ('moved') is planned again on the new list | an import a concurrent write beat is planned again on the new list |
| G3 | A source already imported ('done') adds nothing, and its old copy is cleared | a source imported before (a start that died before clearing it) adds nothing and is cleared |
| G4 | A 0.2 session's agents and calls are written once, under their renumbered todo | a 0.2 session's agents and calls are written out once, following its todos' renumbering |
| G5 | Renumbering moves the pane's open rows with it, its open subtasks line and subtasks too | a migration's renumbering moves the pane's open rows with it |
| G6 | Lists the unreleased build kept in `$.store` go to their path's repo, and the keys are deleted | lists the unreleased build kept in $.store are imported under their repo, then deleted |
| G7 | A stored list whose titles aren't all in the database keeps its key and the old backup keys | a stored list whose titles aren't all in the database keeps its key, and the old keys with it |
| G8 | A backup is dropped at a later start | a backup is dropped at a later start |
| G9 | A backup survives the start that wrote it | migration: session todos move in, backed up, deduped, renumbered on a clash, once |

## The view

| ID | Behaviour | Covered by |
|---|---|---|
| V1 | The header draws one toggle per view (▶ running, ◔ prompting, ● pending, ✗ failed, ⏸ paused, ■ stopped, ✓ done), each its mark and count in its color; a hidden view's is dim and struck through | the default view shows running (drafting and planning too), pending, failed, paused and stopped, and hides done; the counts and the status line stay whole |
| V2 | The default view shows every unfinished todo: running (with drafting and planning), prompting, pending, failed, paused and stopped, so an interrupted todo never vanishes; it hides only done | the default view shows running (drafting and planning too), pending, failed, paused and stopped, and hides done; the counts and the status line stay whole |
| V3 | Pressing a toggle shows or hides its view's todos; done todos, when shown, sort after all others, the rest by number | each status toggle shows or hides its todos, done sorts last, and the last toggle cycles default, all, none |
| V4 | The header's last toggle cycles default → all → none → default, reading what its next press makes: `all` (from default, or any view in between) lights every view, then reads `none`; `none` turns every view off, then reads `default`; `default` restores the default view | each status toggle shows or hides its todos, done sorts last, and the last toggle cycles default, all, none |
| V5 | A dim footer says `N hidden by the view` while the view hides any; `Nothing in this view.` while it hides them all, directly under the header's double `═` rule, which sits directly under the add element; an empty list says only how to add one, under the same rule | each status toggle shows or hides its todos, done sorts last, and the last toggle cycles default, all, none; the view outlasts a redraw and a reload, and a list with no todos only says to add one |
| V6 | The view is kept with the pane's UI state, across redraws, reloads and sessions | the view outlasts a redraw and a reload, and a list with no todos only says to add one |
| V9 | A view stored before prompting had a toggle shows prompting todos wherever it showed pending ones, and the next toggle stores the view in its new field | a view stored before prompting had a toggle shows prompting todos wherever it showed pending ones |
| V12 | A view stored as exactly the old default (running, prompting, pending, failed: before paused and stopped joined it) reads as the new default, so paused and stopped todos show; the next toggle stores the view in its new field | a view stored as the old default (before paused and stopped joined it) reads as the new default, paused and stopped shown |
| V13 | A stored view other than the old default, one the person set by hand, stays as they set it | a view stored as anything but the old default stays as the person set it |
| V7 | A todo in hand stays in the list whatever the view (the none view aside): the one the ring is on (so Pause keeps it under the ring on ⏵ Resume) and one just stopped, until ✓ Leave | a todo in hand stays in a view that hides its status: paused under the ring, or just stopped and asking what next |
| V10 | The none view shows no todo at all, the one the ring is on and one just stopped included: the tree draws the header's double rule, `Nothing in this view.` and the `N hidden by the view` footer under its own double rule, counting every todo, with no blank line or border; the ring, if it was on a hidden todo, moves to the view toggle | the none view hides every todo, the ones in hand too, counts them in its footer, and hands the ring to the toggle |
| V11 | From the none view, lighting one status shows just that status's todos (the last toggle then reads `all`), and the none view outlasts a reload | from the none view, lighting one status shows just that status, and none outlasts a reload |
| V8 | Each state draws exactly the chips docs/architecture.md's "Buttons by state" lists (prompting, pending with and without a run, drafting, planning, running, paused, stopped right after a Stop or not, with or without work to resume, failed, done, in flight in another session, and each confirmation), and each chip leads to the state the doc gives | each state draws exactly the chips docs/architecture.md lists for it, and each leads where the doc says |

## Pane, dialog and focus

| ID | Behaviour | Covered by |
|---|---|---|
| U90 | Every state draws its action chips on one row (a just-stopped todo included, Resume first and Details last), no element draws a blank line (no vertical padding or margin, spacer text, stray rule-only line or focus border; the only lines between items are the rules: a single `─` in a `div:N` Box above each later todo, a double `═` in a `div2:head` Box under the add element (the first todo draws none), and a double in a `div2:hidden` Box above the hidden footer, each one rule Text), and the old "What next?" line is gone | every state draws its actions on one row, and the pane has no blank lines |
| U1 | Level 1 sums a todo's agents on one `▸ N subtasks · d done · c calls` line; their rows wait behind it, and a subtask's calls never draw as code in the tree | M3: a tagged Agent links its spawn and its tool calls show under it |
| U2 | A subtask's ☰ Details turns the pane into a call browser, with nothing to press while nothing in it is long enough to fold | M3: a tagged Agent links its spawn and its tool calls show under it |
| U3 | The pane losing the keys (Esc) closes the dialog | M3: Esc (the pane losing the keys) closes the call browser |
| U4 | A todo's Details shows its prompt, summary, run ids and agents, with nothing to press | a todo's Details shows its prompt, summary, run ids and agents, with nothing to press |
| U5 | The call browser shows an Edit as a diff, JSON pretty-printed, durations, and "Running…" for an open call | a subtask's calls read as their tool would: an Edit as a diff, JSON pretty-printed |
| U6 | The ring's item gets the round border, every other item a blank cell; nothing lights without the keys | every focusable item lights the same border while the ring is on it, and keeps its room otherwise |
| U7 | The mod's own focus moves light the right item: a confirmation's safe choice, Pause→Resume, Resume→Pause, Stop→Refine, Keep/Cancel→the chip that asked, Take over→Refine, Delete→add input, Rename→the row | every focusable item lights the same border while the ring is on it, and keeps its room otherwise; Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring; Take over stops the other session's agents here and cancelling it puts the ring back; Delete removes the row and puts the ring on the add input; Rename stores the new title and puts the ring back on the row |
| U8 | In the tree an arrow key walks the ring like Tab, stops at the ends (the first being the header's first view toggle, then the rest, 🔥 Fire, the add input, the list), and the wheel and page keys still scroll | in the tree an arrow key walks the ring like Tab, even when the tree is taller than the pane |
| U8b | The header (counts and toggles with 🔥 Fire, the add input, then the one ═ rule under it, and the empty note when no todo is shown) stays fixed above the list at any width: the wheel and page keys scroll only the list's window under it, clamped at both ends, and the drawing never outgrows the body, so the engine never scrolls the header away; every row is still drawn, and only the one pane ever opens | the header stays put while the list scrolls under it, at a narrow width, in one pane |
| U8c | Moving the ring (Tab, an arrow, a click, the mod's own focus) scrolls the list's window to keep the ring's row in view; a header element leaves the list where it is | moving the ring scrolls the list to keep its row in the window under the header |
| U8a | A chip that leaves a todo's row while the ring is on it (▶ Exec once the todo turns drafting) hands the ring to that todo's header | a chip that leaves the row under the ring hands the ring to its todo header |
| U9 | The spinner turns while a todo runs | the spinner turns only while a todo runs |
| U10 | Each todo is one focusable line, its own splitter: ▸/▾, #N and title in the status color, a dim rule filling the gap, the status's mark (and d/n subtasks while it has run; a running one spins) at the right in its color, with the status word as the line's label, as wide as the pane's body less its padding and the ring's room; pressing it opens and closes the todo | each todo is one line, its own splitter: toggle, #N and title in the status color, a dim rule, the status mark at the right |
| U10a | A dim rule in `DIVIDER`'s color, as wide as the tree's columns and cut rather than wrapped, parts the todos: the header ends in a double `═` under the add element, the first todo shown draws none of its own, and each later one a single `─`; N todos in the view draw N-1 singles, counting only the todos the view shows, and an open todo's levels draw none | the header ends in a double rule and every later todo has a single one: N todos shown draw N-1, counting only the view |
| U10b | A lone todo draws no rule of its own, only the header's double above it, and at a narrow width a rule stays one row of the tree's width | a lone todo draws no divider under the header rule, and at a narrow width a divider is one row cut to the tree |
| U10d | N todos shown draw one double `═` rule, the header's, and N-1 single `─` rules, the first todo having none; when the first todo leaves the view, the new first loses its single and the double stays put | the first todo draws no rule, under the header double: N todos draw one double and N-1 singles |
| U10e | A double `═` rule sits on the line directly above the `N hidden by the view` footer only while the view hides something, a hidden-everything view included, and never when nothing is hidden | the double rule is above the hidden footer only while the view hides something |
| U10f | Each double rule is one line of `═` cut to the tree's width, never wrapped, and never joins the focus order | each double rule is one line and never joins the focus order |
| U10c | The dividers are never focusable: the arrow keys walk from header to header and through an open todo's chips as they would without them | the dividers never join the focus order: the ring walks the todos as it would without them |
| U11 | The arrow keys walk the drill-down in drawing order: the todo's header, its chips, the subtasks line, each subtask row, its ☰ Details, then the next todo | the arrow keys walk the drill-down in the order it draws, header by header and level by level |
| U12 | At a narrow width the header cuts the title with … (or drops it), keeping the rule and the status mark whole | at a narrow width the header cuts the title with … and keeps the rule and the status mark whole |
| U12a | The header's width sums count terminal cells, so a two-cell emoji in the title or at the right end never makes it wrap | the header sums in terminal cells, so a wide title or mark never pushes it past its width |
| U13 | An old `todoDividers` value, in `/config` or `CLAUDE_TODO_DIVIDERS`, is ignored | an old todoDividers setting, from /config or the environment, is ignored |
| U14 | Level 1 shows the prompt word-wrapped to 2 lines with … (or, while pending, "no prompt yet: ▶ Exec drafts one"), a ✓ summary line once done, the action chips, and the subtasks line only once it has agents | level 1 shows the prompt in 2 lines, a done todo its summary, the actions, and the subtasks line; a prompt wraps by word to the width, kept to its lines with … on the last |
| U15 | Level 3 shows a subtask's newest 6 turns and calls in time order, one line each (`⏺ Tool arg   time` in its state's color, `…` while open; a turn's first line with text, markdown marks dropped), `… N earlier` above when cut, and its ☰ Details | level 2 is one row per subtask, grouped under its wave; level 3 its last 6 turns and calls, one line each |
| U16 | Every action chip is labelled in one word but draws only its symbol, padded a cell each side, and fills with the mark color of the status it moves the todo into: Exec and Resume running, Pause paused, Stop and Takeover stopped (a pure red of its own, apart from failed's orange and Delete's rose), Refine and Restart drafting; Delete is the danger color; Details, which moves no status, wears its own cyan `details` tone (distinct from every status color) in every state that draws it; Rename wears the lime `edit` tone, and Reset, Keep and Cancel the magenta `stay` tone, neither a status color nor grey; the chip under the ring shows its tone's focused twin | every action chip is one word under 10 letters, drawn as its symbol only, filled with the color of the status it moves the todo into |
| U16b | Every enabled chip, walked in every state (each todo status, each confirmation, a just-stopped row with Leave, a subtask's ☰ Details and the transcript's Back), fills with a tone's color and never a grey (`GREYS`) or dim text; every chip label is reached | an enabled chip is never grey or dim, in any state: only a disabled one is |
| U16k | A subtask's Details chip (level 3, `full:<agentId>`) is the todo's ☰ Details: the `Details` word and ☰ symbol from `CHIP`, filled with the cyan `details` tone (never grey or dim), brightening to its `focus` twin under the ring | a subtask's Details chip is the todo's ☰ Details: the same symbol, word and cyan details tone, brighter under the ring |
| U16c | A disabled chip (🔥 Fire with nothing runnable) keeps its own muted look: dimmed, a grey fill from `GREYS` (`DISABLED_FILL`) under dim text, since its emoji symbol ignores text color and dim | a disabled chip keeps its own muted look: dimmed, a grey fill, dim text |
| U16a | No two actions share a chip symbol (Exec ▶ and Resume ⏵ differ) except the safe way back (Keep, Cancel, Back all ↩), and each symbol is one grapheme, wide or not | no two actions share a chip symbol, apart from the safe way back out of a choice |
| U16d | Every chip (each todo state's, each confirmation's, a subtask's ☰ Details, 🔥 Fire) sits in a keyed `tip:` Box beside an absolute label Box drawn `display: "none"` with `hover: { display: "flex" }` holding its word; the label opens on the row above, or below for the header's, and adds no line | every chip has a hidden hover label with its word, absolute so it takes no room, kept inside the pane |
| U16e | Each header status toggle, drawn as its mark alone, joins a hover group (`tip:view:<status>`) whose hidden absolute label, on the row below, holds its status's word | every chip has a hidden hover label with its word, absolute so it takes no room, kept inside the pane |
| U16f | A hover label near the pane's right edge shifts left so the pane doesn't clip it (a narrow pane's ☰ Details), one with room keeps its place, and 🔥 Fire's is anchored at its right edge | every chip has a hidden hover label with its word, absolute so it takes no room, kept inside the pane |
| U16g | With the ring on one of a todo's chips, level 1's first line says `<symbol> <word>: <what it does>` in place of the usual hint or the prompt's first line (the prompt keeps its other lines, re-cut with …), so level 1 keeps its line count; other todos are untouched | focusing a chip puts its word and what it does in the hint line, at the same line count; unfocusing restores the hint |
| U16i | A chip under the focus ring, or any chip's `hover`, is drawn already inverted in its tone's lighter focused twin (dark text on it), so the engine's own inversion leaves it bright, never black; the hover sits on the chip's own Text in its keyed `tip:` Box, lighting that chip alone, the others staying at rest, and the tip label keeps its unfilled reveal | a focused or hovered chip brightens to its own tone's lighter twin, never black |
| U16j | Every status and chip tone has its own hex color and a distinct focused twin of the same hue, lighter; the twelve hues sit evenly 30° apart, pending is the one grey (in `GREYS`), stopped is pure red, and done sits at least 90° from running | every status and tone has its own color and focused twin, spread evenly round the wheel |
| U16h | A confirmation's chips are described in the table's words, and moving the ring off the chips restores the usual hint and line count | focusing a chip puts its word and what it does in the hint line, at the same line count; unfocusing restores the hint |
| U17 | Each status has its own color (done never reads as running, stopped's pure red never as failed's orange), and the done/failed toasts name the status by its mark | the palette gives every status its own color, stopped and failed included, and the toasts name it by its mark |
| U18 | Closing a level closes everything under it (the todo its subtasks line and subtasks, the subtasks line its subtasks), and what is open outlasts a redraw and a reload | closing a level closes everything under it, and what is open outlasts a redraw and a reload |

## The call browser

| ID | Behaviour | Covered by |
|---|---|---|
| B13 | Code and Markdown get no control or format character (escapes, C1, zero-width, bidi, separators, a surrogate half a cut leaves), so the host never refuses the dialog's drawing | the call browser hands Code and Markdown no control or format character, even where a cut splits an emoji |
| B14 | Escape on the call browser closes it, reopens the pane with the keys and puts the ring back on the subtask row it came from | Escape on the dialog closes it and puts the ring back on the subtask row it came from, keeping the keys in the pane |
| B15 | A dialog left open across a reload starts closed | a dialog left open across a reload starts closed |
| B16 | While the dialog shows, the pane is opened with `closeOnEscape`, so Escape raises the person's close; leaving the dialog opens it without | the dialog turns on closeOnEscape while it shows, and leaving it turns it off again |
| B17 | The person's close (Escape or ×) while the dialog shows closes the dialog and keeps the pane, so Escape never reaches a running turn | not covered: the test kit can't raise the person's `ui.close` |
| B1 | A todo agent's text from each model step is kept as a turn row beside its calls; the main loop's steps and steps with no text are not | an agent's turns are kept beside its calls and read in time order |
| B2 | The browser interleaves turns and calls by start time, a step's text before its calls, and counts turns in its header | an agent's turns are kept beside its calls and read in time order |
| B3 | A restarted session reads its kept turns back, in place among the calls | a restarted session reads the turns it kept back, in place among the calls |
| B4 | Turns and markdown-looking responses draw as Markdown; a Read keeps its file-typed Code and shell output stays Code | a response that reads as markdown is drawn as Markdown; shell output and file bodies stay code; an agent's turns are kept beside its calls and read in time order |
| B5 | A long output folds to its first lines behind a `… +N lines` toggle that unfolds and folds it, lit by the ring like every focusable item | a long output folds to a preview, and its toggle unfolds and folds it, lighting the ring |
| B6 | Only the newest 40 entries are drawn; a toggle adds the next 40 older | hundreds of calls draw the newest window, older ones a toggle away |
| B7 | Drawing stops before the 100000-character limit, saying how many entries it left out | calls too big to draw together stop short of the drawing limit, saying so |
| B8 | A Read of a picture records its path, name, size and type, never its bytes, and the response carries no base64 | a Read of a picture keeps a reference, not its bytes, and draws it as a thumbnail |
| B9 | The terminal draws a picture as a 24×8 Image, alt text its name and size; a PNG on disk is drawn as is | a Read of a picture keeps a reference, not its bytes, and draws it as a thumbnail |
| B10 | A picture the host won't read keeps its alt text instead of blanking the dialog | a Read of a picture keeps a reference, not its bytes, and draws it as a thumbnail |
| B11 | A surface without Image shows the alt text | a surface without Image shows the picture as its alt text |
| B12 | An image block in a result is spooled beside the database; its PNG thumbnail is made only once the browser draws it | a result's image block is spooled beside the database and made a PNG thumbnail only when drawn |

## Outside the mod

| ID | Behaviour | Covered by |
|---|---|---|
| X1 | An installed copy and a dev copy loaded together fight over the command, tools and pane | not covered: it's the host's loading of two plugins, which the kit, loading one, can't stage |
