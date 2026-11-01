import type { Kept, Todo } from '../types'

// The texts the mod submits as prompts. The model does the asking, planning
// and launching; the mod only tracks and controls what it launched.

const TAG_RULES = (n: number) => `Linking rules (the todo pane tracks work by these, so follow them exactly):
- A single background Agent's description starts with "[todo:${n}] ".
- A Workflow script's meta.name starts with "todo-${n}-".
- Report every status change with the mcp__todo__update tool.`

// Every todo works on its own branch in its own worktree, commits as it goes,
// and lands on the base branch as one squashed commit, rebased onto whatever
// other todos landed meanwhile and checked again, so each commit on the base
// passes on its own (bisectable) and says what it did and why. Parallel todos
// meet at the push: whoever lands second rebases onto the first and resolves
// the conflicts, so no todo's work is lost and none is forced.
const GIT_RULES = (n: number) => `Git rules: copy them, with <base> filled in, into the prompt of every agent that changes files.
- Work only in your own git worktree, on its own branch; never edit, commit in or check out anything in the main checkout. A worktree starts at <base>'s last commit, so uncommitted changes in the main checkout aren't in it.
- Commit as you go on your branch: small work-in-progress commits are fine there, since they're squashed before landing. Never finish with work uncommitted.
- Validate: run the project's own checks (what its README, package scripts or CI workflow run: tests, lint, typecheck, build). Fix what fails and commit the fixes. If they can't be made to pass, stop: land nothing, and report the failing check.
- Land, only once the checks pass. Other todos will have landed since you started, so:
  1. Squash: git fetch origin, then git reset --soft $(git merge-base HEAD origin/<base>) and git commit with the landing message below. Your branch is now one commit.
  2. git rebase origin/<base>. A conflict usually means another todo running in parallel changed the same files. Read its side (git log -p origin/<base> -- <file>) and resolve keeping both changes' intent; never drop theirs to keep yours. Continue the rebase.
  3. Run every check again on the rebased commit. Fix anything by amending that one commit (git commit --amend), so what lands passes on its own.
  4. git push origin HEAD:<base>. Rejected because <base> moved (another todo landed first)? git fetch origin and go back to 2.
  5. A conflict you can't resolve with confidence, or checks that fail after the rebase: git rebase --abort, push nothing, and report the conflicting files and your branch, which keeps the work.
  Never force-push, and push nothing but HEAD:<base>. With no origin remote, commit only and say so.
- The landing message: a summary line of at most 72 characters, "<area>: <what it does, imperative>"; a blank line; why it was needed and what changed, wrapped at 72 columns; the checks it passed; then the line "Todo: #${n}", then your usual commit attribution trailer. One todo lands as one commit: no merge, fixup or work-in-progress commits on <base>.
- Report back: your branch, the landed commit's hash and summary line, each check run and its result, and whether it landed or why not.`

const RUN_STEPS = (t: Todo, cap: number, auto = false) => `Base branch: before launching, run git branch --show-current in the main checkout; that branch is <base>. If git status there shows uncommitted changes, tell the user in one line that the todo won't see them, then go on.
3. Classify the final prompt:
   - simple: one coherent piece of work a single agent can finish without coordination
   - multi-step: separable subtasks, or several files/areas that parallel writers should change
4. Simple → call mcp__todo__update {n: ${t.n}, mode: "agent", status: "running"}, then launch Agent with run_in_background: true, isolation: "worktree", a description starting "[todo:${t.n}] ", and the final prompt plus any context it needs and the git rules below. The agent lands its own work. Do not wait for it.
5. Multi-step → call mcp__todo__update {n: ${t.n}, mode: "workflow", status: "planning"}, then:
${
  auto
    ? `   a. Auto mode: no plan mode and no questions. Settle every open point yourself with the best-effort default the repo and this session suggest, and note each default you chose.
   b. Write the plan in the chat: a mermaid execution tree (waves, which agents are writers in worktrees, the merge step), a subtask table and the defaults you chose. Don't ask for approval.
   c. Straight away, call Workflow with an inline script:`
    : `   a. EnterPlanMode. Interrogate the user with AskUserQuestion rounds (up to 4 questions each) until the problem and every subtask are unambiguous. Never assume what you can ask.
   b. Write the plan: a mermaid execution tree (waves, which agents are writers in worktrees, the merge step) and a subtask table. ExitPlanMode for approval.
   c. On approval, call Workflow with an inline script:`
}
      - meta.name "todo-${t.n}-<slug>"; meta.phases "Wave 1" … "Wave K"
      - every agent() gets label "w<K>:<name>" and phase "Wave <K>"; every agent that changes files gets isolation: "worktree" and a label ending "@wt"
      - data flows down the dependency tree only: pass each parent's returned result into its children's prompts; no queues or side channels
      - at most ${cap} agents in total; default to pipeline(), use a barrier only where a stage needs all prior results
      - a writer follows the git rules but doesn't land: it commits on its worktree branch, runs the checks that cover its part, and returns its branch name
      - the last wave is one "w<K>:merge@wt" agent in its own worktree: it merges every returned branch into its branch, resolving conflicts between writers by keeping both intents, then validates and lands per the git rules; it is the only agent that pushes
      - the script returns a one-line summary that says whether the work landed
   d. Call mcp__todo__update {n: ${t.n}, status: "running"}.
6. When the background task's completion notification arrives, call mcp__todo__update {n: ${t.n}, status, summary: "<one line>", branch: "<its branch>", landed: "<the pushed commit's hash, if it landed>"}. status is "done" only if the work landed (or there's no remote and it's committed); otherwise "failed", with a summary saying why and where the work is. Once it landed, remove its worktree (git worktree remove) and delete its local branch; a failed todo keeps both. A notification that says it was stopped (by the user or by Claude) means status "stopped", with a summary of where its work is; never leave the todo "running".
If the user dismisses a question at any point, call mcp__todo__update {n: ${t.n}, status: "${t.hasRun ? 'stopped' : 'pending'}"} and stop.

${GIT_RULES(t.n)}

${TAG_RULES(t.n)}`

// Auto mode takes the draft that would have been offered first and runs it
// without a question: no prompt to pick, and multi-step work is planned on
// best-effort defaults and launched without plan-mode approval.
//
// A todo whose drafting subagent already stored candidate prompts skips the
// drafting: the one question offers them as they are, and auto takes the
// first. `note` says why there are none when they were waited for in vain.
export function execPrompt(t: Todo, cap: number, refine: boolean, auto = false, note?: string): string {
  const drafts = refine ? [] : (t.drafts ?? [])
  const best = drafts[0]
  const draft = auto
    ? best
      ? `1. Auto mode: don't ask the user anything, and don't draft: this prompt was already drafted for the todo (the best of its drafts), so go on with it as it is:
   ${best.prompt}`
      : `1. Auto mode: don't ask the user anything. Draft the single best prompt for this todo (the one you would have offered first) from its title and this session's context (repo, recent work, open threads), and go on with it.`
    : refine
    ? `1. Refine the current prompt below. Ask with ONE AskUserQuestion (header "Refine", question 'Prompt for #${t.n} "${t.title}"?'): the first option is "Keep current prompt" with the current prompt as its description, followed by 2 refinements of it. Each option's description holds the full prompt.
   Current prompt: ${t.prompt ?? '(none)'}`
    : drafts.length
    ? `1. These prompts were already drafted for this todo: don't draft new ones. Straight away, ask with ONE AskUserQuestion (header "Prompt", question 'Prompt for #${t.n} "${t.title}"?') offering them in this order, each label as an option's label and its prompt, whole, as that option's description; the user can type their own via Other.
${drafts.map(d => `   - ${d.label}: ${d.prompt}`).join('\n')}`
    : `1. Draft 2–3 concrete prompts for this todo from its title and this session's context (repo, recent work, open threads). Ask with ONE AskUserQuestion (header "Prompt", question 'Prompt for #${t.n} "${t.title}"?'). Each option's label is a short name and its description is the full prompt; the user can type their own via Other.`
  return `[todo] Execute todo #${t.n} "${t.title}"${auto ? ' in auto mode' : ''}. Follow this protocol exactly.${note ? `\n(${note})` : ''}
${draft}
2. Call mcp__todo__update {n: ${t.n}, prompt: "<the final prompt>"}.
${RUN_STEPS(t, cap, auto)}`
}

// What a todo's drafting subagent is asked: the todo, what the session can
// tell it, and the one call that stores its drafts. It changes nothing.
export type DraftContext = { sessionTitle: string; others: string[] }

export function draftsPrompt(t: Pick<Todo, 'n' | 'title'>, key: string, ctx: DraftContext): string {
  const others = ctx.others.length ? ctx.others.map(x => `   - ${x}`).join('\n') : '   - none'
  return `Draft candidate prompts for todo #${t.n} "${t.title}" in the todo pane. You are read-only: never edit or write files, and never change git state.
Session: ${ctx.sessionTitle || '(untitled)'}
The directory's other todos:
${others}
1. Look around the repo just enough to make the prompts concrete (a few Grep, Glob or Read calls: the README, the files the title points at). Keep it short.
2. Call mcp__todo__drafts once: {n: ${t.n}, key: "${key}", drafts: [{label, prompt}, …]} with exactly 3 drafts, best first. A label is a short name of at most 5 words. A prompt is the whole, self-contained task for an agent that hasn't seen this conversation: what to change, where, and how to tell it's done.
3. Answer with one line: how many drafts you stored.`
}

export function restartPrompt(t: Todo, cap: number): string {
  return `[todo] Restart todo #${t.n} "${t.title}" from scratch with its current prompt (skip drafting; any old worktrees stay where they are):
Prompt: ${t.prompt ?? t.title}
${RUN_STEPS(t, cap)}`
}

// What a resume knows that a fresh agent would not: the work the todo's agents
// kept, and what they did, newest last.
export type ResumeContext = { kept: Kept[]; digest: string; canWake: boolean }

export function resumePrompt(t: Todo, ctx: ResumeContext): string {
  const kept = ctx.kept.length
    ? ctx.kept.map(k => `   - ${k.name}: ${k.path} (branch ${k.branch})`).join('\n')
    : '   - none found: no worktree of its agents is left'
  const wake =
    !ctx.canWake
      ? `1. Its agent can't be woken (stopped by the user, or its session is gone): go straight to 2.`
      : t.mode === 'workflow' && t.runId
        ? `1. Call Workflow with {scriptPath: ${JSON.stringify(t.scriptPath ?? '')}, resumeFromRunId: ${JSON.stringify(t.runId)}} so finished agents come back from cache.${ctx.kept.length ? ' First edit the script so its merge agent also merges the kept branches above that no finished agent returned (an interrupted writer re-runs in a new worktree, so its partial commits would otherwise be left out).' : ''} If that call is refused or fails (the run belongs to another session or an earlier process), go to 2.`
        : `1. Send the stopped background agent ${JSON.stringify(t.taskId ?? '')} a SendMessage: "Continue the task where you stopped." It carries on in the worktree it had. If the message is refused (e.g. it was stopped by the user and won't be resumed) or the agent is unknown, go to 2.`
  return `[todo] Resume todo #${t.n} "${t.title}".
Its prompt: ${t.prompt ?? t.title}
Work it kept (git worktrees of its agents):
${kept}
What its agents did before it stopped, newest last:
${ctx.digest || '   (nothing recorded)'}

Base branch: run git branch --show-current in the main checkout; that branch is <base>.
${wake}
2. Fallback: launch Agent with run_in_background: true and a description starting "[todo:${t.n}] " (no isolation: it works in a kept worktree). Its prompt: the todo's prompt above, then that it resumes work an earlier agent left, the kept worktrees and the record above, and these steps: cd into the first kept worktree (if it's gone or none was kept, git worktree add a new one, from that branch if it still exists, else off origin/<base>); read git log origin/<base>..HEAD, git status and git diff to see what's done; merge any other kept branches into it, keeping both sides' intent; then finish the task and land it under the git rules below.
3. Call mcp__todo__update {n: ${t.n}, status: "running"} only once the agent or run is actually going again. If neither 1 nor 2 started anything, call mcp__todo__update {n: ${t.n}, status: "${t.status}", summary: "resume failed: <why>"} and stop.
4. On its completion notification call mcp__todo__update {n: ${t.n}, status, summary: "<one line>", branch: "<its branch>", landed: "<the pushed commit's hash, if it landed>"}: "done" only if the work landed; "stopped" if it was stopped; else "failed" saying why and where the work is. Once it landed, remove its worktree and every kept worktree above, and delete their local branches.

${GIT_RULES(t.n)}

${TAG_RULES(t.n)}`
}
