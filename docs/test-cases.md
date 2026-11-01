# Test cases

**Coverage: 132 of 135 cases (97.8%)** are covered by `claude plugin test .`.

Each row is one behaviour worth testing. "Covered by" names the test (by its title) that would fail if the behaviour broke. The tests run against `engine()`, the tests' stand-in for the host, which includes an in-memory SQLite that answers each script from its `-- op` header, so the rows below are about the mod's behaviour, not about the SQL text it sends.

## Commands and the pane's frame

| ID | Behaviour | Covered by |
|---|---|---|
| C1 | `/todo add` stores a title-only todo with no model turn, and the pane lists it | M1: /todo add stores a title-only todo and the pane lists it |
| C2 | The pane's add input adds a todo | M1: the pane input adds a todo |
| C3 | `/todo add` with no title answers with usage and stores nothing | /todo add with no title, an unknown verb, and an unplaceable pane each say so |
| C4 | An unknown verb answers with usage | /todo add with no title, an unknown verb, and an unplaceable pane each say so |
| C5 | `/todo show` when the pane can't be placed gives the host's reason | /todo add with no title, an unknown verb, and an unplaceable pane each say so |
| C6 | `noshow` closes the pane and keeps it closed through later commands until `show` | show / noshow: noshow keeps the pane closed until show |
| C7 | The pane opens at session start, unless hidden, which outlasts a reload | the pane opens at start, stays closed across a reload once hidden, and offers the way back from a transcript |
| C8 | `/todo exec` finds a todo by number, `#n` or a case-insensitive title fragment; no match says so | /todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight |
| C9 | `/todo exec` submits its prompt from a timer once the command has answered (the host refuses a submit from inside `command.run`) | /todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight |
| C10 | `/todo exec` refuses a todo already in flight | /todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight |
| C11 | The status line counts todos by status while the pane isn't drawn, and clears when the list empties | the status line counts todos by status and clears with the last one |
| C12 | The agent cap shown is CPU count − 4 | M1: /todo add stores a title-only todo and the pane lists it |
| C13 | Viewing an agent's transcript offers the way back to the main conversation | the pane opens at start, stays closed across a reload once hidden, and offers the way back from a transcript |
| C14 | The header draws the session's title at its right end in the prompt bar's border color (`promptBorder`), Todos at its left; with no title it draws none | the header shows the session title at its right in the prompt bar color, following each change |
| C15 | The title follows each change: set at session start, updated on each prompt, a hook's `sessionTitle` winning over the event's, cleared by a start with none | the header shows the session title at its right in the prompt bar color, following each change |

## The counts: the pane's header or the status line

| ID | Behaviour | Covered by |
|---|---|---|
| K1 | A placed pane counts in its header and the status line stays clear; one that waits unplaced (`isPlaced` false) leaves the counts to the status line | open: a placed pane counts in its header and clears the status line; an unplaced one leaves the counts to it |
| K2 | `noshow` (its `ui.close`) hands the counts to the status line, and `show` takes them back | noshow hands the counts to the status line, and show takes them back |
| K3 | The person closing the pane with its × hands the counts to the status line; drawing it again takes them back | closing the pane with its × hands the counts to the status line; drawing it again takes them back (the kit can't raise the person's `ui.close`, so the test has the engine forget the pane and the sync tick notice; the hook itself is the one K2 runs) |
| K4 | A narrower terminal that unseats the pane hands the counts to the status line within a sync tick; a render of the pane takes them back | a narrower terminal that unseats the pane hands the counts to the status line until it is drawn again |
| K5 | The detail dialog covers the header, so the status line counts until it closes | the dialog covers the header, so the status line counts until it closes |
| K6 | The header, the status line and the rows show the same marks (▶ ⏸ ■ ✓ ○) in the same order; the header and rows draw them in the same theme colors | the header, the status line and the rows draw the same marks in the same order and colors |

## Launching and prompts

| ID | Behaviour | Covered by |
|---|---|---|
| E1 | ▶ Exec submits the exec protocol and marks the todo drafting | M2: Exec submits the exec protocol and marks the todo drafting |
| E1a | Exec, restart and resume all carry the git rules: own worktree branch, commit as it goes, the project's checks before landing, rebase onto `origin/<base>` resolving parallel todos' conflicts by keeping both sides, retry a rejected push, never force-push, abort and keep the branch on an unresolvable conflict; a lone Agent runs with `isolation: "worktree"` and a Workflow's merge agent is the only one that pushes | every protocol puts the work on its own worktree branch and lands it only after the checks pass |
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

## Linking and tracing

| ID | Behaviour | Covered by |
|---|---|---|
| L1 | An Agent tagged `[todo:N]` links its spawn, and its tool calls show under the todo | M3: a tagged Agent links its spawn and its tool calls show under it |
| L2 | A Workflow named `todo-N-…` links and records its mode, task, run and script | a Workflow named todo-N- links, recording its mode, task, run and script |
| L3 | A Workflow with `resumeFromRunId` links to the todo with that run, keeping fields the result leaves out; an unknown run links nothing | a resumed Workflow links by its resumeFromRunId, keeping what the result leaves out |
| L4 | A refused launch records the call id and leaves the todo's status alone | a refused launch links the call but leaves the todo where it was |
| L5 | A Workflow's agents link by its call and nested agents through their parent; `w<K>:` sets the wave, `@wt` marks a worktree; a stray spawn isn't linked | a Workflow's agents link by its call and nested ones through their parent, grouped by wave |
| L6 | The tree groups a Workflow's agents under wave headers and marks worktree writers ⎇ | a Workflow's agents link by its call and nested ones through their parent, grouped by wave |
| L7 | A todo agent's call is written with its preview, fields and response | agents and tool calls are kept, so a later session can browse them |
| L8 | A refused call is recorded as an error with its reason; an agent no todo owns isn't traced | a call's state follows its answer: a refusal is an error with its reason |
| L9 | The session keeps an agent's newest 200 calls; the database keeps them all | an agent keeps its newest 200 calls in the session |

## Control

| ID | Behaviour | Covered by |
|---|---|---|
| P20 | An agent stopped by the person (an aborted turn) leaves its todo stopped and its agent marked unwakeable; ▶ Resume skips the message and starts a fresh agent in the kept worktree (found by agent id in `git worktree list`, others' left out), briefed with the prompt and the recorded calls; a newly linked agent clears the mark | an agent stopped by the person leaves Resume offered, which starts a fresh agent on the worktree and record it kept |
| P21 | Resuming a wakeable lone Agent messages it first and spells out the fallback; with nothing kept it says so; a failed resume restores the old status | a paused lone Agent is woken first, with the fallback spelled out if the wake is refused |
| P22 | A Workflow resume has its merge agent take the kept branches of interrupted writers, and falls back when the run is another session's | a Workflow resume merges the branches its interrupted writers kept, and falls back when the run is another session's |
| P23 | A taken-over todo keeps ▶ Resume, which goes straight to a fresh agent on the kept worktree | a taken-over todo keeps Resume, which goes straight to a fresh agent |
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
| P13 | Pause and resume refuse a todo in flight in another session | not covered: the pane never offers those actions for such a todo and no command reaches them, so the guard is unreachable from outside the mod |

## A turn's end

| ID | Behaviour | Covered by |
|---|---|---|
| T1 | An agent's completed turn writes it done; a lone Agent's todo ends done with the answer's first line as summary | an agent's turn ends it: a lone Agent's todo ends with it, a refusal fails it, an abort stops it |
| T2 | A refused turn writes the agent and its lone-Agent todo failed | an agent's turn ends it: a lone Agent's todo ends with it, a refusal fails it, an abort stops it |
| T3 | An aborted turn (stopped outside the pane) stops the agent and its lone-Agent todo, keeping the task id for ▶ Resume, and interrupts its open calls | an agent's turn ends it: a lone Agent's todo ends with it, a refusal fails it, an abort stops it |
| T3a | An agent stopped outside the pane stops its lone-Agent todo and keeps its id to resume | an agent stopped outside the pane stops its lone-Agent todo, keeping its id to resume |
| T4 | A Workflow agent's end doesn't end the Workflow's todo | an agent's turn ends it: a lone Agent's todo ends with it, a refusal fails it, an abort stops it |

## The mod's MCP tools

| ID | Behaviour | Covered by |
|---|---|---|
| M1 | `mcp__todo__update` sets prompt, mode, status and summary, marks the todo run once running, and answers in plain text | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M2 | Done or failed is toasted | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M3 | An unknown todo number answers as an error | mcp__todo__update reports a change and mcp__todo__list reads the backlog |
| M4 | `mcp__todo__list` answers the backlog as JSON text | mcp__todo__update reports a change and mcp__todo__list reads the backlog |

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
| G5 | Renumbering moves the pane's open rows with it | a migration's renumbering moves the pane's open rows with it |
| G6 | Lists the unreleased build kept in `$.store` go to their path's repo, and the keys are deleted | lists the unreleased build kept in $.store are imported under their repo, then deleted |
| G7 | A stored list whose titles aren't all in the database keeps its key and the old backup keys | a stored list whose titles aren't all in the database keeps its key, and the old keys with it |
| G8 | A backup is dropped at a later start | a backup is dropped at a later start |
| G9 | A backup survives the start that wrote it | migration: session todos move in, backed up, deduped, renumbered on a clash, once |

## Pane, dialog and focus

| ID | Behaviour | Covered by |
|---|---|---|
| U1 | The tree keeps a subtask to one line, with no call rows or code | M3: a tagged Agent links its spawn and its tool calls show under it |
| U2 | Pressing a subtask turns the pane into a call browser, with nothing to press while nothing in it is long enough to fold | M3: a tagged Agent links its spawn and its tool calls show under it |
| U3 | The pane losing the keys (Esc) closes the dialog | M3: Esc (the pane losing the keys) closes the call browser |
| U4 | A todo's Details shows its prompt, summary, run ids and agents, with nothing to press | a todo's Details shows its prompt, summary, run ids and agents, with nothing to press |
| U5 | The call browser shows an Edit as a diff, JSON pretty-printed, durations, and "Running…" for an open call | a subtask's calls read as their tool would: an Edit as a diff, JSON pretty-printed |
| U6 | The ring's item gets the round border, every other item a blank cell; nothing lights without the keys | every focusable item lights the same border while the ring is on it, and keeps its room otherwise |
| U7 | The mod's own focus moves light the right item: a confirmation's safe choice, Pause→Resume, Resume→Pause, Stop→Refine, Keep/Cancel→the chip that asked, Take over→Refine, Delete→add input, Rename→the row | every focusable item lights the same border while the ring is on it, and keeps its room otherwise; Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring; Take over stops the other session's agents here and cancelling it puts the ring back; Delete removes the row and puts the ring on the add input; Rename stores the new title and puts the ring back on the row |
| U8 | In the tree an arrow key walks the ring like Tab, stops at the ends, and the wheel and page keys still scroll | in the tree an arrow key walks the ring like Tab, even when the tree is taller than the pane |
| U9 | The spinner turns while a todo runs | the spinner turns only while a todo runs |
| U10 | A titled divider sits above each todo, as wide as the pane's body less its padding, its number in the status color and the rest dim | a titled divider sits above each todo, sized to the pane, its number in the status color |
| U11 | A divider is never focusable: the arrows walk the same items, and the rows keep their blank room | a divider is never focusable: the arrows walk the same items and the rows keep their room |
| U12 | At a narrow width the divider cuts the title with … (or drops it) and still fits | at a narrow width the divider cuts the title with … and still fits |
| U13 | `todoDividers` `line` draws a plain dim rule | todoDividers "line" draws a plain dim rule |
| U14 | `todoDividers` `none` draws no divider | todoDividers "none" draws no divider |
| U15 | `CLAUDE_TODO_DIVIDERS` overrides the option, and an unknown value falls back to `titled` | CLAUDE_TODO_DIVIDERS overrides the option; an unknown value falls back to titled |

## The call browser

| ID | Behaviour | Covered by |
|---|---|---|
| B13 | Code and Markdown get no control or format character (escapes, C1, zero-width, bidi, separators, a surrogate half a cut leaves), so the host never refuses the dialog's drawing | the call browser hands Code and Markdown no control or format character, even where a cut splits an emoji |
| B14 | Escape on the dialog closes it, reopens the pane with the keys and puts the ring back where it was | Escape on the dialog closes it and puts the ring back where it was, keeping the keys in the pane |
| B15 | A dialog left open across a reload starts closed | a dialog left open across a reload starts closed |
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
