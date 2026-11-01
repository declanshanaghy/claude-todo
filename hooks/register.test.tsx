import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentNode, Call, Todo } from '../types'
import type { Op } from './db'
import { CHIP, CHIP_SYMBOL, DISABLED_FILL, DIVIDER, GREYS, MARK, STOP_RED, SUMMARY, type Tone, statusToast, toneColor, toneFocus } from './marks'
import { TAIL, clampLines, headParts } from './pane'
import { type Chip, movesFrom } from './moves'
import { execPrompt } from './protocol'
import { HELP, NONE_PENDING, TODO_VERBS, VERBS, fireBlock, fireTarget, stillPrompting } from './register'
import { TABLE } from './transitions'

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
  openedWith?: { id: string; focus?: boolean; closeOnEscape?: boolean }[]
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
    // The session's directory may be gone (a worktree removed under it), and a
    // run left to default to it fails to spawn: every run must name its own.
    if (e.init?.cwd !== '/') throw new Error(`ENOENT: ${e.argv[0]} spawned in the session's directory`)
    const [bin = '', ...args] = e.argv
    if (bin === 'git' && args.includes('worktree')) return { value: ok(where.worktrees ?? '') }
    if (bin === 'git') {
      const top = (where.repo ?? (() => '/proj'))(args[1] ?? '')
      return { value: top === null ? { ...err('fatal: not a git repository'), exitCode: 128 } : ok(`${top}\n`) }
    }
    if (bin.endsWith('sqlite3')) {
      if (where.hasSqlite === false) throw new Error('ENOENT')
      if (args[0] === '-version') return { value: ok('3.43.2\n') }
      const stdin = e.init.stdin ?? ''
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
    where.openedWith?.push({ id: e.id, ...(e.focus !== undefined ? { focus: e.focus } : {}), ...(e.closeOnEscape !== undefined ? { closeOnEscape: e.closeOnEscape } : {}) })
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
    // The host's refusals here are of plugins' prompts; the person's own go in.
    if (where.drop !== undefined && e.origin.kind !== 'composer') return { drop: where.drop }
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
// Hands todo #n to the chat, as ▶ Exec does, so a launch may take it running:
// the guard refuses pending → running.
const inChat = ($: T$, n: number) => $.tool.call({ tool: 'mcp__todo__update', n, status: 'drafting' } as never)
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
// From an open todo #n down the drill-down: its subtasks, the subtask's last
// turns and calls, then its ☰ Details into the call browser.
const transcript = async (ui: { press: (q: { key: string }) => Promise<unknown> }, n: number, agentId: string) => {
  await ui.press({ key: `subs:${n}` })
  await ui.press({ key: `ag:${agentId}` })
  await ui.press({ key: `full:${agentId}` })
}
// The pane with every view lit, for a case about the rows rather than the view.
// The view is kept across mounts and reloads, so a second mount finds it lit.
const mountAll = async ($: T$, props: { bodyColumns?: number } = {}) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, ...props } })
  if ((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label'] === 'all') await ui.press({ key: 'view:all' })
  return ui
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
  // The header carries 🔥 Fire where the cap used to be; the cap isn't drawn.
  expect(await ui.find({ type: 'Button', key: 'fire' })).toBeDefined()
  // Every chip's ring box is one row; the header centers so Todos and its chips share one baseline.
  expect((((await ui.drawn()) as Found).children?.[0] as Found | undefined)?.props?.['alignItems']).toBe('center')
  expect(await ui.find({ type: 'Text', text: /cap \d+ agents/ })).toBeUndefined()
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

test('an added todo opens one level deep, from the pane or /todo add; todos already there stay folded', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'Already here')]) })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  // `t4` is open before #4 exists: adding #4 keeps that one id.
  const held = legacyState(on, { ui: { expanded: ['t4'], confirm: null, renaming: null, justStopped: [], isHidden: false } })
  const open = () => ((held('ui') as { value?: { expanded?: string[] } }).value?.expanded ?? [])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()

  await ui.input({ key: 'add', text: 'Count md files' })
  await todo($, 'add Fix kitty tab titles')
  await todo($, 'add Reused number')
  expect(open()).toEqual(['t4', 't2', 't3'])
  // Level 1: its chips row and hint, as a press on the row would show.
  for (const n of [2, 3, 4]) expect(await ui.find({ type: 'Button', key: `act:${n}:exec` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()

  // Level 2 stays closed: the subtasks line shows, its subtasks don't.
  await inChat($, 3)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:3] Fix kitty tab titles', prompt: 'fix', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'fix', description: '[todo:3] Fix kitty tab titles', tool_use_id: 'tu1' } as never)
  expect(await ui.find({ type: 'Button', key: 'subs:3' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'ag:ag1' })).toBeUndefined()
  await ui.unmount()
})

test('M2: Exec submits the exec protocol and marks the todo drafting', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:exec' })

  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('Execute todo #1 "Fix kitty tab titles"')
  expect(submitted[0]).toContain('[todo:1]')
  expect(await ui.find({ type: 'Button', key: 'act:1:reset' })).toBeDefined()
  await ui.unmount()
})

test('Auto drafts the one best prompt and runs it with no questions, planning multi-step work on defaults', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  await todo($, 'add Count md files')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const chip = await ui.find({ type: 'Button', key: 'act:1:auto' })
  expect(chip?.props['label']).toBe('Auto')
  const fill = (chip?.children ?? []).find((c): c is { props: Record<string, unknown> } => typeof c === 'object' && c !== null && 'props' in c)
  expect(fill?.props['backgroundColor']).toBe(MARK.running.color)
  await ui.press({ key: 'act:1:auto' })
  await ui.press({ key: 'act:2:exec' })

  const [auto, asked] = submitted as [string, string]
  expect(auto).toContain('Execute todo #1 "Fix kitty tab titles" in auto mode')
  expect(auto).toContain('single best prompt')
  expect(auto).toContain('mcp__todo__update {n: 1, prompt:')
  expect(auto).toContain('isolation: "worktree"')
  expect(auto).toContain('best-effort default')
  for (const gone of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'On approval']) expect(auto).not.toContain(gone)
  // Plain Exec still asks, and plans with the person.
  for (const kept of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) expect(asked).toContain(kept)
  expect(asked).not.toContain('auto mode')
  expect(await ui.find({ type: 'Button', key: 'act:1:reset' })).toBeDefined()
  await ui.unmount()
})

test('a fired todo never says "no prompt yet": Auto stores its first draft as the prompt, and the hint names the mode', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([
    aTodo(1, 'Fix kitty tab titles', { drafts: DRAFTS }),
    aTodo(2, 'Count md files', { drafts: DRAFTS }),
    aTodo(3, 'Tidy the docs'),
  ])
  engine(on, submitted, undefined, false, { db })
  mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const n of [1, 2, 3]) await ui.press({ key: `todo:${n}` })
  await ui.press({ key: 'act:1:auto' })
  await ui.press({ key: 'act:2:exec' })
  await ui.press({ key: 'act:3:auto' })
  expect(submitted).toHaveLength(3)

  // Auto with drafts takes the first at once: it's the prompt from the start.
  expect(todoAt(db, 1)).toMatchObject({ status: 'drafting', prompt: DRAFTS[0]?.prompt, isAuto: true })
  expect(await ui.find({ type: 'Text', text: /Set the kitty tab title from the session name/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'starting with the first draft…' })).toBeDefined()
  // Plain Exec asks: no prompt stored yet, and the hint says so.
  expect(todoAt(db, 2).prompt).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'answer the prompt question in the chat…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' prompt being settled in the chat…' })).toBeDefined()
  // Auto without drafts: Claude drafts it, with no question to answer.
  expect(todoAt(db, 3).prompt).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'drafting the prompt…' })).toBeDefined()

  expect(await ui.find({ type: 'Text', text: /no prompt yet/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Exec drafts one|Exec asks, / })).toBeUndefined()
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
  const ui = await mountAll($)
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
  await inChat($, 1)

  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count md files', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count md files', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls *.md', agentId: 'ag1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'act:1:pause' })).toBeDefined()
  // Level 1 sums the subtasks on one line; the subtask rows wait behind it.
  expect(await ui.find({ type: 'Button', key: 'subs:1', text: '▸ 1 subtask · 0 done · 1 call' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'ag:ag1' })).toBeUndefined()
  await ui.press({ key: 'subs:1' })
  expect(await ui.find({ type: 'Button', key: 'ag:ag1', text: /^▸ . Count md files$/ })).toBeDefined()
  // Level 3: each call is one line, never code; the browser is a press away.
  expect(await ui.find({ type: 'Text', text: / ⏺ Bash ls \*\.md/ })).toBeUndefined()
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Text', text: / ⏺ Bash ls \*\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()

  // A subtask's ☰ Details turns the pane into the view-only call browser.
  await ui.press({ key: 'full:ag1' })
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
  await inChat($, 1)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count', prompt: 'count', subagent_type: 'general-purpose' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  await inChat($, 1)
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu1', script: "export const meta = { name: 'todo-1-statusline', description: 'x' }" } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  await transcript(ui, 1, 'ag1')
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
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await transcript(ui, 1, 'ag1')
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
  const { db } = engine(on, [], undefined, true, { drop: 'a hook refused it', toasts })
  await start($)
  await todo($, 'add Fix focus ring')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:exec' })
  expect(todoAt(db, 1).status).toBe('pending')
  expect(toasts).toContain("#1 didn't start: a hook refused it")
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
    // Lit: the [ ] marks in Claude's color; else the two cells kept blank.
    return p === undefined ? p : p['paddingX'] === 1 ? 'blank' : 'claude'
  }
  const tab = (element: string) =>
    $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element, origin: { kind: 'person' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
    (await ui.find({ type: 'Box', key: `ring:${key}` }))?.props['paddingX'] === undefined
  const arrow = (by: 1 | -1, bodyRows = 4) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: Math.max(0, by), by, bodyRows, contentRows: 40, origin: { kind: 'person' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'todo:1', origin: { kind: 'person' } })
  // Down walks into #1's actions, past the window's height, and the window stays put.
  expect((await arrow(1)).deny).toBeDefined()
  expect(await lit(ui, 'act:1:exec')).toBe(true)
  for (const key of ['act:1:auto', 'act:1:rename', 'act:1:delete', 'act:1:details', 'todo:2']) {
    await arrow(1)
    expect(await lit(ui, key)).toBe(true)
  }
  // Up walks back; it stops at the first element, the header's first toggle.
  await arrow(-1)
  expect(await lit(ui, 'act:1:details')).toBe(true)
  for (let i = 0; i < 20; i++) await arrow(-1)
  expect(await lit(ui, 'view:running')).toBe(true)
  // The header's toggles come first, then 🔥 Fire, then add, then the list.
  for (const key of ['view:prompting', 'view:pending', 'view:failed', 'view:paused', 'view:stopped', 'view:done', 'view:all', 'fire', 'add', 'todo:1']) {
    await arrow(1)
    expect(await lit(ui, key)).toBe(true)
  }
  // The wheel and page keys still scroll.
  expect((await $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: 4, by: 4, bodyRows: 4, contentRows: 40, origin: { kind: 'person' } })).deny).toBeUndefined()
  await ui.unmount()
})

// ---------- fixtures for the cases below ----------

type Drawing = { find: (q: { type: string; key?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown>; text?: string } | undefined> }
// Whether the ring's border is drawn around `key`.
const isLit = async (ui: Drawing, key: string) => {
  const box = await ui.find({ type: 'Box', key: `ring:${key}` })
  return box !== undefined && box.props['paddingX'] !== 1
}

// The window over the list under the fixed header: its height, and the
// offset its inner column's negative margin scrolls it by.
const listWindowOf = async (ui: { find: (q: { type: string; key: string }) => Promise<unknown> }) => {
  const win = (await ui.find({ type: 'Box', key: 'list' })) as Found | undefined
  const col = (win?.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null)
  const margin = col?.props?.['marginTop']
  return { height: win?.props?.['height'], offset: typeof margin === 'number' ? -margin : 0 }
}

// Each row of the list's window, as the focus stops drawn on it.
const listRowsOf = async (ui: { find: (q: { type: string; key: string }) => Promise<unknown> }) => {
  const win = (await ui.find({ type: 'Box', key: 'list' })) as Found | undefined
  const col = (win?.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null)
  const rings = (n: unknown): string[] => {
    if (typeof n !== 'object' || n === null) return []
    const f = n as Found
    const key = f.key ?? f.props?.['key']
    return [...(typeof key === 'string' && key.startsWith('ring:') ? [key.slice(5)] : []), ...(f.children ?? []).flatMap(rings)]
  }
  return (col?.children ?? []).filter(c => typeof c === 'object' && c !== null).map(rings)
}

test('the header stays put while the list scrolls under it, at a narrow width, in one pane', async ($, on) => {
  const opens: string[] = []
  const db = seeded(Array.from({ length: 8 }, (_, i) => aTodo(i + 1, `Todo number ${i + 1}`)))
  engine(on, [], { opens, closes: [] }, true, { db })
  await start($)
  // Eight rows of body: the header's three (counts, add, the ═ rule under
  // it) and a window of five over the list's fifteen (eight todos, seven ─
  // rules; the first todo draws none).
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30, scroll: { offset: 0, bodyRows: 8 } } })
  const wheel = (by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: 0, by, bodyRows: 8, contentRows: 8, origin: { kind: 'person' }, pointer: { column: 3, row: 5 } })
  const top = async () => (((await ui.drawn()) as Found).children ?? []).filter((c): c is Found => typeof c === 'object' && c !== null)
  // The header's rows as drawn, less each press's handle, which a redraw renews.
  const head = async () => JSON.stringify((await top()).slice(0, 3), (k, v: unknown) => (k === 'handle' ? undefined : v))
  const kids = await top()
  // The header, its ═ rule under the add element, then the list's window,
  // which opens on the first todo with no rule above it.
  expect(kids.map(k => keyOf(k))).toEqual(['', 'ring:add', 'div2:head', 'list'])
  expect(keyOf((await listRows(ui))[0] ?? {})).toBe('ring:todo:1')
  expect(JSON.stringify(kids[0])).toContain('"fire"')
  const before = await head()
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 0 })
  expect(kids[3]?.props).toMatchObject({ overflow: 'hidden', flexShrink: 0, flexDirection: 'column' })

  // The wheel, a page key: the list moves, the header doesn't, and the engine
  // isn't asked to scroll the pane.
  expect((await wheel(1)).deny).toBeUndefined()
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 1 })
  await wheel(3)
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 4 })
  expect(await head()).toBe(before)
  // Clamped at either end: the last row at the window's bottom, the first at its top.
  await wheel(100)
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 10 })
  expect(await head()).toBe(before)
  await wheel(-100)
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 0 })
  // Every row is drawn, so the ring reaches those outside the window.
  expect(await rowsDrawn(ui)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(opens).toEqual(['todo'])
  await ui.unmount()
})

test('moving the ring scrolls the list to keep its row in the window under the header', async ($, on) => {
  const db = seeded(Array.from({ length: 8 }, (_, i) => aTodo(i + 1, `Todo number ${i + 1}`)))
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30, scroll: { offset: 0, bodyRows: 8 } } })
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element, origin: { kind: 'person' } })
  const arrow = (by: 1 | -1) => $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: 0, by, bodyRows: 8, contentRows: 8, origin: { kind: 'person' } })
  // #8's header is the list's last row (14): the window ends on it.
  await focus('todo:8')
  expect(await isLit(ui, 'todo:8')).toBe(true)
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 10 })
  // The add input is in the header, always in view: the list stays.
  await focus('add')
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 10 })
  // #1's header, row 0: back to the top.
  await focus('todo:1')
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 0 })
  // The arrows walk the ring down; the window follows once it passes the bottom.
  for (let i = 0; i < 3; i++) await arrow(1)
  expect(await isLit(ui, 'todo:4')).toBe(true)
  expect(await listWindowOf(ui)).toEqual({ height: 5, offset: 2 })
  // Opening a todo adds its rows to the list, and the ring keeps its own in view.
  await ui.press({ key: 'todo:4' })
  await focus('act:4:details')
  const w = await listWindowOf(ui)
  expect(w.height).toBe(5)
  expect(w.offset).toBeGreaterThan(2)
  expect(await isLit(ui, 'act:4:details')).toBe(true)
  await ui.unmount()
})

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

test('/todo add with no title, a bare title, and an unplaceable pane each say so', async ($, on) => {
  const toasts: string[] = []
  const where: Where = { toasts }
  const { db } = engine(on, [], undefined, true, where)
  await start($)
  expect((await todo($, 'add   ')).text).toBe('Usage: /todo add <title>')
  expect(titles(db, '/proj')).toEqual([])
  expect((await todo($, 'frobnicate')).text).toBe('Added #1 frobnicate')
  expect(titles(db, '/proj')).toEqual(['1 frobnicate'])
  where.unplaced = 'the terminal is too narrow'
  expect((await todo($, 'show')).text).toBe("Todo pane can't be placed: the terminal is too narrow")
})

test('/todo with a bare title adds it as /todo add does, and a title starting with a verb word needs the add', async ($, on) => {
  const { db } = engine(on, [], undefined, true)
  await start($)
  expect((await todo($, '  Fix kitty tab titles  ')).text).toBe('Added #1 Fix kitty tab titles')
  expect((await todo($, 'add Fix kitty tab titles')).text).toBe('Added #2 Fix kitty tab titles')
  expect(titles(db, '/proj')).toEqual(['1 Fix kitty tab titles', '2 Fix kitty tab titles'])
  // `list` is a verb, so it lists rather than adds; `add` makes it a title.
  expect((await todo($, 'list the open ports')).text).toBe('Todo pane shown.')
  expect(titles(db, '/proj')).toHaveLength(2)
  expect((await todo($, 'add list the open ports')).text).toBe('Added #3 list the open ports')
  expect(titles(db, '/proj')).toEqual(['1 Fix kitty tab titles', '2 Fix kitty tab titles', '3 list the open ports'])
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

test('/todo exec auto runs a named todo with the keyword before or after it, or the lowest-numbered pending one, and says when none is', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([
    aTodo(1, 'Done one', { status: 'done', hasRun: true }),
    aTodo(2, 'Stopped one', { status: 'stopped', hasRun: true, prompt: 'p' }),
    aTodo(3, 'Count md files'),
    aTodo(4, 'Fix kitty tab titles'),
  ])
  engine(on, submitted, undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  // No target: the lowest-numbered pending todo, skipping a lower stopped one.
  expect((await todo($, 'exec auto')).text).toBe('Auto-executing #3 Count md files: Claude drafts the prompt and launches it, no questions asked.')
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #3 "Count md files" in auto mode')
  expect(todoAt(db, 3).status).toBe('drafting')
  expect((await todo($, 'exec 4 auto')).text).toContain('Auto-executing #4')
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #4 "Fix kitty tab titles" in auto mode')
  expect((await todo($, 'exec auto stopped')).text).toContain('Auto-executing #2 Stopped one')
  await clock.settle()
  expect(submitted.at(-1)).toContain('#2 "Stopped one" in auto mode')
  expect(submitted).toHaveLength(3)
  expect((await todo($, 'exec auto')).text).toBe('No pending todo to run.')
  expect((await todo($, 'exec auto #3')).text).toBe('#3 is drafting.')
  expect((await todo($, 'exec auto nothing-like-it')).text).toBe('No todo matches "nothing-like-it".')
  await clock.settle()
  expect(submitted).toHaveLength(3)
})

test('/todo auto is short for /todo exec auto, with or without a target', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([aTodo(1, 'Done one', { status: 'done', hasRun: true }), aTodo(2, 'Count md files'), aTodo(3, 'Fix kitty tab titles')])
  engine(on, submitted, undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  expect((await todo($, 'auto kitty')).text).toContain('Auto-executing #3 Fix kitty tab titles')
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #3 "Fix kitty tab titles" in auto mode')
  expect((await todo($, 'auto')).text).toContain('Auto-executing #2 Count md files')
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #2 "Count md files" in auto mode')
  expect((await todo($, 'auto')).text).toBe('No pending todo to run.')
  expect((await todo($, 'auto 1')).text).toBe('#1 is done.')
  // A bare exec names no todo, rather than the first one every title matches.
  expect((await todo($, 'exec')).text).toBe('Usage: /todo exec [auto] <n|title>')
  await clock.settle()
  expect(submitted).toHaveLength(2)
})

test('/todo resume resumes a paused todo as the chip does, and one paused before it ever ran as an exec', async ($, on) => {
  const submitted: string[] = []
  const db = seeded(
    [
      aTodo(1, 'Count md files', { status: 'paused', hasRun: true, mode: 'agent', prompt: 'count them', taskId: 'ag1', owner: 's1' }),
      aTodo(2, 'Fix kitty tab titles', { status: 'paused', owner: 's1' }),
    ],
    [agentNode('ag1', 1, { status: 'paused' })],
  )
  engine(on, submitted, undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  expect((await todo($, 'resume md')).text).toBe('Resuming #1 Count md files: Claude picks its work up in the chat.')
  // Submitted from a timer once the command answered, as an exec is.
  expect(submitted).toHaveLength(0)
  await clock.settle()
  expect(submitted.at(-1)).toContain('Send the stopped background agent "ag1" a SendMessage')
  expect(todoAt(db, 1).status).toBe('drafting')
  expect((await todo($, 'resume #2')).text).toContain('Executing #2 Fix kitty tab titles')
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #2 "Fix kitty tab titles"')
  expect(todoAt(db, 2).status).toBe('drafting')
  expect(submitted).toHaveLength(2)
})

test('/todo resume picks up a stopped todo whose agent is gone with a fresh agent on the kept worktree', async ($, on) => {
  const submitted: string[] = []
  const db = seeded(
    [aTodo(1, 'Count md files', { status: 'stopped', hasRun: true, mode: 'agent', prompt: 'count them', taskId: 'ag1', isAgentGone: true })],
    [agentNode('ag1', 1, { status: 'stopped', name: 'Count' })],
  )
  engine(on, submitted, undefined, false, { db, worktrees: porcelain(['/proj/.claude/worktrees/agent-ag1', 'worktree-agent-ag1']) })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  expect((await todo($, 'resume 1')).text).toBe('Resuming #1 Count md files: Claude picks its work up in the chat.')
  await clock.settle()
  const text = submitted.at(-1) ?? ''
  expect(text).toContain("can't be woken")
  expect(text).toContain('- Count: /proj/.claude/worktrees/agent-ag1 (branch worktree-agent-ag1)')
  expect(text).toContain('status: "stopped", summary: "resume failed: <why>"')
  expect(todoAt(db, 1).status).toBe('drafting')
})

test('a todo paused before it ever ran belongs to no session: exec or resume starts it from any', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([
    aTodo(1, 'Later', { status: 'paused', owner: 's-old' }),
    aTodo(2, 'Later too', { status: 'paused', owner: 's-old' }),
  ])
  engine(on, submitted, undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: /in another session/ })).toBeUndefined()
  await ui.unmount()
  expect((await todo($, 'exec 1')).text).not.toMatch(/another session|is paused/)
  expect((await todo($, 'resume 2')).text).not.toMatch(/another session/)
  await clock.settle()
  expect(submitted.filter(x => x.includes('Execute todo #1'))).toHaveLength(1)
  expect(submitted.filter(x => x.includes('Execute todo #2'))).toHaveLength(1)
})

test('a /clear hands the todos the ended session owned to the session that goes on', async ($, on) => {
  const db = seeded([running(1, 'Busy'), aTodo(2, 'Theirs', { status: 'running', hasRun: true, mode: 'agent', taskId: 'ag2', owner: 's9' })])
  // `where` is read on every call: the id changes as the /clear goes on.
  const where = { db, id: 's1' }
  engine(on, [], undefined, true, where)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  await start($)
  expect(todoAt(db, 1).owner).toBe('s1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  where.id = 's2'
  await $.classic.SessionStart({ source: 'clear' })
  expect(todoAt(db, 1).owner).toBe('s2')
  // Another live session's todo stays its own.
  expect(todoAt(db, 2).owner).toBe('s9')
})

test('/todo resume refuses a todo the chip is not offered on, naming its status and the command that applies', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([
    aTodo(1, 'Not yet'),
    aTodo(2, 'Finished', { status: 'done', hasRun: true }),
    aTodo(3, 'Halted', { status: 'stopped', hasRun: true }),
    running(4, 'Busy'),
    aTodo(5, 'Elsewhere', { status: 'paused', hasRun: true, mode: 'agent', taskId: 'ag5', owner: 's2' }),
  ])
  engine(on, submitted, undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  expect((await todo($, 'resume 1')).text).toBe('#1 is pending: /todo exec 1')
  expect((await todo($, 'resume finished')).text).toBe('#2 is done: nothing to resume.')
  expect((await todo($, 'resume 3')).text).toBe('#3 is stopped with nothing to resume: /todo exec 3')
  expect((await todo($, 'resume 4')).text).toBe('#4 is running: already in flight; pause or stop it in the pane (/todo show).')
  expect((await todo($, 'resume 5')).text).toBe('#5 is paused in another session.')
  expect((await todo($, 'resume nothing-like-it')).text).toBe('No todo matches "nothing-like-it".')
  expect((await todo($, 'resume')).text).toBe('Usage: /todo resume <n|title>')
  await clock.settle()
  expect(submitted).toHaveLength(0)
  expect(todoAt(db, 1).status).toBe('pending')
  expect(todoAt(db, 5).status).toBe('paused')
})

// 🔥 Fire's look: filled in running's color while it can launch, dimmed
// (a grey fill under dim text) while it can't. `color` is the fill it shows:
// under the ring it is drawn pre-inverted, so its fill is its text color.
async function fireLook(ui: Drawing) {
  const chip = (await ui.find({ type: 'Button', key: 'fire' })) as Found | undefined
  expect(chip?.props?.['label']).toBe('Fire')
  const fill = (chip?.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null && 'props' in c)?.props
  const shown = fill?.['inverse'] === true ? fill['color'] : fill?.['backgroundColor']
  const isDimmed = chip?.props?.['dimColor'] === true && fill?.['dimColor'] === true && shown === DISABLED_FILL
  return { isDimmed, color: isDimmed ? shown : fill?.['backgroundColor'] }
}

test('🔥 Fire in the header auto-runs the lowest-numbered pending todo, and is dimmed while none is pending', async ($, on) => {
  const submitted: string[] = []
  const toasts: string[] = []
  const db = seeded([
    aTodo(1, 'Stopped one', { status: 'stopped', hasRun: true, prompt: 'p' }),
    aTodo(2, 'Count md files'),
    aTodo(3, 'Fix kitty tab titles'),
  ])
  engine(on, submitted, undefined, false, { db, toasts })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Live: filled with running's color, like Exec and Auto.
  expect(await fireLook(ui)).toMatchObject({ isDimmed: false, color: MARK.running.color })
  // The arrow keys reach it: it is the first stop, above the add input.
  const arrow = (by: 1 | -1) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: 0, by, bodyRows: 60, contentRows: 60, origin: { kind: 'person' } })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'add', origin: { kind: 'person' } })
  await arrow(-1)
  expect(await isLit(ui, 'fire')).toBe(true)
  await arrow(1)
  expect(await isLit(ui, 'add')).toBe(true)

  // The same path as `/todo exec auto`: #2, skipping the lower stopped #1.
  await ui.press({ key: 'fire' })
  await clock.settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('Execute todo #2 "Count md files" in auto mode')
  expect(todoAt(db, 2).status).toBe('drafting')
  // The last press is made with the ring on it.
  await arrow(-1)
  expect(await isLit(ui, 'fire')).toBe(true)
  await ui.press({ key: 'fire' })
  await clock.settle()
  expect(submitted.at(-1)).toContain('Execute todo #3 "Fix kitty tab titles" in auto mode')

  // Nothing pending: Fire stays, dimmed, and the ring stays on it.
  expect(await fireLook(ui)).toMatchObject({ isDimmed: true, color: DISABLED_FILL })
  expect(await isLit(ui, 'fire')).toBe(true)
  await clock.settle()
  expect(await isLit(ui, 'fire')).toBe(true)
  // A press re-checks and only says why.
  await ui.press({ key: 'fire' })
  await clock.settle()
  expect(toasts).toContain('No pending todo to run.')
  expect(submitted).toHaveLength(2)
  expect((await todo($, 'exec auto')).text).toBe('No pending todo to run.')
  // Still a stop for the arrow keys, between the last toggle and add.
  await arrow(-1)
  expect(await isLit(ui, 'view:all')).toBe(true)
  await arrow(1)
  expect(await isLit(ui, 'fire')).toBe(true)
  await arrow(1)
  expect(await isLit(ui, 'add')).toBe(true)
  // Something runnable again: it fills again.
  await todo($, 'add Another')
  expect(await fireLook(ui)).toMatchObject({ isDimmed: false, color: MARK.running.color })
  await ui.unmount()
})

test('🔥 Fire is dimmed while the running agents fill the cap, and a press says so', async ($, on) => {
  const submitted: string[] = []
  const toasts: string[] = []
  // The engine's cap is 6 (10 CPUs less 4): six running agents fill it.
  const full = [1, 2, 3, 4, 5, 6].map(i => agentNode(`a${i}`, 1))
  const db = seeded([running(1, 'Busy'), aTodo(2, 'Count md files')], [...full, agentNode('a7', 1, { status: 'done' })])
  engine(on, submitted, undefined, true, { db, toasts })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await fireLook(ui)).isDimmed).toBe(true)
  await ui.press({ key: 'fire' })
  expect(toasts).toContain('The agent cap is reached (6 of 6 running).')
  expect(submitted).toHaveLength(0)
  expect(todoAt(db, 2).status).toBe('pending')
  await ui.unmount()
})

// Each state where 🔥 Fire can't launch: the dimmed look (fireBlock) and a
// press (fireNext) read the one fireTarget answer, so the chip is dimmed
// exactly when a press would only toast why, and launches what it names.
test('🔥 Fire is dimmed whenever nothing is fireable, and its look and press read one answer', async ($, on) => {
  const prompting = `No pending todo to run. ${stillPrompting(3)}`
  const busy = [1, 2].map(i => agentNode(`a${i}`, 1))
  const stopped = aTodo(4, 'Stopped', { status: 'stopped', hasRun: true })
  const cases: [string, Todo[], AgentNode[], string | number][] = [
    ['no todos', [], [], NONE_PENDING],
    ['all running or done', [running(1, 'Busy'), aTodo(2, 'Finished', { status: 'done', hasRun: true })], busy.slice(0, 1), NONE_PENDING],
    ['only prompting', [aTodo(3, 'Drafting', { status: 'prompting' })], [], prompting],
    ['stopped and failed, which only Exec restarts', [stopped, aTodo(5, 'Broke', { status: 'failed', hasRun: true })], [], NONE_PENDING],
    ['the cap reached', [aTodo(6, 'Waiting')], busy, 'The agent cap is reached (2 of 2 running).'],
    ['a pending one under the cap', [stopped, aTodo(8, 'Later'), aTodo(7, 'Waiting')], busy.slice(0, 1), 7],
  ]
  for (const [name, list, nodes, want] of cases) {
    const to = fireTarget(list, nodes, 2)
    expect(`${name}: ${typeof to === 'string' ? to : to.n}`).toBe(`${name}: ${want}`)
    expect(`${name}: ${fireBlock(list, nodes, 2)}`).toBe(`${name}: ${typeof want === 'string' ? want : null}`)
  }

  // In the pane: zero todos dims it and a press only says why; one pending
  // todo lights it.
  const submitted: string[] = []
  const toasts: string[] = []
  engine(on, submitted, undefined, true, { db: seeded([]), toasts })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await fireLook(ui)).toMatchObject({ isDimmed: true, color: DISABLED_FILL })
  await ui.press({ key: 'fire' })
  expect(toasts).toContain(NONE_PENDING)
  expect(submitted).toHaveLength(0)
  await todo($, 'add Count md files')
  expect(await fireLook(ui)).toMatchObject({ isDimmed: false, color: MARK.running.color })
  await ui.unmount()
})

test('a chip that leaves the row under the ring hands the ring to its todo header', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([aTodo(1, 'Count md files')])
  engine(on, submitted, undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'act:1:exec', origin: { kind: 'person' } })
  expect(await isLit(ui, 'act:1:exec')).toBe(true)
  // Drafting has no Exec: the ring lands on #1's header, not on nothing.
  await ui.press({ key: 'act:1:exec' })
  await clock.settle()
  expect(todoAt(db, 1).status).toBe('drafting')
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()
  expect(await isLit(ui, 'todo:1')).toBe(true)
  await ui.unmount()
})

test('the status line counts todos by status and clears with the last one', async ($, on) => {
  const { statuses } = engine(on, [], undefined, true, { unplaced: 'the terminal is too narrow' })
  await start($)
  await todo($, 'add One')
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●1 ✗0 ⏸0 ■0 ✓0')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:delete' })
  await ui.press({ key: 'act:1:deleteyes' })
  expect(statuses.at(-1)).toBeUndefined()
  await ui.unmount()
})

// ---------- the counts: the pane's header or the status line, never both ----------

// The header's view toggles as drawn: each one's mark and count, its color,
// whether it's lit (neither dim nor struck), in order.
type Drawn = { props?: Record<string, unknown>; children?: unknown[] }
const headerMarks = async (ui: Drawing) => {
  const out: { view: string; text: string; color: unknown; isLit: boolean }[] = []
  for (const view of SUMMARY) {
    const b = (await ui.find({ type: 'Button', key: `view:${view}` })) as Drawn | undefined
    const t = (b?.children ?? []).find((c): c is Drawn => typeof c === 'object' && c !== null && 'props' in c)
    if (t === undefined) continue
    out.push({ view, text: (t.children ?? []).join(''), color: t.props?.['color'], isLit: t.props?.['dimColor'] !== true && t.props?.['strikethrough'] !== true })
  }
  return out
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
  expect((await headerMarks(ui)).map(m => m.text)).toEqual(['▶0', '◔0', '●1', '✗0', '⏸0', '■0', '✓0'])
  await ui.unmount()

  where.unplaced = 'the terminal is too narrow'
  await start($)
  await clock.settle()
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●1 ✗0 ⏸0 ■0 ✓0')
})

// The header row as drawn: the pane's first child.
type Found = { type?: string; key?: unknown; text?: string; props?: Record<string, unknown>; children?: unknown[] }
const headerOf = async (ui: { drawn: () => Promise<unknown> }) => ((await ui.drawn()) as Found).children?.[0] as Found
// Every Text's whole text and every Box's props under a node.
const textsIn = (n: unknown): string[] => {
  if (typeof n !== 'object' || n === null) return []
  const f = n as Found
  const all = (x: unknown): string =>
    typeof x === 'string' || typeof x === 'number' ? String(x) : ((x as Found | null)?.children ?? []).map(all).join('')
  return f.type === 'Text' ? [all(f)] : (f.children ?? []).flatMap(textsIn)
}
// A node with its hover labels (absolute Boxes, drawn only on hover) left out:
// what takes room on screen.
const isTip = (n: unknown) => typeof n === 'object' && n !== null && (n as Found).type === 'Box' && (n as Found).props?.['position'] === 'absolute'
const inFlow = (n: Found): Found => ({
  ...n,
  children: (n.children ?? []).filter(c => !isTip(c)).map(c => (typeof c === 'object' && c !== null ? inFlow(c as Found) : c)),
})
// The list's rows under the fixed header, one line each, in drawing order:
// the children of the column inside the list's window.
const listRows = async (ui: { find: (q: { type: string; key: string }) => Promise<unknown> }) => {
  const win = (await ui.find({ type: 'Box', key: 'list' })) as Found | undefined
  const col = (win?.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null)
  return (col?.children ?? []).filter((c): c is Found => typeof c === 'object' && c !== null)
}
// The tree's top rows in order, each named by its key or, keyless, by its
// text: the header, the add element, the header's ═ rule, an empty note and
// the list's window.
const treeRows = async (ui: { drawn: () => Promise<unknown> }) =>
  (((await ui.drawn()) as Found).children ?? []).filter((c): c is Found => typeof c === 'object' && c !== null).map(c => keyOf(c) || textsIn(c).join(''))
// The header's ═ rule sits directly under the add element and directly above
// `note`, and is one dim line of ═ cut to the tree's width.
const ruleAbove = async (ui: Parameters<typeof treeRows>[0] & { find: (q: { type: string; key: string }) => Promise<unknown> }, note: string) => {
  const rows = await treeRows(ui)
  const at = rows.indexOf('ring:add')
  expect(at).toBeGreaterThan(-1)
  expect(rows.slice(at + 1, at + 3)).toEqual(['div2:head', note])
  const rule = (await ui.find({ type: 'Box', key: 'div2:head' })) as Found
  expect(textParts(rule)).toEqual([{ text: '═'.repeat(68), props: expect.objectContaining({ color: DIVIDER, dimColor: true, wrap: 'truncate-end' }) }])
}
// Todo #n's rows at one indent (2 for level 1, 4 level 2, 6 level 3), the
// contents of each, from its header down to the next todo's rule.
const levelRows = async (ui: { find: (q: { type: string; key: string }) => Promise<unknown> }, n: number, indent: number) => {
  const rows = await listRows(ui)
  const from = rows.findIndex(r => JSON.stringify(r).includes(`"ring:todo:${n}"`) && r.props?.['paddingLeft'] === undefined)
  if (from === -1) return []
  const end = rows.findIndex((r, i) => i > from && r.props?.['paddingLeft'] === undefined)
  return rows
    .slice(from + 1, end === -1 ? undefined : end)
    .filter(r => r.props?.['paddingLeft'] === indent)
    .map(r => (r.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null))
    .filter((r): r is Found => r !== undefined)
}
const boxesIn = (n: unknown): Found[] => {
  if (typeof n !== 'object' || n === null) return []
  const f = n as Found
  return [...(f.type === 'Box' ? [f] : []), ...(f.children ?? []).flatMap(boxesIn)]
}

test('the header draws no session title; the title still follows each change, for the drafter\'s prompt', async ($, on) => {
  const { clock, spawns } = drafterEngine(on)
  // The settings hooks beneath: none at start, one names the session on a prompt.
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', (_, e) => (e.prompt === 'name it' ? { sessionTitle: 'Named by a hook' } : {}))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.classic.SessionStart({ source: 'resume', session_title: 'Fix the pane' })
  expect(textsIn(await headerOf(ui)).some(t => t.includes('Fix the pane'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Fix the pane/ })).toBeUndefined()
  await todo($, 'add First')
  await clock.settle()
  expect(spawns.at(-1)?.prompt).toContain('Session: Fix the pane')

  // A rename reaches the next prompt's event; a hook's title wins over it.
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'Renamed' })
  await todo($, 'add Second')
  await clock.settle()
  expect(spawns.at(-1)?.prompt).toContain('Session: Renamed')
  await $.classic.UserPromptSubmit({ prompt: 'name it', session_title: 'Renamed' })
  expect(await ui.find({ type: 'Text', text: /Named by a hook/ })).toBeUndefined()
  await todo($, 'add Third')
  await clock.settle()
  expect(spawns.at(-1)?.prompt).toContain('Session: Named by a hook')

  // A fresh session with no title clears it.
  await $.classic.SessionStart({ source: 'startup' })
  await todo($, 'add Fourth')
  await clock.settle()
  expect(spawns.at(-1)?.prompt).toContain('Session: (untitled)')
  await ui.unmount()
})

test('the header is one row at a narrow width, never wrapped, with 🔥 Fire flush at its right end', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'One'), aTodo(2, 'Two', { status: 'failed', hasRun: true })]) })
  on('classic.SessionStart', () => ({}))
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_title: 'A long session title' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 24 } })
  const header = await headerOf(ui)
  // A row: no column, and nothing in it wraps.
  expect(header.type).toBe('Box')
  expect(header.props?.['flexDirection']).not.toBe('column')
  expect(boxesIn(header).filter(b => b.props?.['flexWrap'] !== undefined && b.props['flexWrap'] !== 'nowrap')).toEqual([])
  // Two parts in the flow: the toggles, which grow and clip, then Fire, which
  // never shrinks. The hover labels beside them take no room.
  const flow = inFlow(header)
  const [toggles, fire] = flow.children as Found[]
  expect(flow.children).toHaveLength(2)
  expect(toggles?.props).toMatchObject({ flexGrow: 1, overflow: 'hidden' })
  expect(fire?.props?.['flexShrink']).toBe(0)
  expect(JSON.stringify(fire)).toContain('"fire"')
  expect(textsIn(flow).at(-1)?.trim()).toBe('🔥')
  expect(textsIn(header).some(t => t.includes('A long session title'))).toBe(false)
  await ui.unmount()
})

test('the header leads with the count, "3 Todos" or "1 Todo", and its toggles\' labels line up after it', async ($, on) => {
  const where: Where = { db: seeded([aTodo(1, 'One'), aTodo(2, 'Two'), aTodo(3, 'Three')]) }
  engine(on, [], undefined, true, where)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The dim count first, then the semibold word.
  const head = (await ui.find({ type: 'Text', text: /^\d+ Todos?$/ })) as Found | undefined
  expect(textsIn(head)).toEqual(['3 Todos'])
  const [count, word] = (head?.children ?? []) as Found[]
  expect(count?.props?.['dimColor']).toBe(true)
  expect(word?.props?.['weight']).toBe('semibold')
  // The first toggle's label opens past `3 Todos` and its ring's cell.
  const first = (boxesIn(await headerOf(ui)) as (Found & { hover?: unknown })[]).find(
    x => isTip(x) && JSON.stringify(x.hover) === JSON.stringify({ display: 'flex', scope: `tip:view:${SUMMARY[0]}` }),
  )
  expect(labelOf(first)?.left).toBe('3 Todos'.length + 1)
  await ui.unmount()

  await todo($, 'delete 2')
  await todo($, 'delete 3')
  const one = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(textsIn(await one.find({ type: 'Text', text: /^\d+ Todos?$/ }))).toEqual(['1 Todo'])
  const single = (boxesIn(await headerOf(one)) as (Found & { hover?: unknown })[]).find(
    x => isTip(x) && JSON.stringify(x.hover) === JSON.stringify({ display: 'flex', scope: `tip:view:${SUMMARY[0]}` }),
  )
  expect(labelOf(single)?.left).toBe('1 Todo'.length + 1)
  await one.unmount()
})

test('a /clear resets the session state, and the list loads again from the database', async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: legacyTodo(1, 'Kept') }
  engine(on, [], undefined, true, { db })
  // The session's state, held here so the test can drop it as a /clear does.
  const held = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_, e) => ({ value: held.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (held.get(e.key)?.version ?? 0) + 1
    held.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  on('classic.SessionStart', () => ({}))
  await start($)
  const listed = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const at = await ui.find({ type: 'Button', key: 'todo:1' })
    await ui.unmount()
    return at !== undefined
  }
  expect(await listed()).toBe(true)

  held.clear()
  expect(await listed()).toBe(false)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await listed()).toBe(true)
  // And a write after it lands in the same list.
  await todo($, 'add After the clear')
  expect(titles(db, '/proj')).toEqual(['1 Kept', '2 After the clear'])
})

test('the sync tick sets the session up again when its state was reset under it', async ($, on) => {
  const db = emptyDb()
  db.todos['/proj'] = { 1: legacyTodo(1, 'Kept') }
  engine(on, [], undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  const held = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_, e) => ({ value: held.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (held.get(e.key)?.version ?? 0) + 1
    held.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  await start($)
  held.clear()
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await ui.unmount()
})

test('noshow hands the counts to the status line, and show takes them back', async ($, on) => {
  const { statuses } = engine(on, [], undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'add One')
  expect(statuses.at(-1)).toBeUndefined()
  await todo($, 'noshow')
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●1 ✗0 ⏸0 ■0 ✓0')
  await todo($, 'add Two')
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●2 ✗0 ⏸0 ■0 ✓0')
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
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●1 ✗0 ⏸0 ■0 ✓0')
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
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●1 ✗0 ⏸0 ■0 ✓0')
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
  await ui.press({ key: 'act:1:details' })
  expect(statuses.at(-1)).toBe('todo ▶0 ◔0 ●1 ✗0 ⏸0 ■0 ✓0')
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
    // Another session's drafter is still writing its prompts.
    aTodo(7, 'Being prompted', { status: 'prompting', owner: 's2', promptingAt: 1000 }),
  ])
  const { statuses } = engine(on, [], undefined, false, { db, unplaced: 'the terminal is too narrow' })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await clock.settle()
  const line = statuses.at(-1)
  expect(line).toBe('todo ▶1 ◔1 ●2 ✗0 ⏸1 ■1 ✓1')

  const ui = await mountAll($)
  const header = await headerMarks(ui)
  expect(`todo ${header.map(m => m.text).join(' ')}`).toBe(line)
  expect(header.map(m => m.color)).toEqual(['#55f155', '#5555f1', '#8b919c', '#f1a355', '#f1f155', STOP_RED, '#a355f1'])
  expect(header.map(m => m.color)).toEqual(SUMMARY.map(s => MARK[s].color))
  // Each row's glyph is its status's mark; a running row spins in its color.
  for (const [n, s] of [[2, 'paused'], [3, 'stopped'], [4, 'done'], [5, 'pending'], [7, 'prompting']] as const) {
    const row = await ui.find({ type: 'Button', key: `todo:${n}` })
    expect(JSON.stringify(row?.children)).toContain(JSON.stringify(MARK[s].color))
    // The header line is the todo's only line: ▸, #N and title, the mark at its right end.
    expect(row?.text.startsWith(`▸ #${n} `)).toBe(true)
    expect(row?.text.endsWith(` ${MARK[s].symbol}`)).toBe(true)
  }
  expect(JSON.stringify((await ui.find({ type: 'Button', key: 'todo:1' }))?.children)).toContain(JSON.stringify(MARK.running.color))
  await ui.unmount()
})

// ---------- the view: the header's status toggles ----------

// The todos' numbers in the order the list draws them.
const rowsDrawn = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' })).flatMap(b => {
    const m = /^todo:(\d+)$/.exec(b.key ?? '')
    return m ? [Number(m[1])] : []
  })

const viewed = () =>
  seeded([
    aTodo(1, 'Finished first', { status: 'done', hasRun: true, doneAt: 1000 }),
    aTodo(2, 'Waiting'),
    running(3, 'Runs'),
    aTodo(4, 'Drafting', { status: 'drafting', owner: 's1' }),
    aTodo(5, 'Broke', { status: 'failed', hasRun: true }),
    running(6, 'Held', { status: 'paused' }),
    aTodo(7, 'Halted', { status: 'stopped', hasRun: true }),
    aTodo(8, 'Planning', { status: 'planning', owner: 's1' }),
  ])

test('the default view shows running (drafting and planning too), pending, failed, paused and stopped, and hides done; the counts and the status line stay whole', async ($, on) => {
  const { statuses } = engine(on, [], undefined, false, { db: viewed(), unplaced: 'the terminal is too narrow' })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await clock.settle()
  // The status line counts every todo, whatever the pane shows.
  expect(statuses.at(-1)).toBe('todo ▶3 ◔0 ●1 ✗1 ⏸1 ■1 ✓1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Paused #6 and stopped #7 are unfinished work, so they're drawn; done #1 isn't.
  expect(await rowsDrawn(ui)).toEqual([2, 3, 4, 5, 6, 7, 8])
  const marks = await headerMarks(ui)
  expect(marks.map(m => `${m.text}${m.isLit ? '' : ' hidden'}`)).toEqual(['▶3', '◔0', '●1', '✗1', '⏸1', '■1', '✓1 hidden'])
  // A hidden view's toggle is dim and struck through, in its own color.
  const struck = (await ui.find({ type: 'Button', key: 'view:done' })) as Drawn | undefined
  expect(JSON.stringify(struck?.children)).toContain('"strikethrough":true')
  expect(marks.find(m => m.view === 'done')?.color).toBe(MARK.done.color)
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('all')
  expect((await ui.find({ type: 'Text', text: /hidden by the view/ }))?.text).toBe('1 hidden by the view')
  await ui.unmount()
})

test('each status toggle shows or hides its todos, done sorts last, and the last toggle cycles default, all, none', async ($, on) => {
  engine(on, [], undefined, true, { db: viewed() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Done shown: it sorts after every other todo.
  await ui.press({ key: 'view:done' })
  expect(await rowsDrawn(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 1])
  expect(await ui.find({ type: 'Text', text: /hidden by the view/ })).toBeUndefined()
  // Every view lit reads none: its next press.
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('none')
  // Running off hides drafting and planning with it.
  await ui.press({ key: 'view:running' })
  expect(await rowsDrawn(ui)).toEqual([2, 5, 6, 7, 1])
  expect((await ui.find({ type: 'Text', text: /hidden by the view/ }))?.text).toBe('3 hidden by the view')
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('all')
  // All lights every view, and reads none (its next press) while they all are.
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 1])
  expect((await headerMarks(ui)).every(m => m.isLit)).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('none')
  expect(await ui.find({ type: 'Text', text: /hidden by the view/ })).toBeUndefined()
  // Pressed then, it turns every view off: the none view, which reads default.
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([])
  expect((await headerMarks(ui)).some(m => m.isLit)).toBe(false)
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('default')
  // Pressed from none, it puts the default view back, paused and stopped in it.
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([2, 3, 4, 5, 6, 7, 8])
  expect((await headerMarks(ui)).map(m => m.isLit)).toEqual([true, true, true, true, true, true, false])
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('all')
  // And round again: all, none, default.
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([2, 3, 4, 5, 6, 7, 8, 1])
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('none')
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([])
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([2, 3, 4, 5, 6, 7, 8])
  // A view with nothing in it says so.
  for (const v of ['running', 'pending', 'failed', 'paused', 'stopped']) await ui.press({ key: `view:${v}` })
  expect(await rowsDrawn(ui)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Nothing in this view.' })).toBeDefined()
  // The header's double rule sits between the add element and the note.
  await ruleAbove(ui, 'Nothing in this view.')
  expect((await ui.find({ type: 'Text', text: /hidden by the view/ }))?.text).toBe('8 hidden by the view')
  await ui.unmount()
})

test('the view outlasts a redraw and a reload, and a list with no todos only says to add one', async ($, on) => {
  const db = viewed()
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view:paused' })
  await ui.press({ key: 'view:pending' })
  await ui.unmount()
  await start($)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsDrawn(again)).toEqual([3, 4, 5, 7, 8])
  await again.unmount()

  db.todos['/proj'] = {}
  db.rev['/proj'] = (db.rev['/proj'] ?? 0) + 1
  await start($)
  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: 'No todos yet. Type a title above.' })).toBeDefined()
  expect(await empty.find({ type: 'Text', text: 'Nothing in this view.' })).toBeUndefined()
  await ruleAbove(empty, 'No todos yet. Type a title above.')
  expect(await empty.find({ type: 'Text', text: /hidden by the view/ })).toBeUndefined()
  await empty.unmount()
})

test('a todo in hand stays in a view that hides its status: paused under the ring, or just stopped and asking what next', async ($, on) => {
  const db = seeded([running(1, 'Pause me'), running(2, 'Stop me')])
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The default view shows paused and stopped todos, so hide them to see the hold.
  await ui.press({ key: 'view:paused' })
  await ui.press({ key: 'view:stopped' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:pause' })
  // Pause put the ring on ⏵ Resume, so #1 stays while the ring is on it.
  expect(todoAt(db, 1).status).toBe('paused')
  expect(await isLit(ui, 'act:1:resume')).toBe(true)
  await ui.press({ key: 'todo:2' })
  await ui.press({ key: 'act:2:stop' })
  await ui.press({ key: 'act:2:stopyes' })
  // The ring moved to #2's Refine: #1 leaves the view, #2 stays until Leave.
  expect(await rowsDrawn(ui)).toEqual([2])
  // Just stopped: Leave joins its one row of actions (no extra line asks what next).
  expect(await ui.find({ type: 'Button', key: 'act:2:leave' })).toBeDefined()
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'view:running', origin: { kind: 'person' } })
  expect(await rowsDrawn(ui)).toEqual([2])
  await ui.press({ key: 'act:2:leave' })
  expect(await rowsDrawn(ui)).toEqual([])
  expect((await ui.find({ type: 'Text', text: /hidden by the view/ }))?.text).toBe('2 hidden by the view')
  await ui.unmount()
})

test('the none view hides every todo, the ones in hand too, counts them in its footer, and hands the ring to the toggle', async ($, on) => {
  const db = seeded([running(1, 'Under the ring'), running(2, 'Halt me'), aTodo(3, 'Finished', { status: 'done', hasRun: true, doneAt: 1 })])
  engine(on, [], undefined, false, { db })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:2' })
  await ui.press({ key: 'act:2:stop' })
  await ui.press({ key: 'act:2:stopyes' })
  await clock.settle()
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'todo:1', origin: { kind: 'person' } })
  expect(await isLit(ui, 'todo:1')).toBe(true)
  // Default, then all, then none.
  expect(await rowsDrawn(ui)).toEqual([1, 2])
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([1, 2, 3])
  await ui.press({ key: 'view:all' })
  await clock.settle()
  // Neither the todo under the ring nor the one just stopped stays.
  expect(await rowsDrawn(ui)).toEqual([])
  expect((await headerMarks(ui)).some(m => m.isLit)).toBe(false)
  expect((await ui.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('default')
  // The empty tree: the header's double rule, one line saying so, then the
  // footer under its own double rule, with no blank line and no border
  // anywhere.
  expect(await ui.find({ type: 'Text', text: 'Nothing in this view.' })).toBeDefined()
  expect(await dividers(ui)).toEqual(['div2:head', 'div2:hidden'])
  await ruleAbove(ui, 'Nothing in this view.')
  expect((await ui.find({ type: 'Text', text: /hidden by the view/ }))?.text).toBe('3 hidden by the view')
  const tree = (await ui.drawn()) as Found
  const rows = (tree.children ?? []).filter((c): c is Found => typeof c === 'object' && c !== null)
  expect(rows.filter(r => r.type === 'Text' && textsIn(r).join('').trim() === '')).toEqual([])
  expect(boxesIn(tree).filter(b => ['borderStyle', 'paddingY', 'marginY', 'paddingTop', 'marginTop'].some(k => b.props?.[k] !== undefined))).toEqual([])
  // The ring's todo left the tree, so the ring is on the toggle that hid it.
  expect(await isLit(ui, 'view:all')).toBe(true)
  // Pressed again, the default view is back, the stopped todo with it.
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([1, 2])
  await ui.unmount()
})

test('from the none view, lighting one status shows just that status, and none outlasts a reload', async ($, on) => {
  engine(on, [], undefined, true, { db: viewed() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view:all' })
  await ui.press({ key: 'view:all' })
  expect(await rowsDrawn(ui)).toEqual([])
  await ui.unmount()
  await start($)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsDrawn(again)).toEqual([])
  expect((await again.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('default')
  await again.press({ key: 'view:failed' })
  expect(await rowsDrawn(again)).toEqual([5])
  expect((await headerMarks(again)).filter(m => m.isLit).map(m => m.view)).toEqual(['failed'])
  expect((await again.find({ type: 'Button', key: 'view:all' }))?.props['label']).toBe('all')
  expect((await again.find({ type: 'Text', text: /hidden by the view/ }))?.text).toBe('7 hidden by the view')
  await again.unmount()
})

// ---------- conformance: docs/architecture.md, "Buttons by state" ----------

// Where a press leaves the todo: a status, `removed`, `browser` (the call
// browser's dialog), or the chips the confirmation it asks draws instead.
type Lead = Todo['status'] | 'removed' | 'browser' | { confirm: string[] }
type StateRow = { state: string; todo: (n: number) => Todo; before?: string[]; chips: Record<string, Lead> }

// A todo another session's drafter is still prompting, started far ahead of
// the test clock, so the sync tick never counts it stuck mid-table.
const prompting = (n: number, title: string) => aTodo(n, title, { status: 'prompting', owner: 'other', promptingAt: Date.now() })

const BY_STATE: StateRow[] = [
  {
    // Exec and Auto are left out until its drafts arrive.
    state: 'prompting',
    todo: n => prompting(n, 'Prompting'),
    chips: { rename: 'prompting', delete: { confirm: ['deleteyes', 'cancel'] }, details: 'browser' },
  },
  { state: 'prompting, confirming Delete', todo: n => prompting(n, 'Prompting'), before: ['delete'], chips: { deleteyes: 'removed', cancel: 'prompting' } },
  {
    state: 'pending, never ran',
    todo: n => aTodo(n, 'Waiting'),
    chips: { exec: 'drafting', auto: 'drafting', rename: 'pending', delete: { confirm: ['deleteyes', 'cancel'] }, details: 'browser' },
  },
  { state: 'pending, confirming Delete', todo: n => aTodo(n, 'Waiting'), before: ['delete'], chips: { deleteyes: 'removed', cancel: 'pending' } },
  { state: 'pending, has run', todo: n => aTodo(n, 'Again', { hasRun: true }), chips: { exec: 'drafting', auto: 'drafting', rename: 'pending', details: 'browser' } },
  { state: 'drafting, never ran', todo: n => aTodo(n, 'Drafting', { status: 'drafting', owner: 's1' }), chips: { reset: 'pending' } },
  { state: 'drafting, has run', todo: n => aTodo(n, 'Drafting', { status: 'drafting', hasRun: true, owner: 's1' }), chips: { reset: 'stopped' } },
  { state: 'planning, never ran', todo: n => aTodo(n, 'Planning', { status: 'planning', owner: 's1' }), chips: { reset: 'pending' } },
  { state: 'planning, has run', todo: n => aTodo(n, 'Planning', { status: 'planning', hasRun: true, owner: 's1' }), chips: { reset: 'stopped' } },
  { state: 'running', todo: n => running(n, 'Runs'), chips: { pause: 'paused', stop: { confirm: ['stopyes', 'keep'] }, details: 'browser' } },
  { state: 'running, confirming Stop', todo: n => running(n, 'Runs'), before: ['stop'], chips: { stopyes: 'stopped', keep: 'running' } },
  {
    state: 'paused',
    todo: n => running(n, 'Held', { status: 'paused' }),
    chips: { resume: 'drafting', stop: { confirm: ['stopyes', 'keep'] }, details: 'browser' },
  },
  { state: 'paused, confirming Stop', todo: n => running(n, 'Held', { status: 'paused' }), before: ['stop'], chips: { stopyes: 'stopped', keep: 'paused' } },
  {
    state: 'stopped, right after a Stop',
    todo: n => running(n, 'Halted'),
    before: ['stop', 'stopyes'],
    chips: { refine: 'drafting', restart: 'drafting', details: 'browser', resume: 'drafting', leave: 'stopped' },
  },
  {
    state: 'stopped, nothing to pick up',
    todo: n => aTodo(n, 'Halted', { status: 'stopped', hasRun: true }),
    chips: { refine: 'drafting', restart: 'drafting', details: 'browser' },
  },
  {
    state: 'stopped, its agent kept',
    todo: n => aTodo(n, 'Halted', { status: 'stopped', hasRun: true, mode: 'agent', taskId: `ag${n}` }),
    chips: { refine: 'drafting', restart: 'drafting', details: 'browser', resume: 'drafting' },
  },
  {
    state: 'failed',
    todo: n => aTodo(n, 'Broke', { status: 'failed', hasRun: true, mode: 'agent', taskId: `ag${n}` }),
    chips: { refine: 'drafting', restart: 'drafting', details: 'browser', resume: 'drafting' },
  },
  // Done far ahead of the test clock, so it can't leave the tree mid-table.
  { state: 'done', todo: n => aTodo(n, 'Finished', { status: 'done', hasRun: true, doneAt: Date.now() }), chips: { details: 'browser' } },
  {
    state: 'in flight in another session',
    todo: n => running(n, 'Elsewhere', { owner: 'other' }),
    chips: { takeover: { confirm: ['takeyes', 'cancel'] }, details: 'browser' },
  },
  {
    state: 'in flight in another session, confirming Takeover',
    todo: n => running(n, 'Elsewhere', { owner: 'other' }),
    before: ['takeover'],
    chips: { takeyes: 'stopped', cancel: 'running' },
  },
]

test('each state draws exactly the chips docs/architecture.md lists for it, and each leads where the doc says', { timeoutMs: 30_000 }, async ($, on) => {
  // A copy of each row's todo per chip, so every press starts from that state.
  const presses = BY_STATE.flatMap(r => Object.keys(r.chips).map(chip => ({ r, chip })))
  const db = seeded(presses.map(({ r }, i) => r.todo(i + 1)))
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  await start($)
  let ui = await mountAll($)
  const chipsOf = async (n: number) =>
    (await ui.findAll({ type: 'Button' })).flatMap(b => (b.key?.startsWith(`act:${n}:`) ? [b.key.slice(`act:${n}:`.length)] : [])).sort()
  for (const [i, { r, chip }] of presses.entries()) {
    const n = i + 1
    await ui.press({ key: `todo:${n}` })
    for (const k of r.before ?? []) await ui.press({ key: `act:${n}:${k}` })
    expect(`${r.state}: ${(await chipsOf(n)).join(' ')}`).toBe(`${r.state}: ${Object.keys(r.chips).sort().join(' ')}`)
    await ui.press({ key: `act:${n}:${chip}` })
    const lead = r.chips[chip]
    const at = `${r.state} → ${chip}`
    if (lead === 'browser') {
      // The dialog replaces the tree; a reload closes it.
      expect(`${at}: ${String((await ui.find({ type: 'Button', key: `todo:${n}` })) === undefined)}`).toBe(`${at}: true`)
      await ui.unmount()
      await start($)
      ui = await mountAll($)
    } else if (lead === 'removed') {
      expect(`${at}: ${String(db.todos['/proj']?.[n] === undefined)}`).toBe(`${at}: true`)
    } else if (typeof lead === 'object') {
      expect(`${at}: ${(await chipsOf(n)).join(' ')}`).toBe(`${at}: ${[...lead.confirm].sort().join(' ')}`)
    } else {
      expect(`${at}: ${todoAt(db, n).status}`).toBe(`${at}: ${lead}`)
    }
  }
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
  await inChat($, 1)
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu1', script: 'export const meta = { name: "todo-1-statusline" }' } as never)
  expect(todoAt(db, 1)).toMatchObject({ mode: 'workflow', status: 'running', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js', hasRun: true, toolUseIds: ['tu1'], owner: 's1' })
})

test('a resumed Workflow links by its resumeFromRunId, keeping what the result leaves out', async ($, on) => {
  // ⏵ Resume has put it in the chat's hands.
  const db = seeded([aTodo(1, 'Migrate', { status: 'drafting', hasRun: true, mode: 'workflow', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js', toolUseIds: ['tu1'], owner: 's1' })])
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
  await ui.press({ key: 'subs:1' })
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
  const ui = await mountAll($)
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
  const ui = await mountAll($)
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
  const ui = await mountAll($)
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
  engine(on, [], undefined, true, { db, toasts, drop: 'a hook refused it' })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:resume' })
  expect(todoAt(db, 1)).toMatchObject({ status: 'paused', taskId: 'ag1' })
  expect(toasts).toContain("#1 didn't start: a hook refused it")
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

test("an agent's turn ends it: a lone Agent's todo stays running until Claude reports, a refusal fails it, an abort stops it", async ($, on) => {
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
  // Whether its work landed is Claude's to say (protocol step 6): until then
  // the todo runs on, the answer's first line kept as its summary.
  expect(todoAt(db, 1)).toMatchObject({ status: 'running', summary: 'Counted 12 md files.' })
  await $.tool.call({ tool: 'mcp__todo__update', n: 1, status: 'failed', summary: "didn't land: checks fail" } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'failed', summary: "didn't land: checks fail" })
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
  await inChat($, 1)
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

// ---------- prompt drafts ----------

// The spawn as the engine raises it: the Agent tool spells the type subagent_type.
type Spawned = { prompt: string; description?: string; subagentType?: string; subagent_type?: string; model?: string }
// The engine beneath the drafter: it registers the plugin's agent type, and
// each spawn starts dr1, dr2, … (or is refused while `deny` is set). The
// test's engine hands a plugin's spawn no id, so the agent list names them.
function drafterEngine(on: Parameters<TestBody>[1], where: Where = {}) {
  const submitted: string[] = []
  const toasts: string[] = []
  const got = engine(on, submitted, undefined, false, { toasts, ...where })
  const clock = mock.clock(on, { now: 1000 })
  const registered: Record<string, unknown>[] = []
  const spawns: Spawned[] = []
  const gate = { deny: undefined as string | undefined }
  on('agent.register', (_, e) => (registered.push(e as never), { value: { agent: `todo:${e.name}` } }) as never)
  on('agent.spawn', (_, e) => {
    spawns.push(e)
    return gate.deny === undefined ? { model: 'haiku', agentId: `dr${spawns.length}` } : { deny: gate.deny }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => ({
    value: spawns.map((s, i) => ({ id: `dr${i + 1}`, description: s.description ?? '', type: 'todo:drafter', status: 'running' })),
  }) as never)
  return { ...got, submitted, toasts, clock, registered, spawns, gate }
}

const DRAFTS = [
  { label: 'Fix the tab title', prompt: 'Set the kitty tab title from the session name in hooks/title.ts.' },
  { label: 'Add a title test', prompt: 'Cover the kitty tab title with a test.' },
  { label: 'Document it', prompt: 'Explain kitty tab titles in the README.' },
]
// A drafter's call, from its own loop, under the key its launch gave it.
const storeDrafts = ($: T$, n: number, key: string, drafts = DRAFTS) =>
  $.tool.call({ tool: 'mcp__todo__drafts', n, key, drafts, agentId: `drafter-${key}` } as never)

test('adding a todo spawns a small read-only drafter in the background, whose drafts are stored and never linked as its run', async ($, on) => {
  const { db, clock, registered, spawns, submitted } = drafterEngine(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'dr1' } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'hooks/title.ts', stderr: '' }, text: 'hooks/title.ts' }))
  await start($)
  const added = await todo($, 'add Fix kitty tab titles')
  // Adding answers before any drafter starts.
  expect(added.text).toBe('Added #1 Fix kitty tab titles')
  expect(spawns).toHaveLength(0)
  await clock.settle()

  expect(registered[0]).toMatchObject({ name: 'drafter', model: 'haiku', tools: ['Read', 'Grep', 'Glob'] })
  expect(spawns).toHaveLength(1)
  expect(spawns[0]).toMatchObject({ model: 'haiku', description: '[todo-drafts:1] Draft prompts for #1' })
  expect(spawns[0]?.subagentType ?? spawns[0]?.subagent_type).toBe('todo:drafter')
  expect(spawns[0]?.prompt).toContain('only this JSON object')
  expect(spawns[0]?.prompt).toContain('{"n": 1, "key": "1.1", "drafts": [')
  expect(spawns[0]?.prompt).toContain('read-only')

  // Its spawn and its own calls never touch the todo or its subtasks.
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tuD', description: '[todo-drafts:1] Draft prompts for #1', prompt: 'p' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'g1', command: 'grep -rl title', agentId: 'dr1' } as never)
  // Its drafts come back as its answer (a fence around the JSON is fine).
  await turnDone($, 'dr1', '```json\n' + JSON.stringify({ n: 1, key: '1.1', drafts: DRAFTS }) + '\n```')
  expect(todoAt(db, 1)).toMatchObject({ status: 'pending', drafts: DRAFTS, toolUseIds: [], hasRun: false })
  expect(todoAt(db, 1).prompt).toBeUndefined()
  expect(Object.keys(db.agents)).toHaveLength(0)
  expect(Object.keys(db.calls)).toHaveLength(0)
  expect(todoAt(db, 1)).toMatchObject({ status: 'pending', toolUseIds: [], drafts: DRAFTS })

  // Level 1 hints that they're ready.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' 3 drafts: ▶ Exec asks, ⚡/🔥 take the 1st' })).toBeDefined()
  // Its drafts are its prompt's stand-in: no "no prompt yet" beside them.
  expect(await ui.find({ type: 'Text', text: /no prompt yet/ })).toBeUndefined()
  expect(submitted).toHaveLength(0)
  await ui.unmount()

  // The drafter is the plugin's to spawn, never offered to the model; other types are.
  const offer = (agent: string) => $.agent.offer({ agent, description: 'd', source: 'plugin', provider: { plugin: 'todo', tier: 'user' } } as never)
  expect(await offer('todo:drafter')).toMatchObject({ isOffered: false })
  expect(await offer('Explore')).toMatchObject({ isOffered: true })

  // A bad call stores nothing.
  expect(await $.tool.call({ tool: 'mcp__todo__drafts', n: 9, drafts: DRAFTS } as never)).toMatchObject({ isError: true })
  expect(await $.tool.call({ tool: 'mcp__todo__drafts', n: 1, drafts: [{ label: '' }] } as never)).toMatchObject({ isError: true })
  expect(todoAt(db, 1).drafts).toEqual(DRAFTS)
})

test('Exec offers the stored drafts without drafting, Auto takes the first, Refine is unchanged', async ($, on) => {
  const { clock, submitted } = drafterEngine(on)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  await todo($, 'add Count md files')
  await clock.settle()
  await storeDrafts($, 1, '1.1')
  await storeDrafts($, 2, '2.2', [{ label: 'Count', prompt: 'Count the md files.' }, ...DRAFTS.slice(1)])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:exec' })
  expect(await todo($, 'exec auto 2')).toMatchObject({ text: expect.stringContaining('takes the best drafted prompt') })
  await clock.settle()

  const [asked, auto] = submitted as [string, string]
  expect(asked).toContain("don't draft new ones")
  expect(asked).toContain('ONE AskUserQuestion')
  for (const d of DRAFTS) expect(asked).toContain(`   - ${d.label}: ${d.prompt}`)
  expect(asked).toContain('via Other')
  expect(asked).not.toContain('Draft 2–3')
  expect(auto).toContain('in auto mode')
  expect(auto).toContain('Count the md files.')
  expect(auto).not.toContain('Draft the single best prompt')
  expect(auto).not.toContain('AskUserQuestion')
  await ui.unmount()

  // Refine works on the chosen prompt, as ever, never on the drafts.
  const t = { ...aTodo(3, 'T', { status: 'stopped', hasRun: true, prompt: 'chosen' }), drafts: DRAFTS }
  const refine = execPrompt(t, 1, true)
  expect(refine).toContain('Current prompt: chosen')
  expect(refine).not.toContain(DRAFTS[0]?.prompt ?? '-')
})

test('a rename clears the drafts and drafts again; drafts the old drafter sends late are refused as stale', async ($, on) => {
  const { db, clock, spawns } = drafterEngine(on)
  await start($)
  await todo($, 'add Old title')
  await clock.settle()
  await storeDrafts($, 1, '1.1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:rename' })
  await ui.input({ key: 'ren:1', text: 'New title' })
  expect(todoAt(db, 1)).toMatchObject({ title: 'New title' })
  expect(todoAt(db, 1).drafts).toBeUndefined()
  await clock.settle()
  expect(spawns).toHaveLength(2)
  expect(spawns[1]?.prompt).toContain('"New title"')

  expect((await storeDrafts($, 1, '1.1')).result).toContain('stale')
  expect(todoAt(db, 1).drafts).toBeUndefined()
  await storeDrafts($, 1, '1.2')
  expect(todoAt(db, 1).drafts).toEqual(DRAFTS)
  // The same title again is no rename: nothing is re-drafted.
  await ui.press({ key: 'act:1:rename' })
  await ui.input({ key: 'ren:1', text: 'New title' })
  await clock.settle()
  expect(spawns).toHaveLength(2)
  expect(todoAt(db, 1).drafts).toEqual(DRAFTS)
  await ui.unmount()
})

test("a drafter's answer stores its drafts only under its own launch's key, and one without JSON stores none", async ($, on) => {
  const { db, clock } = drafterEngine(on)
  await start($)
  await todo($, 'add Old title')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:rename' })
  await ui.input({ key: 'ren:1', text: 'New title' })
  await ui.unmount()
  await clock.settle()
  // The first drafter, asked for the old title, answers late: stale.
  await turnDone($, 'dr1', JSON.stringify({ n: 1, key: '1.1', drafts: DRAFTS }))
  expect(todoAt(db, 1).drafts).toBeUndefined()
  // The second answers with no JSON: nothing stored, and the todo is no
  // longer prompting.
  await turnDone($, 'dr2', 'I could not draft anything useful.')
  expect(todoAt(db, 1).drafts).toBeUndefined()
  expect(todoAt(db, 1).status).toBe('pending')
})

test('drafts that arrive once a todo is running are kept without touching its run or its chosen prompt', async ($, on) => {
  const { db, clock } = drafterEngine(on)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  await clock.settle()
  // Its drafter ended with none, so it was started; drafts come in late.
  await turnDone($, 'dr1', 'Nothing yet.')
  await inChat($, 1)
  await $.tool.call({ tool: 'mcp__todo__update', n: 1, prompt: 'mine', mode: 'agent', status: 'running' } as never)
  await storeDrafts($, 1, '1.1')
  expect(todoAt(db, 1)).toMatchObject({ status: 'running', prompt: 'mine', drafts: DRAFTS })
})

test("a todo is prompting from its drafter's spawn until its drafts are stored, Exec and Auto left out meanwhile", async ($, on) => {
  const { db, clock, submitted } = drafterEngine(on)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  // Added pending; prompting once its drafter is spawned, owned by this session.
  expect(todoAt(db, 1).status).toBe('pending')
  await clock.settle()
  expect(todoAt(db, 1)).toMatchObject({ status: 'prompting', owner: 's1', promptingAt: 1000 })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'view:prompting' })).toBeDefined()
  const row = await ui.find({ type: 'Button', key: 'todo:1' })
  expect(row?.text.endsWith(` ${MARK.prompting.symbol}`)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /no prompt yet: drafting prompts…/ })).toBeDefined()
  for (const k of ['exec', 'auto']) expect(await ui.find({ type: 'Button', key: `act:1:${k}` })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:rename' })).toBeDefined()

  await storeDrafts($, 1, '1.1')
  const t = todoAt(db, 1)
  expect(t).toMatchObject({ status: 'pending', drafts: DRAFTS })
  expect(t.owner).toBeUndefined()
  expect(t.promptingAt).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /3 drafts: ▶ Exec asks/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeDefined()
  // Its drafter's later end changes nothing.
  await turnDone($, 'dr1', 'Stored 3 drafts.')
  await clock.settle()
  expect(todoAt(db, 1).status).toBe('pending')
  expect(submitted).toHaveLength(0)
  await ui.unmount()
})

test('Exec, Auto, 🔥 Fire and /todo exec never start a prompting todo, and say its prompts are still being drafted', async ($, on) => {
  const { db, clock, submitted, toasts } = drafterEngine(on)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  await clock.settle()
  const still = "#1's prompts are still being drafted: it can start once they're ready."
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:auto' })).toBeUndefined()
  expect((await todo($, 'exec 1')).text).toBe(still)
  expect((await todo($, 'exec auto 1')).text).toBe(still)
  expect((await todo($, 'auto 1')).text).toBe(still)
  expect((await todo($, 'resume 1')).text).toBe(still)
  // Nothing else pending: `/todo exec auto` and Fire skip it, saying why.
  // Fire is dimmed, never hidden: the ring reaches it and keeps it.
  expect((await todo($, 'exec auto')).text).toBe(`No pending todo to run. ${still}`)
  expect((await fireLook(ui)).isDimmed).toBe(true)
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'fire', origin: { kind: 'person' } })
  await clock.settle()
  expect(await isLit(ui, 'fire')).toBe(true)
  await ui.press({ key: 'fire' })
  await clock.settle()
  expect(toasts).toContain(`No pending todo to run. ${still}`)
  expect(await isLit(ui, 'fire')).toBe(true)
  expect(submitted).toHaveLength(0)
  expect(todoAt(db, 1).status).toBe('prompting')
  await ui.unmount()
})

test("a drafter that ends without drafts, fails or can't start leaves its todo pending, and Exec drafts in the chat", async ($, on) => {
  const { db, clock, submitted, toasts, gate } = drafterEngine(on)
  await start($)
  await todo($, 'add Ends empty')
  await todo($, 'add Fails')
  await clock.settle()
  expect(todoAt(db, 1).status).toBe('prompting')
  expect(todoAt(db, 2).status).toBe('prompting')

  await turnDone($, 'dr1', 'Nothing to say.')
  expect(todoAt(db, 1).status).toBe('pending')
  expect(toasts).toContain('#1: no prompt drafts; ▶ Exec drafts in the chat')
  await turnDone($, 'dr2', 'no', { refused: true })
  expect(todoAt(db, 2).status).toBe('pending')
  expect(toasts).toContain('#2: its drafter failed; ▶ Exec drafts in the chat')

  // A spawn the engine refuses never holds the todo.
  gate.deny = 'no subagents here'
  await todo($, 'add Refused')
  await clock.settle()
  expect(todoAt(db, 3).status).toBe('pending')

  await todo($, 'exec 1')
  await clock.settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('Draft 2–3')
  // Fire takes the lowest-numbered pending todo.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fire' })
  expect(submitted.at(-1)).toContain('Execute todo #2 "Fails" in auto mode')
  await ui.unmount()
})

test('a prompting todo can be renamed, staying prompting under its new drafter, or deleted', async ($, on) => {
  const { db, clock, spawns } = drafterEngine(on)
  await start($)
  await todo($, 'add Old title')
  await todo($, 'add Unwanted')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:1:rename' })
  await ui.input({ key: 'ren:1', text: 'New title' })
  await clock.settle()
  expect(spawns).toHaveLength(3)
  expect(todoAt(db, 1)).toMatchObject({ title: 'New title', status: 'prompting' })
  // The old drafter's end and late drafts don't release it; the new one's do.
  await turnDone($, 'dr1', 'Nothing.')
  expect((await storeDrafts($, 1, '1.1')).result).toContain('stale')
  expect(todoAt(db, 1).status).toBe('prompting')
  await storeDrafts($, 1, '1.3')
  expect(todoAt(db, 1)).toMatchObject({ status: 'pending', drafts: DRAFTS })

  await ui.press({ key: 'act:2:delete' })
  await ui.press({ key: 'act:2:deleteyes' })
  expect(db.todos['/proj']?.[2]).toBeUndefined()
  // Its drafter's late drafts find nothing to store.
  expect(await storeDrafts($, 2, '2.2')).toMatchObject({ isError: true })
  await ui.unmount()
})

test("a prompting todo whose drafter isn't running goes back to pending at the next sync: this session's at once, another's after the wait", async ($, on) => {
  const db = seeded([
    // This session's, its drafter lost to a /clear or a restart.
    aTodo(1, 'Mine', { status: 'prompting', owner: 's1', promptingAt: 1000 }),
    aTodo(2, 'Theirs', { status: 'prompting', owner: 'other', promptingAt: 1000 }),
  ])
  engine(on, [], undefined, false, { db })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await clock.advance(2000)
  expect(todoAt(db, 1).status).toBe('pending')
  expect(todoAt(db, 1).owner).toBeUndefined()
  expect(todoAt(db, 2).status).toBe('prompting')
  await clock.advance(120_000)
  expect(todoAt(db, 2).status).toBe('pending')
})

test('a view stored before prompting had a toggle shows prompting todos wherever it showed pending ones', async ($, on) => {
  const db = seeded([aTodo(1, 'Prompting', { status: 'prompting', owner: 'other', promptingAt: Date.now() }), aTodo(2, 'Waits')])
  const held = legacyState(on, { ui: { expanded: [], confirm: null, renaming: null, justStopped: [], isHidden: false, view: ['running', 'failed'] } })
  engine(on, [], undefined, true, { db })
  await start($)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Pending was hidden, so prompting is too.
  expect(await rowsDrawn(ui)).toEqual([])
  // A toggle stores the new view in its place, prompting still hidden.
  await ui.press({ key: 'view:pending' })
  expect(held('ui')).toMatchObject({ value: { shown: ['running', 'pending', 'failed'] } })
  expect((held('ui') as { value: object }).value).not.toHaveProperty('view')
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsDrawn(ui)).toEqual([2])
  await ui.unmount()
})

const parked = () =>
  seeded([aTodo(1, 'Waits'), running(2, 'Held', { status: 'paused' }), aTodo(3, 'Halted', { status: 'stopped', hasRun: true }), aTodo(4, 'Finished', { status: 'done', hasRun: true, doneAt: 1 })])
const storedUi = (views: string[]) => ({ ui: { expanded: [], confirm: null, renaming: null, justStopped: [], isHidden: false, views } })

test('a view stored as the old default (before paused and stopped joined it) reads as the new default, paused and stopped shown', async ($, on) => {
  const held = legacyState(on, storedUi(['running', 'prompting', 'pending', 'failed']))
  engine(on, [], undefined, true, { db: parked() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsDrawn(ui)).toEqual([1, 2, 3])
  expect((await headerMarks(ui)).map(m => m.isLit)).toEqual([true, true, true, true, true, true, false])
  // The next toggle stores the view in its new field and drops the old one.
  await ui.press({ key: 'view:done' })
  expect(held('ui')).toMatchObject({ value: { shown: ['running', 'prompting', 'pending', 'failed', 'paused', 'stopped', 'done'] } })
  expect((held('ui') as { value: object }).value).not.toHaveProperty('views')
  await ui.unmount()
})

test('a view stored as anything but the old default stays as the person set it', async ($, on) => {
  legacyState(on, storedUi(['running', 'pending', 'failed']))
  engine(on, [], undefined, true, { db: parked() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowsDrawn(ui)).toEqual([1])
  expect((await headerMarks(ui)).map(m => m.isLit)).toEqual([true, false, true, true, false, false, false])
  await ui.unmount()
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
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await transcript(ui, 1, 'ag1')
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
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'subs:1' })
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
  await ui.press({ key: 'subs:2' })
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
  const ui = await mountAll($)
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
  await transcript(ui, 1, 'ag1')
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
    agents: [agentNode('ag1', 1)],
    ui: { expanded: ['t1', 's1', 'a1:ag1'], confirm: null, renaming: null, justStopped: [], isHidden: false },
  })
  await start($)
  expect(todoAt(db, 2).title).toBe('Mine')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'act:2:exec' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()
  // Its subtasks line and open subtask move with it.
  expect(await ui.find({ type: 'Text', text: ' No tool calls yet.' })).toBeDefined()
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

  const ui = await mountAll($)
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
  const ui = await mountAll($)
  await clock.advance(60 * 60_000)
  expect(await shown(ui, 1)).toBe(true)
  await ui.unmount()
})

test('the doneTtlMinutes option sets the time in the tree', { options: { doneTtlMinutes: 1 } }, async ($, on) => {
  engine(on, [], undefined, false, { db: seeded([aTodo(1, 'Old', { status: 'done', hasRun: true, doneAt: 1000 })]) })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await mountAll($)
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

// ---------- the drill-down ----------

// A Text's own string children, and its props, for each Text under `node`.
function textParts(node: { children?: unknown[] } | undefined) {
  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const out: { text: string; props: Record<string, unknown> }[] = []
  const walk = (x: unknown) => {
    if (typeof x !== 'object' || x === null) return
    const el = x as Node
    if (el.type === 'Text') out.push({ text: (el.children ?? []).filter(c => typeof c === 'string').join(''), props: el.props ?? {} })
    for (const c of el.children ?? []) walk(c)
  }
  for (const c of node?.children ?? []) walk(c)
  return out
}
const turnRow = (id: string, agentId: string, text: string, startedAt: number) => ({
  dir: '/proj', agentId, session: 's1', seq: 1000 + startedAt, body: { kind: 'turn', id, agentId, text, startedAt },
})

test('each todo is one line, its own splitter: toggle, #N and title in the status color, a dim rule, the status mark at the right', async ($, on) => {
  const db = seeded([aTodo(1, 'Fix kitty tab titles'), running(2, 'Ship it')], [agentNode('ag1', 2, { status: 'done' }), agentNode('ag2', 2, { startedAt: 2 })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const head = await ui.find({ type: 'Button', key: 'todo:1' })
  // 70 columns less the pane's paddingX and the ring's cell on each side.
  expect(head?.text).toMatch(/^▸ #1 Fix kitty tab titles ─+ ●$/)
  expect(head?.text.length).toBe(66)
  // The word the mark stands for stays the line's label.
  expect((head as { props?: { label?: string } } | undefined)?.props?.label).toBe('#1 Fix kitty tab titles: pending')
  const parts = textParts(head)
  expect(parts.find(p => p.text === '#1')?.props).toMatchObject({ weight: 'semibold' })
  expect(parts.find(p => p.text.includes('Fix kitty tab titles'))?.props).toMatchObject({ color: MARK.pending.color })
  expect(parts.find(p => p.text.startsWith(' ──'))?.props).toMatchObject({ dimColor: true })
  expect(parts.find(p => p.text === MARK.pending.symbol)?.props).toMatchObject({ color: MARK.pending.color })
  // A run with subtasks spins and shows its progress in its status color.
  const run = await ui.find({ type: 'Button', key: 'todo:2' })
  expect(run?.text).toMatch(/^▸ #2 Ship it ─+ [·✢✳✶✻✽] 1\/2$/)
  expect(textParts(run as never).find(p => p.text.endsWith(' 1/2'))?.props).toMatchObject({ color: MARK.running.color })
  expect((run as { props?: { label?: string } } | undefined)?.props?.label).toBe('#2 Ship it: running 1/2')
  // No row of its own: the header is the todo's only line until it opens; the
  // first todo shown sits under the header's double rule and draws none.
  expect(await ui.find({ type: 'Box', key: 'div2:head' })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'div2:1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()
  await ui.press({ key: 'todo:1' })
  expect((await ui.find({ type: 'Button', key: 'todo:1' }))?.text).toMatch(/^▾ #1 /)
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeDefined()
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Button', key: 'act:1:exec' })).toBeUndefined()
  await ui.unmount()
})

// The rules the tree drew, in order: `div2:head` the header's double ═ under
// the add element, `div:N` a single ─ above todo N (never the first shown),
// `div2:hidden` the double above the hidden footer.
const dividers = async (ui: { findAll: (q: { type: string }) => Promise<{ key?: unknown; props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Box' })).map(x => x.key ?? x.props['key']).filter((k): k is string => typeof k === 'string' && /^div2?:/.test(k))

test('the header ends in a double rule and every later todo has a single one: N todos shown draw N-1, counting only the view', async ($, on) => {
  const db = seeded([aTodo(1, 'One'), aTodo(2, 'Two'), running(3, 'Three'), aTodo(4, 'Four', { status: 'done', hasRun: true, doneAt: 1 })])
  engine(on, [], undefined, true, { db })
  await start($)
  // The default view hides done: three todos shown under the header's
  // double, two singles (none above the first), and one hidden, so a double
  // above the footer.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2', 'div:3', 'div2:hidden'])
  const rule = await ui.find({ type: 'Box', key: 'div:2' })
  // The tree's 70 columns less its paddingX: one line of ─ in the divider's color.
  expect(rule?.text).toBe('─'.repeat(68))
  expect(textParts(rule)).toEqual([{ text: '─'.repeat(68), props: expect.objectContaining({ color: DIVIDER, dimColor: true, wrap: 'truncate-end' }) }])
  // Every view lit: four shown, three singles, done last, and no footer.
  await ui.press({ key: 'view:all' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2', 'div:3', 'div:4'])
  // An open todo's levels draw none of their own.
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'todo:3' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2', 'div:3', 'div:4'])
  await ui.unmount()
})

test('a lone todo draws no divider under the header rule, and at a narrow width a divider is one row cut to the tree', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'Alone')]) })
  await start($)
  const one = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await dividers(one)).toEqual(['div2:head'])
  await one.unmount()
  await todo($, 'add Second')
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 13 } })
  expect(await dividers(narrow)).toEqual(['div2:head', 'div:2'])
  // 13 columns less the paddingX: 11 cells, never more, and truncated, never wrapped.
  const rule = await narrow.find({ type: 'Box', key: 'div:2' })
  expect(rule?.text).toBe('─'.repeat(11))
  expect(textParts(rule as never).map(t => t.props['wrap'])).toEqual(['truncate-end'])
  await narrow.unmount()
})

test('the dividers never join the focus order: the ring walks the todos as it would without them', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'One'), aTodo(2, 'Two'), aTodo(3, 'Three')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2', 'div:3'])
  // The arrow keys walk the order the drawing placed: from the add input
  // straight from header to header, and into an open todo's chips, never
  // stopping on a divider.
  const arrow = (by: 1 | -1) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: Math.max(0, by), by, bodyRows: 4, contentRows: 40, origin: { kind: 'person' } })
  await ui.press({ key: 'todo:2' })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'add', origin: { kind: 'person' } })
  const walk = ['todo:1', 'todo:2', 'act:2:exec', 'act:2:auto', 'act:2:rename', 'act:2:delete', 'act:2:details', 'todo:3']
  for (const key of walk) {
    await arrow(1)
    expect(`${key}: ${String(await isLit(ui, key))}`).toBe(`${key}: true`)
  }
  for (const key of [...walk].reverse().slice(1)) {
    await arrow(-1)
    expect(`${key}: ${String(await isLit(ui, key))}`).toBe(`${key}: true`)
  }
  await ui.unmount()
})

test('the first todo draws no rule, under the header double: N todos draw one double and N-1 singles', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([running(1, 'One'), aTodo(2, 'Two'), aTodo(3, 'Three'), aTodo(4, 'Four')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const keys = await dividers(ui)
  expect(keys).toEqual(['div2:head', 'div:2', 'div:3', 'div:4'])
  expect(keys.filter(k => k.startsWith('div2:')).length).toBe(1)
  expect(keys.filter(k => k.startsWith('div:')).length).toBe(3)
  // One line of ═ as wide as the tree less its paddingX, in the divider's
  // color, cut rather than wrapped; the later ones stay ─.
  const first = await ui.find({ type: 'Box', key: 'div2:head' })
  expect(first?.text).toBe('═'.repeat(68))
  expect(textParts(first)).toEqual([{ text: '═'.repeat(68), props: expect.objectContaining({ color: DIVIDER, dimColor: true, wrap: 'truncate-end' }) }])
  expect((await ui.find({ type: 'Box', key: 'div:2' }))?.text).toBe('─'.repeat(68))
  // The list opens on the first todo itself: no rule of its own above it.
  expect(keyOf((await listRows(ui))[0] ?? {})).toBe('ring:todo:1')
  // Hiding the first todo's view: the new first loses its single, and the
  // header's double stays put.
  await ui.press({ key: 'view:running' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:3', 'div:4', 'div2:hidden'])
  expect(keyOf((await listRows(ui))[0] ?? {})).toBe('ring:todo:2')
  await ui.unmount()
})

test('the double rule is above the hidden footer only while the view hides something', async ($, on) => {
  const db = seeded([aTodo(1, 'One'), aTodo(2, 'Done', { status: 'done', hasRun: true, doneAt: 1 })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Done hidden: the double is the line right above the footer.
  expect(await dividers(ui)).toEqual(['div2:head', 'div2:hidden'])
  const kids = await listRows(ui)
  const at = kids.findIndex(k => keyOf(k) === 'div2:hidden')
  expect(at).toBeGreaterThan(-1)
  expect(JSON.stringify(kids[at + 1])).toContain('hidden by the view')
  const rule = await ui.find({ type: 'Box', key: 'div2:hidden' })
  expect(rule?.text).toBe('═'.repeat(68))
  expect(textParts(rule)).toEqual([{ text: '═'.repeat(68), props: expect.objectContaining({ color: DIVIDER, dimColor: true, wrap: 'truncate-end' }) }])
  // Nothing hidden: no footer, and no double for it.
  await ui.press({ key: 'view:all' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2'])
  expect(await ui.find({ type: 'Text', text: /hidden by the view/ })).toBeUndefined()
  // Everything hidden (the none view): no todo rules, but the header and the
  // footer keep their doubles.
  await ui.press({ key: 'view:all' })
  expect(await dividers(ui)).toEqual(['div2:head', 'div2:hidden'])
  await ui.unmount()
})

test('each double rule is one line and never joins the focus order', async ($, on) => {
  const db = seeded([aTodo(1, 'One'), aTodo(2, 'Two'), aTodo(3, 'Done', { status: 'done', hasRun: true, doneAt: 1 })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 13 } })
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2', 'div2:hidden'])
  for (const key of ['div2:head', 'div2:hidden']) {
    const rule = await ui.find({ type: 'Box', key })
    // One Text of 11 ═ cells at 13 columns, truncated, never wrapped.
    expect(rule?.text).toBe('═'.repeat(11))
    expect(textParts(rule as never).map(t => t.props['wrap'])).toEqual(['truncate-end'])
    expect(blankRows(rule)).toEqual([])
  }
  // The arrows walk from the add input to #1's header and on to #2's, with
  // nothing focusable between: the doubles are skipped like the singles.
  const arrow = (by: 1 | -1) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: Math.max(0, by), by, bodyRows: 4, contentRows: 40, origin: { kind: 'person' } })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'add', origin: { kind: 'person' } })
  for (const key of ['todo:1', 'todo:2']) {
    await arrow(1)
    expect(`${key}: ${String(await isLit(ui, key))}`).toBe(`${key}: true`)
  }
  expect(await ui.find({ type: 'Box', key: 'ring:div2:head' })).toBeUndefined()
  expect(await ui.find({ type: 'Box', key: 'ring:div2:hidden' })).toBeUndefined()
  await ui.unmount()
})

test('at a narrow width the header cuts the title with … and keeps the rule and the status mark whole', async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(3, 'Fix kitty tab titles')]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  const head = await ui.find({ type: 'Button', key: 'todo:3' })
  expect(head?.text).toBe('▸ #3 Fix kitty tab t… ── ●')
  expect(head?.text.length).toBe(26)
  await ui.unmount()
  // Too narrow for any title: the number, a little rule and the mark.
  const tiny = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 13 } })
  expect((await tiny.find({ type: 'Button', key: 'todo:3' }))?.text).toBe('▸ #3 ── ●')
  await tiny.unmount()
})

test('the header sums in terminal cells, so a wide title or mark never pushes it past its width', () => {
  // 🔥 takes two cells: four of them and the … fit the room a 20-cell line leaves.
  const p = headParts(3, '🔥🔥🔥🔥🔥🔥', '✓', 20)
  expect(p.title).toBe(' 🔥🔥🔥🔥…')
  expect(`▸ #3${p.title}${p.rule}✓`).toBe('▸ #3 🔥🔥🔥🔥… ─── ✓')
  // A wide right end leaves the title one cell less than a narrow one.
  expect(headParts(3, 'abcdefghijkl', '🔥', 20).title.length).toBe(headParts(3, 'abcdefghijkl', '✓', 20).title.length - 1)
})

test('an old todoDividers setting, from /config or the environment, is ignored', { options: { todoDividers: 'none' } }, async ($, on) => {
  engine(on, [], undefined, true, { db: seeded([aTodo(1, 'Fix kitty tab titles')]), env: { CLAUDE_TODO_DIVIDERS: 'line' } })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'todo:1' }))?.text).toMatch(/^▸ #1 Fix kitty tab titles ─+ ●$/)
  // todoDividers 'none' would have dropped it: the rule is drawn regardless.
  expect(await ui.find({ type: 'Box', key: 'div2:head' })).toBeDefined()
  await ui.unmount()
})

test('level 1 shows the prompt in 2 lines, a done todo its summary, the actions, and the subtasks line', async ($, on) => {
  const long = 'Make both statuslines read colors from the theme lib via a new generator, keeping their output byte for byte identical to what they print today on every terminal we support.'
  const db = seeded(
    [
      aTodo(1, 'Fresh'),
      aTodo(2, 'Theme', { status: 'done', hasRun: true, mode: 'workflow', prompt: long, summary: '**Both** read the theme\nmore', doneAt: 1000 }),
    ],
    [agentNode('ag1', 2, { kind: 'workflow', wave: 1, status: 'done' }), agentNode('ag2', 2, { kind: 'workflow', wave: 2, status: 'done', startedAt: 2 })],
    [callRow('c1', 'ag1'), callRow('c2', 'ag2'), callRow('c3', 'ag2')],
  )
  engine(on, [], undefined, false, { db })
  mock.clock(on, { now: 1000 })
  await start($)
  const ui = await mountAll($, { bodyColumns: 50 })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Text', text: ' no prompt yet: ▶ Exec drafts one' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'subs:1' })).toBeUndefined()
  await ui.press({ key: 'todo:2' })
  // 50 columns less the padding, the indent and a cell, quoted, cut to 2 lines.
  const prompt = clampLines(`“${long}”`, 44)
  expect(prompt).toHaveLength(2)
  expect(prompt[0]).toBe('“Make both statuslines read colors from the')
  expect(prompt[1]?.endsWith('…')).toBe(true)
  expect(prompt[1]?.length).toBe(44)
  for (const l of prompt) expect(await ui.find({ type: 'Text', text: ` ${l}` })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: ' ✓ Both read the theme' })).toMatchObject({ props: { color: MARK.done.color } })
  expect(await ui.find({ type: 'Button', key: 'act:2:details' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'subs:2' }))?.text).toBe('▸ 2 subtasks · 2 done · 3 calls · workflow')
  await ui.unmount()
})

test("level 2 is one row per subtask, its ☰ Details on it, grouped under its wave; level 3 its last 6 turns and calls, one line each", async ($, on) => {
  const db = seeded(
    [running(1, 'Theme', { mode: 'workflow' })],
    [agentNode('ag1', 1, { name: 'explore', kind: 'workflow', wave: 1 }), agentNode('ag2', 1, { name: 'fix', kind: 'workflow', wave: 2, isWorktree: true, startedAt: 2 })],
    [
      ...Array.from({ length: 5 }, (_, i) => callRow(`c${i}`, 'ag1', { tool: 'Read', arg: `f${i}.ts`, ms: 1500, startedAt: 10 + i * 10 })),
      unanswered(callRow('c9', 'ag1', { tool: 'Bash', arg: 'npm test\nmore', state: 'run', startedAt: 100 })),
    ],
  )
  db.calls['turn:a'] = turnRow('turn:a', 'ag1', 'Looking first.', 5)
  db.calls['turn:b'] = turnRow('turn:b', 'ag1', '\n\n## Found **it**\nthe rest', 90)
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'subs:1' })
  const all = (await ui.findAll({})).filter(x => x.type === 'Text' || x.type === 'Button').map(x => x.text)
  expect(all.indexOf(' wave 1')).toBeLessThan(all.findIndex(x => x.includes('explore')))
  expect(all.indexOf(' wave 2')).toBeGreaterThan(all.findIndex(x => x.includes('explore')))
  expect((await ui.find({ type: 'Button', key: 'ag:ag2' }))?.text).toMatch(/^▸ . fix ⎇$/)
  expect(await ui.find({ type: 'Text', text: ' 6 calls' })).toBeDefined()
  // Each subtask's ☰ Details sits on its own row, after its splitter, closed
  // or open: a closed subtask takes one row, not two.
  const rows = async () => (await listRowsOf(ui)).filter(r => r.some(k => k.startsWith('ag:'))).map(r => r.join(' '))
  const rowAt = async (key: string) => (await listRowsOf(ui)).findIndex(r => r.includes(key))
  expect(await rows()).toEqual(['ag:ag1 full:ag1', 'ag:ag2 full:ag2'])
  // explore, then wave 2's line, then fix.
  expect(await rowAt('ag:ag2')).toBe((await rowAt('ag:ag1')) + 2)
  // A long title is cut with … to the room left of the chip, which keeps its
  // cells: the splitter's Box shrinks and clips, the chip's never shrinks.
  const win = (await ui.find({ type: 'Box', key: 'list' })) as Found | undefined
  const listLines = ((win?.children?.[0] as Found | undefined)?.children ?? []) as Found[]
  const line = listLines[await rowAt('ag:ag1')]
  const [title, details] = ((line?.children?.[0] as Found | undefined)?.children ?? []) as Found[]
  expect(title?.props).toMatchObject({ flexGrow: 1, flexShrink: 1, overflow: 'hidden' })
  expect(details?.props).toMatchObject({ flexShrink: 0 })
  expect(boxesIn(details).some(x => x.props?.['key'] === 'ring:full:ag1')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /explore/ }))?.props['wrap']).toBe('truncate-end')

  await ui.press({ key: 'ag:ag1' })
  expect((await ui.find({ type: 'Button', key: 'ag:ag1' }))?.text).toMatch(/^▾ /)
  // 8 entries, the newest 6 drawn, in time order, the cut said above them.
  expect(await ui.find({ type: 'Text', text: ' … 2 earlier' })).toBeDefined()
  const lines = (await ui.findAll({ type: 'Text', text: /^ ⏺ \S/ })).map(x => x.text)
  // A turn is its first line with text, its markdown marks dropped.
  expect(lines).toEqual([' ⏺ Read f1.ts', ' ⏺ Read f2.ts', ' ⏺ Read f3.ts', ' ⏺ Read f4.ts', ' ⏺ Found it', ' ⏺ Bash npm test'])
  // A call reads ⏺ Tool arg and its time, in its state's color; an open one says ….
  const read = await ui.find({ type: 'Text', text: ' ⏺ Read f4.ts' })
  expect(textParts({ children: [read] }).find(p => p.text.includes('⏺'))?.props).toMatchObject({ color: 'success' })
  expect((await ui.findAll({ type: 'Text', text: ' 1.5s' })).length).toBe(4)
  expect(await ui.find({ type: 'Text', text: ' …' })).toBeDefined()
  // Level 3 draws its 6 lines and the cut, and no Details row of its own.
  expect((await ui.find({ type: 'Button', key: 'full:ag1' }))?.props['label']).toBe('Details')
  expect(await rows()).toEqual(['ag:ag1 full:ag1', 'ag:ag2 full:ag2'])
  // The cut, the 6 lines, then wave 2's line: no Details row in between.
  expect(await rowAt('ag:ag2')).toBe((await rowAt('ag:ag1')) + 1 + 1 + TAIL + 1)
  await ui.unmount()
})

test('a prompt wraps by word to the width, kept to its lines with … on the last', () => {
  expect(clampLines('one two three', 20)).toEqual(['one two three'])
  expect(clampLines('aaaa bbbb cccc dddd', 9)).toEqual(['aaaa bbbb', 'cccc dddd'])
  expect(clampLines('aaaa bbbb cccc dddd eeee', 9)).toEqual(['aaaa bbbb', 'cccc ddd…'])
  // A word longer than a line breaks; emoji count as one each and never split.
  expect(clampLines('abcdefghijkl', 5)).toEqual(['abcde', 'fghi…'])
  expect(clampLines('😀😀😀😀😀😀', 4, 1)).toEqual(['😀😀😀…'])
  expect(clampLines('', 10)).toEqual([])
})

test('the arrow keys walk the drill-down in the order it draws, header by header and level by level', async ($, on) => {
  const db = seeded([running(1, 'Runs'), aTodo(2, 'Next')], [agentNode('ag1', 1)], [callRow('c1', 'ag1')])
  engine(on, [], undefined, true, { db })
  await start($)
  const arrow = (by: 1 | -1) =>
    $.ui.scroll({ component: 'Pane', requestId: 'todo', offset: Math.max(0, by), by, bodyRows: 4, contentRows: 40, origin: { kind: 'person' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'subs:1' })
  await ui.press({ key: 'ag:ag1' })
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'fire', origin: { kind: 'person' } })
  // The subtask's ☰ Details is on its row, so it comes straight after it, before level 3.
  for (const key of ['add', 'todo:1', 'act:1:pause', 'act:1:stop', 'act:1:details', 'subs:1', 'ag:ag1', 'full:ag1', 'todo:2']) {
    await arrow(1)
    expect(`${key}: ${String(await isLit(ui, key))}`).toBe(`${key}: true`)
  }
  await arrow(-1)
  expect(await isLit(ui, 'full:ag1')).toBe(true)
  await ui.unmount()
})

test('closing a level closes everything under it, and what is open outlasts a redraw and a reload', async ($, on) => {
  const db = seeded([running(1, 'Runs')], [agentNode('ag1', 1)], [callRow('c1', 'ag1')])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Level 3's one call line, which only an open subtask draws.
  const level3 = (x: typeof ui) => x.find({ type: 'Text', text: /^ ⏺ Bash ls/ })
  const open = async () => {
    await ui.press({ key: 'todo:1' })
    await ui.press({ key: 'subs:1' })
    await ui.press({ key: 'ag:ag1' })
    expect(await level3(ui)).toBeDefined()
  }
  await open()
  // Closing the subtasks line folds the subtask too: reopened, it starts closed.
  await ui.press({ key: 'subs:1' })
  expect(await ui.find({ type: 'Button', key: 'ag:ag1' })).toBeUndefined()
  await ui.press({ key: 'subs:1' })
  expect((await ui.find({ type: 'Button', key: 'ag:ag1' }))?.text).toMatch(/^▸ /)
  expect(await level3(ui)).toBeUndefined()
  // Closing the todo folds both levels under it.
  await ui.press({ key: 'ag:ag1' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'todo:1' })
  expect((await ui.find({ type: 'Button', key: 'subs:1' }))?.text).toMatch(/^▸ /)
  expect(await ui.find({ type: 'Button', key: 'ag:ag1' })).toBeUndefined()
  await ui.press({ key: 'todo:1' })
  await open()
  await ui.unmount()
  // Drawn again, and after a reload, every level is as it was left.
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await level3(again)).toBeDefined()
  await again.unmount()
  await start($)
  const reloaded = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await level3(reloaded)).toBeDefined()
  await reloaded.unmount()
})

test('every action chip is one word under 10 letters, drawn as its symbol only, filled with the color of the status it moves the todo into', async ($, on) => {
  const db = seeded([
    aTodo(1, 'Waiting'),
    running(2, 'Runs'),
    running(3, 'Waits', { status: 'paused' }),
    aTodo(4, 'Stopped one', { status: 'stopped', hasRun: true, mode: 'agent', prompt: 'p', taskId: 'ag4' }),
    aTodo(5, 'Drafting', { status: 'drafting', owner: 's1' }),
    running(6, 'Elsewhere', { owner: 'other' }),
    aTodo(7, 'Finished', { status: 'done', hasRun: true, doneAt: Date.now() }),
  ])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await mountAll($)
  const fill = async (key: string) => {
    const chip = await ui.find({ type: 'Button', key })
    const text = (chip?.children ?? []).find((c): c is { props: Record<string, unknown> } => typeof c === 'object' && c !== null && 'props' in c)
    const label = chip?.props['label']
    const drawn = (text as { children?: unknown[] } | undefined)?.children?.join('')
    // The chip under the ring is drawn inverted in its tone's focused twin.
    const isLit = text?.props['inverse'] === true
    return { label: typeof label === 'string' ? label : '', drawn, isLit, color: isLit ? text.props['color'] : text?.props['backgroundColor'] }
  }
  const check = async (n: number, expected: Record<string, Tone>) => {
    for (const [k, tone] of Object.entries(expected)) {
      const { label, drawn, isLit, color } = await fill(`act:${n}:${k}`)
      expect(`${k}: ${String(color)}`).toBe(`${k}: ${isLit ? toneFocus(tone) : toneColor(tone)}`)
      // The label names it in a word; the chip draws only its symbol, a cell
      // of fill either side.
      expect(label).toMatch(/^\p{L}{1,9}$/u)
      expect(`${k}: ${String(drawn)}`).toBe(`${k}: ${CHIP_SYMBOL[label] ? ` ${CHIP_SYMBOL[label]} ` : '(no symbol)'}`)
    }
  }
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await ui.press({ key: `todo:${n}` })
  // Exec and Resume start a run; Pause, Stop and Takeover halt it; Refine and
  // Restart draft it again; Delete destroys it; the rest change no status.
  await check(1, { exec: 'running', rename: 'edit', delete: 'danger', details: 'details' })
  await check(2, { pause: 'paused', stop: 'stopped', details: 'details' })
  await check(3, { resume: 'running', stop: 'stopped', details: 'details' })
  await check(4, { refine: 'drafting', restart: 'drafting', resume: 'running', details: 'details' })
  await check(5, { reset: 'stay' })
  await check(6, { takeover: 'stopped', details: 'details' })
  await check(7, { details: 'details' })
  // Details, Rename and the rest that move no status each wear a color of
  // their own: no status's color, and not each other's.
  expect(toneColor('details')).toBe('#55f1f1')
  expect(toneColor('edit')).toBe('#a3f155')
  expect(toneColor('stay')).toBe('#f155f1')
  const own = (['details', 'edit', 'stay', 'danger'] as const).map(toneColor)
  expect(new Set(own).size).toBe(own.length)
  for (const m of Object.values(MARK)) for (const c of [toneColor('details'), toneColor('edit'), toneColor('stay')]) expect(m.color).not.toBe(c)
  for (const m of Object.values(MARK)) expect(m.color).not.toBe(toneColor('details'))
  // The chips share the rows' palette: Resume and a running row are one color.
  expect(toneColor('running')).toBe(MARK.running.color)
  expect(MARK.running.color).toBe('#55f155')
  // ■ Stop fills in stopped's own true red, which failed and Delete don't share.
  expect((await fill('act:2:stop')).color).toBe(MARK.stopped.color)
  expect(MARK.stopped.color).toBe(STOP_RED)
  expect(MARK.stopped.color).not.toBe(MARK.failed.color)
  expect(MARK.stopped.color).not.toBe(toneColor('danger'))
  // A confirmation's go-ahead is the status it leads to; its way out stays.
  await ui.press({ key: 'act:2:stop' })
  await check(2, { stopyes: 'stopped', keep: 'stay' })
  expect((await fill('act:2:stopyes')).color).toBe(MARK.stopped.color)
  await ui.press({ key: 'act:6:takeover' })
  await check(6, { takeyes: 'stopped', cancel: 'stay' })
  await ui.press({ key: 'act:1:delete' })
  await check(1, { deleteyes: 'danger', cancel: 'stay' })
  await ui.unmount()
})

test("a subtask's Details chip is the todo's ☰ Details: the same symbol, word and cyan details tone, brighter under the ring", async ($, on) => {
  const db = seeded([running(1, 'Runs')], [agentNode('ag1', 1)], [callRow('c1', 'ag1')])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  // Drawn on the subtask's row, so it shows with level 3 still closed.
  await ui.press({ key: 'subs:1' })
  const look = async (key: string) => {
    const chip = await ui.find({ type: 'Button', key })
    const text = (chip?.children ?? []).find((c): c is { props: Record<string, unknown>; children?: unknown[] } => typeof c === 'object' && c !== null && 'props' in c)
    const isLit = text?.props['inverse'] === true
    return { label: chip?.props['label'], drawn: text?.children?.join(''), color: isLit ? text.props['color'] : text?.props['backgroundColor'], isLit, dim: text?.props['dimColor'] }
  }
  const todo = await look('act:1:details')
  const sub = await look('full:ag1')
  expect(sub).toEqual({ label: 'Details', drawn: ` ${CHIP['Details']?.symbol ?? ''} `, color: toneColor('details'), isLit: false, dim: todo.dim })
  expect(CHIP['Details']?.symbol).toBe('☰')
  expect({ ...sub, color: todo.color }).toEqual(todo)
  expect(GREYS).not.toContain(sub.color)
  expect(sub.dim).not.toBe(true)
  // Under the ring it brightens to the details tone's focus twin, and keeps its size.
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'full:ag1', origin: { kind: 'person' } })
  expect(await look('full:ag1')).toMatchObject({ drawn: ' ☰ ', color: toneFocus('details'), isLit: true })
  expect(await isLit(ui, 'full:ag1')).toBe(true)
  // The old ↗ symbol is gone: Details is the one word for a subtask's browser.
  expect(CHIP['Full transcript']).toBeUndefined()
  await ui.unmount()
})

// Every chip drawn: its label, whether it is dimmed (disabled), and its fill.
const chipsDrawn = async (ui: { findAll: (q: { type: string }) => Promise<Found[]> }) =>
  (await ui.findAll({ type: 'Button' })).flatMap(b => {
    const text = (b.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null && 'props' in c)
    const label = b.props?.['label']
    if (b.props?.['plain'] !== true || text?.props?.['weight'] !== 'semibold' || typeof label !== 'string') return []
    const isDimmed = b.props['dimColor'] === true
    const fill = text.props['inverse'] === true ? text.props['color'] : text.props['backgroundColor']
    return [{ label, isDimmed, fill, isDimText: text.props['dimColor'] === true }]
  })

test('an enabled chip is never grey or dim, in any state: only a disabled one is', async ($, on) => {
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  const db = seeded(
    [
      aTodo(1, 'Waiting'),
      running(2, 'Runs'),
      running(3, 'Waits', { status: 'paused' }),
      aTodo(4, 'Stopped one', { status: 'stopped', hasRun: true, mode: 'agent', prompt: 'p', taskId: 'ag4' }),
      aTodo(5, 'Drafting', { status: 'drafting', owner: 's1' }),
      running(6, 'Elsewhere', { owner: 'other' }),
      aTodo(7, 'Finished', { status: 'done', hasRun: true, doneAt: Date.now() }),
      aTodo(8, 'Broke', { status: 'failed', hasRun: true, prompt: 'p' }),
      running(9, 'Runs too'),
    ],
    [agentNode('ag2', 2)],
  )
  engine(on, [], undefined, true, { db })
  await start($)
  const seen = new Set<string>()
  const sweep = async (ui: { findAll: (q: { type: string }) => Promise<Found[]> }) => {
    for (const c of await chipsDrawn(ui)) {
      seen.add(c.label)
      if (c.isDimmed) continue
      // Enabled: a fill in a tone's color, never a grey and never dim text.
      expect(`${c.label}: ${String(c.fill)}`).not.toMatch(/: undefined$/)
      expect(`${c.label}: ${String(c.fill)}`).not.toMatch(new RegExp(`: (${GREYS.join('|')})$`))
      expect(`${c.label}: dim ${String(c.isDimText)}`).toBe(`${c.label}: dim false`)
    }
  }
  const ui = await mountAll($)
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await ui.press({ key: `todo:${n}` })
  await ui.press({ key: 'subs:2' })
  await ui.press({ key: 'ag:ag2' })
  await sweep(ui)
  // Each confirmation, then a stop's what-next row with ✓ Leave.
  await ui.press({ key: 'act:1:delete' })
  await sweep(ui)
  await ui.press({ key: 'act:1:cancel' })
  await ui.press({ key: 'act:6:takeover' })
  await sweep(ui)
  await ui.press({ key: 'act:6:cancel' })
  await ui.press({ key: 'act:9:stop' })
  await sweep(ui)
  await ui.press({ key: 'act:9:stopyes' })
  await sweep(ui)
  expect(await ui.find({ type: 'Button', key: 'act:9:leave' })).toBeDefined()
  await ui.unmount()
  // The way back from a transcript.
  const back = await $.ui.mount({ ...PANE, props: { ...PANE.props, view: { agentId: 'ag2' } }, surface: 'terminal' })
  await sweep(back)
  await back.unmount()
  // Every chip was reached, so none escaped the sweep.
  expect([...seen].sort()).toEqual(Object.keys(CHIP_SYMBOL).sort())
  // And no tone a chip can wear while enabled is a grey: only pending's mark,
  // which no chip leads to, is.
  for (const t of ['danger', 'details', 'edit', 'stay', 'running', 'paused', 'stopped', 'drafting'] as const) expect(GREYS).not.toContain(toneColor(t))
})

test('a disabled chip keeps its own muted look: dimmed, a grey fill, dim text', async ($, on) => {
  const db = seeded([aTodo(1, 'Stopped one', { status: 'stopped', hasRun: true, prompt: 'p' })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await mountAll($)
  const [fire] = (await chipsDrawn(ui)).filter(c => c.label === 'Fire')
  expect(fire).toEqual({ label: 'Fire', isDimmed: true, fill: DISABLED_FILL, isDimText: true })
  // A grey, so it reads as disabled, and one no enabled chip's tone wears.
  expect(GREYS).toContain(DISABLED_FILL)
  await ui.unmount()
})

// A chip's hover label: the absolute Box beside it in its keyed `tip:` Box.
type Tip = { left?: unknown; right?: unknown; top?: unknown; display?: unknown; hover?: unknown; word: string }
const labelOf = (box: Found | undefined): Tip | undefined => {
  if (box === undefined) return undefined
  const p = box.props ?? {}
  return { left: p['left'], right: p['right'], top: p['top'], display: p['display'], hover: (box as { hover?: unknown }).hover, word: textsIn(box).join('').trim() }
}
const tipOf = async (ui: { find: (q: { type: string; key: string }) => Promise<unknown> }, key: string) =>
  labelOf(((await ui.find({ type: 'Box', key: `tip:${key}` })) as Found | undefined)?.children?.find(isTip) as Found | undefined)

test('every chip has a hidden hover label with its word, absolute so it takes no room, kept inside the pane', async ($, on) => {
  const db = seeded(
    [
      aTodo(1, 'Waiting'),
      running(2, 'Runs'),
      aTodo(4, 'Stopped one', { status: 'stopped', hasRun: true, mode: 'agent', prompt: 'p', taskId: 'ag4' }),
      aTodo(5, 'Drafting', { status: 'drafting', owner: 's1' }),
      running(6, 'Elsewhere', { owner: 'other' }),
    ],
    [agentNode('ag2', 2)],
    [callRow('c1', 'ag2', { ms: 12 })],
  )
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await mountAll($)
  for (const n of [1, 2, 4, 5, 6]) await ui.press({ key: `todo:${n}` })
  await ui.press({ key: 'subs:2' })
  await ui.press({ key: 'ag:ag2' })
  await ui.press({ key: 'act:6:takeover' })
  const chips = (await ui.findAll({ type: 'Button' })).filter(b => /^(act:|fire$|full:)/.test(String(b.key)))
  expect(chips.length).toBeGreaterThan(15)
  for (const b of chips) {
    const word = String(b.props['label'])
    const tip = await tipOf(ui, String(b.key))
    // Hidden until the pointer is on the chip, then its word.
    expect(`${String(b.key)}: ${JSON.stringify(tip && { word: tip.word, display: tip.display, hover: tip.hover })}`).toBe(
      `${String(b.key)}: ${JSON.stringify({ word, display: 'none', hover: { display: 'flex' } })}`,
    )
    // A row away from the chip, above, but for the header's, below.
    expect(tip?.top).toBe(b.key === 'fire' ? 1 : -1)
  }
  // Fire is flush at the right edge, so its label is anchored there.
  expect(await tipOf(ui, 'fire')).toMatchObject({ right: 0 })
  // So is a subtask's ☰ Details, flush right on its row.
  expect(await tipOf(ui, 'full:ag2')).toMatchObject({ right: 0 })
  // Each header toggle draws only its mark: its status's word joins its hover group.
  const header = await headerOf(ui)
  const drawnBoxes = boxesIn(header) as (Found & { hover?: unknown })[]
  for (const v of SUMMARY) {
    expect(drawnBoxes.find(x => x.props?.['key'] === `tip:view:${v}`)?.hover).toEqual({ scope: `tip:view:${v}` })
    const label = drawnBoxes.find(x => isTip(x) && JSON.stringify(x.hover) === JSON.stringify({ display: 'flex', scope: `tip:view:${v}` }))
    expect(`${v}: ${String(labelOf(label)?.word)} ${String(labelOf(label)?.display)} ${String(labelOf(label)?.top)}`).toBe(`${v}: ${v} none 1`)
  }
  // The hover labels add no line and no blank one.
  expect(blankRows(await ui.findAll({ type: 'Box' }))).toEqual([])
  await ui.unmount()

  // Near the right edge a label shifts left, so the pane doesn't clip it.
  const narrow = await mountAll($, { bodyColumns: 24 })
  expect(await tipOf(narrow, 'act:1:exec')).toMatchObject({ left: 0 })
  const details = await tipOf(narrow, 'act:1:details')
  expect(typeof details?.left === 'number' && details.left < 0).toBe(true)
  await narrow.unmount()
})

// Every hover label the pane draws: the absolute Boxes, chips' and toggles' alike.
const tipsDrawn = async (ui: { drawn: () => Promise<unknown> }) => boxesIn(await ui.drawn()).filter(isTip).length

test('/todo tooltips off drops every hover label, on brings them back, and the bare form flips them', async ($, on) => {
  const db = seeded([aTodo(1, 'Waiting'), running(2, 'Runs')], [agentNode('ag2', 2)], [callRow('c1', 'ag2', { ms: 12 })])
  const { store } = engine(on, [], undefined, true, { db })
  await start($)
  // Off by nobody's choice: on, and nothing written to the store.
  expect(store).not.toHaveProperty('tooltips')
  const ui = await mountAll($)
  for (const n of [1, 2]) await ui.press({ key: `todo:${n}` })
  await ui.press({ key: 'subs:2' })
  await ui.press({ key: 'ag:ag2' })
  const all = await tipsDrawn(ui)
  expect(all).toBeGreaterThan(SUMMARY.length)
  const rows = (await ui.findAll({ type: 'Box' })).length

  expect((await todo($, 'tooltips off')).text).toBe('Pane hover labels off; /todo tooltips on brings them back.')
  expect(store['tooltips']).toBe(false)
  expect(await tipsDrawn(ui)).toBe(0)
  expect(await tipOf(ui, 'act:1:exec')).toBeUndefined()
  // A subtask's ☰ Details, on its title row, loses its label too.
  expect(await ui.find({ type: 'Button', key: 'full:ag2' })).toBeDefined()
  expect(await tipOf(ui, 'full:ag2')).toBeUndefined()
  // The chips stay, each in its keyed Box with its own hover fill, and the ring's hint line still says what one does.
  const exec = (await ui.find({ type: 'Box', key: 'tip:act:1:exec' })) as Found | undefined
  expect(exec).toBeDefined()
  expect(JSON.stringify(exec)).toContain('"inverse":true')
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'act:1:rename', origin: { kind: 'person' } })
  const first = (await levelRows(ui, 1, 2))[0]
  expect(first === undefined ? '' : textsIn({ children: [first] }).join('')).toBe(' ✎ Rename: give the todo a new title')
  expect(blankRows(await ui.findAll({ type: 'Box' }))).toEqual([])
  // Only the labels went: every other Box is still drawn.
  expect((await ui.findAll({ type: 'Box' })).length).toBe(rows - all)

  expect((await todo($, 'tooltips on')).text).toBe('Pane hover labels on.')
  expect(store['tooltips']).toBe(true)
  expect(await tipsDrawn(ui)).toBe(all)

  // Bare, it flips whatever it is, both ways, and keeps each choice.
  expect((await todo($, 'tooltips')).text).toContain('off')
  expect(store['tooltips']).toBe(false)
  expect(await tipsDrawn(ui)).toBe(0)
  expect((await todo($, 'tooltips')).text).toBe('Pane hover labels on.')
  expect(store['tooltips']).toBe(true)
  expect(await tipsDrawn(ui)).toBe(all)

  // Any other word is a usage note that changes nothing, and never a todo.
  expect((await todo($, 'tooltips maybe')).text).toBe('Usage: /todo tooltips [on|off]')
  expect(store['tooltips']).toBe(true)
  expect(titles(db, '/proj')).toEqual(['1 Waiting', '2 Runs'])
  await ui.unmount()
})

test('/todo tooltips off outlives the session: a later one starts with the hover labels off', async ($, on) => {
  const db = seeded([aTodo(1, 'Waiting')])
  const { store } = engine(on, [], undefined, true, { db, store: { tooltips: false } })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  expect(await tipsDrawn(ui)).toBe(0)
  // A reload boots again from the store, so it stays off.
  await start($)
  expect(await tipsDrawn(ui)).toBe(0)
  // Turned on there, it is kept on for the next session.
  await todo($, 'tooltips on')
  expect(store['tooltips']).toBe(true)
  expect(await tipsDrawn(ui)).toBeGreaterThan(0)
  await start($)
  expect(await tipsDrawn(ui)).toBeGreaterThan(0)
  await ui.unmount()
})

test('focusing a chip puts its word and what it does in the hint line, at the same line count; unfocusing restores the hint', async ($, on) => {
  const long = 'Make both statuslines read colors from the theme lib via a new generator, keeping their output byte for byte identical.'
  const db = seeded([aTodo(1, 'Fresh'), aTodo(2, 'Long', { prompt: long })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await mountAll($, { bodyColumns: 50 })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'todo:2' })
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element, origin: { kind: 'person' } })
  // Level 1's lines: the rows indented 2 under todo #n's header.
  const level1 = async (n: number) => (await levelRows(ui, n, 2)).length
  const before = [await level1(1), await level1(2)]
  // The hint line: level 1's first Text that names a chip, `✎ Rename: …`.
  const hint = async (n: number) => {
    const first = (await levelRows(ui, n, 2))[0]
    const text = first === undefined ? '' : textsIn({ children: [first] }).join('')
    return Object.entries(CHIP).some(([w, c]) => text.startsWith(` ${c.symbol} ${w}: `)) ? text : undefined
  }

  await focus('act:1:rename')
  expect(await hint(1)).toBe(' ✎ Rename: give the todo a new title')
  expect(await ui.find({ type: 'Text', text: ' no prompt yet: ▶ Exec drafts one' })).toBeUndefined()
  expect(await level1(1)).toBe(before[0])
  // Another todo's level 1 is left as it was.
  expect(await hint(2)).toBeUndefined()

  // A two-line prompt gives up its first line, and keeps the rest cut with …
  await focus('act:2:details')
  expect(await hint(2)).toBe(' ☰ Details: browse its prompt, subtasks and calls')
  expect(await hint(1)).toBeUndefined()
  expect(await level1(2)).toBe(before[1])
  const [first] = clampLines(`“${long}”`, 44, 1)
  expect(await ui.find({ type: 'Text', text: ` ${first}` })).toBeDefined()

  // A confirmation's chips are described in its own words.
  await ui.press({ key: 'act:1:delete' })
  await focus('act:1:deleteyes')
  expect(await hint(1)).toBe(' ✕ Delete: remove the todo for good')

  // Off the chips, the usual hint is back.
  await ui.press({ key: 'act:1:cancel' })
  await focus('todo:1')
  expect(await hint(1)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' no prompt yet: ▶ Exec drafts one' })).toBeDefined()
  expect([await level1(1), await level1(2)]).toEqual(before)
  await ui.unmount()
})

test('no two actions share a chip symbol, apart from the safe way back out of a choice', () => {
  const back = new Set(['Keep', 'Cancel', 'Back'])
  const owners = new Map<string, string>()
  for (const [word, sym] of Object.entries(CHIP_SYMBOL)) {
    // One grapheme, so a chip is one symbol however many cells it takes.
    expect([...new Intl.Segmenter().segment(sym)].length).toBe(1)
    const key = back.has(word) ? 'back' : word
    expect(`${sym}: ${owners.get(sym) ?? key}`).toBe(`${sym}: ${key}`)
    owners.set(sym, key)
  }
  expect(CHIP_SYMBOL['Exec']).not.toBe(CHIP_SYMBOL['Resume'])
})

// A chip's Text as drawn, and as it draws under the pointer.
const chipText = async (ui: { find: (q: { type: string; key: string }) => Promise<Found | undefined> }, key: string) => {
  const chip = await ui.find({ type: 'Button', key })
  const text = (chip?.children ?? []).find((c): c is Found => typeof c === 'object' && c !== null && 'props' in c)
  return { props: text?.props ?? {}, hover: ((text as { hover?: Record<string, unknown> } | undefined)?.hover ?? text?.props?.['hover']) as Record<string, unknown> | undefined }
}
// The fill a style shows: an inverted run shows its color as the fill.
const fillOf = (st: Record<string, unknown> | undefined) => (st?.['inverse'] === true ? st['color'] : st?.['backgroundColor'])

test('a focused or hovered chip brightens to its own tone\'s lighter twin, never black', async ($, on) => {
  const db = seeded([aTodo(1, 'Waiting'), running(2, 'Runs')])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'todo:2' })
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element, origin: { kind: 'person' } })
  const chips: [string, Tone][] = [
    ['act:1:exec', 'running'],
    ['act:1:rename', 'edit'],
    ['act:1:delete', 'danger'],
    ['act:1:details', 'details'],
    ['act:2:pause', 'paused'],
    ['act:2:stop', 'stopped'],
  ]
  for (const [key, tone] of chips) {
    // At rest: its tone's fill, and under the pointer, already inverted in the
    // tone's focused color, so the engine's own inversion keeps it bright.
    const rest = await chipText(ui, key)
    expect(`${key}: ${String(fillOf(rest.props))}`).toBe(`${key}: ${toneColor(tone)}`)
    expect(rest.hover).toEqual({ inverse: true, color: toneFocus(tone), backgroundColor: 'inverseText' })
    // Under the ring: drawn the same way, inverted in the focused color.
    await focus(key)
    const lit = await chipText(ui, key)
    expect(lit.props['inverse']).toBe(true)
    expect(`${key}: ${String(fillOf(lit.props))}`).toBe(`${key}: ${toneFocus(tone)}`)
    expect(lit.props['backgroundColor']).toBe('inverseText')
    // Neither is ever a dark fill, and the others stay at rest.
    for (const st of [lit.props, rest.hover]) expect(String(fillOf(st))).not.toMatch(/^(inverseText|#000000|black)$/)
    for (const [other, t] of chips) if (other !== key) expect(fillOf((await chipText(ui, other)).props)).toBe(toneColor(t))
  }
  // The hover sits on the chip's own Text, inside its keyed tip: Box, so it
  // lights that chip alone; the tip label beside it stays unfilled.
  const tip = (await ui.find({ type: 'Box', key: 'tip:act:1:exec' })) as Found | undefined
  expect(JSON.stringify(tip?.children)).toContain('"inverse":true')
  expect((await tipOf(ui, 'act:1:exec'))?.hover).toEqual({ display: 'flex' })
  await ui.unmount()
})

// A hex color's hue in degrees, and its HSL lightness.
const hsl = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const h = d === 0 ? NaN : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { hue: Math.round(h * 60) % 360, light: (max + min) / 2, sat: d }
}

test('every status and tone has its own color and focused twin, spread evenly round the wheel', () => {
  const tones: Tone[] = [...(Object.keys(MARK) as Tone[]), 'danger', 'details', 'edit', 'stay']
  const all = tones.flatMap(t => [toneColor(t), toneFocus(t)]).map(String)
  for (const c of all) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  expect(new Set(all).size).toBe(all.length)
  // Pending is the one grey; every other entry sits on its own hue, 30° apart
  // from 0° to 300°, but Delete's red, which sits at 350°: red, not rose, and
  // 10° off stopped's pure red.
  const hued = tones.filter(t => t !== 'pending')
  const hues = hued.filter(t => t !== 'danger').map(t => hsl(String(toneColor(t))).hue).sort((a, b) => a - b)
  expect(hues).toEqual(Array.from({ length: 11 }, (_, i) => i * 30))
  const danger = hsl(String(toneColor('danger')))
  expect(danger.hue).toBe(350)
  expect(Math.round(danger.light * 100)).toBe(64)
  expect(toneColor('danger')).not.toBe(STOP_RED)
  expect(GREYS).toContain(MARK.pending.color)
  expect(hsl(String(MARK.pending.color)).sat).toBeLessThan(0.1)
  // Each focused twin is its own hue, lighter.
  for (const t of hued) {
    const [base, lit] = [hsl(String(toneColor(t))), hsl(String(toneFocus(t)))]
    expect(`${t}: ${lit.hue}`).toBe(`${t}: ${base.hue}`)
    expect(lit.light).toBeGreaterThan(base.light + 0.1)
  }
  expect(hsl(String(toneFocus('pending'))).light).toBeGreaterThan(hsl(String(MARK.pending.color)).light + 0.1)
  // Stopped is pure red, and done sits well away from running's green.
  expect(MARK.stopped.color).toBe('#ff0000')
  const gap = Math.abs(hsl(String(MARK.done.color)).hue - hsl(String(MARK.running.color)).hue)
  expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(90)
})

test('the palette gives every status its own color, stopped and failed included, and the toasts name it by its mark', () => {
  const colors = Object.values(MARK).map(m => m.color)
  expect(new Set(colors).size).toBe(colors.length)
  expect(MARK.done.color).not.toBe(MARK.running.color)
  expect(statusToast(3, 'done')).toBe(`${MARK.done.symbol} #3 done`)
  expect(statusToast(4, 'failed')).toBe(`${MARK.failed.symbol} #4 failed`)
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
// A todo `launched` added is open already, as every added todo is; a seeded
// one is folded until pressed.
const browse = async ($: T$, surface: 'terminal' | 'desktop' = 'terminal', agentId = 'ag1', isAdded = false) => {
  const ui = await $.ui.mount({ ...PANE, surface })
  if (!isAdded) await ui.press({ key: 'todo:1' })
  await transcript(ui, 1, agentId)
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

  const ui = await browse($, 'terminal', 'ag1', true)
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
  const ui = await browse($, 'terminal', 'ag1', true)
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

  const ui = await browse($, 'terminal', 'ag1', true)
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

  const ui = await mountAll($)
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
  const ui = await mountAll($)
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
  const ui = await mountAll($)
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
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await transcript(ui, 1, 'ag1')
  const all = texts(await ui.findAll({ type: 'Code' })).concat(texts(await ui.findAll({ type: 'Markdown' })))
  expect(all.length).toBeGreaterThan(0)
  for (const t of all) expect(t).not.toMatch(/[^\P{C}\t\n]|[\p{Zl}\p{Zp}]/u)
  await ui.unmount()
})

test('Escape on the dialog closes it and puts the ring back on the subtask row it came from, keeping the keys in the pane', async ($, on) => {
  const openedWith: { id: string; focus?: boolean }[] = []
  const db = seeded([aTodo(1, 'Count', { status: 'done', hasRun: true, mode: 'agent', taskId: 'ag1' })], [agentNode('ag1', 1, { status: 'done' })])
  engine(on, [], undefined, false, { db, openedWith })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'subs:1' })
  await ui.press({ key: 'ag:ag1' })
  // The ring is on the subtask's ☰ Details when it's pressed; Escape puts it back on
  // the subtask's row, the line the browser came from.
  await $.ui.focus({ component: 'Pane', requestId: 'todo', plugin: 'todo', element: 'full:ag1', origin: { kind: 'person' } })
  await ui.press({ key: 'full:ag1' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
  // Escape takes the keys from the pane: it's drawn unfocused.
  const before = openedWith.length
  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  await clock.advance(1)
  await blurred.unmount()
  expect(openedWith.slice(before)).toEqual([{ id: 'todo', focus: true }])
  const back = await mountAll($)
  expect(await back.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect((await back.find({ type: 'Box', key: 'ring:ag:ag1' }))?.props['paddingX']).toBeUndefined()
  await back.unmount()
})

test('the dialog turns on closeOnEscape while it shows, and leaving it turns it off again', async ($, on) => {
  const openedWith: { id: string; focus?: boolean; closeOnEscape?: boolean }[] = []
  const db = seeded([aTodo(1, 'Count', { status: 'done', hasRun: true })])
  engine(on, [], undefined, false, { db, openedWith })
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:details' })
  // Escape then raises the person's ui.close, which closes the dialog and
  // keeps the pane, so it never reaches the prompt (and a running turn).
  expect(openedWith.at(-1)).toEqual({ id: 'todo', closeOnEscape: true })
  await ui.unmount()
  // The dialog closes: the pane takes the keys back without closeOnEscape,
  // so Escape on the tree is a plain hand-back again.
  const before = openedWith.length
  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  await clock.advance(1)
  await blurred.unmount()
  expect(openedWith.slice(before)).toEqual([{ id: 'todo', focus: true }])
})

test("a failure in one of the mod's own tools answers with what failed, not as a tool nobody answered", async ($, on) => {
  const db = seeded([aTodo(1, 'Count')])
  engine(on, [], undefined, true, { db })
  let isBroken = false
  on('state.get', (_, e, next) => {
    // A value the code can't index: reading the todo's key throws.
    if (isBroken && e.key === 'draftKeys') return { value: { value: null, version: 1 } }
    return next(e)
  })
  await start($)
  isBroken = true
  const r = await $.tool.call({ tool: 'mcp__todo__drafts', n: 1, key: '1.1', drafts: DRAFTS } as never)
  expect(r).toMatchObject({ isError: true })
  expect(String((r as { result?: unknown }).result)).toMatch(/mcp__todo__drafts failed \(throw\)/)
})

test('a dialog left open across a reload starts closed', async ($, on) => {
  const db = seeded([aTodo(1, 'Count', { status: 'done', hasRun: true })])
  engine(on, [], undefined, true, { db })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:details' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
  await start($)
  const again = await mountAll($)
  expect(await again.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await again.unmount()
})

// ---------- compact: one line per row, no blank lines ----------

// Every drawn row: a Box laid out as a row is one line; a column stacks its children.
// The one line allowed between items is a rule: a Box keyed div:N (above a
// later todo) or div2:head / div2:hidden (under the add element or above the
// hidden footer) holding one Text of ─ or ═ alone. A rule-only line anywhere else is a spacer by
// another name, so it's refused like a blank one.
const isRule = (el: { type?: unknown; children?: unknown[] }) =>
  el.type === 'Text' && Array.isArray(el.children) && el.children.length > 0 && el.children.every(c => typeof c === 'string' && /^(─+|═+)$/.test(c))
const keyOf = (el: { key?: unknown; props?: Record<string, unknown> }) => {
  const k = el.key ?? el.props?.['key']
  return typeof k === 'string' ? k : ''
}
function blankRows(node: unknown, out: string[] = [], inDivider = false): string[] {
  if (Array.isArray(node)) for (const n of node) blankRows(n, out, inDivider)
  else if (typeof node === 'object' && node !== null) {
    const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
    const p = el.props ?? {}
    for (const k of ['padding', 'paddingY', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'margin', 'marginY']) {
      if (typeof p[k] === 'number' && p[k] > 0) out.push(`${String(el.type)} ${k}=${String(p[k])}`)
    }
    const key = typeof p['key'] === 'string' ? p['key'] : ''
    if (el.type === 'Box' && p['borderStyle'] !== undefined && key.startsWith('ring:')) out.push(`ring border ${key}`)
    if (el.type === 'Text' && Array.isArray(el.children) && el.children.every(c => typeof c === 'string' && c.trim() === '')) out.push('blank Text')
    if (isRule(el) && !inDivider) out.push('stray rule')
    const isDivider = /^div2?:/.test(keyOf(el))
    if (isDivider) {
      const kids = (el.children ?? []).filter(c => typeof c === 'object' && c !== null) as { type?: unknown; children?: unknown[] }[]
      if (el.type !== 'Box' || kids.length !== 1 || kids.some(c => !isRule(c))) out.push(`divider ${keyOf(el)} is not one rule`)
    }
    blankRows(el.children, out, inDivider || isDivider)
  }
  return out
}

test('every state draws its actions on one row, and the pane has no blank lines', async ($, on) => {
  const db = seeded([
    aTodo(1, 'Pending'),
    aTodo(2, 'Running', { status: 'running', hasRun: true, mode: 'agent', taskId: 'a2', owner: 's1' }),
    aTodo(3, 'Paused', { status: 'paused', hasRun: true, mode: 'agent', taskId: 'a3', owner: 's1' }),
    aTodo(4, 'Stopped', { status: 'stopped', hasRun: true, mode: 'agent', taskId: 'a4' }),
    aTodo(5, 'Failed', { status: 'failed', hasRun: true, mode: 'agent', isAgentGone: true }),
  ])
  engine(on, [], undefined, true, { db })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Every state on show, not just the default view's.
  await ui.press({ key: 'view:all' })
  for (const n of [1, 2, 3, 4, 5]) await ui.press({ key: `todo:${n}` })
  // A stopped todo that was just stopped also offers Leave, on the same row.
  await ui.press({ key: 'act:2:stop' })
  await ui.press({ key: 'act:2:stopyes' })
  const tree = await ui.findAll({ type: 'Box' })
  // Each todo's chips share one parent: one row.
  for (const n of [1, 2, 3, 4, 5]) {
    const chips = await ui.findAll({ type: 'Button' })
    const mine = chips.filter(b => String(b.key).startsWith(`act:${n}:`))
    expect(mine.length).toBeGreaterThan(0)
    const rows = tree.filter(b => b.props['flexDirection'] !== 'column' && mine.every(m => JSON.stringify(b.children).includes(`"act:${n}:${String(m.key).split(':')[2] ?? ''}"`)))
    expect(rows.length).toBeGreaterThan(0)
  }
  expect(await ui.find({ type: 'Text', text: /What next/ })).toBeUndefined()
  expect(blankRows(tree)).toEqual([])
  // The rules, the one exception to one line per element: a double under the
  // add element, a single above each todo after the first, and nothing else
  // (nothing is hidden, so no footer and no double above it).
  expect(await dividers(ui)).toEqual(['div2:head', 'div:2', 'div:3', 'div:4', 'div:5'])
  await ui.unmount()
})

// ---------- a Stop holds plugin prompts until the person types ----------

test('an exec the host refuses after a Stop is held, and goes in after the person\'s next message', async ($, on) => {
  const submitted: string[] = []
  const toasts: string[] = []
  const db = seeded([aTodo(1, 'Count'), aTodo(2, 'Other')])
  const where: Parameters<typeof engine>[4] = { db, toasts, drop: 'the session was stopped and nobody has sent input since' }
  engine(on, submitted, undefined, false, where)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'exec 1')
  // /todo exec submits once the command has answered.
  await clock.advance(1)
  expect(submitted).toEqual([])
  expect(todoAt(db, 1).status).toBe('drafting')
  expect(toasts).toContain('#1 queued: it starts after your next message')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /queued: starts after your next message/ })).toBeDefined()
  await ui.unmount()

  // The person types: the Stop is lifted, and the held prompt goes in.
  delete where.drop
  await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' } } as never)
  await clock.advance(1)
  expect(submitted.filter(x => x.startsWith('[todo] Execute todo #1'))).toHaveLength(1)
  // Sent once: a later message sends nothing more.
  await $.prompt.submit({ text: 'and again', origin: { kind: 'composer' } } as never)
  await clock.advance(1)
  expect(submitted.filter(x => x.startsWith('[todo] Execute todo #1'))).toHaveLength(1)
})

test('Reset drops a held prompt, and a prompt from a plugin or a notification doesn\'t lift the hold', async ($, on) => {
  const submitted: string[] = []
  const db = seeded([aTodo(1, 'Count'), aTodo(2, 'Other')])
  const where: Parameters<typeof engine>[4] = { db, drop: 'the session was stopped and nobody has sent input since' }
  engine(on, submitted, undefined, false, where)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  await todo($, 'exec 1')
  await todo($, 'exec 2')
  await clock.advance(1)
  delete where.drop
  // Not the person: nothing is sent.
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  await clock.advance(1)
  expect(submitted.filter(x => x.startsWith('[todo]'))).toEqual([])
  // Reset #2: only #1 goes in.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:2:reset' })
  await ui.unmount()
  expect(todoAt(db, 2).status).toBe('pending')
  await $.prompt.submit({ text: 'go', origin: { kind: 'composer' } } as never)
  await clock.advance(1)
  expect(submitted.filter(x => x.startsWith('[todo]')).map(x => /#(\d+)/.exec(x)?.[1])).toEqual(['1'])
})

test('a held prompt the host refuses for another reason puts the todo back as it was before it was queued', async ($, on) => {
  const submitted: string[] = []
  const toasts: string[] = []
  const db = seeded([aTodo(1, 'Count', { status: 'stopped', hasRun: true, taskId: 'ag1', mode: 'agent', prompt: 'p' })])
  const where: Parameters<typeof engine>[4] = { db, toasts, drop: 'the session was stopped and nobody has sent input since' }
  engine(on, submitted, undefined, false, where)
  const clock = mock.clock(on, { now: 1000 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view:all' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:restart' })
  await ui.unmount()
  expect(todoAt(db, 1).status).toBe('drafting')
  where.drop = 'a hook refused it'
  await $.prompt.submit({ text: 'go', origin: { kind: 'composer' } } as never)
  await clock.advance(1)
  expect(todoAt(db, 1)).toMatchObject({ status: 'stopped', taskId: 'ag1' })
  expect(toasts).toContain("#1 didn't start: a hook refused it")
})

// ---------- a /todo verb for every chip ----------

// Every chip a todo's row can draw, each a /todo verb of the same name.
const CHIP_VERBS: Chip[] = ['exec', 'auto', 'rename', 'delete', 'reset', 'pause', 'stop', 'resume', 'refine', 'restart', 'leave', 'takeover', 'details']
// What the yes of a chip's confirmation leads to: its command acts at once.
const CONFIRMED: Record<string, Lead> = { deleteyes: 'removed', stopyes: 'stopped', takeyes: 'stopped' }

test('every chip has a /todo verb that does what the chip does wherever it is drawn, and refuses it everywhere else', { timeoutMs: 60_000 }, async ($, on) => {
  // The rows of the chip table a command can reach: a confirmation is the
  // pane's own question, and a command never asks it.
  const rows = BY_STATE.filter(r => r.before === undefined || r.before.join(' ') === 'stop stopyes')
  const presses = rows.flatMap(r => CHIP_VERBS.map(verb => ({ r, verb })))
  const db = seeded(presses.map(({ r }, i) => r.todo(i + 1)))
  const submitted: string[] = []
  const openedWith: { id: string; focus?: boolean; closeOnEscape?: boolean }[] = []
  engine(on, submitted, undefined, false, { db, openedWith })
  const clock = mock.clock(on, { now: 1000 })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  await start($)
  for (const [i, { r, verb }] of presses.entries()) {
    const n = i + 1
    // Just stopped: the command stops it as the chip would.
    if (r.before) await todo($, `stop ${n}`)
    const was = todoAt(db, n).status
    const asked = submitted.length
    const said = (await todo($, verb === 'rename' ? `rename ${n} Renamed` : `${verb} ${n}`)).text ?? ''
    await clock.settle()
    const at = `${r.state} → /todo ${verb}`
    const chip = r.chips[verb]
    if (chip === undefined) {
      // exec and auto also start a stopped or failed todo (their own rules).
      if (verb === 'exec' || verb === 'auto') continue
      expect(`${at}: ${new RegExp(`^#${n}(?!\\d)`).test(said)}`).toBe(`${at}: true`)
      expect(`${at}: ${todoAt(db, n).status}, ${submitted.length - asked} submitted`).toBe(`${at}: ${was}, 0 submitted`)
      continue
    }
    const lead = typeof chip === 'object' ? CONFIRMED[chip.confirm.find(k => k in CONFIRMED) ?? ''] : chip
    if (lead === 'removed') expect(`${at}: ${String(db.todos['/proj']?.[n] === undefined)}`).toBe(`${at}: true`)
    else if (lead === 'browser') expect(`${at}: ${JSON.stringify(openedWith.at(-1))}`).toBe(`${at}: ${JSON.stringify({ id: 'todo', focus: true, closeOnEscape: true })}`)
    else if (verb === 'rename') expect(`${at}: ${todoAt(db, n).title}`).toBe(`${at}: Renamed`)
    else expect(`${at}: ${JSON.stringify(todoAt(db, n).status)}`).toBe(`${at}: ${JSON.stringify(lead)}`)
  }
})

test('a chip verb refused names the todo, its status and the commands that do apply, and a bad target says so', async ($, on) => {
  const db = seeded([
    aTodo(1, 'Waiting'),
    aTodo(2, 'Again', { hasRun: true }),
    running(3, 'Runs'),
    aTodo(4, 'Halted', { status: 'stopped', hasRun: true }),
    running(5, 'Elsewhere', { owner: 'other' }),
    aTodo(6, 'Drafting', { status: 'drafting', owner: 's1' }),
  ])
  engine(on, [], undefined, false, { db })
  mock.clock(on, { now: 1000 })
  await start($)
  const said = async (args: string) => (await todo($, args)).text
  expect(await said('pause 1')).toBe('#1 is pending, so /todo pause doesn\'t apply; it takes /todo exec 1 · /todo auto 1 · /todo rename 1 · /todo delete 1 · /todo details 1.')
  expect(await said('reset 3')).toBe('#3 is running, so /todo reset doesn\'t apply; it takes /todo pause 3 · /todo stop 3 · /todo details 3.')
  expect(await said('stop 6')).toBe('#6 is drafting, so /todo stop doesn\'t apply; it takes /todo reset 6.')
  expect(await said('delete 2')).toBe('#2 has run: only a todo that never ran can be deleted.')
  expect(await said('leave 4')).toBe("#4 wasn't just stopped: nothing to leave.")
  expect(await said('takeover 3')).toBe('#3 is running, not in flight in another session: nothing to take over.')
  expect(await said('pause 5')).toBe('#5 is running in another session.')
  expect(await said('pause nothing-like-it')).toBe('No todo matches "nothing-like-it".')
  expect(await said('stop')).toBe('Usage: /todo stop <n|title>')
  // rename takes the number, then the new title.
  expect(await said('rename 1')).toBe('Usage: /todo rename <n> <new title>')
  expect(await said('rename Waiting Better')).toBe('Usage: /todo rename <n> <new title>')
  expect(await said('rename 1 Waiting')).toBe('#1 is already called that.')
  expect(await said('rename #1 Better title')).toBe('✎ #1 renamed Better title: its prompts are drafted again')
  expect(todoAt(db, 1).title).toBe('Better title')
  expect(todoAt(db, 3).status).toBe('running')
})

test('a chip verb is a verb, never a title: /todo <verb> runs it rather than adding a todo', async ($, on) => {
  const db = seeded([running(1, 'Runs')])
  engine(on, [], undefined, false, { db })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  mock.clock(on, { now: 1000 })
  await start($)
  for (const verb of CHIP_VERBS) expect(`${verb}: ${String(TODO_VERBS.includes(verb))}`).toBe(`${verb}: true`)
  expect((await todo($, 'pause 1')).text).toBe('⏸ #1 paused')
  expect((await todo($, 'stop runs')).text).toBe('■ #1 stopped')
  for (const verb of CHIP_VERBS.filter(v => v !== 'exec' && v !== 'auto')) await todo($, `${verb} 99`)
  expect(titles(db, '/proj')).toEqual(['1 Runs'])
})

test('/todo help and /todo ? list every verb then the pane keys, one short line each', async ($, on) => {
  const { db } = engine(on, [], undefined, true)
  await start($)
  const lines = String((await todo($, 'help')).text).split('\n')
  expect((await todo($, '?')).text).toBe(lines.join('\n'))
  // One line per verb in the dispatcher's own table, in its order, then the keys.
  expect(lines).toHaveLength(VERBS.length + 4)
  for (const [i, v] of VERBS.entries()) expect(lines[i]?.startsWith(v.use)).toBe(true)
  expect(lines.slice(-4).map(l => l.split(/\s{2,}/)[0])).toEqual(['pane: ctrl+x tab', 'pane: tab/arrows', 'pane: enter', 'pane: esc'])
  for (const line of lines) {
    expect(line.trim()).not.toBe('')
    expect(line.length <= 80).toBe(true)
  }
  expect(HELP).toBe(lines.join('\n'))
  expect(titles(db, '/proj')).toEqual([])
})

test('help and ? are never a todo title: in any case and with words after, /todo answers with help and adds nothing', async ($, on) => {
  const { db } = engine(on, [], undefined, true)
  await start($)
  for (const said of ['help', 'HELP', 'Help me', '?', '? what now', '  help  ']) expect((await todo($, said)).text).toBe(HELP)
  expect(titles(db, '/proj')).toEqual([])
  // Any other bare title is still added as before.
  expect((await todo($, 'helpful hints')).text).toBe('Added #1 helpful hints')
  expect(titles(db, '/proj')).toEqual(['1 helpful hints'])
})

test('a command acts without the question its chip asks, answering a confirmation the pane had open', async ($, on) => {
  const db = seeded([running(1, 'Runs'), aTodo(2, 'Waiting'), running(3, 'Elsewhere', { owner: 'other' })])
  engine(on, [], undefined, false, { db })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  mock.clock(on, { now: 1000 })
  await start($)
  const ui = await mountAll($)
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:stop' })
  expect(await ui.find({ type: 'Button', key: 'act:1:keep' })).toBeDefined()
  expect((await todo($, 'stop 1')).text).toBe('■ #1 stopped')
  // The question is answered: the row offers what next, Leave among it.
  expect(await ui.find({ type: 'Button', key: 'act:1:keep' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:leave' })).toBeDefined()
  expect((await todo($, 'leave 1')).text).toBe('✓ #1 left')
  expect((await todo($, 'delete 2')).text).toBe('✕ #2 deleted')
  expect(db.todos['/proj']?.[2]).toBeUndefined()
  expect((await todo($, 'takeover 3')).text).toBe("#3 taken over: stopped here; its run in the other session isn't stopped")
  expect(todoAt(db, 3)).toMatchObject({ status: 'stopped', isAgentGone: true })
  expect(todoAt(db, 3).owner).toBeUndefined()
  await ui.unmount()
})

// ---------- the guard: hooks/transitions.json ----------

test('mcp__todo__update refuses a status move the table does not allow, naming the moves it does, and writes nothing', async ($, on) => {
  const db = seeded([aTodo(1, 'Waiting'), running(2, 'Runs')])
  engine(on, [], undefined, true, { db })
  await start($)
  const r = await $.tool.call({ tool: 'mcp__todo__update', n: 1, status: 'done', summary: 'landed' } as never)
  expect(r).toMatchObject({
    result: "#1 can't go from pending to done: from pending it can only go to prompting, drafting, removed. Nothing was written.",
    isError: true,
  })
  expect(todoAt(db, 1).status).toBe('pending')
  expect(todoAt(db, 1).summary).toBeUndefined()
  expect(movesFrom('done')).toEqual(['[*]'])
  const late = await $.tool.call({ tool: 'mcp__todo__update', n: 2, status: 'drafting' } as never)
  expect(late.isError).toBe(true)
  // An allowed move still lands.
  const ok = await $.tool.call({ tool: 'mcp__todo__update', n: 2, status: 'done', summary: 'landed' } as never)
  expect(ok.isError).toBeFalsy()
  expect(todoAt(db, 2)).toMatchObject({ status: 'done', summary: 'landed' })
})

test("the guard keeps a todo's status when an internal move isn't in the table, saying so once, and the rest of the write stands", async ($, on) => {
  const toasts: string[] = []
  const db = seeded([aTodo(1, 'Waiting')])
  engine(on, [], undefined, true, { db, toasts })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }))
  await start($)
  // Launched outside the protocol: pending → running isn't a move.
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Waiting', prompt: 'p', subagent_type: 'general-purpose' } as never)
  expect(todoAt(db, 1)).toMatchObject({ status: 'pending', taskId: 'ag1', mode: 'agent', toolUseIds: ['tu1'] })
  expect(toasts.filter(x => x.startsWith("todo: #1 can't go from pending to running"))).toHaveLength(1)
})

test('every status move the code makes is in hooks/transitions.json, and every move there is one the code makes', { timeoutMs: 30_000 }, async ($, on) => {
  // What each todo write moved, read from the scripts as they reach the database.
  const made = new Set<string>()
  const db = seeded([
    aTodo(2, 'Cycle', { status: 'drafting', hasRun: true, owner: 's1', mode: 'agent', taskId: 'ag2' }),
    running(3, 'Stop me'),
    running(4, 'Fail me'),
    aTodo(5, 'Reset me', { status: 'drafting', owner: 's1' }),
    aTodo(6, 'Plan me', { status: 'planning', owner: 's1' }),
    aTodo(7, 'Plan again', { status: 'planning', hasRun: true, owner: 's1' }),
    aTodo(8, 'Drafting elsewhere', { status: 'prompting', owner: 'other', promptingAt: Date.now() }),
    aTodo(9, 'Delete me'),
  ])
  const sql = (op: Op, d: Db) => {
    if (op.kind !== 'todos') return undefined
    const had = d.todos[op.dir] ?? {}
    for (const t of op.put) made.add(`${(had[t.n] as Todo | undefined)?.status ?? '[*]'} → ${t.status}`)
    for (const n of op.del) made.add(`${(had[n] as Todo | undefined)?.status ?? '[*]'} → [*]`)
    return undefined
  }
  const { clock, toasts } = drafterEngine(on, { db, sql })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => ({ result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }))
  await start($)
  const report = (n: number, status: Todo['status']) => $.tool.call({ tool: 'mcp__todo__update', n, status } as never)
  const run = async (args: string) => {
    await todo($, args)
    await clock.settle()
  }
  // Added, drafted, run through a plan to done.
  await run('add Fresh one')
  await turnDone($, 'dr1', JSON.stringify({ n: 10, key: '10.1', drafts: DRAFTS }))
  await run('exec 10')
  await report(10, 'planning')
  await report(10, 'running')
  await report(10, 'done')
  // Around the cycle: running, paused, resumed, failed, refined, reset,
  // restarted, a resume that started nothing, stopped.
  await report(2, 'running')
  await run('pause 2')
  await run('resume 2')
  await report(2, 'failed')
  await run('refine 2')
  await run('reset 2')
  await run('restart 2')
  await report(2, 'paused')
  await run('stop 2')
  await run('stop 3')
  await report(4, 'failed')
  await run('reset 5')
  await run('reset 6')
  await run('reset 7')
  await run('delete 8')
  await run('delete 9')
  expect(toasts.filter(x => x.includes("can't go from"))).toEqual([])
  // A write that keeps the status isn't a move; done → [*] is the tree
  // hiding a done todo, never a write.
  const table = new Set(TABLE.transitions.map(m => `${m.from} → ${m.to}`))
  const quiet = new Set(['prompting → prompting', 'done → [*]'])
  const moves = [...made].filter(m => m.split(' → ')[0] !== m.split(' → ')[1])
  expect(moves.filter(m => !table.has(m))).toEqual([])
  expect([...table].filter(m => !quiet.has(m) && !made.has(m))).toEqual([])
})
