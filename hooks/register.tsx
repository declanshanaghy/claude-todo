import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNode, Call, Confirm, Detail, ImageRef, Kept, PaneUi, Todo, Turn, View } from '../types'
import { CWD, DbError, backups, callsAfter, dropBackups, importTodos, locate, snapshot, writeAgents, writeCall, writeTodos, writeTurn } from './db'
import { drawDetail } from './detail'
import { imageRefs, splitImages, thumbnail } from './images'
import { DEFAULT_VIEW, SUMMARY, statusToast, tallyText } from './marks'
import { drawPane, focusOrder } from './pane'
import { execPrompt, restartPrompt, resumePrompt } from './protocol'

export const PANE = 'todo'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
//
// Todos belong to a directory (the repo the session is in, else the home
// directory), kept with their agents and tool calls in the SQLite file db.ts
// drives. These values are this session's copy of that directory's rows for
// drawing, refreshed on each write and whenever the file changes.
const todos = atom({ plugin: 'todo', key: 'list' } as const, [], { shape: 'list-1' })
// Where versions before 0.3 kept the session's todos; read once to migrate.
const legacy = atom({ plugin: 'todo', key: 'todos' } as const, [], { shape: 'todos-1' })
// The directory the list belongs to, the root it was resolved from, and the
// list's rev and last call seq this copy stands at.
const dir = atom({ plugin: 'todo', key: 'dir' } as const, '')
const root = atom({ plugin: 'todo', key: 'root' } as const, '')
const rev = atom({ plugin: 'todo', key: 'rev' } as const, -1)
const seq = atom({ plugin: 'todo', key: 'seq' } as const, 0)
const stamp = atom({ plugin: 'todo', key: 'stamp' } as const, '')
const me = atom({ plugin: 'todo', key: 'me' } as const, '')
// Why the database can't be used; the pane is read-only while it's set.
const fault = atom({ plugin: 'todo', key: 'fault' } as const, '')
// The last failed run of the database, said once until a write lands again.
const warned = atom({ plugin: 'todo', key: 'warned' } as const, '')
// Whether this session's agents and calls from before 0.3 were written out.
const persisted = atom({ plugin: 'todo', key: 'persisted' } as const, false)
const db = atom({ plugin: 'todo', key: 'db' } as const, null as { bin: string; file: string } | null)
const agents = atom({ plugin: 'todo', key: 'agents' } as const, [], { shape: 'agents-1' })
const calls = atom({ plugin: 'todo', key: 'calls' } as const, [], { shape: 'calls-2' })
// What each todo agent wrote between its calls, kept beside them.
const turns = atom({ plugin: 'todo', key: 'turns' } as const, [], { shape: 'turns-1' })
// The call browser's unfolded blocks and how many windows of older entries it
// shows; both reset when it opens. `thumbs` maps an image's path to the PNG
// made for it ('' when none can be).
const unfolded = atom({ plugin: 'todo', key: 'unfolded' } as const, [] as string[])
const earlier = atom({ plugin: 'todo', key: 'earlier' } as const, 0)
const thumbs = atom({ plugin: 'todo', key: 'thumbs' } as const, {} as Record<string, string>)
// The pane's layout, kept across reloads and sessions: what's open, a pending
// confirmation, the view the header toggles. `view` is optional, so the tag
// stays: what an earlier version stored (without one) reads as the default.
const ui = atom(
  { plugin: 'todo', key: 'ui' } as const,
  { expanded: [], confirm: null, renaming: null, justStopped: [], isHidden: false, view: [...DEFAULT_VIEW] },
  { shape: 'ui-2' },
)
const cpuCap = atom({ plugin: 'todo', key: 'cpuCap' } as const, 1)
const spin = atom({ plugin: 'todo', key: 'spin' } as const, 0)
const detail = atom({ plugin: 'todo', key: 'detail' } as const, null as Detail)
// What held the pane's focus ring when the dialog opened: Escape puts it back.
const returnTo = atom({ plugin: 'todo', key: 'returnTo' } as const, null as string | null)
// Whether a surface draws the pane now. Its header summary or, while it isn't
// on screen (closed, hidden, waiting for a wider terminal, or showing the
// dialog), the status line counts the todos: one of them, never both.
const placed = atom({ plugin: 'todo', key: 'placed' } as const, false)
// The key of the element the pane's focus ring is on, so the pane can draw
// that chip's border; a person's moves arrive at ui.focus, the mod's own here.
const ring = atom({ plugin: 'todo', key: 'ring' } as const, null as string | null)
// How long a done todo stays in the tree, in ms (0 keeps it), and the todos
// whose time is up: the tree leaves them out; the database keeps them.
const ttl = atom({ plugin: 'todo', key: 'ttl' } as const, 0)
const expired = atom({ plugin: 'todo', key: 'expired' } as const, [] as number[])
// The session's title, as the prompt bar shows it; '' while it has none. The
// engine offers no getter, so the classic SessionStart and UserPromptSubmit
// events, which carry it, keep it current.
const sessionTitle = atom({ plugin: 'todo', key: 'sessionTitle' } as const, '')

const CALLS_PER_AGENT = 200
const CALLS_TOTAL = 1500
const FIELD_MAX = 3000
const RESPONSE_MAX = 6000
const TURN_MAX = 8000
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'path', 'prompt']
export const INFLIGHT = new Set<Todo['status']>(['drafting', 'planning', 'running', 'paused'])
const SYNC_MS = 2000
// Each write retries this often when other sessions keep moving the list.
const TRIES = 5
const CALLS_PAGE = 100

type $ = EngineInterface

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const num = (m: RegExpExecArray | null) => (m ? Number(m[1]) : undefined)
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
const norm = (s: string) => s.trim().toLowerCase()

// Sets each field `patch` names; one it names as undefined is dropped, as an
// optional field is absent rather than undefined.
function assign<T extends object>(o: T, patch: { [K in keyof T]?: T[K] | undefined }): T {
  const fields: [string, unknown][] = Object.entries({ ...o, ...patch })
  return Object.fromEntries(fields.filter(([, v]) => v !== undefined)) as T
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
// JSON.stringify answers undefined for undefined, a function or a symbol.
const json = (v: unknown, space?: number): string | undefined => JSON.stringify(v, null, space)

// ---------- the directory's rows ----------

async function real($: $, path: string) {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

// The repo `from` is in, its worktree its own; outside any repo, home.
async function keyFor($: $, from: string) {
  try {
    const r = await $.process.run(['git', '-C', from, 'rev-parse', '--show-toplevel'], CWD)
    if (r.exitCode === 0 && r.stdout.trim()) return await real($, r.stdout.trim())
  } catch {
    // not a repo, or no git
  }
  return real($, (await $.env.get('HOME')) ?? from)
}

const isTodo = (t: unknown): t is Todo =>
  typeof t === 'object' && t !== null && typeof (t as Todo).n === 'number' && typeof (t as Todo).title === 'string'

async function where($: $) {
  const at = await read($, db)
  if (!at) throw new DbError(await read($, fault))
  return { at, d: await read($, dir), me: await read($, me) }
}

// A failure the person should see once, not a hook error on every tick.
// The database can't be used at all (no sqlite3, no folder for the file):
// the pane says why and stays read-only.
async function fail($: $, err: unknown) {
  const why = err instanceof Error ? err.message : String(err)
  if ((await read($, fault)) !== why) $.ui.toast(`todo: ${why}`)
  await update($, fault, () => why)
}

// One failed run of the database: said once until a write lands again, and no
// bar to the next one. Most are one-offs, like a write the host aborts as the
// turn or agent it ran for ends.
async function warn($: $, err: unknown) {
  const why = err instanceof Error ? err.message : String(err)
  if ((await read($, warned)) !== why) $.ui.toast(`todo: ${why}`)
  await update($, warned, () => why)
}

// Reads the directory's todos and agents; the calls since the copy's last seq
// (or, from scratch, the newest CALLS_TOTAL) are merged in.
async function reload($: $, fresh = false) {
  const { at, d } = await where($)
  const snap = await snapshot($, at, d, CALLS_TOTAL)
  // A write of this session's that landed after the read began stays.
  if (fresh || snap.rev >= (await read($, rev))) {
    await update($, todos, () => snap.todos.filter(isTodo))
    await update($, rev, () => snap.rev)
  }
  await update($, agents, () => snap.agents)
  let after = fresh ? Math.max(0, snap.floor - 1) : await read($, seq)
  const got: Call[] = []
  const said: Turn[] = []
  for (;;) {
    const page = await callsAfter($, at, d, after, CALLS_PAGE)
    for (const { seq: _, ...c } of page.rows) {
      // A turn's body carries `kind`; a call's has none.
      if ('kind' in c) said.push(c)
      else got.push(c)
    }
    if (page.last === null || page.rows.length < CALLS_PAGE) {
      if (page.last !== null) after = page.last
      break
    }
    after = page.last
  }
  await update($, seq, () => after)
  const ids = new Set(snap.agents.map(a => a.agentId))
  const byId = new Map(got.map(c => [c.id, c]))
  await update($, calls, l =>
    [...(fresh ? [] : l.filter(c => !byId.has(c.id))), ...got].filter(c => ids.has(c.agentId)).slice(-CALLS_TOTAL),
  )
  const saidIds = new Set(said.map(x => x.id))
  await update($, turns, l =>
    [...(fresh ? [] : l.filter(x => !saidIds.has(x.id))), ...said].filter(x => ids.has(x.agentId)).slice(-CALLS_TOTAL),
  )
  await syncStatus($)
}

// Every todo write is checked against the rev this copy stands at: when
// another session moved the list since, the copy is re-read and `fn` runs
// again. A todo this session puts in flight is stamped its owner.
async function editTodos($: $, fn: (list: Todo[]) => Todo[]) {
  if (await read($, fault)) {
    $.ui.toast(`todo is read-only: ${await read($, fault)}`)
    return false
  }
  try {
    const { at, d, me: self } = await where($)
    const now = await $.clock.now()
    for (let i = 0; i < TRIES; i++) {
      const before = await read($, todos)
      const r = await read($, rev)
      // A todo this session puts in flight is stamped its owner; one that turns
      // done, the time, which its time in the tree counts from.
      const stamp = (t: Todo): Todo =>
        t.status === 'done'
          ? t.doneAt === undefined ? { ...t, doneAt: now } : t
          : t.doneAt === undefined ? t : assign(t, { doneAt: undefined })
      const after = fn(before).map(t =>
        before.includes(t) ? t : stamp(INFLIGHT.has(t.status) ? { ...t, owner: self } : t),
      )
      const put = after.filter(t => !before.includes(t))
      const del = before.filter(t => !after.some(x => x.n === t.n)).map(t => t.n)
      if (put.length === 0 && del.length === 0) return true
      if (await writeTodos($, at, d, r, put, del)) {
        await update($, warned, () => '')
        await update($, todos, () => after)
        await update($, rev, () => r + 1)
        return true
      }
      await reload($)
    }
    $.ui.toast('todo: not saved, other sessions kept changing the list; try again')
  } catch (err) {
    await warn($, err)
  }
  return false
}

// Agents and calls are written through: each change to this session's copy
// lands in the database, where a later session (or this one after a restart)
// reads it back.
async function editAgents($: $, fn: (list: AgentNode[]) => AgentNode[]) {
  let before: AgentNode[] = []
  let after: AgentNode[] = []
  await update($, agents, l => ((before = l), (after = fn(l)), after))
  const put = after.filter(a => !before.includes(a))
  const del = before.filter(a => !after.some(x => x.agentId === a.agentId)).map(a => a.agentId)
  if (put.length === 0 && del.length === 0) return
  try {
    const { at, d, me: self } = await where($)
    await writeAgents($, at, d, self, put, del)
  } catch (err) {
    await warn($, err)
  }
}

async function editCalls($: $, fn: (list: Call[]) => Call[]) {
  let before: Call[] = []
  let after: Call[] = []
  await update($, calls, l => ((before = l), (after = fn(l)), after))
  const put = after.filter(c => !before.includes(c))
  if (put.length === 0) return
  try {
    const { at, d, me: self } = await where($)
    for (const c of put) await writeCall($, at, d, self, c)
  } catch (err) {
    await warn($, err)
  }
}

async function addTurn($: $, x: Turn) {
  await update($, turns, l => {
    const mine = l.filter(y => y.agentId === x.agentId)
    const oldest = mine.length >= CALLS_PER_AGENT ? mine[0]?.id : undefined
    return [...l.filter(y => y.id !== oldest && y.id !== x.id), x].slice(-CALLS_TOTAL)
  })
  try {
    const { at, d, me: self } = await where($)
    await writeTurn($, at, d, self, x)
  } catch (err) {
    await fail($, err)
  }
}

// Folds `incoming` into directory `d`'s list in one transaction with its
// backup, once per `id`. Never-run todos whose title the list already has
// (or an earlier incoming one) collapse into it; the rest keep their number
// unless it's taken. Resolves the renumbering, or undefined when `id` was
// imported before.
async function importInto($: $, d: string, id: string, incoming: Todo[], own: (t: Todo) => Todo) {
  const { at } = await where($)
  const fresh = (t: Todo) => !t.hasRun && t.status === 'pending'
  for (let i = 0; i < TRIES; i++) {
    const snap = await snapshot($, at, d, 1)
    const have = snap.todos.filter(isTodo)
    const taken = new Set(have.map(t => t.n))
    let top = Math.max(0, ...taken, ...incoming.map(t => t.n))
    const put: Todo[] = []
    const renum = new Map<number, number>()
    for (const t of incoming) {
      const twin = fresh(t) ? [...have, ...put].find(x => fresh(x) && norm(x.title) === norm(t.title)) : undefined
      if (twin) {
        if (twin.n !== t.n) renum.set(t.n, twin.n)
        continue
      }
      const n = taken.has(t.n) ? ++top : t.n
      taken.add(n)
      if (n !== t.n) renum.set(t.n, n)
      put.push(own({ ...t, n }))
    }
    const r = await importTodos($, at, { dir: d, rev: snap.rev, id, at: await $.clock.now(), backup: incoming, put })
    if (r === 'ok') return renum
    if (r === 'done') return undefined
  }
  throw new DbError(`import of ${id} kept colliding with other sessions' writes`)
}

// Moves the todos an earlier version kept in this session's state into the
// directory's list (see importInto), then clears them; this session's links
// follow any renumbering.
async function migrate($: $) {
  const old = (await read($, legacy)).filter(isTodo)
  if (old.length === 0) return
  const { d, me: self } = await where($)
  const renum = await importInto($, d, `session:${self}`, old, t => (INFLIGHT.has(t.status) ? { ...t, owner: self } : t))
  await update($, legacy, () => [])
  if (!renum || renum.size === 0) return
  const to = (n: number) => renum.get(n) ?? n
  await update($, agents, l => l.map(a => ({ ...a, todoN: to(a.todoN) })))
  await update($, ui, u => ({
    ...u,
    expanded: u.expanded.map(x => x.replace(/^([tsa])(\d+)(?=$|:)/, (_, k: string, n: string) => `${k}${to(Number(n))}`)),
    justStopped: u.justStopped.map(to),
    confirm: u.confirm && { ...u.confirm, n: to(u.confirm.n) },
    renaming: u.renaming === null ? null : to(u.renaming),
  }))
  await update($, detail, x => (x?.kind === 'todo' ? { ...x, n: to(x.n) } : x))
}

// An unreleased build kept lists in $.store under `dir:<cwd>`: each goes to
// the list its path now belongs to, and its key is deleted once every title is
// there. Its other keys (backups, heartbeats) go with the last of them.
async function migrateStore($: $) {
  const { at } = await where($)
  const keys = await $.store.keys()
  let isLeft = false
  for (const k of keys.filter(x => x.startsWith('dir:'))) {
    const path = k.slice('dir:'.length)
    const v = (await $.store.get(k)) as { todos?: unknown[] } | undefined
    const incoming = (Array.isArray(v?.todos) ? v.todos : []).filter(isTodo)
    const d = await keyFor($, path)
    await importInto($, d, `store:${path}`, incoming, t => t)
    const there = new Set((await snapshot($, at, d, 1)).todos.map(t => norm(t.title)))
    if (incoming.every(t => there.has(norm(t.title)))) await $.store.delete(k)
    else isLeft = true
  }
  if (isLeft) return
  for (const k of keys) if (k.startsWith('backup:') || k.startsWith('alive:')) await $.store.delete(k)
}

// A session from before 0.3 kept its agents and calls in its own state: write
// them out once, under the list they now belong to.
async function persistTraces($: $) {
  if (await read($, persisted)) return
  const { at, d, me: self } = await where($)
  await writeAgents($, at, d, self, await read($, agents), [])
  for (const c of await read($, calls)) await writeCall($, at, d, self, c)
  await update($, persisted, () => true)
}

// A backup is kept until a later start than the one that wrote it.
async function pruneBackups($: $, bootAt: number) {
  const { at } = await where($)
  const old = (await backups($, at)).filter(b => b.at < bootAt).map(b => b.id)
  await dropBackups($, at, old)
}

// Resolves the list for the session's root; a new one is read from scratch.
async function settle($: $) {
  const r = await $.session.root()
  if (r === (await read($, root)) && (await read($, dir))) return false
  const d = await keyFor($, r)
  await update($, root, () => r)
  if (d === (await read($, dir))) return false
  await update($, dir, () => d)
  await update($, rev, () => -1)
  await update($, seq, () => 0)
  return true
}

async function mtime($: $, path: string) {
  try {
    return String((await $.fs.stat(path)).mtimeMs)
  } catch {
    return ''
  }
}

async function sync($: $) {
  if (await read($, fault)) return
  try {
    if (await settle($)) {
      await reload($, true)
      return
    }
    const { at } = await where($)
    const now = `${await mtime($, at.file)}:${await mtime($, `${at.file}-wal`)}`
    if (now === (await read($, stamp))) return
    await update($, stamp, () => now)
    await reload($)
  } catch (err) {
    await warn($, err)
  }
}

// ---------- state helpers ----------

async function patchTodo($: $, n: number, fn: (t: Todo) => Todo) {
  await editTodos($, list => list.map(t => (t.n === n ? fn(t) : t)))
  await syncStatus($)
}

// In flight in another live session: its task ids aren't this session's.
async function isForeign($: $, t: Todo) {
  return INFLIGHT.has(t.status) && t.owner !== undefined && t.owner !== (await $.session.id())
}

async function syncStatus($: $) {
  const list = await read($, todos)
  const isSummed = (await read($, placed)) && (await read($, detail)) === null
  // A status line carries plain text only, so it has the marks but not their
  // colors; the pane's header draws the same marks in them.
  $.ui.status(list.length === 0 || isSummed ? undefined : `todo ${tallyText(list)}`)
}

async function setPlaced($: $, isPlaced: boolean) {
  if ((await read($, placed)) !== isPlaced) await update($, placed, () => isPlaced)
  await syncStatus($)
}

// The engine raises nothing when a narrower terminal unseats the pane, so the
// sync tick asks it where the pane stands.
async function checkPlaced($: $) {
  const isPlaced = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  if ((await read($, placed)) !== isPlaced) await setPlaced($, isPlaced)
}

async function openPane($: $, asked: boolean) {
  const opened = await $.ui.open({ id: PANE, title: 'Todos', backgroundColor: 'transparent', ...(asked ? { focus: true } : {}) })
  await setPlaced($, opened.isPlaced)
  return opened
}

// The view-only detail dialog replaces the tree in the same pane, which
// already holds the keys; Escape hands them back and the render closes it.
// `back` is where Escape puts the ring, when not on what opened it.
export async function openDetail($: $, d: Detail, back?: string) {
  const at = back ?? (await read($, ring))
  await update($, returnTo, () => at)
  await update($, unfolded, () => [])
  await update($, earlier, () => 0)
  await update($, detail, () => d)
  await syncStatus($)
}

async function closeDetail($: $) {
  await update($, detail, () => null)
  await syncStatus($)
}

// Escape (or a click elsewhere) takes the keys from the pane while the dialog
// shows: it closes, and the pane takes the keys back with the ring where it
// was before the dialog opened, rather than leaving them at the prompt.
async function leaveDetail($: $) {
  const back = await read($, returnTo)
  await closeDetail($)
  await update($, returnTo, () => null)
  try {
    await $.ui.open({ id: PANE, title: 'Todos', backgroundColor: 'transparent', focus: true })
  } catch {
    // The pane can't be seated now: the prompt keeps the keys.
    return
  }
  if (back !== null) await focus($, back)
}

// A fold toggle in the call browser: one block unfolds or folds again.
export async function unfold($: $, id: string) {
  await update($, unfolded, l => (l.includes(id) ? l.filter(x => x !== id) : [...l, id]))
}

// The call browser's "earlier" toggle: one more window of older entries.
export async function showEarlier($: $) {
  await update($, earlier, n => n + 1)
}

// Images the call browser wants drawn and has no PNG for yet: each is made
// once, off the render, and the drawing follows the thumbs atom.
const making = new Set<string>()
function makeThumbs($: $, want: ImageRef[]) {
  const todo = want.filter(im => !making.has(im.path))
  if (todo.length === 0) return
  for (const im of todo) making.add(im.path)
  $.clock.after(0, () => {
    void (async () => {
      const at = await read($, db)
      for (const im of todo) {
        const png = at ? await thumbnail($, im, at.file.slice(0, at.file.lastIndexOf('/'))) : ''
        await update($, thumbs, t => ({ ...t, [im.path]: png }))
        making.delete(im.path)
      }
    })()
  })
}

export async function patchUi($: $, fn: (u: PaneUi) => PaneUi) {
  await update($, ui, fn)
}

// The pane's drill-down keeps what's open as ids in `expanded`: `t3` todo #3,
// `s3` its subtasks line, `a3:<agentId>` one of its subtasks. Closing a level
// closes everything under it, so reopening it starts folded.
const isUnder = (id: string, x: string) => {
  const m = /^([ts])(\d+)$/.exec(id)
  if (!m) return false
  return (m[1] === 't' && x === `s${m[2]}`) || x.startsWith(`a${m[2]}:`)
}

export const collapse = (expanded: readonly string[], id: string) => expanded.filter(x => x !== id && !isUnder(id, x))

export async function toggle($: $, id: string) {
  await patchUi($, u => ({
    ...u,
    expanded: u.expanded.includes(id) ? collapse(u.expanded, id) : [...u.expanded, id],
  }))
}

// A header toggle shows or hides one view's todos. `all` lights every view;
// pressed while they all are (it reads `default` then), it puts the default
// view back. Kept in SUMMARY's order, so the stored view reads the same way.
export const viewIn = (u: PaneUi): readonly View[] => u.view ?? DEFAULT_VIEW

export const nextView = (view: readonly View[], v: View | 'all'): View[] => {
  if (v === 'all') return [...(view.length === SUMMARY.length ? DEFAULT_VIEW : SUMMARY)]
  const on = new Set(view)
  if (on.has(v)) on.delete(v)
  else on.add(v)
  return SUMMARY.filter(x => on.has(x))
}

export async function toggleView($: $, v: View | 'all') {
  await patchUi($, u => ({ ...u, view: nextView(viewIn(u), v) }))
}

async function focus($: $, key: string) {
  // The engine skips this plugin's own ui.focus hook for its own call, so the
  // ring is noted here, and put back if the move is refused.
  const was = await read($, ring)
  await update($, ring, () => key)
  try {
    if ((await $.ui.focus({ requestId: PANE, key })).deny !== undefined) await update($, ring, () => was)
  } catch {
    // A refusal comes back as `deny`; a throw is the host's own, and the note
    // stands so the chip the mod asked for still lights.
  }
}

export async function addTodo($: $, title: string) {
  const clean = title.trim()
  if (!clean) return undefined
  let n = 0
  const isSaved = await editTodos($, list => {
    n = Math.max(0, ...list.map(t => t.n)) + 1
    const t: Todo = { n, title: clean, status: 'pending', toolUseIds: [], hasRun: false }
    return [...list, t]
  })
  await syncStatus($)
  // A refused write has already said why.
  if (!isSaved) return null
  $.ui.toast(`＋ added #${n}`)
  return n
}

async function clearRun($: $, n: number) {
  // Deleting an agent's row deletes its calls' rows with it.
  const gone = new Set((await read($, agents)).filter(a => a.todoN === n).map(a => a.agentId))
  await editAgents($, l => l.filter(a => a.todoN !== n))
  await update($, calls, l => l.filter(c => !gone.has(c.agentId)))
  await update($, turns, l => l.filter(x => !gone.has(x.agentId)))
}

// ---------- actions (pane buttons and /todo) ----------

// A plugin's prompt can be dropped (a Stop standing after an interrupt, a
// hook's refusal): the todo goes back to how `t` had it, and the drop says why.
async function submit($: $, t: Todo, text: string) {
  const r = await $.prompt.submit({ text })
  if (r.drop === undefined) return undefined
  await patchTodo($, t.n, x => assign(x, { status: t.status, taskId: t.taskId, runId: t.runId }))
  $.ui.toast(`#${t.n} didn't start: ${r.drop}`)
  return r.drop
}

const RUNNABLE = new Set<Todo['status']>(['pending', 'stopped', 'failed'])

// The todo `/todo exec auto` runs when it names none: the next by priority,
// which for now is the lowest-numbered pending one.
export const nextRunnable = (list: readonly Todo[]) =>
  list.filter(t => t.status === 'pending').sort((a, b) => a.n - b.n)[0]

export const NONE_PENDING = 'No pending todo to run.'

// Why 🔥 Fire can't launch the next todo right now, or null when it can:
// nothing is pending, or this directory's live agents already fill the cap.
export function fireBlock(list: readonly Todo[], nodes: readonly AgentNode[], cap: number): string | null {
  if (!nextRunnable(list)) return NONE_PENDING
  const live = nodes.filter(a => a.status === 'running').length
  return live >= cap ? `The agent cap is reached (${live} of ${cap} running).` : null
}

// 🔥 Fire: what `/todo exec auto` with no target does, from the pane, where a
// press may submit at once. Pressed while blocked, it says why instead.
export async function fireNext($: $) {
  const list = await read($, todos)
  const why = fireBlock(list, await read($, agents), await read($, cpuCap))
  const t = nextRunnable(list)
  if (why !== null || !t) {
    $.ui.toast(why ?? NONE_PENDING)
    return why ?? NONE_PENDING
  }
  return execTodo($, t, false, true)
}

const execNote = (t: Todo, auto: boolean) =>
  auto
    ? `Auto-executing #${t.n} ${t.title}: Claude drafts the prompt and launches it, no questions asked.`
    : `Executing #${t.n} ${t.title}: answer the prompt question in the chat.`

// `auto` skips every question: Claude picks the prompt and, for multi-step
// work, plans on defaults and runs it without plan-mode approval.
export async function execTodo($: $, t: Todo, refine: boolean, auto = false) {
  if (!refine && !RUNNABLE.has(t.status)) return `#${t.n} is ${t.status}.`
  if (refine) await clearRun($, t.n)
  await patchTodo($, t.n, x => ({ ...x, status: 'drafting' }))
  await patchUi($, u => ({
    ...u,
    expanded: u.expanded.includes(`t${t.n}`) ? u.expanded : [...u.expanded, `t${t.n}`],
    justStopped: u.justStopped.filter(x => x !== t.n),
  }))
  const drop = await submit($, t, execPrompt(t, await read($, cpuCap), refine, auto))
  if (drop !== undefined) return `#${t.n} didn't start: ${drop}`
  return execNote(t, auto)
}

export async function restartTodo($: $, t: Todo) {
  await clearRun($, t.n)
  await patchTodo($, t.n, x => assign(x, { status: 'drafting', taskId: undefined, runId: undefined }))
  await patchUi($, u => ({ ...u, justStopped: u.justStopped.filter(x => x !== t.n) }))
  if ((await submit($, t, restartPrompt(t, await read($, cpuCap)))) !== undefined) return
  $.ui.toast(`↻ restarting #${t.n}`)
}

// Marks a todo's live agents `to`, and their unfinished calls interrupted.
async function settleAgents($: $, n: number, to: 'paused' | 'stopped') {
  const live = new Set(
    (await read($, agents)).filter(a => a.todoN === n && (a.status === 'running' || a.status === 'paused')).map(a => a.agentId),
  )
  await editAgents($, l => l.map((a): AgentNode => (live.has(a.agentId) ? { ...a, status: to } : a)))
  await editCalls($, l => l.map((c): Call => (live.has(c.agentId) && c.state === 'run' ? { ...c, state: 'interrupted' } : c)))
}

export async function haltTodo($: $, t: Todo, to: 'paused' | 'stopped') {
  if (await isForeign($, t)) {
    $.ui.toast(`#${t.n} is running in another session`)
    return
  }
  if (t.taskId) {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: t.taskId })
    if (r.deny !== undefined) $.ui.toast(`TaskStop refused: ${r.deny}`)
  }
  await settleAgents($, t.n, to)
  await patchTodo($, t.n, x => ({ ...x, status: to }))
  if (to === 'stopped') {
    await patchUi($, u => ({ ...u, confirm: null, justStopped: [...u.justStopped, t.n] }))
    await focus($, `act:${t.n}:refine`)
  } else {
    await focus($, `act:${t.n}:resume`)
  }
  $.ui.toast(to === 'paused' ? `⏸ #${t.n} paused` : `■ #${t.n} stopped`)
}

// The worktrees the todo's agents left, found by agent id (or the todo's own
// branch) in `git worktree list`: what a resume picks up when it can't wake
// the agent that made them.
async function keptWork($: $, t: Todo): Promise<Kept[]> {
  const mine = (await read($, agents)).filter(a => a.todoN === t.n)
  const names = new Map(mine.map(a => [a.agentId, a.name]))
  if (t.taskId !== undefined && !names.has(t.taskId)) names.set(t.taskId, `#${t.n}`)
  let listed = ''
  try {
    const r = await $.process.run(['git', '-C', await read($, dir), 'worktree', 'list', '--porcelain'], CWD)
    if (r.exitCode !== 0) return []
    listed = r.stdout
  } catch {
    return []
  }
  const kept: Kept[] = []
  for (const block of listed.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '(detached)'
    if (path === undefined) continue
    const id = [...names.keys()].find(i => path.endsWith(`/agent-${i}`) || branch === `worktree-agent-${i}`)
    if (id !== undefined) kept.push({ agentId: id, name: names.get(id) ?? `#${t.n}`, path, branch })
    else if (t.branch !== undefined && branch === t.branch) kept.push({ agentId: '', name: `#${t.n}`, path, branch })
  }
  return kept
}

const DIGEST_TURNS = 12
const DIGEST_CALLS = 25

// What the todo's agents wrote and did, newest last: the context a fresh agent
// needs to pick their work up.
async function digestOf($: $, t: Todo) {
  const mine = new Set((await read($, agents)).filter(a => a.todoN === t.n).map(a => a.agentId))
  const said = (await read($, turns)).filter(x => mine.has(x.agentId)).slice(-DIGEST_TURNS)
  const did = (await read($, calls)).filter(c => mine.has(c.agentId)).slice(-DIGEST_CALLS)
  const lines = [
    ...said.map(x => ({ at: x.startedAt, text: `   said: ${cut(x.text.replace(/\s+/g, ' '), 300)}` })),
    ...did.map(c => ({ at: c.startedAt, text: `   ${c.tool} ${cut(c.arg, 100)} → ${c.state}` })),
  ]
  return lines.sort((x, y) => x.at - y.at).map(l => l.text).join('\n')
}

// Resume wakes the todo's agent (or Workflow run) where it can, and otherwise
// has Claude start a fresh agent on the work it kept. The todo turns running
// only once Claude reports something is: a resume that starts nothing leaves
// it as it was.
export async function resumeTodo($: $, t: Todo) {
  if (await isForeign($, t)) {
    $.ui.toast(`#${t.n} is paused in another session`)
    return
  }
  // A resumed Workflow replays finished agents from its journal and spawns the
  // rest afresh, so the interrupted nodes are left marked as such.
  if (t.mode === 'workflow') {
    await editAgents($, l => l.map((a): AgentNode => (a.todoN === t.n && a.status === 'paused' ? { ...a, status: 'stopped' } : a)))
  }
  await patchUi($, u => ({ ...u, justStopped: u.justStopped.filter(x => x !== t.n) }))
  // In the chat's hands until it reports: no second ⏵ Resume meanwhile.
  await patchTodo($, t.n, x => ({ ...x, status: 'drafting' }))
  const ctx = { kept: await keptWork($, t), digest: await digestOf($, t), canWake: t.isAgentGone !== true && t.taskId !== undefined }
  if ((await submit($, t, resumePrompt(t, ctx))) !== undefined) return
  await focus($, `todo:${t.n}`)
  $.ui.toast(`▶ resuming #${t.n}`)
}

// Claims a todo another session put in flight. Its task there isn't stopped
// (its ids are that session's): the todo is marked stopped here, to restart.
export async function takeOver($: $, t: Todo) {
  await settleAgents($, t.n, 'stopped')
  // Its agent and run were the other session's: ⏵ Resume here starts a fresh
  // agent on the worktree it kept.
  await patchTodo($, t.n, x => assign(x, { status: 'stopped', taskId: undefined, runId: undefined, owner: undefined, isAgentGone: true }))
  await patchUi($, u => ({ ...u, confirm: null, justStopped: [...u.justStopped, t.n] }))
  await focus($, `act:${t.n}:refine`)
  $.ui.toast(`#${t.n} taken over`)
}

export async function deleteTodo($: $, t: Todo) {
  await editTodos($, l => l.filter(x => x.n !== t.n))
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

export async function askConfirm($: $, n: number, kind: Confirm) {
  await patchUi($, u => ({ ...u, confirm: { n, kind } }))
  // The ring starts on the safe choice.
  await focus($, `act:${n}:${kind === 'stop' ? 'keep' : 'cancel'}`)
}

export async function cancelConfirm($: $, n: number, kind: Confirm) {
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
  for (const k of ARG_KEYS) {
    const v = a[k]
    if (typeof v === 'string') return v
  }
  return Object.values(a).find((v): v is string => typeof v === 'string') ?? ''
}

function responseOf(ran: { deny?: string | undefined; text?: string | undefined }, rest: unknown) {
  if (ran.deny !== undefined) return `denied: ${ran.deny}`
  if (ran.text) return ran.text
  try {
    return json(rest, 1) ?? ''
  } catch {
    return String(rest)
  }
}

const DONE_TTL_MINUTES = 5
const EXPIRE_MS = 5000

// Done todos' time in the tree: the CLAUDE_TODO_DONE_TTL_MINUTES variable, else
// the doneTtlMinutes option (/config), else 5 minutes; 0 keeps them.
async function ttlMs($: $, option: unknown) {
  const env = (await $.env.get('CLAUDE_TODO_DONE_TTL_MINUTES'))?.trim()
  const minutes = env ? Number(env) : typeof option === 'number' ? option : DONE_TTL_MINUTES
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : DONE_TTL_MINUTES * 60_000
}

async function expire($: $) {
  const keep = await read($, ttl)
  const now = await $.clock.now()
  const gone = keep === 0 ? [] : (await read($, todos)).filter(t => t.status === 'done' && t.doneAt !== undefined && now - t.doneAt >= keep).map(t => t.n)
  if (JSON.stringify(gone) !== JSON.stringify(await read($, expired))) await update($, expired, () => gone)
}

// What a classic event says the title is now: a hook's new title wins over
// the one the event arrived with; neither means the session has none.
async function noteTitle($: $, now: string | undefined) {
  const t = (now ?? '').trim()
  if ((await read($, sessionTitle)) !== t) await update($, sessionTitle, () => t)
}

export const register: Register = (on, options) => {
  // The pane's header draws the session's title, so it follows each change:
  // set at start (a resume brings its old one), and on every prompt, where a
  // rename or a hook's sessionTitle shows up.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    await noteTitle($, r.sessionTitle ?? e.session_title)
    return r
  }).catch((_, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    await noteTitle($, r.sessionTitle ?? e.session_title)
    return r
  }).catch((_, e, next) => next(e))
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Per-directory todos: /todo add <title> · /todo exec [auto] <n|title> · /todo exec auto · /todo show · /todo noshow',
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
          branch: { type: 'string', description: "The todo's git branch" },
          landed: { type: 'string', description: 'The commit hash it pushed to the base branch' },
        },
        required: ['n'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list',
      description: "List this repo's todos, or the home directory's outside a repo (number, title, status, prompt, summary).",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    let cap = 1
    for (const argv of [['sysctl', '-n', 'hw.ncpu'], ['nproc']]) {
      try {
        const r = await $.process.run(argv, CWD)
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

    // The database first: a session that can't reach it keeps its 0.2 todos
    // where they are and shows them read-only.
    // A dialog left open across a reload (or stranded by a refused drawing)
    // starts closed.
    await update($, detail, () => null)
    const bootAt = await $.clock.now()
    const self = await $.session.id()
    await update($, me, () => self)
    const found = await locate($)
    if (typeof found === 'string') {
      await update($, db, () => null)
      await fail($, found)
      const old = (await read($, legacy)).filter(isTodo)
      if (old.length > 0) await update($, todos, () => old)
    } else {
      await update($, db, () => found)
      await update($, fault, () => '')
      try {
        await settle($)
        await migrateStore($)
        await migrate($)
        await persistTraces($)
        await pruneBackups($, bootAt)
        await reload($, true)
        // Done before 0.3 kept the time: their time in the tree starts now.
        if ((await read($, todos)).some(t => t.status === 'done' && t.doneAt === undefined)) {
          await editTodos($, l => l.map(t => (t.status === 'done' && t.doneAt === undefined ? { ...t } : t)))
        }
      } catch (err) {
        await warn($, err)
      }
    }
    const keep = await ttlMs($, options['doneTtlMinutes'])
    await update($, ttl, () => keep)
    await expire($)
    $.clock.every(EXPIRE_MS, () => void expire($).catch(() => undefined))
    // A tick that fails (the module reloading under it) is tried again next tick.
    $.clock.every(SYNC_MS, () => {
      void sync($).catch(() => undefined)
      void checkPlaced($).catch(() => undefined)
    })

    $.clock.every(500, () => {
      void (async () => {
        const list = await read($, todos)
        if (list.some(t => t.status === 'running')) await update($, spin, s => (s + 1) % 12)
      })()
    })

    const ran = await next(e)
    // Not drawn until the open says so; until then the status line counts.
    await setPlaced($, false)
    if (!(await read($, ui)).isHidden) void openPane($, false).catch(() => undefined)
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
      const opened = await openPane($, asked)
      if (asked) return { text: opened.isPlaced ? 'Todo pane shown.' : `Todo pane can't be placed: ${opened.reason}` }
    }
    if (verb === 'add') {
      const n = await addTodo($, arg)
      if (n === undefined) return { text: 'Usage: /todo add <title>' }
      return { text: n === null ? 'Not added: the todo list could not be saved.' : `Added #${n} ${arg.trim()}` }
    }
    if (verb === 'exec') {
      // `auto` may lead or trail the target: `exec auto 3` or `exec 3 auto`.
      const auto = rest[0] === 'auto' || (rest.length > 1 && rest.at(-1) === 'auto')
      const words = auto ? (rest[0] === 'auto' ? rest.slice(1) : rest.slice(0, -1)) : rest
      const target = words.join(' ')
      const t = auto && target === '' ? nextRunnable(await read($, todos)) : await findTodo($, target)
      if (!t) return { text: auto && target === '' ? NONE_PENDING : `No todo matches "${target}".` }
      if (!RUNNABLE.has(t.status)) return { text: `#${t.n} is ${t.status}.` }
      // A command's own hook can't submit a prompt (it would wait on the turn
      // the command holds), so the exec starts from a timer once it answered.
      $.clock.after(0, () => {
        void (async () => {
          const now = (await read($, todos)).find(x => x.n === t.n)
          if (now) await execTodo($, now, false, auto)
        })()
      })
      return { text: execNote(t, auto) }
    }
    return { text: 'Usage: /todo [show] · /todo noshow · /todo add <title> · /todo exec [auto] <n|title> · /todo exec auto' }
  })

  on('tool.call', { tool: 'mcp__todo__update' as never }, async ($, e) => {
    const a = argsOf(e) as {
      n?: number
      status?: Todo['status']
      prompt?: string
      mode?: Todo['mode']
      summary?: string
      branch?: string
      landed?: string
    }
    const list = await read($, todos)
    const t = list.find(x => x.n === a.n)
    if (!t) return { result: `No todo #${a.n}.`, isError: true as const }
    await patchTodo($, t.n, x => ({
      ...x,
      ...(a.status ? { status: a.status } : {}),
      ...(a.prompt ? { prompt: a.prompt } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.branch ? { branch: a.branch } : {}),
      ...(a.landed ? { landed: a.landed } : {}),
      hasRun: x.hasRun || a.status === 'running',
    }))
    if (a.status === 'done' || a.status === 'failed') $.ui.toast(statusToast(t.n, a.status))
    const now = (await read($, todos)).find(x => x.n === t.n)
    return { result: `#${t.n} ${now?.title ?? t.title}: ${now?.status ?? t.status}` }
  })

  on('tool.call', { tool: 'mcp__todo__list' as never }, async $ => {
    const list = await read($, todos)
    // An MCP-style tool answers text (or content blocks), never a bare object.
    return { result: JSON.stringify(list.map(({ n, title, status, prompt, summary, mode }) => ({ n, title, status, prompt, summary, mode }))) }
  })

  on('tool.call', async ($, e, next) => {
    const tool = e.tool
    if (tool.startsWith('mcp__todo__')) return next(e)
    const a = argsOf(e)

    // Main loop: link the Agent/Workflow call that launches a todo.
    if (e.agentId === undefined) {
      let n: number | undefined
      if (tool === 'Agent') n = num(/\[todo:(\d+)\]/.exec(str(a['description'])))
      if (tool === 'Workflow') {
        n = num(/name\s*:\s*['"`]todo-(\d+)-/.exec(str(a['script'])))
        const from = a['resumeFromRunId']
        if (n === undefined && typeof from === 'string') {
          n = (await read($, todos)).find(t => t.runId === from)?.n
        }
      }
      if (n === undefined) return next(e)
      const id = e.tool_use_id
      await patchTodo($, n, t => ({ ...t, toolUseIds: [...t.toolUseIds, id], hasRun: true }))
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        const r = (ran.result ?? {}) as { agentId?: string; taskId?: string; runId?: string; scriptPath?: string }
        await patchTodo($, n, t =>
          tool === 'Agent'
            ? assign(t, { mode: 'agent', status: 'running', taskId: r.agentId ?? t.taskId, isAgentGone: undefined })
            : assign(t, {
                mode: 'workflow',
                status: 'running',
                taskId: r.taskId ?? t.taskId,
                runId: r.runId ?? t.runId,
                scriptPath: r.scriptPath ?? t.scriptPath,
                isAgentGone: undefined,
              }),
        )
      }
      return ran
    }

    // A todo's agent: record the call and its response.
    const node = (await read($, agents)).find(x => x.agentId === e.agentId)
    if (!node) return next(e)
    const startedAt = await $.clock.now()
    const filePath = a['file_path']
    const call: Call = {
      id: e.tool_use_id,
      agentId: node.agentId,
      tool,
      arg: cut(previewOf(a).replace(/\s+/g, ' '), 120),
      fields: Object.entries(a).map(([k, v]) => ({
        k,
        v: cut(typeof v === 'string' ? v : (json(v, 2) ?? String(v)), FIELD_MAX),
      })),
      ...(typeof filePath === 'string' ? { filePath } : {}),
      state: 'run',
      startedAt,
    }
    await editCalls($, l => {
      const mine = l.filter(c => c.agentId === node.agentId)
      const oldest = mine[0]
      const drop = new Set(mine.length >= CALLS_PER_AGENT && oldest ? [oldest.id] : [])
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
    const { blocks, rest } = splitImages(ran.result)
    const response = cut(responseOf(ran, rest), RESPONSE_MAX)
    const at = await read($, db)
    const images = await imageRefs($, {
      id: call.id,
      tool,
      ...(typeof filePath === 'string' ? { filePath } : {}),
      blocks,
      ...(at ? { folder: at.file.slice(0, at.file.lastIndexOf('/')) } : {}),
    })
    await editCalls($, l => l.map(c => (c.id === call.id ? { ...c, state, ms, response, ...(images.length ? { images } : {}) } : c)))
    return ran
  }).catch((_, e, next) => next(e))

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
    const name = (m?.[2] ?? label).trim()
    const node: AgentNode = {
      agentId: ran.agentId,
      todoN: n,
      ...(e.parentAgentId !== undefined ? { parentAgentId: e.parentAgentId } : {}),
      name: name.replace(/\s*@wt$/, ''),
      ...(m ? { wave: Number(m[1]) } : {}),
      kind: e.workflow ? 'workflow' : 'agent',
      isWorktree: name.endsWith('@wt'),
      status: 'running',
      startedAt: await $.clock.now(),
    }
    await editAgents($, l => {
      const old = l.find(a => a.agentId === node.agentId)
      const next_: AgentNode = old ? { ...old, status: 'running' } : node
      return [...l.filter(a => a.agentId !== node.agentId), next_]
    })
    return ran
  }).catch((_, e, next) => next(e))

  // A todo agent's visible text, one model step at a time, stamped when the
  // step began: its tool calls start after it, so time orders the two.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const node = id === undefined ? undefined : (await read($, agents)).find(a => a.agentId === id)
    if (!node) return yield* next(e)
    const startedAt = await $.clock.now()
    const r = yield* next(e)
    const text = r.answer.trim()
    if (text) {
      try {
        await addTurn($, { kind: 'turn', id: `turn:${e.turnId}:${e.index}`, agentId: node.agentId, text: cut(text, TURN_MAX), startedAt })
      } catch {
        // the step's answer stands whatever the record did
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const node = (await read($, agents)).find(a => a.agentId === id)
      if (node?.status === 'running' && e.isAborted) {
        // Stopped outside the pane (the tasks list, an interrupt): the agent
        // and a lone Agent's todo are stopped, keeping its id for ⏵ Resume.
        await editAgents($, l => l.map((a): AgentNode => (a.agentId === id ? { ...a, status: 'stopped' } : a)))
        await editCalls($, l => l.map((c): Call => (c.agentId === id && c.state === 'run' ? { ...c, state: 'interrupted' } : c)))
        const t = (await read($, todos)).find(x => x.n === node.todoN)
        // An agent stopped this way won't take a message, so ⏵ Resume starts a
        // fresh one on the worktree it kept.
        if (t?.mode === 'agent' && t.taskId === id && t.status === 'running') {
          await patchTodo($, t.n, x => ({ ...x, status: 'stopped', isAgentGone: true }))
        }
      } else if (node?.status === 'running') {
        const failed = 'reason' in e && e.reason === 'refusal'
        await editAgents($, l => l.map((a): AgentNode => (a.agentId === id ? { ...a, status: failed ? 'failed' : 'done' } : a)))
        // A lone background Agent's end is the todo's end; the model's later
        // mcp__todo__update may still replace the summary.
        const t = (await read($, todos)).find(x => x.n === node.todoN)
        if (t?.mode === 'agent' && t.taskId === id && t.status === 'running') {
          await patchTodo($, t.n, x => ({ ...x, status: failed ? 'failed' : 'done', summary: cut(firstLine(e.answer), 80) }))
        }
      }
    }
    return next(e)
  }).catch((_, e, next) => next(e))

  // Any close: noshow's, the person's × or close key, an unload's.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    await setPlaced($, false)
    return r
  }).catch((_, e, next) => next(e))

  on('ui.focus', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && e.component === 'Pane' && e.requestId === PANE) {
      await update($, ring, () => (e.plugin === 'todo' ? (e.element ?? null) : null))
    }
    return r
  }).catch((_, e, next) => next(e))

  // In the tree an arrow moves the ring, as Tab does: once the tree is taller
  // than the pane the engine would scroll instead, and the ring could never
  // reach what's below. A trackpad swipe or the wheel still scrolls, and the
  // engine keeps the ring's element in view. The detail dialog scrolls as ever.
  on('ui.scroll', async ($, e, next) => {
    const isArrow = e.origin.kind === 'person' && e.pointer === undefined && Math.abs(e.by) === 1
    if (!isArrow || e.component !== 'Pane' || e.requestId !== PANE || (await read($, detail))) return next(e)
    const keys = focusOrder()
    const at = keys.indexOf((await read($, ring)) ?? '')
    const to = at === -1 ? keys[e.by > 0 ? 0 : keys.length - 1] : keys[Math.min(keys.length - 1, Math.max(0, at + e.by))]
    if (to !== undefined && to !== keys[at]) await focus($, to)
    return { deny: 'the arrow moved the focus ring' }
  }).catch((_, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Drawn again (the person opened it, the terminal widened): the header
    // takes the counts back, from a timer, since a render never writes state.
    if (!(await read($, placed))) $.clock.after(0, () => void setPlaced($, true).catch(() => undefined))
    const d = await read($, detail)
    if (d) {
      // Escape (or a click elsewhere) takes the keys from the pane: close the
      // dialog then, from a timer, as above.
      if (!e.props.isFocused) $.clock.after(0, () => void leaveDetail($).catch(() => undefined))
      const want: ImageRef[] = []
      const tree = drawDetail($, e, {
        detail: d,
        list: await read($, todos),
        nodes: await read($, agents),
        all: await read($, calls),
        turns: await read($, turns),
        ring: e.props.isFocused ? await read($, ring) : null,
        unfolded: await read($, unfolded),
        earlier: await read($, earlier),
        thumbs: await read($, thumbs),
        want,
      })
      makeThumbs($, want)
      return tree
    }
    const gone = new Set(await read($, expired))
    return drawPane($, e, {
      me: await read($, me),
      fault: await read($, fault),
      // The ring shows only while the pane holds the keys.
      ring: e.props.isFocused ? await read($, ring) : null,
      list: (await read($, todos)).filter(t => !gone.has(t.n)),
      nodes: await read($, agents),
      all: await read($, calls),
      u: await read($, ui),
      cap: await read($, cpuCap),
      f: await read($, spin),
      turns: await read($, turns),
      sessionTitle: await read($, sessionTitle),
    })
  })
}
