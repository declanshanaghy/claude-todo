# Validating the todo state machine

The state diagram in [architecture.md](architecture.md#a-todos-life) is drawn by hand, and the code that moves `Todo.status` is spread across many handlers. This page covers how we check that the two agree, and that the machine has no holes. It was todo #18.

## What has to be checked

- **Reachability**: every state can be reached from `[*]` (add).
- **Dead or stuck states**: every state has a way out, and a path to an end (`[*]`: deleted or expired).
- **Unhandled events**: each state has a defined answer to each button or report.
- **Diagram vs code**: every move the code makes is an edge in the diagram, and every edge in the diagram is a move the code makes.

## Candidates

| Tool | Reachability | Dead / stuck | Unhandled events | Diagram vs code | Input, and how we'd make it | Licence | Headless in GitHub Actions | Maintenance |
|---|---|---|---|---|---|---|---|---|
| **TLA+ TLC** (`tla2tools.jar`) | yes (state dump, invariants, `-coverage`) | yes (built-in deadlock check, liveness) | yes (an invariant per state and event) | yes (two transition relations in one spec) | TLA+ text, generated from the mermaid edges and the code table | MIT | yes: one jar, `java -cp tla2tools.jar tlc2.TLC` | active (stable v1.7.4; v1.8.0 pre-release Oct 2026) |
| Apalache (symbolic TLA+) | yes (bounded) | yes | yes | yes | the same TLA+, plus type annotations | Apache-2.0 | yes, but a zip with a launcher and Z3, not one jar | active (v0.62.4, Oct 2026) |
| Alloy 6 | yes | yes | yes | yes (set equality of two relations) | generated Alloy text | MIT, moving to Apache-2.0 | partly: the jar is the GUI, so headless use needs a driver | active but slow (v6.2.0, Jan 2025) |
| PlantUML | no | no | no | no (renders only) | close to mermaid | GPL/LGPL/MIT/Apache builds | yes, one jar | very active |
| Apache Commons SCXML | no (runs charts) | no | partly | no | SCXML XML | Apache-2.0 | needs a classpath of several jars | dormant (only a 2.0-M1 milestone) |
| Spring Statemachine | no (runtime library) | no | no | no | Java config | Apache-2.0 | needs Maven or Gradle | maintenance mode |
| UPPAAL (`verifyta`) | yes | yes | yes | yes | UPPAAL XML | proprietary: free for academics, paid otherwise | native binary and a licence key | active, closed source |
| itemis CREATE (ex Yakindu) | yes (editor checks) | yes | partly | no | `.ysc` statechart | commercial | needs the whole Eclipse install | active, commercial |

## The pick: TLA+ TLC

- It is the only candidate that does all four checks from **one MIT-licensed jar** fetched by URL, with no build tool.
- It is actively maintained, and it is the standard choice for model checking with a CLI.
- Our machine is tiny (10 states), so TLC explores all of it in about a second.
- The runner-up was Alloy 6: the same checks, but clumsier headless use and slower releases.

## How it works

`scripts/state-check.mjs` (run on node, like the other scripts; the hooks module is untouched):

1. Reads both machines:
   - the diagram: the `A --> B: label` lines of the `stateDiagram-v2` block in `architecture.md`;
   - the code: `hooks/transitions.json`, the one table of the moves the code may make and where it makes them. The code can't be read statically, because the moves are spread over handlers, hooks and `mcp__todo__update` reports, so the table is enforced instead: every status write passes a guard that reads its mirror, `hooks/transitions.ts` (a hooks module can't import JSON), and refuses any other move. The script first checks the mirror is the JSON.
2. Writes one TLA+ module holding both machines. `[*]` becomes `new` as a source and `gone` as a target. TLC starts each machine from every state, which gives what each state can reach, and it prints the transitions only one machine has.
3. Reads TLC's state dump and reports:
   - each transition in only one machine;
   - states unreachable from `[*]`;
   - dead ends (nothing leaves them);
   - stuck states (no path to `[*]`).

   It exits 1 when there are any.

Unhandled events aren't checked yet. That needs the table to list every event per state, as a target or an explicit refusal; then it's one more TLA+ set difference.

## Running it

```sh
brew install openjdk          # keg-only: leaves the /usr/bin/java stub alone
node scripts/state-check.mjs
```

- The script finds a JDK at `$JAVA_HOME/bin/java`, then Homebrew's `/opt/homebrew/opt/openjdk/bin/java` (or `/usr/local/...` on Intel), then `java` on `PATH`. It tries each with `-version`, because macOS's `/usr/bin/java` is a stub that fails without a JDK.
- `tla2tools.jar` v1.7.4 is downloaded once into `.cache/tla/` (gitignored) and checked against a pinned SHA-256. The generated `TodoStates.tla` lands in `.cache/tla/run/` for reading.
- When the code gains or loses a status move, update `hooks/transitions.json` in the same change and run `node scripts/transitions.mjs --write` to regenerate its mirror; until then the guard refuses the new move, and a test ("every status move the code makes is in hooks/transitions.json…") fails.

## Findings

From the first run (2026-10-31). Todo #23 fixed every mismatch; the script now reports none:

| Finding | Fixed by |
|---|---|
| `[*] → prompting` in the diagram, `[*] → pending → prompting` in the code | The diagram now has `[*] → pending` (＋ add) and `pending → prompting` (drafter spawned), which is what the code does |
| `drafting → paused` and `drafting → failed` missing from the diagram | Added to the diagram as "prompt refused · resume started nothing" |
| `done → failed`: a lone agent's end marked its todo done before anyone knew whether the work landed | `turn.complete` now keeps the todo running (with the answer's first line as its summary) until Claude reports done or failed; a refused turn still fails it at once. The move is gone from the table |
| `mcp__todo__update` accepted any status from any state | It refuses a move the table doesn't allow with an error naming the allowed ones, and writes nothing. Every internal write passes the same guard in `editTodos`, which keeps the old status and warns |
| Nothing kept the table honest | A test drives every move and checks the moves written to the database are exactly the table's (bar the self-loop and the expiry, which write nothing) |

The original findings, as found:

- `[*] → prompting` is in the diagram, but the code never makes it: `addTodo` writes `pending`, and the drafter's launch then moves it `pending → prompting`.
- `[*] → pending` is in the code but not the diagram: every add, and the only path when the drafter can't spawn. The prose mentions it; the diagram doesn't.
- `drafting → paused` and `drafting → failed` are in the code but not the diagram. A refused `$.prompt.submit` (`submit`) puts the todo back to its earlier status, and so does a resume that started nothing (protocol.ts, resume step 3). That status may be paused or failed. The diagram only has `drafting → pending/stopped`, and only as Reset.
- `done → failed` is in the code but not the diagram. `turn.complete` marks a lone agent's todo done whenever the agent ends without refusing, and Claude then reports `failed` if the work didn't land (protocol.ts step 6).
- Confirmed by reading the code, not by the model: `mcp__todo__update` accepts any status from any state, so the Claude-reported edges (drafting → planning/running, running → done/failed/stopped) are only what protocol.ts asks for. Nothing enforces them.
- Not confirmed as a mismatch: a todo `paused` without having run is handled (`isRunnable`, `resumeTodo`), but nothing in the code puts one there except older or imported data. The model has no `hasRun`, so it can't see this. Its exit, `paused → drafting`, is in both machines.
- Not a mismatch at the level of state pairs: ⇄ Takeover, and an agent aborted outside the pane, only make moves the diagram already has (`running/paused/drafting/planning → stopped`). Only the edge labels leave them out, and the prose covers both.
- No state is unreachable, a dead end or stuck, in either machine.

## Wiring it into CI (not done yet)

- **The job:** add a job (or step) to `.github/workflows/ci.yml`:
  - `actions/setup-java` (Temurin, any LTS) sets `JAVA_HOME`, which the script tries first;
  - `actions/cache` keyed on the jar version in the script, with the path `.cache/tla`, so the jar is fetched once;
  - `node scripts/state-check.mjs`.
- **The findings first:** done; it exits 0, so it can gate merges as it stands.
- **Keeping the table honest:** done, by the guard and the test above; CI's "Transition table" job checks the mirror.
