import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentNode, Call, Todo } from '../types'
import type { Op } from './db'
import { MARK, SUMMARY } from './marks'

const PANE = {
  plugin: 'todo',
  component: 'Pane',
  requestId: 'todo',
  props: {
    title: 'Todos',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Row = { dir: string; body: unknown }
// The database as the tests' engine holds it: what db.ts's scripts would leave
// in SQLite, answered from each script's `-- op` line.
export type Db = {
  rev: Record<string, number>
  todos: Record<string, Record<number, unknown>>
  agents: Record<string, Row & { todoN: number; session: string }>
  calls: Record<string, Row & { agentId: string; session: string; seq: number }>
  migrated: Record<string, { dir: string; at: number }>
  backups: Record<string, { dir: string; at: number; body: unknown }>
}
export const emptyDb = (): Db => ({ rev: {}, todos: {}, agents: {}, calls: {}, migrated: {}, backups: {} })

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const err = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })
type Ran = ReturnType<typeof ok>

type Where = {
  cwd?: string
  id?: string
  store?: Record<string, unknown>
  db?: Db
  // What `git rev-parse --show-toplevel` answers for a path; null outside a repo.
  repo?: (path: string) => string | null
  hasSqlite?: boolean
  // Why the engine drops a submitted prompt, when it does.
  drop?: string
  // What `git worktree list --porcelain` answers.
  worktrees?: string
  // Each $.ui.open's argument, readable by the test.
  openedWith?: { id: string; focus?: boolean }[]
  toasts?: string[]
  // The environment beyond HOME.
  env?: Record<string, string>
  // A file's mtime, for the sync loop's gate; undefined answers as missing.
  mtime?: (path: string) => number | undefined
  // A file's size in bytes, for a picture a Read names; undefined answers as missing.
  size?: (path: string) => number | undefined
  // How `mkdir -p` goes.
  mkdir?: 'ok' | 'fail' | 'throw'
  // Why the pane can't be placed, when it can't: an open answers it, and an
  // open pane is listed unplaced while it's set (a narrower terminal).
  unplaced?: string
  // Runs before the stand-in answers each script: may change `db` (another
  // session's write between a read and a write), or answer instead.
  sql?: (op: Op, db: Db) => Ran | undefined
}

function sqlite(db: Db, op: Op) {
  const bump = (dir: string, rev: number) => {
    if ((db.rev[dir] ?? 0) !== rev) return false
    db.rev[dir] = rev + 1
    return true
  }
  const list = (dir: string) => (db.todos[dir] ??= {})
  const top = () => Math.max(0, ...Object.values(db.calls).map(c => c.seq))
  switch (op.kind) {
    case 'read': {
      const d = op.dir
      const seqs = Object.values(db.calls).filter(c => c.dir === d).map(c => c.seq).sort((a, b) => b - a)
      return ok(
        JSON.stringify({
          rev: db.rev[d] ?? 0,
          todos: Object.entries(list(d)).sort(([a], [b]) => Number(a) - Number(b)).map(([, t]) => t),
          agents: Object.values(db.agents).filter(a => a.dir === d).map(a => a.body),
          floor: seqs[op.keep - 1] ?? 0,
          top: seqs[0] ?? 0,
        }),
      )
    }
    case 'calls': {
      const rows = Object.values(db.calls)
        .filter(c => c.dir === op.dir && c.seq > op.after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, op.limit)
      return ok(JSON.stringify({ rows: rows.map(c => ({ ...(c.body as object), seq: c.seq })), last: rows.at(-1)?.seq ?? null }))
    }
    case 'todos': {
      if (!bump(op.dir, op.rev)) return err('Runtime error near line 19: CHECK constraint failed: ok (19)')
      for (const n of op.del) Reflect.deleteProperty(list(op.dir), n)
      for (const t of op.put) list(op.dir)[t.n] = t
      return ok()
    }
    case 'agents': {
      for (const a of op.put) {
        db.agents[a.agentId] = { dir: op.dir, todoN: a.todoN, session: op.session, body: a }
      }
      for (const id of op.del) {
        Reflect.deleteProperty(db.agents, id)
        for (const [k, c] of Object.entries(db.calls)) if (c.agentId === id) Reflect.deleteProperty(db.calls, k)
      }
      return ok()
    }
    // A turn shares the calls table, its body marked kind: 'turn'.
    case 'call':
    case 'turn': {
      const c = op.put
      db.calls[c.id] = { dir: op.dir, agentId: c.agentId, session: op.session, seq: top() + 1, body: c }
      return ok()
    }
    case 'import': {
      if (db.migrated[op.id]) return err('Runtime error near line 17: UNIQUE constraint failed: migrated.id (19)')
      if (!bump(op.dir, op.rev)) return err('Runtime error near line 21: CHECK constraint failed: ok (19)')
      db.migrated[op.id] = { dir: op.dir, at: op.at }
      db.backups[op.id] = { dir: op.dir, at: op.at, body: op.backup }
      for (const t of op.put) list(op.dir)[t.n] = t
      return ok()
    }
    case 'backups':
      return ok(JSON.stringify(Object.entries(db.backups).map(([id, b]) => ({ id, dir: b.dir, at: b.at }))))
    case 'drop':
      for (const id of op.ids) Reflect.deleteProperty(db.backups, id)
      return ok()
  }
}

// Each hook stands for the engine beneath the plugin. `where` is read on every
// call, so a test can change it mid-way (the session's root, a file's mtime).
function engine(
  on: On,
  submitted: string[],
  panes = { opens: [] as string[], closes: [] as string[] },
  ownClock = true,
  where: Where = {},
) {
  // The store and the database in memory, readable by the test.
  const store: Record<string, unknown> = { ...where.store }
  const db = where.db ?? emptyDb()
  // Each script's op, the sqlite3 file it named, and each mkdir's folder.
  const ops: Op[] = []
  const files: string[] = []
  const folders: string[] = []
  // What the status line said, in order.
  const statuses: (string | undefined)[] = []
  // Every other process's argv, and each file written, by path.
  const runs: string[][] = []
  const written: Record<string, string> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_, e) => (Reflect.deleteProperty(store, e.key), { value: undefined }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.cwd', () => ({ value: where.cwd ?? '/proj' }))
  on('session.root', () => ({ value: where.cwd ?? '/proj' }))
  on('session.id', () => ({ value: where.id ?? 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : where.env?.[e.name] }))
  on('fs.stat', (_, e) => {
    const ms = where.mtime?.(e.path)
    const size = where.size?.(e.path)
    if (size !== undefined) return { value: { kind: 'file', size, mtimeMs: ms ?? 0, isLink: false } } as never
    return (ms === undefined ? { value: undefined } : { value: { kind: 'file', size: 0, mtimeMs: ms, isLink: false } }) as never
  })
  on('fs.write', (_, e) => ((written[e.path] = e.text), { value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__todo__${e.name}` } }))
  on('process.run', (_, e) => {
    const [bin = '', ...args] = e.argv
    if (bin === 'git' && args.includes('worktree')) return { value: ok(where.worktrees ?? '') }
    if (bin === 'git') {
      const top = (where.repo ?? (() => '/proj'))(args[1] ?? '')
      return { value: top === null ? { ...err('fatal: not a git repository'), exitCode: 128 } : ok(`${top}\n`) }
    }
    if (bin.endsWith('sqlite3')) {
      if (where.hasSqlite === false) throw new Error('ENOENT')
      if (args[0] === '-version') return { value: ok('3.43.2\n') }
      const stdin = e.init?.stdin ?? ''
      const op = JSON.parse(stdin.slice('-- op '.length, stdin.indexOf('\n'))) as Op
      ops.push(op)
      files.push(args[1] ?? '')
      return { value: where.sql?.(op, db) ?? sqlite(db, op) }
    }
    if (bin === 'mkdir') {
      folders.push(args[1] ?? '')
      if (where.mkdir === 'throw') throw new Error('EACCES')
      return { value: where.mkdir === 'fail' ? err('mkdir: Permission denied\n') : ok() }
    }
    runs.push([...e.argv])
    return { value: ok('10\n') }
  })
  if (ownClock) on('clock.every', () => ({ value: undefined }))
  const isOpen = new Set<string>()
  on('ui.open', (_, e) => {
    panes.opens.push(e.id)
    where.openedWith?.push({ id: e.id, ...(e.focus !== undefined ? { focus: e.focus } : {}) })
    isOpen.add(e.id)
    return { value: where.unplaced === undefined ? { isPlaced: true } : { isPlaced: false, reason: where.unplaced } } as never
  })
  on('ui.close', (_, e) => (panes.closes.push(e.id), isOpen.delete(e.id), { value: undefined }))
  on('ui.panes', () => ({
    value: [...isOpen].map(id => {
      const isPlaced = where.unplaced === undefined
      return { id, title: 'Todos', isShown: isPlaced, isFocused: false, isPlaced }
    }),
  }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (where.toasts?.push(e.text), { value: undefined }))
  on('prompt.submit', (_, e) => {
    if (where.drop !== undefined) return { drop: where.drop }
    submitted.push(e.text)
    return { text: e.text }
  })
  let t = 1000
  if (ownClock) on('clock.now', () => ({ value: (t += 250) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { store, db, ops, files, folders, statuses, runs, written, isOpen }
}

type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type T$ = Parameters<TestBody>[0]

const start = ($: T$) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const todo = ($: T$, args: string) => $.command.run({ command: 'todo', args } as never)
// A todo row as the database holds it; a missing one fails the test.
const todoAt = (db: Db, n: number, dir = '/proj') => {
  const t = db.todos[dir]?.[n]
  if (t === undefined) throw new Error(`no todo #${n} in ${dir}`)
  return t as Todo
}
const agentAt = (db: Db, id: string) => {
  const a = db.agents[id]
  if (a === undefined) throw new Error(`no agent ${id}`)
  return a.body as AgentNode
}
const callAt = (db: Db, id: string) => {
  const c = db.calls[id]
  if (c === undefined) throw new Error(`no call ${id}`)
  return c.body as Call
}

test('M1: /todo add stores a title-only todo and the pane lists it', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Fix kitty tab titles')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /cap 6 agents/ }))?.text).toBe('cap 6 agents')
  expect(submitted).toHaveLength(0)
  await ui.unmount()
})

test('M1: the pane input adds a todo', async ($, on) => {
  engine(on, [])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'add', text: 'Count md files' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await ui.unmount()
})

test('M2: Exec submits the exec protocol and marks the todo drafting', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:exec' })

  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('Execute todo #1 "Fix kitty tab titles"')
  expect(submitted[0]).toContain('[todo:1]')
  expect(await ui.find({ type: 'Button', key: 'act:1:reset' })).toBeDefined()
  await ui.unmount()
})

test('every protocol puts the work on its own worktree branch and lands it only after the checks pass', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([
    aTodo(1, 'New'),
    aTodo(2, 'Stopped', { status: 'stopped', hasRun: true, prompt: 'p', mode: 'agent' }),
    aTodo(3, 'Paused', { status: 'paused', hasRun: true, prompt: 'p', mode: 'agent', taskId: 'ag3' }),
  ])
  engine(on, submitted, undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const [n, act] of [[1, 'exec'], [2, 'restart'], [3, 'resume']] as const) {
    await ui.press({ key: `todo:${n}` })
    await ui.press({ key: `act:${n}:${act}` })
  }
  expect(submitted).toHaveLength(3)
  for (const text of submitted) {
    // Its own worktree, commits as it goes, the checks before landing.
    expect(text).toContain('Work only in your own git worktree')
    expect(text).toContain('Commit as you go')
    // One squashed, re-checked, well-described commit per todo.
    expect(text).toContain('git reset --soft $(git merge-base HEAD origin/<base>)')
    expect(text).toContain('Run every check again on the rebased commit')
    expect(text).toContain('git commit --amend')
    expect(text).toContain('"<area>: <what it does, imperative>"')
    expect(text).toContain('One todo lands as one commit')
    expect(text).toMatch(/Todo: #[123]"/)
    expect(text).toContain("run the project's own checks")
    // Parallel todos: rebase onto the base, resolve keeping both sides, retry; never force.
    expect(text).toContain('git rebase origin/<base>')
    expect(text).toContain('git push origin HEAD:<base>')
    expect(text).toContain('another todo landed first')
    expect(text).toContain("never drop theirs to keep yours")
    expect(text).toContain('git rebase --abort, push nothing')
    expect(text).toContain('Never force-push')
    expect(text).toContain('landed: "<the pushed commit')
    expect(text).not.toContain('it never pushes')
  }
  const [exec, restart] = submitted as [string, string, string]
  for (const text of [exec, restart]) {
    expect(text).toContain('isolation: "worktree", a description starting "[todo:')
    expect(text).toContain('it is the only agent that pushes')
    expect(text).toContain('git branch --show-current')
  }
  await ui.unmount()
})

test('M3: a tagged Agent links its spawn and its tool calls show under it', async ($, on) => {
  engine(on, [])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'a.md\nb.md', stderr: '' }, text: 'a.md\nb.md' }))
  await start($)
  await todo($, 'add Count md files')

  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count md files', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count md files', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls *.md', agentId: 'ag1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Button', key: 'act:1:pause' })).toBeDefined()
  // The tree keeps the subtask to one line: no tool call rows, no code.
  expect(await ui.find({ type: 'Button', key: 'call:c1' })).toBeUndefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()

  // Pressing the subtask turns the pane into the view-only call browser.
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Code', text: /ls \*\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /a\.md/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('M5: Stop asks first, keeps the todo, and offers what next', async ($, on) => {
  engine(on, [])
  const stopped: string[] = []
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    stopped.push(String(e.task_id))
    return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }
  })
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count', prompt: 'count', subagent_type: 'general-purpose' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:stop' })
  expect(await ui.find({ type: 'Button', key: 'act:1:keep' })).toBeDefined()
  expect(stopped).toHaveLength(0)
  await ui.press({ key: 'act:1:stopyes' })
  expect(stopped).toEqual(['ag1'])
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:refine' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:leave' })).toBeDefined()
  await ui.unmount()
})

test('M6: Delete is pre-exec only and confirms first', async ($, on) => {
  engine(on, [])
  await start($)
  await todo($, 'add Fix kitty tab titles')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:delete' })
  expect(await ui.find({ type: 'Button', key: 'act:1:cancel' })).toBeDefined()
  await ui.press({ key: 'act:1:deleteyes' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
})

test('M4: Pause stops the task, Resume asks Claude to continue it', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  const stopped: string[] = []
  on('tool.call', { tool: 'Workflow' }, () => ({
    result: { status: 'async_launched', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js' },
  }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    stopped.push(String(e.task_id))
    return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_workflow' } }
  })
  await start($)
  await todo($, 'add Migrate statusline')
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu1', script: "export const meta = { name: 'todo-1-statusline', description: 'x' }" } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:pause' })
  expect(stopped).toEqual(['task9'])
  await ui.press({ key: 'act:1:resume' })
  expect(submitted.at(-1)).toContain('resumeFromRunId: "wf_abc"')
  // In the chat's hands until Claude reports the run is going again.
  expect(await ui.find({ type: 'Button', key: 'act:1:reset' })).toBeDefined()
  await $.tool.call({ tool: 'mcp__todo__update', n: 1, status: 'running' } as never)
  expect(await ui.find({ type: 'Button', key: 'act:1:pause' })).toBeDefined()
  await ui.unmount()
})

test('show / noshow: noshow keeps the pane closed until show', async ($, on) => {
  const opens: string[] = []
  const closes: string[] = []
  engine(on, [], { opens, closes })
  await start($)
  opens.length = 0
  expect((await todo($, 'noshow')).text).toContain('hidden')
  expect(closes).toEqual(['todo'])
  await todo($, 'add Quiet one')
  expect(opens).toHaveLength(0)
  expect((await todo($, 'show')).text).toBe('Todo pane shown.')
  expect(opens).toEqual(['todo'])
  await todo($, 'add Loud one')
  expect(opens).toEqual(['todo', 'todo'])
})

test('M3: Esc (the pane losing the keys) closes the call browser', async ($, on) => {
  engine(on, [], undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count', tool_use_id: 'tu1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()

  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  await clock.advance(1)
  await blurred.unmount()
  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await back.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await back.unmount()
})


const legacyTodo = (n: number, title: string, status = 'pending') => ({ n, title, status, toolUseIds: [], hasRun: false })
const titles = (db: Db, dir: string) =>
  Object.values(db.todos[dir] ?? {}).map(t => `${(t as { n: number }).n} ${(t as { title: string }).title}`)

// What a version before 0.3 left in the session's state, each key under its
// shape tag.
const SHAPES = { todos: 'todos-1', agents: 'agents-1', calls: 'calls-2', ui: 'ui-2' } as const
type Legacy = Partial<Record<keyof typeof SHAPES, unknown>>
function legacyState(on: On, lists: Legacy) {
  const held = new Map<string, { value: unknown; version: number }>()
  for (const [k, v] of Object.entries(lists)) held.set(k, { value: { shape: SHAPES[k as keyof Legacy], value: v }, version: 1 })
  on('state.get', (_, e, next) => {
    const h = held.get(e.key)
    return h ? { value: h } : next(e)
  })
  on('state.set', (_, e, next) => {
    const h = held.get(e.key)
    if (!h) return next(e)
    held.set(e.key, { value: e.value, version: h.version + 1 })
    return { value: { isSet: true, version: h.version + 1 } }
  })
  return (key: keyof Legacy = 'todos') => held.get(key)?.value as { value?: unknown[] } | unknown[]
}

test('todos are saved under the repo the session is in', async ($, on) => {
  const { db } = engine(on, [], undefined, true, { cwd: '/proj/sub', repo: () => '/proj' })
  await start($)
  await todo($, 'add Fix kitty tab titles')
  expect(titles(db, '/proj')).toEqual(['1 Fix kitty tab titles'])
})

test('outside a repo, todos go to the home directory', async ($, on) => {
  const { db } = engine(on, [], undefined, true, { cwd: '/tmp/x', repo: () => null })
  await start($)
  await todo($, 'add Somewhere')
  expect(titles(db, '/home/me')).toEqual(['1 Somewhere'])
})

test('a session in the same repo sees the stored todos', async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: legacyTodo(1, 'Kept') }
  engine(on, [], undefined, true, { id: 's2', db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await ui.unmount()
})

test('a session in another repo starts empty', async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: legacyTodo(1, 'Kept') }
  engine(on, [], undefined, true, { db, repo: () => '/other' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
})

test('a write another session beat is re-read and applied on top', async ($, on) => {
  const { db } = engine(on, [])
  await start($)
  await todo($, 'add Mine')
  // Another session adds #2 meanwhile, moving the list's rev.
  ;(db.todos['/proj'] ??= {})[2] = legacyTodo(2, 'Theirs')
  db.rev['/proj'] = (db.rev['/proj'] ?? 0) + 1
  await todo($, 'add Also mine')
  expect(titles(db, '/proj')).toEqual(['1 Mine', '2 Theirs', '3 Also mine'])
})

test('migration: session todos move in, backed up, deduped, renumbered on a clash, once', async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: legacyTodo(1, 'Already here'), 2: legacyTodo(2, 'second') }
  const { store } = engine(on, [], undefined, true, { id: 'old', db })
  const held = legacyState(on, { todos: [legacyTodo(1, 'From session'), legacyTodo(2, 'Second '), legacyTodo(3, 'Third', 'done')] })
  await start($)
  // "Second " never ran and matches #2, so it collapses into it.
  expect(titles(db, '/proj')).toEqual(['1 Already here', '2 second', '3 Third', '4 From session'])
  expect(Object.keys(db.migrated)).toEqual(['session:old'])
  expect(db.backups['session:old']?.body).toHaveLength(3)
  expect(held()).toEqual({ shape: 'todos-1', value: [] })
  expect(store).toEqual({})

  // A reload runs session.start again: nothing is added twice.
  await start($)
  expect(titles(db, '/proj')).toHaveLength(4)
})

test('a backup is dropped at a later start', async ($, on) => {
  const db = emptyDb()
  db.backups['session:gone'] = { dir: '/proj', at: 1, body: [] }
  engine(on, [], undefined, true, { db })
  await start($)
  expect(db.backups).toEqual({})
})

test('lists the unreleased build kept in $.store are imported under their repo, then deleted', async ($, on) => {
  const store = {
    'dir:/proj/sub': { todos: [legacyTodo(1, 'From store')], migrated: ['x'] },
    'dir:/loose': { todos: [legacyTodo(1, 'Loose')], migrated: [] },
    'backup:x': { dir: '/proj/sub', at: 1, todos: [] },
    'alive:x': 5,
  }
  const repo = (p: string) => (p.startsWith('/proj') ? '/proj' : null)
  const { db, store: left } = engine(on, [], undefined, true, { store, repo })
  await start($)
  expect(titles(db, '/proj')).toEqual(['1 From store'])
  expect(titles(db, '/home/me')).toEqual(['1 Loose'])
  expect(left).toEqual({})
})

test('agents and tool calls are kept, so a later session can browse them', async ($, on) => {
  const db = emptyDb()
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'a.md', stderr: '' }, text: 'a.md' }))
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count md files', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count md files', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls *.md', agentId: 'ag1' } as never)

  expect(db.agents['ag1']).toMatchObject({ dir: '/proj', todoN: 1, session: 's1' })
  expect(callAt(db, 'c1')).toMatchObject({ tool: 'Bash', state: 'ok', response: 'a.md', fields: [{ k: 'command', v: 'ls *.md' }] })
})

test('a restarted session browses the calls it kept', async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: { ...legacyTodo(1, 'Count md files', 'done'), hasRun: true, mode: 'agent' } }
  db.agents['ag1'] = {
    dir: '/proj', todoN: 1, session: 'gone',
    body: { agentId: 'ag1', todoN: 1, name: 'Count md files', kind: 'agent', isWorktree: false, status: 'done', startedAt: 1 },
  }
  db.calls['c1'] = {
    dir: '/proj', agentId: 'ag1', session: 'gone', seq: 1,
    body: { id: 'c1', agentId: 'ag1', tool: 'Bash', arg: 'ls *.md', fields: [{ k: 'command', v: 'ls *.md' }], response: 'a.md', state: 'ok', startedAt: 1 },
  }
  engine(on, [], undefined, true, { id: 's2', db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Code', text: /ls \*\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /a\.md/ })).toBeDefined()
  await ui.unmount()
})

test("another session's running todo offers Take over, which stops it here", async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: { ...legacyTodo(1, 'Busy', 'running'), owner: 'other', taskId: 'x', runId: 'wf_x' } }
  engine(on, [], undefined, true, { id: 's2', db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Button', key: 'act:1:pause' })).toBeUndefined()
  await ui.press({ key: 'act:1:takeover' })
  // The ring starts on the safe choice.
  expect(await ui.find({ type: 'Button', key: 'act:1:cancel' })).toBeDefined()
  await ui.press({ key: 'act:1:takeyes' })
  const t = todoAt(db, 1)
  expect(t.status).toBe('stopped')
  expect(t.taskId).toBeUndefined()
  expect(t.owner).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:refine' })).toBeDefined()
  await ui.unmount()
})

test('without sqlite3 the pane says why and stays read-only, keeping 0.2 todos in place', async ($, on) => {
  const toasts: string[] = []
  engine(on, [], undefined, true, { hasSqlite: false, toasts })
  const held = legacyState(on, { todos: [legacyTodo(1, 'Old one')] })
  await start($)
  expect((await todo($, 'add Refused')).text).toBe('Not added: the todo list could not be saved.')
  // Refused, not claimed as added (it once toasted "＋ added #0").
  expect(toasts.some(t => t.startsWith('＋'))).toBe(false)
  expect(toasts.at(-1)).toMatch(/^todo is read-only: sqlite3 was not found/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /sqlite3 was not found/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'todo:2' })).toBeUndefined()
  expect(held()).toEqual({ shape: 'todos-1', value: [legacyTodo(1, 'Old one')] })
  await ui.unmount()
})

test('a dropped exec prompt puts the todo back and says why', async ($, on) => {
  const toasts: string[] = []
  const { db } = engine(on, [], undefined, true, { drop: 'a Stop stands', toasts })
  await start($)
  await todo($, 'add Fix focus ring')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:exec' })
  expect(todoAt(db, 1).status).toBe('pending')
  expect(toasts).toContain("#1 didn't start: a Stop stands")
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeDefined()
  await ui.unmount()
})

test('every focusable item lights the same border while the ring is on it, and keeps its room otherwise', async ($, on) => {
  engine(on, [])
  await start($)
  await todo($, 'add Fix focus ring')
  // The border's color, or `blank` for the cell of room an unlit item keeps.
  const lit = async (ui: { find: (q: { type: string; key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string) => {
    const p = (await ui.find({ type: 'Box', key: `ring:${key}` }))?.props
    return p?.['borderStyle'] === 'round' ? p['borderColor'] : p?.['padding'] === 1 ? 'blank' : p
  }
  const tab = (element: string) =>
    $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element, origin: { kind: 'person' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  // The person tabs across an input, a todo row and an action chip.
  for (const key of ['add', 'todo:1', 'act:1:rename']) {
    await tab(key)
    for (const other of ['add', 'todo:1', 'act:1:exec', 'act:1:rename', 'act:1:delete']) {
      expect(await lit(ui, other)).toBe(other === key ? 'claude' : 'blank')
    }
  }
  // A confirmation's safe choice lights as the mod moves the ring there.
  await ui.press({ key: 'act:1:delete' })
  expect(await lit(ui, 'act:1:cancel')).toBe('claude')
  expect(await lit(ui, 'act:1:deleteyes')).toBe('blank')
  await ui.unmount()

  // Without the keys the pane lights nothing.
  const away = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: false } })
  expect(await lit(away, 'act:1:cancel')).toBe('blank')
  await away.unmount()
})

test('in the tree an arrow key walks the ring like Tab, even when the tree is taller than the pane', async ($, on) => {
  engine(on, [])
  await start($)
  await todo($, 'add First')
  await todo($, 'add Second')
  const lit = async (ui: { find: (q: { type: string; key: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, key: string) =>
    (await ui.find({ type: 'Box', key: `ring:${key}` }))?.props['borderStyle'] === 'round'
  const arrow = (by: 1 | -1, bodyRows = 4) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: Math.max(0, by), by, bodyRows, contentRows: 40, origin: { kind: 'person' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'todo:1', origin: { kind: 'person' } })
  // Down walks into #1's actions, past the window's height, and the window stays put.
  expect((await arrow(1)).deny).toBeDefined()
  expect(await lit(ui, 'act:1:exec')).toBe(true)
  for (const key of ['act:1:rename', 'act:1:delete', 'act:1:details', 'todo:2']) {
    await arrow(1)
    expect(await lit(ui, key)).toBe(true)
  }
  // Up walks back; it stops at the first element.
  await arrow(-1)
  expect(await lit(ui, 'act:1:details')).toBe(true)
  for (let i = 0; i < 9; i++) await arrow(-1)
  expect(await lit(ui, 'add')).toBe(true)
  // The wheel and page keys still scroll.
  expect((await $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: 4, by: 4, bodyRows: 4, contentRows: 40, origin: { kind: 'person' } })).deny).toBeUndefined()
  await ui.unmount()
})

// ---------- fixtures for the cases below ----------

type Drawing = { find: (q: { type: string; key?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown>; text?: string } | undefined> }
// Whether the ring's border is drawn around `key`.
const isLit = async (ui: Drawing, key: string) => (await ui.find({ type: 'Box', key: `ring:${key}` }))?.props['borderStyle'] === 'round'

const agentNode = (agentId: string, todoN: number, over: Partial<AgentNode> = {}): AgentNode => ({
  agentId, todoN, name: agentId, kind: 'agent', isWorktree: false, status: 'running', startedAt: 1, ...over,
})
const callRow = (id: string, agentId: string, over: Partial<Call> = {}): Call => ({
  id, agentId, tool: 'Bash', arg: 'ls', fields: [{ k: 'command', v: 'ls' }], response: 'a.md', state: 'ok', startedAt: 1, ...over,
})
// A call still running has no response yet.
const unanswered = ({ response: _response, ...c }: Call): Call => c
// A database holding todos, agents and calls as earlier sessions left them.
function seeded(todos: Todo[], agents: AgentNode[] = [], calls: Call[] = [], dir = '/proj', session = 's1') {
  const db = emptyDb()
  db.todos[dir] = Object.fromEntries(todos.map(t => [t.n, t]))
  for (const a of agents) db.agents[a.agentId] = { dir, todoN: a.todoN, session, body: a }
  calls.forEach((c, i) => (db.calls[c.id] = { dir, agentId: c.agentId, session, seq: i + 1, body: c }))
  return db
}
const aTodo = (n: number, title: string, over: Partial<Todo> = {}): Todo => ({ n, title, status: 'pending', toolUseIds: [], hasRun: false, ...over })
// This session's lone Agent run of todo #n, in flight.
const running = (n: number, title: string, over: Partial<Todo> = {}) =>
  aTodo(n, title, { status: 'running', hasRun: true, mode: 'agent', taskId: `ag${n}`, owner: 's1', ...over })
const turnDone = ($: T$, agentId: string, answer: string, extra: { isAborted?: boolean; refused?: boolean } = {}) =>
  $.turn.complete({
    answer, durationMs: 1, isAborted: extra.isAborted ?? false, turnId: `turn-${agentId}`, agentId,
    ...(extra.refused ? { reason: 'refusal', refusal: {} } : { reason: extra.isAborted ? 'aborted' : 'answer' }),
  } as never)

// ---------- commands ----------

test('/todo add with no title, an unknown verb, and an unplaceable pane each say so', async ($, on) => {
  const toasts: string[] = []
  const where: Where = { toasts }
  const { db } = engine(on, [], undefined, true, where)
  await start($)
  expect((await todo($, 'add   ')).text).toBe('Usage: /todo add <title>')
  expect((await todo($, 'frobnicate')).text).toContain('Usage: /todo [show]')
  expect(titles(db, '/proj')).toEqual([])
  where.unplaced = 'the terminal is too narrow'
  expect((await todo($, 'show')).text).toBe("Todo pane can't be placed: the terminal is too narrow")
})

test('/todo exec finds a todo by number or title fragment, submits once the command answered, and refuses one in flight', async ($, on) => {
  const submitted: string[] = []
  const { db } = engine(on, submitted, undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add Fix kitty tab titles')
  await todo($, 'add Count md files')
  expect((await todo($, 'exec nothing-like-it')).text).toBe('No todo matches "nothing-like-it".')
  expect((await todo($, 'exec md FILES')).text).toContain('Executing #2 Count md files')
  // The command's own hook can't submit; the timer it set does.
  expect(submitted).toHaveLength(0)
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #2 "Count md files"')
  expect((await todo($, 'exec #2')).text).toBe('#2 is drafting.')
  expect((await todo($, 'exec 1')).text).toContain('Executing #1')
  await clock.settle()
  expect(todoAt(db, 1).status).toBe('drafting')
  expect(submitted).toHaveLength(2)
})

test('the status line counts todos by status and clears with the last one', async ($, on) => {
  const { statuses } = engine(on, [], undefined, true, { unplaced: 'the terminal is too narrow' })
  await start($)
  await todo($, 'add One')
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:delete' })
  await ui.press({ key: 'act:1:deleteyes' })
  expect(statuses.at(-1)).toBeUndefined()
  await ui.unmount()
})

// ---------- the counts: the pane's header or the status line, never both ----------

// The header summary as drawn: each colored mark's text and color, in order.
type Drawn = { props?: { color?: unknown }; children?: unknown[] }
const headerMarks = async (ui: Drawing) => {
  const header = (await ui.find({ type: 'Text', text: /^Todos / })) as { children?: unknown[] } | undefined
  return ((header?.children ?? []) as Drawn[])
    .filter(c => typeof c === 'object' && c.props?.color !== undefined)
    .map(c => ({ text: (c.children ?? []).join('').trim(), color: c.props?.color }))
}

test('open: a placed pane counts in its header and clears the status line; an unplaced one leaves the counts to it', async ($, on) => {
  const where: Where = {}
  const { statuses } = engine(on, [], undefined, false, where)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add One')
  await clock.settle()
  // Never both: the status line said nothing while the header counted.
  expect(statuses.filter(x => x !== undefined)).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await headerMarks(ui)).map(m => m.text)).toEqual(['▶0', '⏸0', '■0', '✓0', '○1'])
  await ui.unmount()

  where.unplaced = 'the terminal is too narrow'
  await start($)
  await clock.settle()
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○1')
})

test('noshow hands the counts to the status line, and show takes them back', async ($, on) => {
  const { statuses } = engine(on, [], undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add One')
  expect(statuses.at(-1)).toBeUndefined()
  await todo($, 'noshow')
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○1')
  await todo($, 'add Two')
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○2')
  await todo($, 'show')
  await clock.settle()
  expect(statuses.at(-1)).toBeUndefined()
})

test('closing the pane with its × hands the counts to the status line; drawing it again takes them back', async ($, on) => {
  const { statuses, isOpen } = engine(on, [], undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add One')
  expect(statuses.at(-1)).toBeUndefined()
  // The kit can't raise the person's ui.close (noshow's runs the same hook),
  // so the engine just forgets the pane, as the × leaves it: the next tick sees.
  isOpen.delete('todo')
  await clock.advance(2000)
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○1')
  // The person opens it again: its render takes the counts back.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(1)
  expect(statuses.at(-1)).toBeUndefined()
  await ui.unmount()
})

test('a narrower terminal that unseats the pane hands the counts to the status line until it is drawn again', async ($, on) => {
  const where: Where = {}
  const { statuses } = engine(on, [], undefined, false, where)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add One')
  await clock.advance(2000)
  expect(statuses.at(-1)).toBeUndefined()
  where.unplaced = 'the terminal is too narrow'
  await clock.advance(2000)
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○1')
  // Widened: the pane is drawn again.
  delete where.unplaced
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(1)
  expect(statuses.at(-1)).toBeUndefined()
  await ui.unmount()
  await clock.advance(2000)
  expect(statuses.at(-1)).toBeUndefined()
})

test('the dialog covers the header, so the status line counts until it closes', async ($, on) => {
  const { statuses } = engine(on, [], undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add One')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:details' })
  expect(statuses.at(-1)).toBe('todo ▶0 ⏸0 ■0 ✓0 ○1')
  await ui.unmount()
  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  await clock.advance(1)
  await blurred.unmount()
  expect(statuses.at(-1)).toBeUndefined()
})

test('the header, the status line and the rows draw the same marks in the same order and colors', async ($, on) => {
  const db = seeded([
    running(1, 'Runs'),
    running(2, 'Waits', { status: 'paused' }),
    aTodo(3, 'Halted', { status: 'stopped', hasRun: true }),
    aTodo(4, 'Finished', { status: 'done', hasRun: true, doneAt: 1000 }),
    aTodo(5, 'Later'),
    aTodo(6, 'Also later'),
  ])
  const { statuses } = engine(on, [], undefined, false, { db, unplaced: 'the terminal is too narrow' })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await clock.settle()
  const line = statuses.at(-1)
  expect(line).toBe('todo ▶1 ⏸1 ■1 ✓1 ○2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const header = await headerMarks(ui)
  expect(`todo ${header.map(m => m.text).join(' ')}`).toBe(line)
  expect(header.map(m => m.color)).toEqual(['claude', 'warning', 'error', 'success', 'inactive'])
  expect(header.map(m => m.color)).toEqual(SUMMARY.map(s => MARK[s].color))
  // Each row's glyph is its status's mark; a running row spins in its color.
  for (const [n, s] of [[2, 'paused'], [3, 'stopped'], [4, 'done'], [5, 'pending']] as const) {
    const row = await ui.find({ type: 'Button', key: `todo:${n}` })
    expect(JSON.stringify(row?.children)).toContain(JSON.stringify(MARK[s].color))
    expect(row?.text).toContain(`${MARK[s].symbol} #${n}`)
  }
  expect(JSON.stringify((await ui.find({ type: 'Button', key: 'todo:1' }))?.children)).toContain(JSON.stringify(MARK.running.color))
  await ui.unmount()
})

test('Reset puts a drafting todo back to pending, or to stopped once it has run', async ($, on) => {
  const db = seeded([aTodo(1, 'Never ran', { status: 'drafting', owner: 's1' }), aTodo(2, 'Ran', { status: 'drafting', hasRun: true, owner: 's1' })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'todo:2' })
  await ui.press({ key: 'act:1:reset' })
  await ui.press({ key: 'act:2:reset' })
  expect(todoAt(db, 1).status).toBe('pending')
  expect(todoAt(db, 2).status).toBe('stopped')
  await ui.unmount()
})

test('Rename stores the new title and puts the ring back on the row', async ($, on) => {
  const { db } = engine(on, [])
  await start($)
  await todo($, 'add Old title')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:rename' })
  await ui.input({ key: 'ren:1', text: '  New title ' })
  expect(todoAt(db, 1).title).toBe('New title')
  expect(await isLit(ui, 'todo:1')).toBe(true)
  await ui.unmount()
})

// ---------- linking ----------

// ---------- linking ----------

test('a Workflow named todo-N- links, recording its mode, task, run and script', async ($, on) => {
  const { db } = engine(on, [])
  on('tool.call', { tool: 'Workflow' }, () => ({ result: { status: 'async_launched', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js' } }))
  await start($)
  await todo($, 'add Migrate statusline')
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu1', script: 'export const meta = { name: "todo-1-statusline" }' } as never)
  expect(todoAt(db, 1)).toMatchObject({ mode: 'workflow', status: 'running', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js', hasRun: true, toolUseIds: ['tu1'], owner: 's1' })
})

test('a resumed Workflow links by its resumeFromRunId, keeping what the result leaves out', async ($, on) => {
  const db = seeded([aTodo(1, 'Migrate', { status: 'paused', hasRun: true, mode: 'workflow', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js', toolUseIds: ['tu1'], owner: 's1' })])
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'Workflow' }, () => ({ result: { status: 'async_launched', taskId: 'task10' } }))
  await start($)
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu2', scriptPath: '/tmp/s.js', resumeFromRunId: 'wf_abc' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'running', taskId: 'task10', runId: 'wf_abc', scriptPath: '/tmp/s.js', toolUseIds: ['tu1', 'tu2'] })
  // An unrelated Workflow links nothing.
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu3', resumeFromRunId: 'wf_other' } as never)
  expect(todoAt(db, 1).toolUseIds).toEqual(['tu1', 'tu2'])
})

test('a refused launch links the call but leaves the todo where it was', async ($, on) => {
  const { db } = engine(on, [])
  on('tool.call', { tool: 'Agent' }, () => ({ deny: 'not now' }))
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count', prompt: 'p', subagent_type: 'general-purpose' } as never)
  const t = todoAt(db, 1)
  expect(t.status).toBe('pending')
  expect(t.taskId).toBeUndefined()
  expect(t.toolUseIds).toEqual(['tu1'])
})

test("a Workflow's agents link by its call and nested ones through their parent, grouped by wave", async ($, on) => {
  const { db } = engine(on, [])
  on('tool.call', { tool: 'Workflow' }, () => ({ result: { status: 'async_launched', taskId: 'task9', runId: 'wf_abc' } }))
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: (e as { name?: string }).name ?? 'x' }))
  await start($)
  await todo($, 'add Split the module')
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu1', script: "meta = { name: 'todo-1-split' }" } as never)
  await $.agent.spawn({ prompt: 'p', name: 'ag1', description: 'w1:scan', tool_use_id: 'tu1', workflow: { runId: 'wf_abc' } } as never)
  await $.agent.spawn({ prompt: 'p', name: 'ag2', description: 'w2:fix parser @wt', tool_use_id: 'inner', parentAgentId: 'ag1', workflow: { runId: 'wf_abc' } } as never)
  await $.agent.spawn({ prompt: 'p', name: 'ag3', description: 'stray', tool_use_id: 'elsewhere' } as never)
  expect(agentAt(db, 'ag1')).toMatchObject({ todoN: 1, name: 'scan', wave: 1, kind: 'workflow', isWorktree: false })
  expect(agentAt(db, 'ag2')).toMatchObject({ todoN: 1, name: 'fix parser', wave: 2, isWorktree: true, parentAgentId: 'ag1' })
  expect(db.agents['ag3']).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: /wave 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /wave 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeDefined()
  await ui.unmount()
})

test("a call's state follows its answer: a refusal is an error with its reason", async ($, on) => {
  const db = seeded([running(1, 'Count')], [agentNode('ag1', 1)])
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'blocked by policy' }))
  await start($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'rm -rf /', agentId: 'ag1' } as never)
  expect(callAt(db, 'c1')).toMatchObject({ state: 'err', response: 'denied: blocked by policy', arg: 'rm -rf /' })
  // A call by an agent no todo owns isn't recorded.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c2', command: 'ls', agentId: 'stranger' } as never)
  expect(db.calls['c2']).toBeUndefined()
})

test('an agent keeps its newest 200 calls in the session', async ($, on) => {
  const db = seeded([running(1, 'Busy')], [agentNode('ag1', 1)])
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' }, text: '' }))
  await start($)
  for (let i = 0; i < 201; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `c${i}`, command: `echo ${i}`, agentId: 'ag1' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: /\b200 calls/ })).toBeDefined()
  await ui.unmount()
  // The database keeps every one.
  expect(Object.keys(db.calls)).toHaveLength(201)
})

// ---------- control and what each writes ----------

test('Pause, Resume and Stop of a lone Agent write the todo, its agent and its open calls, and move the ring', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([running(1, 'Count')], [agentNode('ag1', 1)], [callRow('c1', 'ag1', { state: 'run' })])
  engine(on, submitted, undefined, true, { db })
  const stopped: string[] = []
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    stopped.push(String(e.task_id))
    return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })

  await ui.press({ key: 'act:1:pause' })
  expect(stopped).toEqual(['ag1'])
  expect(todoAt(db, 1).status).toBe('paused')
  expect(agentAt(db, 'ag1').status).toBe('paused')
  expect(callAt(db, 'c1').state).toBe('interrupted')
  expect(await isLit(ui, 'act:1:resume')).toBe(true)

  await ui.press({ key: 'act:1:resume' })
  expect(submitted.at(-1)).toContain('Send the stopped background agent "ag1" a SendMessage')
  expect(todoAt(db, 1).status).toBe('drafting')
  expect(await isLit(ui, 'todo:1')).toBe(true)
  await $.tool.call({ tool: 'mcp__todo__update', n: 1, status: 'running' } as never)
  expect(todoAt(db, 1).status).toBe('running')

  await ui.press({ key: 'act:1:stop' })
  expect(await isLit(ui, 'act:1:keep')).toBe(true)
  await ui.press({ key: 'act:1:keep' })
  expect(await isLit(ui, 'act:1:stop')).toBe(true)
  expect(todoAt(db, 1).status).toBe('running')
  await ui.press({ key: 'act:1:stop' })
  await ui.press({ key: 'act:1:stopyes' })
  expect(stopped).toEqual(['ag1', 'ag1'])
  expect(todoAt(db, 1).status).toBe('stopped')
  expect(agentAt(db, 'ag1').status).toBe('stopped')
  expect(await isLit(ui, 'act:1:refine')).toBe(true)

  // Leave stopped folds the todo away.
  await ui.press({ key: 'act:1:leave' })
  expect(await ui.find({ type: 'Button', key: 'act:1:refine' })).toBeUndefined()
  await ui.unmount()
})

test('a refused TaskStop says so, and the todo is still marked paused', async ($, on) => {
  const toasts: string[] = []
  const db = seeded([running(1, 'Count')])
  engine(on, [], undefined, true, { db, toasts })
  on('tool.call', { tool: 'TaskStop' }, () => ({ deny: 'no such task' }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:pause' })
  expect(toasts).toContain('TaskStop refused: no such task')
  expect(todoAt(db, 1).status).toBe('paused')
  await ui.unmount()
})

test("resuming a Workflow marks its interrupted agents stopped, as the run respawns them", async ($, on) => {
  const submitted: string[] = []
  const db = seeded(
    [running(1, 'Split', { status: 'paused', mode: 'workflow', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js' })],
    [agentNode('ag1', 1, { kind: 'workflow', status: 'done' }), agentNode('ag2', 1, { kind: 'workflow', status: 'paused' })],
  )
  engine(on, submitted, undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:resume' })
  expect(submitted.at(-1)).toContain('{scriptPath: "/tmp/s.js", resumeFromRunId: "wf_abc"}')
  expect(agentAt(db, 'ag1').status).toBe('done')
  expect(agentAt(db, 'ag2').status).toBe('stopped')
  expect(todoAt(db, 1).status).toBe('drafting')
  await ui.unmount()
})

test('Refine clears the old run from the database and asks for a refined prompt', async ($, on) => {
  const submitted: string[] = []
  const db = seeded(
    [aTodo(1, 'Count', { status: 'stopped', hasRun: true, mode: 'agent', taskId: 'ag1', prompt: 'count the md files' })],
    [agentNode('ag1', 1, { status: 'stopped' })],
    [callRow('c1', 'ag1')],
  )
  engine(on, submitted, undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:refine' })
  expect(db.agents['ag1']).toBeUndefined()
  expect(db.calls['c1']).toBeUndefined()
  expect(todoAt(db, 1)).toMatchObject({ status: 'drafting', owner: 's1' })
  expect(submitted.at(-1)).toContain('Refine the current prompt below')
  expect(submitted.at(-1)).toContain('Current prompt: count the md files')
  await ui.unmount()
})

test('Restart as-is clears the run ids and its agents, then submits the restart protocol', async ($, on) => {
  const submitted: string[] = []
  const toasts: string[] = []
  const db = seeded(
    [aTodo(1, 'Count', { status: 'failed', hasRun: true, mode: 'workflow', taskId: 'task9', runId: 'wf_abc', prompt: 'count' })],
    [agentNode('ag1', 1, { status: 'failed' })],
  )
  engine(on, submitted, undefined, true, { db, toasts })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:restart' })
  const t = todoAt(db, 1)
  expect(t.status).toBe('drafting')
  expect(t.taskId).toBeUndefined()
  expect(t.runId).toBeUndefined()
  expect(db.agents['ag1']).toBeUndefined()
  expect(submitted.at(-1)).toContain('Restart todo #1 "Count" from scratch')
  expect(toasts).toContain('↻ restarting #1')
  await ui.unmount()
})

test('a dropped restart puts the stopped todo back, run ids and all', async ($, on) => {
  const toasts: string[] = []
  const db = seeded([aTodo(1, 'Count', { status: 'stopped', hasRun: true, mode: 'workflow', taskId: 'task9', runId: 'wf_abc' })])
  engine(on, [], undefined, true, { db, toasts, drop: 'a hook refused it' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:restart' })
  expect(todoAt(db, 1)).toMatchObject({ status: 'stopped', taskId: 'task9', runId: 'wf_abc' })
  expect(toasts).toContain("#1 didn't start: a hook refused it")
  expect(toasts).not.toContain('↻ restarting #1')
  await ui.unmount()
})

test('a dropped resume puts the paused todo back', async ($, on) => {
  const toasts: string[] = []
  const db = seeded([running(1, 'Count', { status: 'paused' })])
  engine(on, [], undefined, true, { db, toasts, drop: 'a Stop stands' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:resume' })
  expect(todoAt(db, 1)).toMatchObject({ status: 'paused', taskId: 'ag1' })
  expect(toasts).toContain("#1 didn't start: a Stop stands")
  expect(toasts).not.toContain('▶ resuming #1')
  await ui.unmount()
})

test('Take over stops the other session\'s agents here and cancelling it puts the ring back', async ($, on) => {
  const db = seeded([running(1, 'Busy', { owner: 'other' })], [agentNode('ag1', 1)], [], '/proj', 'other')
  engine(on, [], undefined, true, { id: 's2', db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: /running in another session/ })).toBeDefined()
  await ui.press({ key: 'act:1:takeover' })
  await ui.press({ key: 'act:1:cancel' })
  expect(await isLit(ui, 'act:1:takeover')).toBe(true)
  expect(todoAt(db, 1).status).toBe('running')
  await ui.press({ key: 'act:1:takeover' })
  await ui.press({ key: 'act:1:takeyes' })
  expect(agentAt(db, 'ag1').status).toBe('stopped')
  expect(todoAt(db, 1).status).toBe('stopped')
  expect(await isLit(ui, 'act:1:refine')).toBe(true)
  await ui.unmount()
})

test('Delete removes the row and puts the ring on the add input', async ($, on) => {
  const { db } = engine(on, [])
  await start($)
  await todo($, 'add Scratch')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:delete' })
  await ui.press({ key: 'act:1:cancel' })
  expect(await isLit(ui, 'act:1:delete')).toBe(true)
  await ui.press({ key: 'act:1:delete' })
  await ui.press({ key: 'act:1:deleteyes' })
  expect(db.todos['/proj']?.[1]).toBeUndefined()
  expect(await isLit(ui, 'add')).toBe(true)
  await ui.unmount()
})

// ---------- a turn's end ----------

test("an agent's turn ends it: a lone Agent's todo ends with it, a refusal fails it, an abort stops it", async ($, on) => {
  const db = seeded(
    [running(1, 'Done one'), running(2, 'Refused one'), running(3, 'Aborted one'), running(4, 'Workflow', { mode: 'workflow', taskId: 'task9' })],
    [agentNode('ag1', 1), agentNode('ag2', 2), agentNode('ag3', 3), agentNode('ag4', 4, { kind: 'workflow' })],
  )
  engine(on, [], undefined, true, { db })
  await start($)
  await turnDone($, 'ag1', '\n  Counted 12 md files.\nDetails follow')
  await turnDone($, 'ag2', 'I cannot help with that', { refused: true })
  await turnDone($, 'ag3', '', { isAborted: true })
  await turnDone($, 'ag4', 'wave 1 done')
  expect(agentAt(db, 'ag1').status).toBe('done')
  expect(todoAt(db, 1)).toMatchObject({ status: 'done', summary: 'Counted 12 md files.' })
  expect(agentAt(db, 'ag2').status).toBe('failed')
  expect(todoAt(db, 2).status).toBe('failed')
  expect(agentAt(db, 'ag3').status).toBe('stopped')
  expect(todoAt(db, 3).status).toBe('stopped')
  // A Workflow's agent ending doesn't end the Workflow.
  expect(agentAt(db, 'ag4').status).toBe('done')
  expect(todoAt(db, 4).status).toBe('running')
})

// ---------- the mod's MCP tools ----------

test('mcp__todo__update reports a change and mcp__todo__list reads the backlog', async ($, on) => {
  const toasts: string[] = []
  const { db } = engine(on, [], undefined, true, { toasts })
  await start($)
  await todo($, 'add Count md files')
  const set = await $.tool.call({ tool: 'mcp__todo__update', n: 1, prompt: 'count them', mode: 'agent', status: 'running' } as never)
  expect(set.result).toBe('#1 Count md files: running')
  expect(set.isError).toBeFalsy()
  expect(todoAt(db, 1)).toMatchObject({ prompt: 'count them', mode: 'agent', status: 'running', hasRun: true })
  await $.tool.call({ tool: 'mcp__todo__update', n: 1, status: 'done', summary: '12 files' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'done', summary: '12 files', prompt: 'count them' })
  expect(toasts).toContain('✓ #1 done')

  await $.tool.call({ tool: 'mcp__todo__update', n: 1, branch: 'todo/1-count', landed: 'abc1234' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'done', branch: 'todo/1-count', landed: 'abc1234' })

  const missing = await $.tool.call({ tool: 'mcp__todo__update', n: 9, status: 'done' } as never)
  expect(missing).toMatchObject({ result: 'No todo #9.', isError: true })

  const listed = await $.tool.call({ tool: 'mcp__todo__list' } as never)
  expect(JSON.parse(String(listed.result))).toEqual([{ n: 1, title: 'Count md files', status: 'done', prompt: 'count them', summary: '12 files', mode: 'agent' }])
})

// ---------- the sync loop ----------

test('every 2 s the copy re-reads only when the file changed, takes only new calls, and follows a new root', async ($, on) => {
  const db = seeded([aTodo(1, 'Mine')], [agentNode('ag1', 1, { status: 'done' })], [callRow('c1', 'ag1')])
  db.todos['/other'] = { 1: aTodo(1, 'Elsewhere') }
  let mtime = 1
  const where: Where = { db, mtime: () => mtime, repo: p => (p.startsWith('/other') ? '/other' : '/proj') }
  const { ops } = engine(on, [], undefined, false, where)
  const clock = mock.clock(on, { now: 1000 })
  const reads = () => ops.filter(o => o.kind === 'read').length
  await start($)
  const booted = reads()

  // The first tick has no stamp to match, so it reads; the next, unchanged, doesn't.
  await clock.advance(2000)
  expect(reads()).toBe(booted + 1)
  await clock.advance(2000)
  expect(reads()).toBe(booted + 1)

  // Another session adds a todo and its agent makes a call.
  ;(db.todos['/proj'] ??= {})[2] = aTodo(2, 'Theirs')
  db.rev['/proj'] = 1
  db.calls['c2'] = { dir: '/proj', agentId: 'ag1', session: 'other', seq: 2, body: callRow('c2', 'ag1') }
  mtime = 2
  await clock.advance(2000)
  expect(reads()).toBe(booted + 2)
  expect(ops.filter(o => o.kind === 'calls').at(-1)).toMatchObject({ after: 1 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'todo:2' })).toBeDefined()
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: /\b2 calls/ })).toBeDefined()
  await ui.unmount()

  // The session moves to another repo: its list replaces this one, from scratch.
  where.cwd = '/other/sub'
  await clock.advance(2000)
  const there = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await there.find({ type: 'Text', text: /Elsewhere/ })).toBeDefined()
  expect(await there.find({ type: 'Button', key: 'todo:2' })).toBeUndefined()
  await there.unmount()
  expect(ops.at(-2)).toMatchObject({ kind: 'read', dir: '/other' })
})

test("calls are read in pages of 100 until a short page", async ($, on) => {
  const calls = Array.from({ length: 250 }, (_, i) => callRow(`c${i}`, 'ag1'))
  const db = seeded([aTodo(1, 'Busy', { status: 'done', hasRun: true })], [agentNode('ag1', 1, { status: 'done' })], calls)
  const { ops } = engine(on, [], undefined, true, { db })
  await start($)
  expect(ops.filter(o => o.kind === 'calls').map(o => (o as { after: number }).after)).toEqual([0, 100, 200])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Text', text: /250 tool calls/ })).toBeDefined()
  await ui.unmount()
})

test('a fresh read keeps only the newest 1500 calls of the directory', async ($, on) => {
  const calls = [
    ...Array.from({ length: 800 }, (_, i) => callRow(`a${i}`, 'ag1')),
    ...Array.from({ length: 800 }, (_, i) => callRow(`b${i}`, 'ag2')),
  ]
  const db = seeded([aTodo(1, 'Busy', { status: 'done', hasRun: true })], [agentNode('ag1', 1, { status: 'done' }), agentNode('ag2', 1, { status: 'done', startedAt: 2 })], calls)
  const { ops } = engine(on, [], undefined, true, { db })
  await start($)
  expect(ops.find(o => o.kind === 'calls')).toMatchObject({ after: 100 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: /\b700 calls/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\b800 calls/ })).toBeDefined()
  await ui.unmount()
})

// ---------- the database's failures ----------

test('a failed database run is said once and the next write goes through: the pane never turns read-only', async ($, on) => {
  const toasts: string[] = []
  let failing = ''
  const { db } = engine(on, [], undefined, true, { toasts, sql: op => (failing && op.kind === 'todos' ? err(failing) : undefined) })
  await start($)
  await todo($, 'add Saved')
  // The host aborts a write as the turn it ran for ends.
  failing = '$.process.run(/usr/bin/sqlite3) aborted'
  expect((await todo($, 'add Lost')).text).toBe('Not added: the todo list could not be saved.')
  await todo($, 'add Lost again')
  expect(toasts.filter(t => t === 'todo: $.process.run(/usr/bin/sqlite3) aborted')).toHaveLength(1)
  expect(toasts.some(t => t.startsWith('todo is read-only'))).toBe(false)
  failing = ''
  expect((await todo($, 'add Lands')).text).toMatch(/^Added #2 Lands/)
  expect(titles(db, '/proj')).toEqual(['1 Saved', '2 Lands'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeUndefined()
  expect(await ui.find({ type: 'Input', key: 'add' })).toBeDefined()
  await ui.unmount()
})

test('an agent stopped outside the pane stops its lone-Agent todo, keeping its id to resume', async ($, on) => {
  const db = seeded([aTodo(1, 'Count', { status: 'running', hasRun: true, mode: 'agent', taskId: 'ag1', owner: 's1' })], [agentNode('ag1', 1, { status: 'running' })], [callRow('c1', 'ag1', { state: 'run' })])
  engine(on, [], undefined, true, { db })
  await start($)
  await $.turn.complete({ agentId: 'ag1', isAborted: true, answer: '' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'stopped', taskId: 'ag1' })
  expect(db.agents['ag1']?.body).toMatchObject({ status: 'stopped' })
  expect(db.calls['c1']?.body).toMatchObject({ state: 'interrupted' })
})

test('a write other sessions keep beating gives up after 5 tries and says so', async ($, on) => {
  const toasts: string[] = []
  const { db, ops } = engine(on, [], undefined, true, {
    toasts,
    // Another session moves the list between each read and write.
    sql: (op, d) => {
      if (op.kind === 'todos') d.rev[op.dir] = (d.rev[op.dir] ?? 0) + 1
      return undefined
    },
  })
  await start($)
  expect((await todo($, 'add Never lands')).text).toBe('Not added: the todo list could not be saved.')
  expect(ops.filter(o => o.kind === 'todos')).toHaveLength(5)
  expect(toasts).toContain('todo: not saved, other sessions kept changing the list; try again')
  expect(titles(db, '/proj')).toEqual([])
})

test("a folder mkdir can't create makes the pane read-only, saying why", async ($, on) => {
  engine(on, [], undefined, true, { mkdir: 'fail' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /can't create \/home\/me\/\.claude\/plugins\/data\/todo: mkdir: Permission denied/ })).toBeDefined()
  await ui.unmount()
})

test('a mkdir that throws makes the pane read-only too', async ($, on) => {
  const { ops } = engine(on, [], undefined, true, { mkdir: 'throw' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The kit hands the throw back as its own error; the mod reports whatever it was.
  expect(await ui.find({ type: 'Text', text: /can't create \/home\/me\/\.claude\/plugins\/data\/todo: \S/ })).toBeDefined()
  await ui.unmount()
  expect(ops).toHaveLength(0)
})

test('the database lives in the plugin data folder, under CLAUDE_CONFIG_DIR when set', async ($, on) => {
  const { files, folders } = engine(on, [], undefined, true, { env: { CLAUDE_CONFIG_DIR: '/cfg' } })
  await start($)
  await todo($, 'add Somewhere')
  expect(folders).toEqual(['/cfg/plugins/data/todo'])
  expect(files.length).toBeGreaterThan(0)
  expect(new Set(files)).toEqual(new Set(['/cfg/plugins/data/todo/todo.db']))
})

test('without CLAUDE_CONFIG_DIR the database is under ~/.claude', async ($, on) => {
  const { files } = engine(on, [])
  await start($)
  expect(new Set(files)).toEqual(new Set(['/home/me/.claude/plugins/data/todo/todo.db']))
})

// ---------- migration's other paths ----------

test('an import a concurrent write beat is planned again on the new list', async ($, on) => {
  let isRaced = false
  const { db, ops } = engine(on, [], undefined, true, {
    sql: (op, d) => {
      if (op.kind === 'import' && !isRaced) {
        isRaced = true
        d.todos['/proj'] = { 1: aTodo(1, 'Theirs') }
        d.rev['/proj'] = 1
      }
      return undefined
    },
  })
  const held = legacyState(on, { todos: [legacyTodo(1, 'Mine')] })
  await start($)
  expect(ops.filter(o => o.kind === 'import')).toHaveLength(2)
  expect(titles(db, '/proj')).toEqual(['1 Theirs', '2 Mine'])
  expect(held()).toEqual({ shape: 'todos-1', value: [] })
})

test('a source imported before (a start that died before clearing it) adds nothing and is cleared', async ($, on) => {
  const db = emptyDb()
  db.migrated['session:s1'] = { dir: '/proj', at: 1 }
  const { ops } = engine(on, [], undefined, true, { db })
  const held = legacyState(on, { todos: [legacyTodo(1, 'Mine')] })
  await start($)
  expect(ops.filter(o => o.kind === 'import')).toHaveLength(1)
  expect(titles(db, '/proj')).toEqual([])
  expect(held()).toEqual({ shape: 'todos-1', value: [] })
})

test("a 0.2 session's agents and calls are written out once, following its todos' renumbering", async ($, on) => {
  const db = seeded([aTodo(1, 'Already here')])
  const { ops } = engine(on, [], undefined, true, { db })
  legacyState(on, {
    todos: [{ ...legacyTodo(1, 'Mine', 'running'), hasRun: true, mode: 'agent', taskId: 'ag1' }],
    agents: [agentNode('ag1', 1)],
    calls: [callRow('c1', 'ag1')],
  })
  await start($)
  expect(todoAt(db, 2)).toMatchObject({ title: 'Mine', owner: 's1' })
  expect(db.agents['ag1']).toMatchObject({ todoN: 2, session: 's1', dir: '/proj' })
  expect(agentAt(db, 'ag1').todoN).toBe(2)
  expect(callAt(db, 'c1').agentId).toBe('ag1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:2' })
  expect(await ui.find({ type: 'Button', key: 'ag:ag1' })).toBeDefined()
  await ui.unmount()

  const written = ops.filter(o => o.kind === 'call').length
  await start($)
  expect(ops.filter(o => o.kind === 'call')).toHaveLength(written)
})

test("a stored list whose titles aren't all in the database keeps its key, and the old keys with it", async ($, on) => {
  const db = seeded([aTodo(1, 'A')])
  db.migrated['store:/proj'] = { dir: '/proj', at: 1 }
  const store = { 'dir:/proj': { todos: [legacyTodo(1, 'A'), legacyTodo(2, 'B')] }, 'backup:x': { dir: '/proj', at: 1, todos: [] } }
  const { store: left } = engine(on, [], undefined, true, { db, store })
  await start($)
  expect(Object.keys(left).sort()).toEqual(['backup:x', 'dir:/proj'])
  expect(titles(db, '/proj')).toEqual(['1 A'])
})

// ---------- the detail dialog ----------

test("a todo's Details shows its prompt, summary, run ids and agents, with nothing to press", async ($, on) => {
  const db = seeded(
    [aTodo(1, 'Split the module', { status: 'done', hasRun: true, mode: 'workflow', prompt: 'Split register.tsx into three files', summary: 'Split into 3 files', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js', branch: 'todo/1-split', landed: 'abc1234' })],
    [agentNode('ag1', 1, { name: 'scan', kind: 'workflow', wave: 1, status: 'done' }), agentNode('ag2', 1, { name: 'fix', kind: 'workflow', wave: 2, isWorktree: true, status: 'done', startedAt: 2 })],
    [callRow('c1', 'ag1')],
  )
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:details' })
  expect(await ui.find({ type: 'Text', text: /#1 Split the module/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /done · Workflow/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Split register.tsx into three files' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Split into 3 files' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /workflow run: wf_abc/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /script: \/tmp\/s\.js/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /branch: todo\/1-split/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /landed: abc1234/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Agents \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /w2 fix ⎇ · 0 calls/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test("a subtask's calls read as their tool would: an Edit as a diff, JSON pretty-printed", async ($, on) => {
  const edit = callRow('c1', 'ag1', {
    tool: 'Edit',
    filePath: '/proj/a.ts',
    fields: [{ k: 'file_path', v: '/proj/a.ts' }, { k: 'old_string', v: 'let a = 1' }, { k: 'new_string', v: 'const a = 1' }],
    response: '{"ok":true}',
    ms: 1500,
  })
  const db = seeded([running(1, 'Tidy')], [agentNode('ag1', 1, { name: 'tidy' })], [edit, unanswered(callRow('c2', 'ag1', { state: 'run' }))])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Code', text: /-let a = 1\n\+const a = 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /"ok": true/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ok · 1\.5s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Running…' })).toBeDefined()
  await ui.unmount()
})

test('the spinner turns only while a todo runs', async ($, on) => {
  const db = seeded([running(1, 'Spinning')])
  engine(on, [], undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '·' })).toBeDefined()
  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: '✢' })).toBeDefined()
  await ui.unmount()
})

test('the pane opens at start, stays closed across a reload once hidden, and offers the way back from a transcript', async ($, on) => {
  const opens: string[] = []
  engine(on, [], { opens, closes: [] })
  await start($)
  expect(opens).toEqual(['todo'])
  await todo($, 'noshow')
  await start($)
  expect(opens).toEqual(['todo'])
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, view: { agentId: 'ag1' } }, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('a failed write leaves the sync loop reading', async ($, on) => {
  let mtime = 1
  const { ops } = engine(on, [], undefined, false, { mtime: () => mtime, sql: op => (op.kind === 'todos' ? err('$.process.run(/usr/bin/sqlite3) aborted') : undefined) })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add Aborted')
  const before = ops.length
  mtime = 2
  await clock.advance(4000)
  expect(ops.slice(before).some(o => o.kind === 'read')).toBe(true)
})

test("a migration's renumbering moves the pane's open rows with it", async ($, on) => {
  const db = seeded([aTodo(1, 'Already here')])
  engine(on, [], undefined, true, { db })
  legacyState(on, {
    todos: [legacyTodo(1, 'Mine')],
    ui: { expanded: ['t1'], confirm: null, renaming: null, justStopped: [], isHidden: false },
  })
  await start($)
  expect(todoAt(db, 2).title).toBe('Mine')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'act:2:exec' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()
  await ui.unmount()
})

// ---------- done todos' time in the tree ----------

const shown = async (ui: { find: (q: { type: string; key: string }) => Promise<unknown> }, n: number) =>
  (await ui.find({ type: 'Button', key: `todo:${n}` })) !== undefined

test('a done todo leaves the tree 5 minutes after it finished; a failed one stays, and the list keeps both', async ($, on) => {
  const db = seeded([aTodo(1, 'Will finish', { status: 'running', hasRun: true, mode: 'agent', owner: 's1' }), aTodo(2, 'Broke', { status: 'running', hasRun: true, mode: 'agent', owner: 's1' })])
  engine(on, [], undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await $.tool.call({ tool: 'mcp__todo__update', n: 1, status: 'done', summary: 'ok' } as never)
  await $.tool.call({ tool: 'mcp__todo__update', n: 2, status: 'failed', summary: 'no' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'done', doneAt: 1000 })
  expect(todoAt(db, 2).doneAt).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(4 * 60_000)
  expect(await shown(ui, 1)).toBe(true)
  await clock.advance(60_000 + 5000)
  expect(await shown(ui, 1)).toBe(false)
  expect(await shown(ui, 2)).toBe(true)
  await ui.unmount()

  const listed = await $.tool.call({ tool: 'mcp__todo__list' } as never)
  expect((JSON.parse(String(listed.result)) as { n: number }[]).map(t => t.n)).toEqual([1, 2])
})

test('CLAUDE_TODO_DONE_TTL_MINUTES overrides the option; 0 keeps done todos', async ($, on) => {
  const done = [aTodo(1, 'Old', { status: 'done', hasRun: true, doneAt: 1000 })]
  engine(on, [], undefined, false, { db: seeded(done), env: { CLAUDE_TODO_DONE_TTL_MINUTES: '0' } })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(60 * 60_000)
  expect(await shown(ui, 1)).toBe(true)
  await ui.unmount()
})

test('the doneTtlMinutes option sets the time in the tree', { options: { doneTtlMinutes: 1 } }, async ($, on) => {
  engine(on, [], undefined, false, { db: seeded([aTodo(1, 'Old', { status: 'done', hasRun: true, doneAt: 1000 })]) })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shown(ui, 1)).toBe(true)
  await clock.advance(60_000 + 5000)
  expect(await shown(ui, 1)).toBe(false)
  await ui.unmount()
})

test('a done todo from before its time was kept starts its time in the tree at the next start', async ($, on) => {
  const db = seeded([aTodo(1, 'Done in 0.2', { status: 'done', hasRun: true })])
  engine(on, [], undefined, false, { db })
  mock.clock(on, { now: 7000 })
  await start($)
  expect(todoAt(db, 1).doneAt).toBe(7000)
})

// ---------- dividers ----------

// The divider above todo #n as drawn: its whole line, and each Text's own
// text and props; undefined when none is drawn.
async function dividerOf(ui: { find: (q: { type: string; key: string }) => Promise<{ text: string; children: unknown[] } | undefined> }, n: number) {
  const box = await ui.find({ type: 'Box', key: `div:${n}` })
  if (box === undefined) return undefined
  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const texts: Node[] = []
  const walk = (x: unknown) => {
    if (typeof x !== 'object' || x === null) return
    const el = x as Node
    if (el.type === 'Text') texts.push(el)
    for (const c of el.children ?? []) walk(c)
  }
  for (const c of box.children) walk(c)
  const own = (t: Node) => (t.children ?? []).filter(c => typeof c === 'string').join('')
  return { line: box.text, parts: texts.map(t => ({ text: own(t), props: t.props ?? {} })) }
}

test('a titled divider sits above each todo, sized to the pane, its number in the status color', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'Fix kitty tab titles'), running(2, 'Ship it')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const d = await dividerOf(ui, 1)
  // 70 columns less the pane's paddingX of 1 on each side.
  expect(d?.line).toBe(`── #1 Fix kitty tab titles ${'─'.repeat(68 - 27)}`)
  expect(d?.line.length).toBe(68)
  expect(d?.parts.find(p => p.text === '#1')?.props).toMatchObject({ color: 'inactive' })
  expect(d?.parts.find(p => p.text === '── ')?.props).toMatchObject({ dimColor: true })
  expect(d?.parts.find(p => p.text.endsWith('───'))?.props).toMatchObject({ dimColor: true })
  expect((await dividerOf(ui, 2))?.parts.find(p => p.text === '#2')?.props).toMatchObject({ color: 'claude' })
  await ui.unmount()
})

test('a divider is never focusable: the arrows walk the same items and the rows keep their room', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'First'), aTodo(2, 'Second')]) })
  await start($)
  const arrow = (by: 1 | -1) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: Math.max(0, by), by, bodyRows: 4, contentRows: 40, origin: { kind: 'person' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await dividerOf(ui, 2)).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'ring:div:2' })).toBeUndefined()
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'add', origin: { kind: 'person' } })
  for (const key of ['todo:1', 'todo:2']) {
    await arrow(1)
    expect(await isLit(ui, key)).toBe(true)
  }
  await arrow(-1)
  expect(await isLit(ui, 'todo:1')).toBe(true)
  expect((await ui.find({ type: 'Box', key: 'ring:todo:2' }))?.props['padding']).toBe(1)
  await ui.unmount()
})

test('at a narrow width the divider cuts the title with … and still fits', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(3, 'Fix kitty tab titles')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 22 } })
  const d = await dividerOf(ui, 3)
  expect(d?.line).toBe('── #3 Fix kitty… ───')
  expect(d?.line.length).toBe(20)
  await ui.unmount()
  // Too narrow for any title: just the number on the rule.
  const tiny = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 12 } })
  expect((await dividerOf(tiny, 3))?.line).toBe('── #3 ────')
  await tiny.unmount()
})

test('todoDividers "line" draws a plain dim rule', { options: { todoDividers: 'line' } }, async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'Fix kitty tab titles')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const d = await dividerOf(ui, 1)
  expect(d?.line).toBe('─'.repeat(68))
  expect(d?.parts.every(p => p.props['dimColor'] === true)).toBe(true)
  await ui.unmount()
})

test('todoDividers "none" draws no divider', { options: { todoDividers: 'none' } }, async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'Fix kitty tab titles')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await dividerOf(ui, 1)).toBeUndefined()
  expect(await shown(ui, 1)).toBe(true)
  await ui.unmount()
})

test('CLAUDE_TODO_DIVIDERS overrides the option; an unknown value falls back to titled', { options: { todoDividers: 'none' } }, async ($, on) => {
  const where: Where = { db: seeded([aTodo(1, 'Fix kitty tab titles')]), env: { CLAUDE_TODO_DIVIDERS: 'line' } }
  engine(on, [], undefined, true, where)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await dividerOf(ui, 1))?.line).toBe('─'.repeat(68))
  await ui.unmount()

  where.env = { CLAUDE_TODO_DIVIDERS: 'fancy' }
  await start($)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await dividerOf(again, 1))?.line).toMatch(/^── #1 Fix kitty tab titles ─+$/)
  await again.unmount()
})
test('action chips are one word under 10 letters, and Resume, Restart, Refine and Details carry their own colors', async ($, on) => {
  const db = seeded([aTodo(1, 'Stopped one', { status: 'stopped', hasRun: true, mode: 'agent', prompt: 'p', taskId: 'ag1' })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  const fill = async (key: string) => {
    const chip = await ui.find({ type: 'Button', key: `act:1:${key}` })
    const text = (chip?.children ?? []).find((c): c is { props: Record<string, unknown> } => typeof c === 'object' && c !== null && 'props' in c)
    const label = chip?.props['label']
    return { label: typeof label === 'string' ? label : '', color: text?.props['backgroundColor'] }
  }
  const expected = { resume: 'success', restart: 'claude', refine: 'warning', details: 'planMode' } as const
  for (const [key, color] of Object.entries(expected)) {
    const { label, color: got } = await fill(key)
    expect(got).toBe(color)
    const word = label.replace(/^\W+\s*/u, '')
    expect(word).toMatch(/^\p{L}{1,9}$/u)
  }
  await ui.unmount()
})

// ---------- the call browser: turns, markdown, folds, images ----------

// A lone Agent for todo #1, spawned as ag1, whose calls the test answers.
// `hooks` registers the test's own answers, before the first call on $.
async function launched($: T$, on: On, hooks: () => void, where: Where = {}, ownClock = true) {
  const e = engine(on, [], undefined, ownClock, where)
  hooks()
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count md files', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count md files', tool_use_id: 'tu1' } as never)
  return e
}
// The model's answer to each step, by turn and index: the test's own
// turn.step hook, the bottom of the chain.
function steps(on: On, say: Record<string, string>) {
  // A stream hook is an async generator, even one with nothing to wait on.
  // eslint-disable-next-line @typescript-eslint/require-await
  on('turn.step', async function* (_, e) {
    const answer = say[`${e.turnId}:${e.index}`] ?? ''
    if (answer) yield { kind: 'text', index: 0, text: answer }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: answer ? 'end_turn' : 'tool_use', usage: null }
  })
}
async function step($: T$, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}
const browse = async ($: T$, surface: 'terminal' | 'desktop' = 'terminal', agentId = 'ag1') => {
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: `ag:${agentId}` })
  return ui
}
const lines = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n')

test("an agent's turns are kept beside its calls and read in time order", async ($, on) => {
  steps(on, { 'tA:0': 'Counting the **markdown** files first.', 'tA:1': 'Found two:\n\n- a.md\n- b.md', 'tM:0': 'main loop' })
  const { db } = await launched($, on, () =>
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'a.md\nb.md', stderr: '' }, text: 'a.md\nb.md' })),
  )
  expect((await step($, 'tA', 0, 'ag1')).answer).toBe('Counting the **markdown** files first.')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls *.md', agentId: 'ag1' } as never)
  await step($, 'tA', 1, 'ag1')
  // The main loop's steps and a step with no text are not kept.
  await step($, 'tM', 0)
  await step($, 'tA', 2, 'ag1')

  const kept = Object.values(db.calls).sort((a, b) => a.seq - b.seq).map(r => r.body as { kind?: string })
  expect(kept.map(r => r.kind ?? 'call')).toEqual(['turn', 'call', 'turn'])
  expect(kept[0]).toEqual({ kind: 'turn', id: 'turn:tA:0', agentId: 'ag1', text: 'Counting the **markdown** files first.', startedAt: expect.any(Number) })

  const ui = await browse($)
  const all = (await ui.findAll({})).map(x => `${x.type}:${x.text}`)
  const at = (re: RegExp) => all.findIndex(x => re.test(x))
  expect(at(/^Markdown:Counting/)).toBeGreaterThan(-1)
  expect(at(/^Markdown:Counting/)).toBeLessThan(at(/^Code:ls \*\.md/))
  expect(at(/^Code:ls \*\.md/)).toBeLessThan(at(/^Markdown:Found two/))
  expect(await ui.find({ type: 'Text', text: /1 tool calls · 2 turns/ })).toBeDefined()
  await ui.unmount()
})

test('a restarted session reads the turns it kept back, in place among the calls', async ($, on) => {
  const db = seeded([running(1, 'Count md files')], [agentNode('ag1', 1)], [callRow('c1', 'ag1', { startedAt: 5 })])
  db.calls['turn:t:0'] = { dir: '/proj', agentId: 'ag1', session: 'gone', seq: 2, body: { kind: 'turn', id: 'turn:t:0', agentId: 'ag1', text: 'Looking first.', startedAt: 3 } }
  engine(on, [], undefined, true, { id: 's2', db })
  await start($)
  const ui = await browse($)
  const all = (await ui.findAll({})).map(x => `${x.type}:${x.text}`)
  expect(all.indexOf('Markdown:Looking first.')).toBeGreaterThan(-1)
  expect(all.indexOf('Markdown:Looking first.')).toBeLessThan(all.findIndex(x => x.startsWith('Code:ls')))
  await ui.unmount()
})

test('a response that reads as markdown is drawn as Markdown; shell output and file bodies stay code', async ($, on) => {
  const md = '# Report\n\n| file | lines |\n|---|---|\n| a.md | 3 |'
  const db = seeded(
    [running(1, 'Count md files')],
    [agentNode('ag1', 1)],
    [
      callRow('c1', 'ag1', { tool: 'WebFetch', fields: [{ k: 'url', v: 'https://x.dev' }], response: md }),
      callRow('c2', 'ag1', { tool: 'Read', filePath: '/proj/README.md', fields: [{ k: 'file_path', v: '/proj/README.md' }], response: '# Title\n\nbody', startedAt: 2 }),
      callRow('c3', 'ag1', { response: 'a.md\nb.md', startedAt: 3 }),
    ],
  )
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await browse($)
  expect(await ui.find({ type: 'Markdown', text: /# Report/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /# Title/ })).toMatchObject({ props: { path: '/proj/README.md' } })
  expect(await ui.find({ type: 'Code', text: /a\.md\nb\.md/ })).toBeDefined()
  await ui.unmount()
})

test('a long output folds to a preview, and its toggle unfolds and folds it, lighting the ring', async ($, on) => {
  const db = seeded([running(1, 'Count md files')], [agentNode('ag1', 1)], [callRow('c1', 'ag1', { response: lines(30) })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await browse($)
  const out = async () => (await ui.find({ type: 'Code', text: /line 1\n/ }))?.text ?? ''
  expect(await out()).toContain('line 6')
  expect(await out()).not.toContain('line 7')
  expect(await ui.find({ type: 'Button', key: 'fold:c1:out' })).toMatchObject({ props: { label: '… +24 lines' } })
  expect(await ui.find({ type: 'Text', text: /tab, then enter, unfolds/ })).toBeDefined()

  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'fold:c1:out', origin: { kind: 'person' } })
  expect(await isLit(ui, 'fold:c1:out')).toBe(true)
  await ui.press({ key: 'fold:c1:out' })
  expect(await out()).toContain('line 30')
  expect(await ui.find({ type: 'Button', key: 'fold:c1:out' })).toMatchObject({ props: { label: '▴ fold' } })
  await ui.press({ key: 'fold:c1:out' })
  expect(await out()).not.toContain('line 7')
  await ui.unmount()
})

const codeSize = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Code' })).reduce((n, x) => n + x.text.length, 0)

test('hundreds of calls draw the newest window, older ones a toggle away', async ($, on) => {
  const many = Array.from({ length: 300 }, (_, i) => callRow(`c${i}`, 'ag1', { response: lines(40, `out${i}`), startedAt: i + 1 }))
  engine(on, [], undefined, true, { db: seeded([running(1, 'Count md files')], [agentNode('ag1', 1)], many) })
  await start($)
  const ui = await browse($)
  expect(await ui.find({ type: 'Code', text: /out299 1\n/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /out259 1\n/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'fold:earlier' })).toMatchObject({ props: { label: '▴ 260 earlier entries' } })
  await ui.press({ key: 'fold:earlier' })
  expect(await ui.find({ type: 'Code', text: /out220 1\n/ })).toBeDefined()
  expect(await codeSize(ui)).toBeLessThan(100000)
  await ui.unmount()
})

test('calls too big to draw together stop short of the drawing limit, saying so', async ($, on) => {
  const huge = Array.from({ length: 60 }, (_, i) =>
    callRow(`w${i}`, 'ag1', { tool: 'Write', fields: Array.from({ length: 8 }, (_, k) => ({ k: `content${k}`, v: 'x'.repeat(3000) })), startedAt: i + 1 }),
  )
  engine(on, [], undefined, true, { db: seeded([running(1, 'Count md files')], [agentNode('ag1', 1)], huge) })
  await start($)
  const ui = await browse($)
  expect(await ui.find({ type: 'Text', text: /earlier entries past what one drawing holds/ })).toBeDefined()
  expect(await codeSize(ui)).toBeLessThan(100000)
  expect(await codeSize(ui)).toBeGreaterThan(50000)
  await ui.unmount()
})

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('a Read of a picture keeps a reference, not its bytes, and draws it as a thumbnail', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const { db, runs } = await launched(
    $,
    on,
    () => on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'image', file: { base64: PNG, type: 'image/png', originalSize: 2048 } } })),
    { size: p => (p === '/proj/shot.png' ? 2048 : undefined) },
    false,
  )
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/proj/shot.png', agentId: 'ag1' } as never)
  // A picture the host won't open (here a path under /home, which macOS
  // mounts from the network) keeps its alt text rather than blanking the dialog.
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/home/u/far.png', agentId: 'ag1' } as never)

  expect(callAt(db, 'r1').images).toEqual([{ name: 'shot.png', path: '/proj/shot.png', bytes: 2048, mediaType: 'image/png' }])
  expect(JSON.stringify(db.calls)).not.toContain(PNG)
  const ui = await browse($)
  await clock.advance(1)
  expect(await ui.find({ type: 'Image', key: 'img:r1:0' })).toMatchObject({
    props: { source: { file: '/proj/shot.png', format: 'png' }, columns: 24, rows: 8, alt: 'shot.png · 2 KB' },
  })
  expect(await ui.find({ type: 'Image', key: 'img:r2:0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▣ far\.png/ })).toBeDefined()
  // A PNG on disk is drawn as it is: nothing is converted.
  expect(runs.some(r => r[0] === 'sips' || r[0] === 'sh')).toBe(false)
  await ui.unmount()
})

test('a surface without Image shows the picture as its alt text', async ($, on) => {
  const shot = callRow('r1', 'ag1', {
    tool: 'Read', filePath: '/proj/shot.png', response: '', images: [{ name: 'shot.png', path: '/proj/shot.png', bytes: 2048, mediaType: 'image/png' }],
  })
  engine(on, [], undefined, true, { db: seeded([running(1, 'Count md files')], [agentNode('ag1', 1)], [shot]) })
  await start($)
  const ui = await browse($, 'desktop')
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▣ shot.png · 2 KB' })).toBeDefined()
  await ui.unmount()
})

test("a result's image block is spooled beside the database and made a PNG thumbnail only when drawn", async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const { db, runs, written } = await launched(
    $,
    on,
    () => on('tool.call', { tool: 'mcp__web__shot' as never }, () => ({ result: { content: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }] } })),
    // Image refuses a path under /home, which macOS mounts from the network.
    { env: { CLAUDE_CONFIG_DIR: '/Users/me/.claude' }, size: p => (p.includes('/thumbs/') ? 900 : undefined) },
    false,
  )
  await $.tool.call({ tool: 'mcp__web__shot', tool_use_id: 's1', agentId: 'ag1' } as never)

  const spool = '/Users/me/.claude/plugins/data/todo/images/s1-0.b64'
  expect(written[spool]).toBe(PNG)
  expect(callAt(db, 's1')).toMatchObject({ images: [{ name: 'mcp__web__shot image 1.jpg', path: spool, mediaType: 'image/jpeg', spooled: true }] })
  expect(callAt(db, 's1').response).toContain('[image image/jpeg]')
  expect(JSON.stringify(db.calls)).not.toContain(PNG)
  expect(runs.some(r => r[0] === 'sips')).toBe(false)

  const ui = await browse($)
  // Until its PNG is made the alt text stands in.
  expect(await ui.find({ type: 'Text', text: /▣ mcp__web__shot image 1\.jpg/ })).toBeDefined()
  await clock.advance(1)
  expect(runs.find(r => r[0] === 'sh')?.[4]).toBe(spool)
  const sips = runs.find(r => r[0] === 'sips')
  expect(sips?.slice(0, 5)).toEqual(['sips', '-s', 'format', 'png', '-Z'])
  const png = sips?.at(-1) ?? ''
  expect(png).toMatch(/^\/Users\/me\/\.claude\/plugins\/data\/todo\/thumbs\/[0-9a-f]+\.png$/)
  expect(await ui.find({ type: 'Image', key: 'img:s1:0' })).toMatchObject({ props: { source: { file: png, format: 'png' } } })
  await ui.unmount()
})

// ---------- resuming what can't be woken ----------

const porcelain = (...wts: [string, string][]) =>
  ['worktree /proj\nHEAD aaa\nbranch refs/heads/main', ...wts.map(([p, b]) => `worktree ${p}\nHEAD bbb\nbranch refs/heads/${b}`)].join('\n\n') + '\n'

test('an agent stopped by the person leaves Resume offered, which starts a fresh agent on the worktree and record it kept', async ($, on) => {
  const submitted: string[] = []
  const db = seeded(
    [aTodo(1, 'Count md files', { status: 'running', hasRun: true, mode: 'agent', prompt: 'count them', taskId: 'ag1', owner: 's1' })],
    [agentNode('ag1', 1, { status: 'running', name: 'Count' })],
    [callRow('c1', 'ag1', { tool: 'Bash', arg: 'ls *.md', state: 'ok', startedAt: 2 })],
  )
  engine(on, submitted, undefined, true, { db, worktrees: porcelain(['/proj/.claude/worktrees/agent-ag1', 'worktree-agent-ag1'], ['/proj/.claude/worktrees/agent-zz', 'worktree-agent-zz']) })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag2' } }))
  await start($)
  await $.turn.complete({ agentId: 'ag1', isAborted: true, answer: '' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'stopped', isAgentGone: true, taskId: 'ag1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:resume' })
  const text = submitted.at(-1) ?? ''
  // No message to an agent that won't take one: straight to the fallback.
  expect(text).not.toContain('a SendMessage')
  expect(text).toContain("can't be woken")
  expect(text).toContain('description starting "[todo:1] " (no isolation')
  // Only this todo's worktree, with its branch.
  expect(text).toContain('- Count: /proj/.claude/worktrees/agent-ag1 (branch worktree-agent-ag1)')
  expect(text).not.toContain('agent-zz')
  // The record of what it did, and the prompt it was given.
  expect(text).toContain('Bash ls *.md → ok')
  expect(text).toContain('Its prompt: count them')
  // Nothing claims it runs until Claude says so; a failed resume puts it back.
  expect(todoAt(db, 1).status).toBe('drafting')
  expect(text).toContain('status: "stopped", summary: "resume failed: <why>"')
  await ui.unmount()

  // The fresh agent links to the todo and clears the flag.
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu9', description: '[todo:1] Count md files (resumed)', prompt: 'p', subagent_type: 'general-purpose' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'running', taskId: 'ag2' })
  expect(todoAt(db, 1).isAgentGone).toBeUndefined()
})

test('a paused lone Agent is woken first, with the fallback spelled out if the wake is refused', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([aTodo(1, 'Count', { status: 'paused', hasRun: true, mode: 'agent', taskId: 'ag1', owner: 's1' })], [agentNode('ag1', 1, { status: 'paused' })])
  engine(on, submitted, undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:resume' })
  const text = submitted.at(-1) ?? ''
  expect(text).toContain('Send the stopped background agent "ag1" a SendMessage')
  expect(text).toContain('If the message is refused')
  expect(text).toContain('2. Fallback')
  expect(text).toContain('none found: no worktree of its agents is left')
  expect(text).toContain('status: "paused", summary: "resume failed: <why>"')
  await ui.unmount()
})

test('a Workflow resume merges the branches its interrupted writers kept, and falls back when the run is another session\'s', async ($, on) => {
  const submitted: string[] = []
  const db = seeded(
    [aTodo(1, 'Split', { status: 'paused', hasRun: true, mode: 'workflow', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js', owner: 's1' })],
    [agentNode('w1', 1, { kind: 'workflow', status: 'paused', name: 'fix', isWorktree: true })],
  )
  engine(on, submitted, undefined, true, { db, worktrees: porcelain(['/proj/.claude/worktrees/agent-w1', 'worktree-agent-w1']) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:resume' })
  const text = submitted.at(-1) ?? ''
  expect(text).toContain('{scriptPath: "/tmp/s.js", resumeFromRunId: "wf_abc"}')
  expect(text).toContain('its merge agent also merges the kept branches above')
  expect(text).toContain('- fix: /proj/.claude/worktrees/agent-w1 (branch worktree-agent-w1)')
  expect(text).toContain('the run belongs to another session or an earlier process), go to 2')
  await ui.unmount()
})

test('a taken-over todo keeps Resume, which goes straight to a fresh agent', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([aTodo(1, 'Busy', { status: 'running', hasRun: true, mode: 'agent', owner: 'other', taskId: 'x', branch: 'worktree-agent-x' })])
  engine(on, submitted, undefined, true, { db, id: 's2', worktrees: porcelain(['/proj/.claude/worktrees/agent-x', 'worktree-agent-x']) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:takeover' })
  await ui.press({ key: 'act:1:takeyes' })
  expect(todoAt(db, 1)).toMatchObject({ status: 'stopped', isAgentGone: true })
  await ui.press({ key: 'act:1:resume' })
  const text = submitted.at(-1) ?? ''
  expect(text).toContain("can't be woken")
  expect(text).toContain('/proj/.claude/worktrees/agent-x (branch worktree-agent-x)')
  await ui.unmount()
})

test('the run protocol never leaves a stopped todo running', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Anything')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:exec' })
  expect(submitted.at(-1)).toContain('A notification that says it was stopped (by the user or by Claude) means status "stopped"')
  await ui.unmount()
})

// ---------- the dialog never wedges ----------

// Every Code source and Markdown text a drawing holds.
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) texts(n, out)
  else if (typeof node === 'object' && node !== null) {
    const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
    if (el.type === 'Code' && typeof el.props?.['source'] === 'string') out.push(el.props['source'])
    if (el.type === 'Markdown' && typeof el.props?.['text'] === 'string') out.push(el.props['text'])
    texts(el.children, out)
  }
  return out
}

test('the call browser hands Code and Markdown no control or format character, even where a cut splits an emoji', async ($, on) => {
  const nasty = `ok \u001b]8;;https://x\u0007link\u001b]8;;\u0007 \u0085 zw\u200b bidi\u202e sep\u2028 ${'😀'.repeat(400)}\r\n${'line\n'.repeat(30)}`
  const db = seeded(
    [aTodo(1, 'Count', { status: 'done', hasRun: true, mode: 'agent', taskId: 'ag1' })],
    [agentNode('ag1', 1, { status: 'done' })],
    [callRow('c1', 'ag1', { tool: 'Bash', fields: [{ k: 'command', v: nasty }], response: nasty, state: 'ok' }), callRow('c2', 'ag1', { tool: 'Edit', fields: [{ k: 'old_string', v: nasty }, { k: 'new_string', v: 'b\u200b' }], response: '{"a":"\\u2028"}', state: 'ok', startedAt: 2 })],
  )
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'ag:ag1' })
  const all = texts(await ui.findAll({ type: 'Code' })).concat(texts(await ui.findAll({ type: 'Markdown' })))
  expect(all.length).toBeGreaterThan(0)
  for (const t of all) expect(t).not.toMatch(/[^\P{C}\t\n]|[\p{Zl}\p{Zp}]/u)
  await ui.unmount()
})

test('Escape on the dialog closes it and puts the ring back where it was, keeping the keys in the pane', async ($, on) => {
  const openedWith: { id: string; focus?: boolean }[] = []
  const db = seeded([aTodo(1, 'Count', { status: 'done', hasRun: true, mode: 'agent', taskId: 'ag1' })], [agentNode('ag1', 1, { status: 'done' })])
  engine(on, [], undefined, false, { db, openedWith })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'ag:ag1', origin: { kind: 'person' } })
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
  // Escape takes the keys from the pane: it's drawn unfocused.
  const before = openedWith.length
  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  await clock.advance(1)
  await blurred.unmount()
  expect(openedWith.slice(before)).toEqual([{ id: 'todo', focus: true }])
  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await back.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect((await back.find({ type: 'Box', key: 'ring:ag:ag1' }))?.props['borderStyle']).toBe('round')
  await back.unmount()
})

test('a dialog left open across a reload starts closed', async ($, on) => {
  const db = seeded([aTodo(1, 'Count', { status: 'done', hasRun: true })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:details' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
  await start($)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await again.unmount()
})
