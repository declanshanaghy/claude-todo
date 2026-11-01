# claude-todo: working rules

The todo mod: a per-repo backlog with a pane beside the chat that turns titles into subagent work. Read `docs/architecture.md` first; `docs/test-cases.md` lists every behaviour and the test that covers it.

## Pane UI rules (must hold, every change)

The pane sits in a narrow column beside the chat, so it has to be as compact and easy to scan as possible.

1. **One line per element, and no blank lines anywhere**: no spacer `Text`, no vertical `padding`/`margin`, no borders around items. This holds in the tree and in the details dialog alike. The dialog's frame is its only border. The one exception is the tree's rule lines, each a single dim line in `DIVIDER`'s color (`hooks/marks.tsx`), cut to the tree's width and never focusable: a double `═` above the first todo shown, a single `─` above each later one, and a double `═` directly above the `N hidden by the view` footer. None other, never inside a todo's levels or the dialog, and never a blank line or padding in their place.
2. **A todo's actions are always one row.** Every state, a just-stopped one included, draws its chips in a single `Box` that never wraps. Order: carry on (Exec, Resume) → start over (Refine, Restart) → put away or destroy (Leave, Delete, Stop) → **Details last**. Keep it to at most six chips; if a state needs more, rethink the state.
3. **Only a confirmation adds a line:** one question line above its one row of choices, with the focus ring starting on the safe choice.
4. **Focus never changes an item's size.** Every focusable element goes through `ringBox`/`lit` (`hooks/pane.tsx`). The lit item gets an orange `[ ]` in the cell on either side, and every other item keeps those two cells blank. Never use a border or vertical room for focus.
5. **Chips:** a symbol plus a one-word label under 10 letters. The fill is the color of the status the action moves the todo to; Details, which moves no status, wears its own teal `details` tone, ✎ Rename its orange `edit` tone, and the other chips that move no status the mauve `stay` tone. **An enabled chip is never grey or dim: grey/dim means disabled** (`GREYS`), so the only muted chip is a dimmed one (rule 6). Symbols and colors come only from `hooks/marks.tsx`, which is also what the rows, counts and statusline use, so never hard-code a status color.
6. **Hidden or dimmed:** a todo's action chips appear only in states where they act, never dimmed. A persistent header control (🔥 Fire) is never hidden: while it can't act it is drawn dimmed (`statusChip`'s `isDimmed`), stays a focus stop, and a press only says why.
7. **Rows truncate and never wrap.** Titles and rules are cut with `…` to `e.props.bodyColumns`.
8. **Counts show in exactly one place**: the pane's header while it's drawn, else the statusline.
9. **Text for `Code` or `Markdown` goes through `clean()` (`hooks/detail.tsx`) after any truncation.** The host refuses a whole drawing over a single control character, and a refused drawing wedges the pane.
10. **Change `docs/mockup.html` with the pane**, so the two never disagree.

The tests enforce 1–4. A new element or state needs a test there too.

## Engine constraints that bite

- **No Node, Bun or `require`**, in the hooks module or in tests. Only `$` reaches outside: files, processes, store, clock. `claude plugin validate` refuses dynamic `import()` and `$` passed through a namespace member call, so import named functions.
- **A render never writes state.** Write from a handler, a hook, or `$.clock.after(0, …)`.
- **The mod's own `$.ui.focus` call skips its own `ui.focus` hook.** Note the ring before calling it. In tests that call has no implementation and throws.
- **Esc always hands the keys back to the prompt**, where a second Esc cancels a running turn. So the dialog opens the pane with `closeOnEscape`: Esc then raises the person's `ui.close`, which the mod answers by closing the dialog and keeping the pane, and it takes the keys back with `$.ui.open({ focus: true })`.
- **After a Stop, the host refuses a plugin's `$.prompt.submit` until the person types** ("the session was stopped and nobody has sent input since"). `submit` holds the prompt, and the `prompt.submit` hook sends it after their next message. Never treat that refusal as a failure.
- **A prompt submitted from inside a hook waits on that hook's own turn.** Submit from `$.clock.after(0, …)`.
- **Arrow keys scroll a pane taller than its window.** The `ui.scroll` hook turns ±1 arrows into ring moves.
- **The host aborts a hook's in-flight `$.process.run` when the turn or agent it serves ends.** Database errors must stay non-fatal (`warn`). Only a missing `sqlite3` or data folder makes the pane read-only (`fail`).
- **`$.ui.status` takes plain text only.**
- **`Image` sources must be paths the host will open.** `$.fs.stat` them first, or the whole drawing is refused.
- **An agent stopped by the person won't take a `SendMessage`.** One stopped with `TaskStop` will. Resume falls back to a fresh agent on the kept worktree.

## Storage

SQLite through the `sqlite3` CLI, with all SQL in `hooks/db.ts`. One process runs per script, so no transaction may span the mod's own logic. Todo writes carry the list's `rev`, and a guard row aborts a stale one, which the mod then retries. Every script starts with a `-- op <json>` line, and the test engine's in-memory stand-in answers from that line, not from the SQL. So after changing SQL, also run the scripts against a real `sqlite3` file. Never store image bytes, only references.

## Developing

- **Checks:** `npm run lint`, `npm run typecheck`, `claude plugin validate .`, `claude plugin test .`, `npm run coverage`, `npm run transitions`. CI runs all of them. `node scripts/state-check.mjs` (needs a JDK) model-checks the state diagram against `hooks/transitions.json`; after editing that table, `node scripts/transitions.mjs --write` regenerates the guard's mirror.
- **A fresh worktree** lacks the gitignored engine types: copy `.claude-plugin/types` in from the main checkout, and run `npm ci`.
- **Test coverage list:** every behaviour gets a row in `docs/test-cases.md` (unique id, the covering test's title), and the "Coverage: X of Y" line must match the rows, or CI fails.
- **Test kit quirks:** register each event hook once (put options on `engine()`'s `where` argument), and register hooks before the first `$` call. Drive timers with `mock.clock` and `ownClock: false`.
- **This checkout runs the mod live** in sessions started here. Work only lands in them after `git pull --ff-only` on `main`.

## Todos and git

`hooks/protocol.ts` is the source of truth for how Claude runs a todo: the exec, restart and resume prompts and the git rules. In short:
- each todo works in its own worktree and commits as it goes
- it lands only once the checks pass, squashed to one commit, rebased onto the latest `origin/main`, re-checked, never force-pushed
- the landed message reads `<area>: <imperative>` (72 columns at most), followed by the why and what, the checks it passed, and `Todo: #N`

Direct fixes follow the same rules. A protocol change needs matching assertions in the protocol tests.

Triage: fix logic and processing errors immediately; queue cosmetic and research work as todos.
