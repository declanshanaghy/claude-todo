import type { Todo } from '../types'

// The texts the mod submits as prompts. The model does the asking, planning
// and launching; the mod only tracks and controls what it launched.

const TAG_RULES = (n: number) => `Linking rules (the todo pane tracks work by these, so follow them exactly):
- A single background Agent's description starts with "[todo:${n}] ".
- A Workflow script's meta.name starts with "todo-${n}-".
- Report every status change with the mcp__todo__update tool.`

const RUN_STEPS = (t: Todo, cap: number) => `3. Classify the final prompt:
   - simple: one coherent piece of work a single agent can finish without coordination
   - multi-step: separable subtasks, or several files/areas that parallel writers should change
4. Simple → call mcp__todo__update {n: ${t.n}, mode: "agent", status: "running"}, then launch Agent with run_in_background: true, a description starting "[todo:${t.n}] ", and the final prompt plus any context it needs. Do not wait for it.
5. Multi-step → call mcp__todo__update {n: ${t.n}, mode: "workflow", status: "planning"}, then:
   a. EnterPlanMode. Interrogate the user with AskUserQuestion rounds (up to 4 questions each) until the problem and every subtask are unambiguous. Never assume what you can ask.
   b. Write the plan: a mermaid execution tree (waves, which agents are writers in worktrees, the merge step) and a subtask table. ExitPlanMode for approval.
   c. On approval, call Workflow with an inline script:
      - meta.name "todo-${t.n}-<slug>"; meta.phases "Wave 1" … "Wave K"
      - every agent() gets label "w<K>:<name>" and phase "Wave <K>"; writers that change files in parallel get isolation: "worktree" and a label ending "@wt"
      - data flows down the dependency tree only: pass each parent's returned result into its children's prompts; no queues or side channels
      - at most ${cap} agents in total; default to pipeline(), use a barrier only where a stage needs all prior results
      - a worktree writer commits its work on its worktree branch and returns the branch name
      - the last wave is one "w<K>:merge" agent that merges every returned branch into the current branch, resolves conflicts, runs the relevant checks, and commits with your usual commit attribution trailer; it never pushes
      - the script returns a one-line summary
   d. Call mcp__todo__update {n: ${t.n}, status: "running"}.
6. When the background task's completion notification arrives, call mcp__todo__update {n: ${t.n}, status: "done" or "failed", summary: "<one line>"}.
If the user dismisses a question at any point, call mcp__todo__update {n: ${t.n}, status: "${t.hasRun ? 'stopped' : 'pending'}"} and stop.

${TAG_RULES(t.n)}`

export function execPrompt(t: Todo, cap: number, refine: boolean): string {
  const draft = refine
    ? `1. Refine the current prompt below. Ask with ONE AskUserQuestion (header "Refine", question 'Prompt for #${t.n} "${t.title}"?'): the first option is "Keep current prompt" with the current prompt as its description, followed by 2 refinements of it. Each option's description holds the full prompt.
   Current prompt: ${t.prompt ?? '(none)'}`
    : `1. Draft 2–3 concrete prompts for this todo from its title and this session's context (repo, recent work, open threads). Ask with ONE AskUserQuestion (header "Prompt", question 'Prompt for #${t.n} "${t.title}"?'). Each option's label is a short name and its description is the full prompt; the user can type their own via Other.`
  return `[todo] Execute todo #${t.n} "${t.title}". Follow this protocol exactly.
${draft}
2. Call mcp__todo__update {n: ${t.n}, prompt: "<the final prompt>"}.
${RUN_STEPS(t, cap)}`
}

export function restartPrompt(t: Todo, cap: number): string {
  return `[todo] Restart todo #${t.n} "${t.title}" from scratch with its current prompt (skip drafting; any old worktrees stay where they are):
Prompt: ${t.prompt ?? t.title}
${RUN_STEPS(t, cap)}`
}

export function resumePrompt(t: Todo, agentId?: string): string {
  const how =
    t.mode === 'workflow' && t.runId
      ? `Call Workflow with {scriptPath: ${JSON.stringify(t.scriptPath ?? '')}, resumeFromRunId: ${JSON.stringify(t.runId)}} so finished agents come back from cache.`
      : `Send the stopped background agent ${JSON.stringify(agentId ?? t.taskId ?? '')} a SendMessage: "Continue the task where you stopped."`
  return `[todo] Resume todo #${t.n} "${t.title}". ${how}
Then call mcp__todo__update {n: ${t.n}, status: "running"}, and on its completion notification mcp__todo__update {n: ${t.n}, status: "done" or "failed", summary: "<one line>"}.

${TAG_RULES(t.n)}`
}
