import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNode, Call, Detail, PaneUi, Todo } from '../types'
import { drawDetail } from './detail'
import { drawPane } from './pane'
import { execPrompt, restartPrompt, resumePrompt } from './protocol'

export const PANE = 'todo'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const todos = atom({ plugin: 'todo', key: 'todos' } as const, [], { shape: 'todos-1' })
const agents = atom({ plugin: 'todo', key: 'agents' } as const, [], { shape: 'agents-1' })
const calls = atom({ plugin: 'todo', key: 'calls' } as const, [], { shape: 'calls-2' })
const ui = atom(
  { plugin: 'todo', key: 'ui' } as const,
  { expanded: [], confirm: null, renaming: null, justStopped: [], isHidden: false },
  { shape: 'ui-2' },
)
const cpuCap = atom({ plugin: 'todo', key: 'cpuCap' } as const, 1)
const spin = atom({ plugin: 'todo', key: 'spin' } as const, 0)
const detail = atom({ plugin: 'todo', key: 'detail' } as const, null as Detail)

const CALLS_PER_AGENT = 200
const CALLS_TOTAL = 1500
const FIELD_MAX = 3000
const RESPONSE_MAX = 6000
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'path', 'prompt']

type $ = EngineInterface

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const num = (m: RegExpExecArray | null) => (m ? Number(m[1]) : undefined)
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

// ---------- state helpers ----------

async function patchTodo($: $, n: number, fn: (t: Todo) => Todo) {
  await update($, todos, list => list.map(t => (t.n === n ? fn(t) : t)))
  await syncStatus($)
}

async function syncStatus($: $) {
  const list = await read($, todos)
  if (list.length === 0) return $.ui.status(undefined)
  const c = (s: Todo['status']) => list.filter(t => t.status === s).length
  $.ui.status(`todo ▶${c('running')} ⏸${c('paused')} ■${c('stopped')} ✓${c('done')} ○${c('pending')}`)
}

// The view-only detail dialog replaces the tree in the same pane, which
// already holds the keys; Escape hands them back and the render closes it.
export async function openDetail($: $, d: Detail) {
  await update($, detail, () => d)
}

export async function patchUi($: $, fn: (u: PaneUi) => PaneUi) {
  await update($, ui, fn)
}

export async function toggle($: $, id: string) {
  await patchUi($, u => ({
    ...u,
    expanded: u.expanded.includes(id) ? u.expanded.filter(x => x !== id) : [...u.expanded, id],
  }))
}

async function focus($: $, key: string) {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // The element may not be drawn yet; the ring stays where it is.
  }
}

export async function addTodo($: $, title: string) {
  const clean = title.trim()
  if (!clean) return undefined
  let n = 0
  await update($, todos, list => {
    n = Math.max(0, ...list.map(t => t.n)) + 1
    const t: Todo = { n, title: clean, status: 'pending', toolUseIds: [], hasRun: false }
    return [...list, t]
  })
  await syncStatus($)
  $.ui.toast(`＋ added #${n}`)
  return n
}

async function clearRun($: $, n: number) {
  const gone = new Set((await read($, agents)).filter(a => a.todoN === n).map(a => a.agentId))
  await update($, agents, l => l.filter(a => a.todoN !== n))
  await update($, calls, l => l.filter(c => !gone.has(c.agentId)))
}

// ---------- actions (pane buttons and /todo) ----------

export async function execTodo($: $, t: Todo, refine: boolean) {
  if (!refine && !['pending', 'stopped', 'failed'].includes(t.status)) return `#${t.n} is ${t.status}.`
  if (refine) await clearRun($, t.n)
  await patchTodo($, t.n, x => ({ ...x, status: 'drafting' }))
  await patchUi($, u => ({
    ...u,
    expanded: u.expanded.includes(`t${t.n}`) ? u.expanded : [...u.expanded, `t${t.n}`],
    justStopped: u.justStopped.filter(x => x !== t.n),
  }))
  await $.prompt.submit({ text: execPrompt(t, await read($, cpuCap), refine) })
  return `Executing #${t.n} ${t.title}: answer the prompt question in the chat.`
}

export async function restartTodo($: $, t: Todo) {
  await clearRun($, t.n)
  await patchTodo($, t.n, x => ({ ...x, status: 'drafting', taskId: undefined, runId: undefined }))
  await patchUi($, u => ({ ...u, justStopped: u.justStopped.filter(x => x !== t.n) }))
  await $.prompt.submit({ text: restartPrompt(t, await read($, cpuCap)) })
  $.ui.toast(`↻ restarting #${t.n}`)
}

export async function haltTodo($: $, t: Todo, to: 'paused' | 'stopped') {
  if (t.taskId) {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: t.taskId })
    if (r.deny !== undefined) $.ui.toast(`TaskStop refused: ${r.deny}`)
  }
  const live = new Set(
    (await read($, agents)).filter(a => a.todoN === t.n && (a.status === 'running' || a.status === 'paused')).map(a => a.agentId),
  )
  await update($, agents, l => l.map((a): AgentNode => (live.has(a.agentId) ? { ...a, status: to } : a)))
  await update($, calls, l => l.map((c): Call => (live.has(c.agentId) && c.state === 'run' ? { ...c, state: 'interrupted' } : c)))
  await patchTodo($, t.n, x => ({ ...x, status: to }))
  if (to === 'stopped') {
    await patchUi($, u => ({ ...u, confirm: null, justStopped: [...u.justStopped, t.n] }))
    await focus($, `act:${t.n}:refine`)
  } else {
    await focus($, `act:${t.n}:resume`)
  }
  $.ui.toast(to === 'paused' ? `⏸ #${t.n} paused` : `■ #${t.n} stopped`)
}

export async function resumeTodo($: $, t: Todo) {
  // A resumed Workflow replays finished agents from its journal and spawns the
  // rest afresh, so the interrupted nodes are left marked as such.
  if (t.mode === 'workflow') {
    await update($, agents, l => l.map((a): AgentNode => (a.todoN === t.n && a.status === 'paused' ? { ...a, status: 'stopped' } : a)))
  }
  await patchTodo($, t.n, x => ({ ...x, status: 'running' }))
  await patchUi($, u => ({ ...u, justStopped: u.justStopped.filter(x => x !== t.n) }))
  await $.prompt.submit({ text: resumePrompt(t, t.taskId) })
  await focus($, `act:${t.n}:pause`)
  $.ui.toast(`▶ resuming #${t.n}`)
}

export async function deleteTodo($: $, t: Todo) {
  await update($, todos, l => l.filter(x => x.n !== t.n))
  await patchUi($, u => ({ ...u, confirm: null }))
  await syncStatus($)
  await focus($, 'add')
  $.ui.toast(`✕ #${t.n} deleted`)
}

export async function renameTodo($: $, n: number, title: string) {
  const clean = title.trim()
  if (clean) await patchTodo($, n, t => ({ ...t, title: clean }))
  await patchUi($, u => ({ ...u, renaming: null }))
  await focus($, `todo:${n}`)
}

export async function askConfirm($: $, n: number, kind: 'stop' | 'delete') {
  await patchUi($, u => ({ ...u, confirm: { n, kind } }))
  // The ring starts on the safe choice.
  await focus($, `act:${n}:${kind === 'stop' ? 'keep' : 'cancel'}`)
}

export async function cancelConfirm($: $, n: number, kind: 'stop' | 'delete') {
  await patchUi($, u => ({ ...u, confirm: null }))
  await focus($, `act:${n}:${kind}`)
}

export async function setTodoStatus($: $, n: number, status: Todo['status']) {
  await patchTodo($, n, t => ({ ...t, status }))
}

async function findTodo($: $, arg: string) {
  const list = await read($, todos)
  const n = Number(arg.replace(/^#/, ''))
  if (Number.isInteger(n) && n > 0) return list.find(t => t.n === n)
  const q = arg.toLowerCase()
  return list.find(t => t.title.toLowerCase().includes(q))
}

// ---------- tracing ----------

function argsOf(e: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) out[k] = v
  return out
}

function previewOf(a: Record<string, unknown>) {
  for (const k of ARG_KEYS) if (typeof a[k] === 'string') return a[k] as string
  return (Object.values(a).find(v => typeof v === 'string') as string | undefined) ?? ''
}

function responseOf(ran: { deny?: string; text?: string; result?: unknown }) {
  if (ran.deny !== undefined) return `denied: ${ran.deny}`
  if (ran.text) return ran.text
  try {
    return JSON.stringify(ran.result, null, 1) ?? ''
  } catch {
    return String(ran.result)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Per-session todos: /todo add <title> · /todo exec <n|title> · /todo show · /todo noshow',
    })
    await $.tool.register({
      name: 'update',
      description:
        'Report a todo-pane todo change: its final prompt, mode, status, or one-line summary. Called by the [todo] exec/resume protocol.',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'Todo number' },
          status: { type: 'string', enum: ['pending', 'drafting', 'planning', 'running', 'paused', 'stopped', 'done', 'failed'] },
          prompt: { type: 'string' },
          mode: { type: 'string', enum: ['agent', 'workflow'] },
          summary: { type: 'string', description: 'One line, for done/failed' },
        },
        required: ['n'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list',
      description: "List this session's todos (number, title, status, prompt, summary).",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    let cap = 1
    for (const argv of [['sysctl', '-n', 'hw.ncpu'], ['nproc']]) {
      try {
        const r = await $.process.run(argv)
        const cpus = parseInt(r.stdout, 10)
        if (r.exitCode === 0 && cpus > 0) {
          cap = Math.max(1, cpus - 4)
          break
        }
      } catch {
        // try the next one
      }
    }
    await update($, cpuCap, () => cap)

    $.clock.every(500, () => {
      void (async () => {
        const list = await read($, todos)
        if (list.some(t => t.status === 'running')) await update($, spin, s => (s + 1) % 12)
      })()
    })

    const ran = await next(e)
    await syncStatus($)
    if (!(await read($, ui)).isHidden) void $.ui.open({ id: PANE, title: 'Todos', backgroundColor: 'transparent' })
    return ran
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    if (verb === 'noshow') {
      await patchUi($, u => ({ ...u, isHidden: true }))
      await $.ui.close({ id: PANE })
      return { text: 'Todo pane hidden; /todo show brings it back.' }
    }
    const asked = verb === '' || verb === 'list' || verb === 'show'
    if (asked) await patchUi($, u => ({ ...u, isHidden: false }))
    // Every /todo is the person asking, so the pane seats at any width; one
    // opened unasked at session start waits for a wide enough terminal.
    if (asked || !(await read($, ui)).isHidden) {
      const opened = await $.ui.open({ id: PANE, title: 'Todos', backgroundColor: 'transparent', focus: asked ? true : undefined })
      if (asked) return { text: opened.isPlaced ? 'Todo pane shown.' : `Todo pane can't be placed: ${opened.reason}` }
    }
    if (verb === 'add') {
      const n = await addTodo($, arg)
      return { text: n ? `Added #${n} ${arg.trim()}` : 'Usage: /todo add <title>' }
    }
    if (verb === 'exec') {
      const t = await findTodo($, arg)
      return { text: t ? await execTodo($, t, false) : `No todo matches "${arg}".` }
    }
    return { text: 'Usage: /todo [show] · /todo noshow · /todo add <title> · /todo exec <n|title>' }
  })

  on('tool.call', { tool: 'mcp__todo__update' as never }, async ($, e) => {
    const a = argsOf(e) as { n?: number; status?: Todo['status']; prompt?: string; mode?: Todo['mode']; summary?: string }
    const list = await read($, todos)
    const t = list.find(x => x.n === a.n)
    if (!t) return { result: `No todo #${a.n}.`, isError: true as const }
    await patchTodo($, t.n, x => ({
      ...x,
      ...(a.status ? { status: a.status } : {}),
      ...(a.prompt ? { prompt: a.prompt } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      hasRun: x.hasRun || a.status === 'running',
    }))
    if (a.status === 'done' || a.status === 'failed') $.ui.toast(`${a.status === 'done' ? '✓' : '✗'} #${t.n} ${a.status}`)
    const now = (await read($, todos)).find(x => x.n === t.n)
    return { result: `#${t.n} ${now?.title ?? t.title}: ${now?.status ?? t.status}` }
  })

  on('tool.call', { tool: 'mcp__todo__list' as never }, async $ => {
    const list = await read($, todos)
    // An MCP-style tool answers text (or content blocks), never a bare object.
    return { result: JSON.stringify(list.map(({ n, title, status, prompt, summary, mode }) => ({ n, title, status, prompt, summary, mode }))) }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith('mcp__todo__')) return next(e)
    const a = argsOf(e)

    // Main loop: link the Agent/Workflow call that launches a todo.
    if (e.agentId === undefined) {
      let n: number | undefined
      if (tool === 'Agent') n = num(/\[todo:(\d+)\]/.exec(String(a.description ?? '')))
      if (tool === 'Workflow') {
        n = num(/name\s*:\s*['"`]todo-(\d+)-/.exec(String(a.script ?? '')))
        if (n === undefined && typeof a.resumeFromRunId === 'string') {
          n = (await read($, todos)).find(t => t.runId === a.resumeFromRunId)?.n
        }
      }
      if (n === undefined) return next(e)
      const id = e.tool_use_id ?? ''
      await patchTodo($, n, t => ({ ...t, toolUseIds: [...t.toolUseIds, id], hasRun: true }))
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        const r = (ran.result ?? {}) as { agentId?: string; taskId?: string; runId?: string; scriptPath?: string }
        await patchTodo($, n, t =>
          tool === 'Agent'
            ? { ...t, mode: 'agent', status: 'running', taskId: r.agentId ?? t.taskId }
            : {
                ...t,
                mode: 'workflow',
                status: 'running',
                taskId: r.taskId ?? t.taskId,
                runId: r.runId ?? t.runId,
                scriptPath: r.scriptPath ?? t.scriptPath,
              },
        )
      }
      return ran
    }

    // A todo's agent: record the call and its response.
    const node = (await read($, agents)).find(x => x.agentId === e.agentId)
    if (!node) return next(e)
    const startedAt = await $.clock.now()
    const call: Call = {
      id: e.tool_use_id ?? `${e.agentId}:${startedAt}`,
      agentId: node.agentId,
      tool,
      arg: cut(previewOf(a).replace(/\s+/g, ' '), 120),
      fields: Object.entries(a).map(([k, v]) => ({
        k,
        v: cut(typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v)), FIELD_MAX),
      })),
      filePath: typeof a.file_path === 'string' ? a.file_path : undefined,
      state: 'run',
      startedAt,
    }
    await update($, calls, l => {
      const mine = l.filter(c => c.agentId === node.agentId)
      const drop = mine.length >= CALLS_PER_AGENT ? new Set([mine[0]!.id]) : new Set<string>()
      return [...l.filter(c => !drop.has(c.id)), call].slice(-CALLS_TOTAL)
    })
    const ran = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const now = (await read($, agents)).find(x => x.agentId === node.agentId)
    const state: Call['state'] =
      now && (now.status === 'paused' || now.status === 'stopped')
        ? 'interrupted'
        : ran.deny !== undefined || ran.isError
          ? 'err'
          : 'ok'
    const response = cut(responseOf(ran), RESPONSE_MAX)
    await update($, calls, l => l.map(c => (c.id === call.id ? { ...c, state, ms, response } : c)))
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !ran.agentId) return ran
    let n = (await read($, todos)).find(t => t.toolUseIds.includes(e.tool_use_id))?.n
    if (n === undefined && e.parentAgentId) {
      n = (await read($, agents)).find(a => a.agentId === e.parentAgentId)?.todoN
    }
    if (n === undefined) return ran
    const label = (e.description || e.name || e.subagentType || 'agent').replace(/^\[todo:\d+\]\s*/, '')
    const m = /^w(\d+)\s*:\s*(.*)$/.exec(label)
    const name = (m ? m[2]! : label).trim()
    const node: AgentNode = {
      agentId: ran.agentId,
      todoN: n,
      parentAgentId: e.parentAgentId,
      name: name.replace(/\s*@wt$/, ''),
      wave: m ? Number(m[1]) : undefined,
      kind: e.workflow ? 'workflow' : 'agent',
      isWorktree: /@wt$/.test(name),
      status: 'running',
      startedAt: await $.clock.now(),
    }
    await update($, agents, l => {
      const old = l.find(a => a.agentId === node.agentId)
      const next_: AgentNode = old ? { ...old, status: 'running' } : node
      return [...l.filter(a => a.agentId !== node.agentId), next_]
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const node = (await read($, agents)).find(a => a.agentId === id)
      if (node && node.status === 'running' && !e.isAborted) {
        const failed = 'reason' in e && e.reason === 'refusal'
        await update($, agents, l => l.map((a): AgentNode => (a.agentId === id ? { ...a, status: failed ? 'failed' : 'done' } : a)))
        // A lone background Agent's end is the todo's end; the model's later
        // mcp__todo__update may still replace the summary.
        const t = (await read($, todos)).find(x => x.n === node.todoN)
        if (t && t.mode === 'agent' && t.taskId === id && t.status === 'running') {
          await patchTodo($, t.n, x => ({ ...x, status: failed ? 'failed' : 'done', summary: cut(firstLine(e.answer ?? ''), 80) }))
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const d = await read($, detail)
    if (d) {
      // Escape (or a click elsewhere) takes the keys from the pane: close the
      // dialog then, from a timer, since a render never writes state.
      if (!e.props.isFocused) $.clock.after(0, () => void update($, detail, () => null))
      return drawDetail($, e, { detail: d, list: await read($, todos), nodes: await read($, agents), all: await read($, calls) })
    }
    return drawPane($, e, {
      list: await read($, todos),
      nodes: await read($, agents),
      all: await read($, calls),
      u: await read($, ui),
      cap: await read($, cpuCap),
      f: await read($, spin),
    })
  })
}
