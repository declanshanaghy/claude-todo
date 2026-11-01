import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNode, Call, Confirm, Detail, Draft, Drafting, ImageRef, Kept, PaneUi, Queued, Todo, Turn, View } from '../types'
import { CWD, DbError, backups, callsAfter, dropBackups, importTodos, locate, snapshot, writeAgents, writeCall, writeTodos, writeTurn } from './db'
import { drawDetail } from './detail'
import { imageRefs, splitImages, thumbnail } from './images'
import { DEFAULT_VIEW, SUMMARY, statusToast, tallyText } from './marks'
import { type Chip, INFLIGHT, canMove, canResume, isOwnedElsewhere, moveRefusal, offers } from './moves'
import { drawPane, focusOrder, rehome } from './pane'
import { draftsPrompt, execPrompt, restartPrompt, resumePrompt } from './protocol'

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
// confirmation, the view the header toggles. The views are optional, so the
// tag stays: what an earlier version stored (without them) reads as the
// default, or as its `view` from before prompting had a toggle.
const ui = atom(
  { plugin: 'todo', key: 'ui' } as const,
  { expanded: [], confirm: null, renaming: null, justStopped: [], isHidden: false, views: [...DEFAULT_VIEW] },
  { shape: 'ui-2' },
)
const cpuCap = atom({ plugin: 'todo', key: 'cpuCap' } as const, 1)
const spin = atom({ plugin: 'todo', key: 'spin' } as const, 0)
const detail = atom({ plugin: 'todo', key: 'detail' } as const, null as Detail)
// Prompts the host refused because the session was stopped: each goes in
// after the person's next message, with what to restore if it's refused then.
const queued = atom({ plugin: 'todo', key: 'queued' } as const, [] as Queued[])
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
// Each todo's drafting subagent while it works; every drafter this session
// spawned, by agent id, until it ends; each todo's latest drafting key (drafts
// sent under an older one were asked for an old title) and the last key's
// number; and the agent type drafters spawn as.
const drafting = atom({ plugin: 'todo', key: 'drafting' } as const, {} as Record<number, Drafting>)
const drafters = atom({ plugin: 'todo', key: 'drafters' } as const, {} as Record<string, { n: number; key: string }>)
const draftKeys = atom({ plugin: 'todo', key: 'draftKeys' } as const, {} as Record<number, string>)
const draftSeq = atom({ plugin: 'todo', key: 'draftSeq' } as const, 0)
const drafterType = atom({ plugin: 'todo', key: 'drafterType' } as const, 'Explore')

const CALLS_PER_AGENT = 200
const CALLS_TOTAL = 1500
const FIELD_MAX = 3000
const RESPONSE_MAX = 6000
const TURN_MAX = 8000
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'path', 'prompt']
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
//
// Every status move passes the guard: one hooks/transitions.json doesn't
// allow (checked against the list as it stands, re-read or not) keeps the
// old status while the rest of the edit stands, and a todo it may not remove
// stays. Each refusal is said once (warn) and added to `refused`.
async function editTodos($: $, fn: (list: Todo[]) => Todo[], refused: string[] = []) {
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
      const said: string[] = []
      const raw = fn(before)
      const kept = raw.flatMap(t => {
        if (before.includes(t)) return [t]
        const was = before.find(x => x.n === t.n)
        const from = was?.status ?? '[*]'
        if (canMove(from, t.status)) return [t]
        said.push(moveRefusal(t.n, from, t.status))
        return was ? [{ ...t, status: was.status }] : []
      })
      for (const was of before) {
        if (raw.some(x => x.n === was.n) || canMove(was.status, '[*]')) continue
        said.push(moveRefusal(was.n, was.status, '[*]'))
        kept.push(was)
      }
      if (said.length > 0) kept.sort((x, y) => x.n - y.n)
      // A todo this session puts in flight is stamped its owner; one that turns
      // done, the time, which its time in the tree counts from.
      const stamp = (t: Todo): Todo =>
        t.status === 'done'
          ? t.doneAt === undefined ? { ...t, doneAt: now } : t
          : t.doneAt === undefined ? t : assign(t, { doneAt: undefined })
      const after = kept.map(t =>
        before.includes(t) ? t : stamp(INFLIGHT.has(t.status) ? { ...t, owner: self } : t),
      )
      const put = after.filter(t => !before.includes(t))
      const del = before.filter(t => !after.some(x => x.n === t.n)).map(t => t.n)
      let isSaved = put.length === 0 && del.length === 0
      if (!isSaved && (await writeTodos($, at, d, r, put, del))) {
        await update($, warned, () => '')
        await update($, todos, () => after)
        await update($, rev, () => r + 1)
        isSaved = true
      }
      if (isSaved) {
        for (const why of said) await warn($, why)
        refused.push(...said)
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

// Resolves undefined once written, else why not: the list couldn't be saved,
// or the guard kept its status (both already said to the person).
async function patchTodo($: $, n: number, fn: (t: Todo) => Todo) {
  const refused: string[] = []
  const isSaved = await editTodos($, list => list.map(t => (t.n === n ? fn(t) : t)), refused)
  await syncStatus($)
  return isSaved ? refused[0] : 'the todo list could not be saved'
}

// In flight in another live session (see isOwnedElsewhere in moves.ts).
async function isForeign($: $, t: Todo) {
  return isOwnedElsewhere(t, await $.session.id())
}

// A /clear (or /new) goes on under a new session id: session.end leaves the
// old one here, and the next boot takes over the todos it owned, which were
// this conversation's own.
const CLEARED_FROM = 'clearedFrom'

async function adoptCleared($: $, self: string) {
  const old = (await $.store.get(CLEARED_FROM)) as string | undefined
  if (typeof old !== 'string' || old === self) return
  const ok = await editTodos($, l => l.map(t => (t.owner === old ? { ...t, owner: self } : t)))
  if (ok) await $.store.delete(CLEARED_FROM)
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
//
// While it shows, the pane is opened with closeOnEscape, so the Escape that
// takes the keys from the pane raises ui.close (the person's). That hook
// keeps the pane and closes the dialog instead: the render alone never saw
// the keys leave reliably, and a second Escape at the prompt cancelled the
// running turn. Opened by /todo details, the pane takes the keys too: the
// dialog closes as soon as the pane loses them.
export async function openDetail($: $, d: Detail, back?: string, via: Via = 'chip') {
  const at = back ?? (await read($, ring))
  await update($, returnTo, () => at)
  await update($, unfolded, () => [])
  await update($, earlier, () => 0)
  await update($, detail, () => d)
  await syncStatus($)
  await reopen($, via === 'command' ? { focus: true, closeOnEscape: true } : { closeOnEscape: true })
}

// Opens the pane again with its usual options plus `extra`; each open sets
// closeOnEscape anew, so one without it turns it off. A pane that can't be
// seated now keeps the prompt's keys.
async function reopen($: $, extra: { focus?: true; closeOnEscape?: true } = {}) {
  try {
    await $.ui.open({ id: PANE, title: 'Todos', backgroundColor: 'transparent', ...extra })
    return true
  } catch {
    return false
  }
}

// Closes the dialog; `reopened` when the caller opens the pane itself.
async function closeDetail($: $, reopened = false) {
  await update($, detail, () => null)
  await syncStatus($)
  if (!reopened) await reopen($)
}

// Escape (or a click elsewhere) takes the keys from the pane while the dialog
// shows: it closes, and the pane takes the keys back with the ring where it
// was before the dialog opened, rather than leaving them at the prompt.
async function leaveDetail($: $) {
  if (!(await read($, detail))) return
  const back = await read($, returnTo)
  await closeDetail($, true)
  await update($, returnTo, () => null)
  if (!(await reopen($, { focus: true }))) return
  if (back !== null) await focus($, back)
}

// The person's close of the pane (Escape, under closeOnEscape, or the ×):
// while the dialog shows, it closes the dialog instead and keeps the pane.
// Answers whether it did. The pane is opened again from a timer, as a hook
// can't seat it under its own close.
async function escapeDetail($: $) {
  if (!(await read($, detail))) return false
  $.clock.after(0, () => void leaveDetail($).catch(() => undefined))
  return true
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

// A header toggle shows or hides one view's todos. The last one cycles
// default → all → none → default, reading what a press makes it: `all`
// lights every view; pressed while they all are (it reads `none` then), it
// turns every view off; pressed then (it reads `default`), it puts the
// default view back. From any other view it reads `all`. Kept in SUMMARY's
// order, so the stored view reads the same way.
// A view stored before prompting had its own toggle shows prompting todos
// wherever it showed pending ones, as they were pending then.
export const viewIn = (u: PaneUi): readonly View[] =>
  u.views ?? (u.view ? SUMMARY.filter(v => u.view?.includes(v === 'prompting' ? 'pending' : v)) : DEFAULT_VIEW)

export const nextView = (view: readonly View[], v: View | 'all'): View[] => {
  if (v === 'all') return view.length === SUMMARY.length ? [] : [...(view.length === 0 ? DEFAULT_VIEW : SUMMARY)]
  const on = new Set(view)
  if (on.has(v)) on.delete(v)
  else on.add(v)
  return SUMMARY.filter(x => on.has(x))
}

export async function toggleView($: $, v: View | 'all') {
  await patchUi($, u => assign(u, { views: nextView(viewIn(u), v), view: undefined }))
}

// How an action was asked for. A chip's press moves the pane's ring and
// says what it did in a toast; a /todo verb answers in its own text and
// leaves the keys with the prompt.
export type Via = 'chip' | 'command'

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

// Every /todo verb, how it's typed and what it does, one line each. The
// dispatcher's verb words and /todo help both come from this table, so a new
// verb goes here (or `/todo <verb>` would add it as a todo) and the help
// can't drift from the commands that exist. `also` are the verb's other words.
export const VERBS: readonly { verb: string; also?: readonly string[]; use: string; means: string }[] = [
  { verb: 'show', also: ['', 'list'], use: '/todo [show|list]', means: 'open and focus the pane' },
  { verb: 'noshow', use: '/todo noshow', means: 'close the pane until /todo show' },
  { verb: 'add', use: '/todo [add] <title>', means: 'store a todo; add only before a verb word' },
  { verb: 'exec', use: '/todo exec [auto] <n|title>', means: 'run a todo; auto asks nothing' },
  { verb: 'auto', use: '/todo auto [<n|title>]', means: 'exec auto, by default the next pending' },
  { verb: 'resume', use: '/todo resume <n|title>', means: 'pick a paused or stopped todo up' },
  { verb: 'pause', use: '/todo pause <n|title>', means: 'pause a running todo' },
  { verb: 'stop', use: '/todo stop <n|title>', means: 'stop a todo and keep it' },
  { verb: 'refine', use: '/todo refine <n|title>', means: 'pick a new prompt, then restart' },
  { verb: 'restart', use: '/todo restart <n|title>', means: 'run again with the same prompt' },
  { verb: 'reset', use: '/todo reset <n|title>', means: 'put a stuck todo back to pending or stopped' },
  { verb: 'delete', use: '/todo delete <n|title>', means: 'remove a todo that never ran' },
  { verb: 'takeover', use: '/todo takeover <n|title>', means: "take another session's todo over" },
  { verb: 'rename', use: '/todo rename <n> <new title>', means: 'retitle a todo, drafting again' },
  { verb: 'leave', use: '/todo leave <n|title>', means: 'leave a just-stopped todo as it is' },
  { verb: 'details', use: '/todo details <n|title>', means: 'its prompt, runs and agents in the pane' },
  { verb: 'help', also: ['?'], use: '/todo help|?', means: 'this list' },
]

// Every first word `/todo` treats as a verb; any other word starts a title.
export const TODO_VERBS: readonly string[] = VERBS.flatMap(v => [v.verb, ...(v.also ?? [])])

const isHelp = (word: string) => VERBS.some(v => v.verb === 'help' && [v.verb, ...(v.also ?? [])].includes(word.toLowerCase()))

// The pane's keys, after the verbs in /todo help.
const PANE_KEYS = [
  ['ctrl+x tab', 'move the keys into the pane'],
  ['tab/arrows', 'move the focus ring'],
  ['enter', 'press what the ring is on'],
  ['esc', 'hand the keys back to the prompt'],
] as const

// The widest a /todo answer's line gets, as a run's one-line summary does.
const ANSWER_COLUMNS = 80

// /todo help: one line per verb, then one per pane key, each cut to fit.
export const HELP = [
  ...VERBS.map(v => `${v.use.padEnd(30)}${v.means}`),
  ...PANE_KEYS.map(([key, does]) => `${`pane: ${key}`.padEnd(30)}${does}`),
]
  .map(line => cut(line, ANSWER_COLUMNS))
  .join('\n')

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
  queueDrafts($, n)
  return n
}

// ---------- prompt drafts ----------

// How long a todo another session put in prompting may stay there before
// this one counts its drafter gone (that session cleared or quit) and hands it
// back as pending. One this session prompts goes back as soon as its drafter
// isn't tracked here any more.
export const DRAFT_WAIT_MS = 120_000
export const DRAFTS_TAG = (n: number) => `[todo-drafts:${n}] `

// Adding stays instant: the drafting subagent starts from a timer, never
// inside the add (a command's hook can't wait on what it starts).
function queueDrafts($: $, n: number) {
  $.clock.after(0, () => void launchDrafts($, n).catch(() => undefined))
}

// The plugin spawns the drafter itself: a small, read-only agent type it
// registered, in the background. It answers with its drafts and the key it
// was given, as JSON its turn.complete reads; it is never linked as the
// todo's run. Each launch gets a new key, so a rename's stale drafts are told
// apart from the ones the new title asked for. Once it's spawned, a pending
// todo turns prompting (nothing may start it) until its drafts are stored, or
// its drafter ends without them; one that already started is left as it is.
async function launchDrafts($: $, n: number) {
  const t = (await read($, todos)).find(x => x.n === n)
  if (!t) return
  const seq = (await read($, draftSeq)) + 1
  await update($, draftSeq, () => seq)
  const key = `${n}.${seq}`
  const at = await $.clock.now()
  await update($, draftKeys, k => ({ ...k, [n]: key }))
  await update($, drafting, d => ({ ...d, [n]: { key, at } }))
  const others = (await read($, todos)).filter(x => x.n !== n).map(x => `#${x.n} ${x.title} (${x.status})`)
  const description = `${DRAFTS_TAG(n)}Draft prompts for #${n}`
  const args = { prompt: draftsPrompt(t, key, { sessionTitle: await read($, sessionTitle), others }), description, model: 'haiku' }
  let ran: Awaited<ReturnType<$['agent']['spawn']>> | undefined
  for (const subagentType of [...new Set([await read($, drafterType), 'Explore'])]) {
    try {
      ran = await $.agent.spawn({ ...args, subagentType })
    } catch (err) {
      ran = { deny: err instanceof Error ? err.message : String(err) }
    }
    if (ran.deny === undefined) break
  }
  const isMine = async () => (await read($, drafting))[n]?.key === key
  if (ran?.deny !== undefined) {
    if (!(await isMine())) return
    await update($, drafting, d => omit(d, n))
    // A rename's drafter that can't start: the earlier one's prompting ends.
    await unprompt($, n)
    return
  }
  // Its id tells its end apart; an answer without one is found by its tag.
  // Untracked (no id to tell its end by), it can't hold the todo: drafts it
  // stores still land.
  const id = ran?.agentId ?? (await findDrafter($, description))
  if (!id) return
  await update($, drafters, x => ({ ...x, [id]: { n, key } }))
  if (!(await isMine())) return
  await update($, drafting, d => (d[n]?.key === key ? { ...d, [n]: { ...d[n], agentId: id } } : d))
  const self = await read($, me)
  const isHeld = (x: Todo) => x.status === 'pending' || x.status === 'prompting'
  await patchTodo($, n, x => (isHeld(x) ? { ...x, status: 'prompting', owner: self, promptingAt: at } : x))
  // Its drafts (or its end) may have come in while that was written.
  if ((await read($, drafting))[n] === undefined) await unprompt($, n)
}

// A prompting todo goes back to pending: its drafts are stored, or its
// drafter ended (or never started) without them, so ▶ Exec drafts in the chat.
const toPending = (t: Todo) => assign(t, { status: 'pending', owner: undefined, promptingAt: undefined })

async function unprompt($: $, n: number) {
  if ((await read($, todos)).find(x => x.n === n)?.status !== 'prompting') return
  await patchTodo($, n, x => (x.status === 'prompting' ? toPending(x) : x))
}

// A todo left prompting with no drafter to finish it goes back to pending at
// the next sync: one this session prompts once its drafter isn't tracked here
// (it ended unseen, or the session's state was reset by a /clear or a
// restart), another session's once DRAFT_WAIT_MS have passed.
async function settlePrompting($: $) {
  const list = await read($, todos)
  if (!list.some(t => t.status === 'prompting')) return
  const self = await read($, me)
  const live = await read($, drafting)
  const now = await $.clock.now()
  const isStuck = (t: Todo) =>
    t.status === 'prompting' && (t.owner === self ? live[t.n] === undefined : now - (t.promptingAt ?? 0) >= DRAFT_WAIT_MS)
  const stuck = new Set(list.filter(isStuck).map(t => t.n))
  if (stuck.size === 0) return
  await editTodos($, l => l.map(t => (stuck.has(t.n) && t.status === 'prompting' ? toPending(t) : t)))
  await syncStatus($)
}

async function findDrafter($: $, description: string) {
  try {
    const known = await read($, drafters)
    return (await $.agent.list()).filter(a => a.description === description && !known[a.id]).at(-1)?.id
  } catch {
    return undefined
  }
}

function omit<V>(o: Record<number, V>, n: number): Record<number, V> {
  const { [n]: _, ...rest } = o
  return rest
}

// Drafts a drafter stored, which take a prompting todo to pending. Ones whose
// key an earlier launch had (the todo was renamed since) are refused; a todo
// that already started keeps them and nothing is interrupted.
async function storeDrafts($: $, a: { n?: unknown; key?: unknown; drafts?: unknown }) {
  const t = (await read($, todos)).find(x => x.n === a.n)
  if (!t) return { result: `No todo #${String(a.n)}.`, isError: true as const }
  const key = str(a.key)
  if (key && key !== (await read($, draftKeys))[t.n]) return { result: `#${t.n} was renamed since; these drafts are stale and were not stored.` }
  const raw = Array.isArray(a.drafts) ? (a.drafts as unknown[]) : []
  const drafts: Draft[] = raw
    .map(d => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}))
    .map(d => ({ label: str(d['label']).trim(), prompt: str(d['prompt']).trim() }))
    .filter(d => d.label && d.prompt)
    .slice(0, 3)
  if (drafts.length === 0) return { result: 'No drafts given: each needs a label and a prompt.', isError: true as const }
  await update($, drafting, d => omit(d, t.n))
  await patchTodo($, t.n, x => (x.status === 'prompting' ? toPending({ ...x, drafts }) : { ...x, drafts }))
  return { result: `Stored ${drafts.length} drafts for #${t.n}.` }
}

// A drafter's turn ended: if it stored nothing, its todo isn't prompting any
// more, and ▶ Exec drafts in the chat.
// The drafts in a drafter's answer: the JSON object it was asked for, found
// from its first { to its last }, so a fence or a stray line around it is
// fine. Undefined when there's none.
export function draftsIn(answer: string): unknown[] | undefined {
  const from = answer.indexOf('{')
  const to = answer.lastIndexOf('}')
  if (from === -1 || to <= from) return undefined
  try {
    const v = JSON.parse(answer.slice(from, to + 1)) as { drafts?: unknown }
    return Array.isArray(v.drafts) ? v.drafts : undefined
  } catch {
    return undefined
  }
}

async function drafterEnded($: $, id: string, failed: boolean, answer = '') {
  const who = (await read($, drafters))[id]
  if (!who) return
  // Its drafts come back as its answer: a tool call from a background
  // drafter's loop never reached the mod's tool.call hook.
  const sent = failed ? undefined : draftsIn(answer)
  if (sent) await storeDrafts($, { n: who.n, key: who.key, drafts: sent })
  await update($, drafters, d => Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)))
  if ((await read($, drafting))[who.n]?.key !== who.key) return
  await update($, drafting, d => omit(d, who.n))
  if ((await read($, todos)).find(x => x.n === who.n)?.status === 'prompting') {
    $.ui.toast(`#${who.n}: ${failed ? 'its drafter failed' : 'no prompt drafts'}; ▶ Exec drafts in the chat`)
  }
  await unprompt($, who.n)
}

async function clearRun($: $, n: number) {
  // Deleting an agent's row deletes its calls' rows with it.
  const gone = new Set((await read($, agents)).filter(a => a.todoN === n).map(a => a.agentId))
  await editAgents($, l => l.filter(a => a.todoN !== n))
  await update($, calls, l => l.filter(c => !gone.has(c.agentId)))
  await update($, turns, l => l.filter(x => !gone.has(x.agentId)))
}

// ---------- actions (pane buttons and /todo) ----------

// What submit answers for a prompt held until the person's next message.
const QUEUED = 'queued'

// The host refuses a plugin's prompt after a Stop until the person sends
// input of their own: that refusal is a wait, not a failure.
const isStopStanding = (why: string) => /nobody has sent input|stop stands/i.test(why)

// A plugin's prompt can be dropped. One refused only because the session was
// stopped is held, the todo staying in hand, and goes in after the person's
// next message (flushQueued). Any other drop (a hook's refusal, a limit) puts
// the todo back to how `t` had it, and says why.
async function submit($: $, t: Todo, text: string) {
  const r = await $.prompt.submit({ text })
  if (r.drop === undefined) return undefined
  if (isStopStanding(r.drop)) {
    const entry = { n: t.n, text, status: t.status, ...(t.taskId !== undefined ? { taskId: t.taskId } : {}), ...(t.runId !== undefined ? { runId: t.runId } : {}) }
    await update($, queued, l => [...l.filter(q => q.n !== t.n), entry])
    $.ui.toast(`#${t.n} queued: it starts after your next message`)
    return QUEUED
  }
  await patchTodo($, t.n, x => assign(x, { status: t.status, taskId: t.taskId, runId: t.runId, prompt: t.prompt, isAuto: t.isAuto }))
  $.ui.toast(`#${t.n} didn't start: ${r.drop}`)
  return r.drop
}

// Sends the prompts a Stop held, once the person has sent input. One whose
// todo left the chat's hands meanwhile (Reset, another session) is dropped.
async function flushQueued($: $) {
  const waiting = await read($, queued)
  if (waiting.length === 0) return
  await update($, queued, () => [])
  for (const q of waiting) {
    const t = (await read($, todos)).find(x => x.n === q.n)
    if (t?.status !== 'drafting') continue
    // A refusal now reverts to what the todo was before it was queued.
    await submit($, assign(t, { status: q.status, taskId: q.taskId, runId: q.runId }), q.text)
  }
}

const RUNNABLE = new Set<Todo['status']>(['pending', 'stopped', 'failed'])

// What ▶ Exec can start: a todo at rest, or one paused before it ever ran
// (paused for a new session, say), which has no run to resume.
const isRunnable = (t: Todo) => RUNNABLE.has(t.status) || (t.status === 'paused' && !t.hasRun)

// Why /todo resume can't take `t`, and the command that does apply.
function resumeRefusal(t: Todo) {
  const at = `#${t.n} is ${t.status}`
  switch (t.status) {
    case 'pending':
      return `${at}: /todo exec ${t.n}`
    case 'stopped':
    case 'failed':
      return `${at} with nothing to resume: /todo exec ${t.n}`
    case 'done':
      return `${at}: nothing to resume.`
    case 'prompting':
      return stillPrompting(t.n)
    default:
      return `${at}: already in flight; pause or stop it in the pane (/todo show).`
  }
}

// ---------- a /todo verb for every chip ----------

export const USAGE = `Usage: ${VERBS.map(v => v.use).join(' · ')}`

// The chips with a /todo verb of their own name beyond exec, auto and resume,
// which have theirs above. Each acts through the function its chip calls,
// once offers() (moves.ts) says the todo's row offers that chip.
const CHIP_VERBS: readonly Chip[] = ['pause', 'stop', 'refine', 'restart', 'reset', 'delete', 'takeover', 'rename', 'leave', 'details']
const isChipVerb = (v: string): v is Chip => (CHIP_VERBS as readonly string[]).includes(v)

// Why `verb` can't take `t`: the chip isn't on its row now. `on` is what the
// row does offer, so the answer names the commands that apply.
function chipRefusal(t: Todo, verb: Chip, on: readonly Chip[]) {
  const at = `#${t.n} is ${t.status}`
  if (on.includes('takeover')) return `${at} in another session.`
  if (verb === 'takeover') return `${at}, not in flight in another session: nothing to take over.`
  if (verb === 'delete' && on.includes('rename')) return `#${t.n} has run: only a todo that never ran can be deleted.`
  if (verb === 'leave' && on.includes('refine')) return `#${t.n} wasn't just stopped: nothing to leave.`
  return `${at}, so /todo ${verb} doesn't apply; it takes ${on.map(v => `/todo ${v} ${t.n}`).join(' · ')}.`
}

// One of CHIP_VERBS typed: `words` are the todo (and, for rename, its number
// then the new title). A command is already an explicit request, so the
// verbs whose chips ask first (Stop, Delete, Takeover) act at once.
async function chipCommand($: $, verb: Chip, words: readonly string[]) {
  const isRename = verb === 'rename'
  const usage = `Usage: /todo ${verb} ${isRename ? '<n> <new title>' : '<n|title>'}`
  const target = isRename ? (words[0] ?? '') : words.join(' ')
  const title = words.slice(1).join(' ').trim()
  if (target === '' || (isRename && (!/^#?\d+$/.test(target) || title === ''))) return usage
  const t = await findTodo($, target)
  if (!t) return `No todo matches "${target}".`
  const on = offers(t, await $.session.id(), (await read($, ui)).justStopped)
  if (!on.includes(verb)) return chipRefusal(t, verb, on)
  // A confirmation the pane was asking for this todo is answered by the command.
  await patchUi($, u => (u.confirm?.n === t.n ? { ...u, confirm: null } : u))
  // Refine and Restart submit a prompt, which a command's own hook can't (it
  // would wait on the turn the command holds): they start from a timer once
  // it answered, if the todo still offers them then.
  const later = (go: (now: Todo) => Promise<unknown>) => {
    $.clock.after(0, () => {
      void (async () => {
        const now = (await read($, todos)).find(x => x.n === t.n)
        if (now && offers(now, await $.session.id(), (await read($, ui)).justStopped).includes(verb)) await go(now)
      })()
    })
  }
  switch (verb) {
    case 'pause':
      return haltTodo($, t, 'paused', 'command')
    case 'stop':
      return haltTodo($, t, 'stopped', 'command')
    case 'refine':
      later(now => execTodo($, now, true))
      return `Refining #${t.n} ${t.title}: answer the prompt question in the chat.`
    case 'restart':
      later(now => restartTodo($, now))
      return `Restarting #${t.n} ${t.title} from scratch with its current prompt.`
    case 'reset':
      return resetTodo($, t)
    case 'delete':
      return deleteTodo($, t, 'command')
    case 'takeover':
      return takeOver($, t, 'command')
    case 'rename':
      return renameTodo($, t.n, title, 'command')
    case 'leave':
      return leaveTodo($, t.n)
    default:
      // details: the dialog in the pane, which takes the keys while it shows.
      await patchUi($, u => ({ ...u, isHidden: false }))
      await openDetail($, { kind: 'todo', n: t.n }, undefined, 'command')
      return `☰ #${t.n} ${t.title}: its details are in the pane; Esc goes back.`
  }
}

// The todo `/todo exec auto` runs when it names none: the next by priority,
// which for now is the lowest-numbered pending one.
export const nextRunnable = (list: readonly Todo[]) =>
  list.filter(t => t.status === 'pending').sort((a, b) => a.n - b.n)[0]

export const NONE_PENDING = 'No pending todo to run.'

// What an exec of a prompting todo answers: nothing may start it yet.
export const stillPrompting = (n: number) => `#${n}'s prompts are still being drafted: it can start once they're ready.`

// What `/todo exec auto` and 🔥 Fire say when nothing is pending: that, or,
// while some todo is still prompting, that its prompts are on their way.
export const noneRunnable = (list: readonly Todo[]) => {
  const next = list.filter(t => t.status === 'prompting').sort((a, b) => a.n - b.n)[0]
  return next ? `${NONE_PENDING} ${stillPrompting(next.n)}` : NONE_PENDING
}

// Why 🔥 Fire can't launch the next todo right now, or null when it can:
// nothing is pending (a prompting todo is skipped), or this directory's live
// agents already fill the cap.
export function fireBlock(list: readonly Todo[], nodes: readonly AgentNode[], cap: number): string | null {
  if (!nextRunnable(list)) return noneRunnable(list)
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
    const said = why ?? noneRunnable(list)
    $.ui.toast(said)
    return said
  }
  return execTodo($, t, false, true)
}

const execNote = (t: Todo, auto: boolean) =>
  auto
    ? `Auto-executing #${t.n} ${t.title}: Claude ${t.drafts?.length ? 'takes the best drafted prompt' : 'drafts the prompt'} and launches it, no questions asked.`
    : `Executing #${t.n} ${t.title}: answer the prompt question in the chat.`

// Why `t` can't be executed now, or undefined when it can. A prompting todo
// waits for its drafter, whatever asked (▶ Exec, ⚡ Auto, 🔥 Fire, /todo exec).
const execBlock = (t: Todo, refine: boolean) =>
  t.status === 'prompting' ? stillPrompting(t.n) : !refine && !isRunnable(t) ? `#${t.n} is ${t.status}.` : undefined

// `auto` skips every question: Claude picks the prompt and, for multi-step
// work, plans on defaults and runs it without plan-mode approval.
export async function execTodo($: $, t: Todo, refine: boolean, auto = false) {
  const why = execBlock(t, refine)
  if (why !== undefined) {
    $.ui.toast(why)
    return why
  }
  // A move the guard refuses (the todo moved on meanwhile) starts nothing.
  // Auto with drafts runs the first as it is: it's the prompt from the start,
  // so the row shows it before Claude's update comes back.
  const best = auto && !refine ? t.drafts?.[0]?.prompt : undefined
  const held = await patchTodo($, t.n, x => ({ ...x, status: 'drafting', isAuto: auto, ...(best !== undefined ? { prompt: best } : {}) }))
  if (held !== undefined) return held
  if (refine) await clearRun($, t.n)
  await patchUi($, u => ({
    ...u,
    expanded: u.expanded.includes(`t${t.n}`) ? u.expanded : [...u.expanded, `t${t.n}`],
    justStopped: u.justStopped.filter(x => x !== t.n),
  }))
  const drop = await submit($, t, execPrompt(t, await read($, cpuCap), refine, auto))
  if (drop === QUEUED) return `Queued #${t.n} ${t.title}: it starts after your next message.`
  if (drop !== undefined) return `#${t.n} didn't start: ${drop}`
  return execNote(t, auto)
}

export async function restartTodo($: $, t: Todo) {
  if (!canMove(t.status, 'drafting')) {
    $.ui.toast(moveRefusal(t.n, t.status, 'drafting'))
    return
  }
  await clearRun($, t.n)
  if ((await patchTodo($, t.n, x => assign(x, { status: 'drafting', taskId: undefined, runId: undefined }))) !== undefined) return
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

// Resolves what it did, or why it didn't.
export async function haltTodo($: $, t: Todo, to: 'paused' | 'stopped', via: Via = 'chip') {
  const say = (text: string) => {
    if (via === 'chip') $.ui.toast(text)
    return text
  }
  if (await isForeign($, t)) return say(`#${t.n} is ${t.status} in another session.`)
  if (!canMove(t.status, to)) return say(moveRefusal(t.n, t.status, to))
  if (t.taskId) {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: t.taskId })
    if (r.deny !== undefined) $.ui.toast(`TaskStop refused: ${r.deny}`)
  }
  await settleAgents($, t.n, to)
  const held = await patchTodo($, t.n, x => ({ ...x, status: to }))
  if (held !== undefined) return held
  if (to === 'stopped') {
    await patchUi($, u => ({ ...u, confirm: null, justStopped: [...u.justStopped.filter(x => x !== t.n), t.n] }))
    if (via === 'chip') await focus($, `act:${t.n}:refine`)
  } else if (via === 'chip') {
    await focus($, `act:${t.n}:resume`)
  }
  return say(to === 'paused' ? `⏸ #${t.n} paused` : `■ #${t.n} stopped`)
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
export async function resumeTodo($: $, t: Todo, via: Via = 'chip') {
  if (await isForeign($, t)) {
    $.ui.toast(`#${t.n} is ${t.status} in another session.`)
    return
  }
  if (!canMove(t.status, 'drafting')) {
    $.ui.toast(moveRefusal(t.n, t.status, 'drafting'))
    return
  }
  // Paused before it ever ran: there's no run to pick up, so it starts as
  // ▶ Exec would.
  if (t.status === 'paused' && !t.hasRun) {
    await execTodo($, t, false)
    return
  }
  // A resumed Workflow replays finished agents from its journal and spawns the
  // rest afresh, so the interrupted nodes are left marked as such.
  if (t.mode === 'workflow') {
    await editAgents($, l => l.map((a): AgentNode => (a.todoN === t.n && a.status === 'paused' ? { ...a, status: 'stopped' } : a)))
  }
  await patchUi($, u => ({ ...u, justStopped: u.justStopped.filter(x => x !== t.n) }))
  // In the chat's hands until it reports: no second ⏵ Resume meanwhile.
  if ((await patchTodo($, t.n, x => ({ ...x, status: 'drafting' }))) !== undefined) return
  const ctx = { kept: await keptWork($, t), digest: await digestOf($, t), canWake: t.isAgentGone !== true && t.taskId !== undefined }
  if ((await submit($, t, resumePrompt(t, ctx))) !== undefined) return
  if (via === 'chip') await focus($, `todo:${t.n}`)
  $.ui.toast(`▶ resuming #${t.n}`)
}

// Claims a todo another session put in flight. Its task there isn't stopped
// (its ids are that session's): the todo is marked stopped here, to restart.
// Resolves what it did, or why it didn't.
export async function takeOver($: $, t: Todo, via: Via = 'chip') {
  const say = (text: string) => {
    if (via === 'chip') $.ui.toast(text)
    return text
  }
  if (!canMove(t.status, 'stopped')) return say(moveRefusal(t.n, t.status, 'stopped'))
  await settleAgents($, t.n, 'stopped')
  // Its agent and run were the other session's: ⏵ Resume here starts a fresh
  // agent on the worktree it kept.
  const held = await patchTodo($, t.n, x => assign(x, { status: 'stopped', taskId: undefined, runId: undefined, owner: undefined, isAgentGone: true }))
  if (held !== undefined) return held
  await patchUi($, u => ({ ...u, confirm: null, justStopped: [...u.justStopped.filter(x => x !== t.n), t.n] }))
  if (via === 'chip') await focus($, `act:${t.n}:refine`)
  return say(`#${t.n} taken over: stopped here; its run in the other session isn't stopped`)
}

// Resolves what it did, or why it didn't.
export async function deleteTodo($: $, t: Todo, via: Via = 'chip') {
  const say = (text: string) => {
    if (via === 'chip') $.ui.toast(text)
    return text
  }
  const refused: string[] = []
  const isSaved = await editTodos($, l => l.filter(x => x.n !== t.n), refused)
  await patchUi($, u => ({ ...u, confirm: null }))
  await syncStatus($)
  if (!isSaved || refused.length > 0) return refused[0] ?? 'the todo list could not be saved'
  if (via === 'chip') await focus($, 'add')
  return say(`✕ #${t.n} deleted`)
}

// Resolves what it did.
export async function renameTodo($: $, n: number, title: string, via: Via = 'chip') {
  const clean = title.trim()
  const was = (await read($, todos)).find(t => t.n === n)
  // A new title makes its drafts stale: they go, and it is drafted again.
  const isNew = clean !== '' && was !== undefined && clean !== was.title
  if (isNew) {
    await patchTodo($, n, t => assign(t, { title: clean, drafts: undefined }))
    queueDrafts($, n)
  }
  await patchUi($, u => ({ ...u, renaming: null }))
  if (via === 'chip') await focus($, `todo:${n}`)
  return isNew ? `✎ #${n} renamed ${clean}: its prompts are drafted again` : `#${n} is already called that.`
}

// ✓ Leave: a todo just stopped folds away, and leaves the view if it hides it.
export async function leaveTodo($: $, n: number) {
  await patchUi($, x => ({
    ...x,
    justStopped: x.justStopped.filter(m => m !== n),
    expanded: collapse(x.expanded, `t${n}`),
  }))
  return `✓ #${n} left`
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

// ↺ Reset: a todo in the chat's hands goes back to pending, or to stopped
// once it has run. A prompt a Stop held goes too. Resolves what it did, or
// why it didn't.
export async function resetTodo($: $, t: Todo) {
  const status = t.hasRun ? 'stopped' : 'pending'
  await update($, queued, l => l.filter(q => q.n !== t.n))
  return (await patchTodo($, t.n, x => ({ ...x, status }))) ?? `↺ #${t.n} reset to ${status}`
}

async function findTodo($: $, arg: string) {
  // Every title holds the empty string: no target names no todo.
  if (arg.trim() === '') return undefined
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

// Everything the session's state holds that the mod sets up itself. A
// /clear goes on under a new session id with that state reset and no
// session.start, so it runs again at classic.SessionStart's `clear`, and
// sync runs it whenever the database handle is missing. One runs at a time.
type Options = Parameters<Register>[1]
let booting: Promise<void> | undefined
async function boot($: $, options: Options) {
  booting ??= setUp($, options).finally(() => (booting = undefined))
  return booting
}

async function setUp($: $, options: Options) {
  // The drafter: small, cheap and read-only, run in the background and
  // hidden from the model's own agent listing. Without it (an engine that
  // refuses the type) drafters spawn as the read-only Explore.
  try {
    const { agent } = await $.agent.register({
      name: 'drafter',
      description: "Drafts candidate prompts for a todo-pane todo; spawned by the todo plugin only.",
      prompt:
        'You draft candidate prompts for a todo in a todo list. You only read: never edit or write files, and never change git state. Follow the task you are given and answer with your drafts as the JSON it asks for.',
      tools: ['Read', 'Grep', 'Glob'],
      model: 'haiku',
      effort: 'low',
      maxTurns: 12,
      background: true,
    })
    await update($, drafterType, () => agent)
  } catch {
    await update($, drafterType, () => 'Explore')
  }
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
      await adoptCleared($, self)
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
}

// The answer of one of the mod's own tools whose hook failed.
const toolFailed = (_: unknown, e: { tool: string }, next: { error: { kind: string; message?: string } }) => ({
  result: `${e.tool} failed (${next.error.kind}): ${next.error.message ?? 'no message'}`,
  isError: true as const,
})

export const register: Register = (on, options) => {
  // A drafter's prompt names the session, so its title follows each change:
  // set at start (a resume brings its old one), and on every prompt, where a
  // rename or a hook's sessionTitle shows up.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') await boot($, options)
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
      description:
        'Per-directory todos: /todo [add] <title> · /todo exec [auto] <n|title> · /todo auto [<n|title>] · /todo resume|pause|stop|refine|restart|reset|delete|takeover|leave|details <n|title> · /todo rename <n> <new title> · /todo show · /todo noshow · /todo help',
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
      name: 'drafts',
      description:
        "Store a todo-pane todo's candidate prompts, best first (3). Called by the todo plugin's drafting subagent only.",
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'Todo number' },
          key: { type: 'string', description: 'The key your task gave you, as given' },
          drafts: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'A short name, at most 5 words' },
                prompt: { type: 'string', description: 'The full, self-contained prompt' },
              },
              required: ['label', 'prompt'],
            },
          },
        },
        required: ['n', 'drafts'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list',
      description: "List this repo's todos, or the home directory's outside a repo (number, title, status, prompt, summary).",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    await boot($, options)
    $.clock.every(EXPIRE_MS, () => void expire($).catch(() => undefined))
    // A tick that fails (the module reloading under it) is tried again next tick.
    $.clock.every(SYNC_MS, () => {
      void (async () => {
        if (!(await read($, db)) && !(await read($, fault))) await boot($, options)
        else await sync($)
        await settlePrompting($)
      })().catch(() => undefined)
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
    const [said = '', ...words] = e.args.trim().split(/\s+/)
    // A first word that is no verb makes the whole args a title: `/todo Fix
    // kitty` is `/todo add Fix kitty`. A title that starts with a verb word
    // still needs the `add`.
    // Help in any case (`/todo Help`, `/todo ?`) is help, never a todo titled
    // after it: whoever typed it was asking how, not adding.
    if (isHelp(said)) return { text: HELP }
    const isBare = !TODO_VERBS.includes(said)
    // `/todo auto …` is short for `/todo exec auto …`.
    const verb = isBare ? 'add' : said === 'auto' ? 'exec' : said
    const rest = isBare ? [said, ...words] : said === 'auto' ? ['auto', ...words] : words
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
      const target = (auto ? (rest[0] === 'auto' ? rest.slice(1) : rest.slice(0, -1)) : rest).join(' ')
      if (!auto && target === '') return { text: 'Usage: /todo exec [auto] <n|title>' }
      const t = auto && target === '' ? nextRunnable(await read($, todos)) : await findTodo($, target)
      if (!t) return { text: auto && target === '' ? noneRunnable(await read($, todos)) : `No todo matches "${target}".` }
      const why = execBlock(t, false)
      if (why !== undefined) return { text: why }
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
    if (verb === 'resume') {
      // What the pane's ⏵ Resume does, for the todos it is offered on.
      if (arg === '') return { text: 'Usage: /todo resume <n|title>' }
      const t = await findTodo($, arg)
      if (!t) return { text: `No todo matches "${arg}".` }
      if (await isForeign($, t)) return { text: `#${t.n} is ${t.status} in another session.` }
      if (!canResume(t)) return { text: resumeRefusal(t) }
      // Submitted from a timer, as an exec is.
      $.clock.after(0, () => {
        void (async () => {
          const now = (await read($, todos)).find(x => x.n === t.n)
          if (now && canResume(now)) await resumeTodo($, now)
        })()
      })
      if (!t.hasRun && t.status === 'paused') return { text: execNote(t, false) }
      return { text: `Resuming #${t.n} ${t.title}: Claude picks its work up in the chat.` }
    }
    if (isChipVerb(verb)) return { text: await chipCommand($, verb, rest) }
    return { text: USAGE }
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
    // A status move hooks/transitions.json doesn't allow is refused whole,
    // naming the moves that are, so Claude can send what applies.
    if (a.status && !canMove(t.status, a.status)) {
      return { result: `${moveRefusal(t.n, t.status, a.status)} Nothing was written.`, isError: true as const }
    }
    const held = await patchTodo($, t.n, x => ({
      ...x,
      ...(a.status ? { status: a.status } : {}),
      ...(a.prompt ? { prompt: a.prompt } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.branch ? { branch: a.branch } : {}),
      ...(a.landed ? { landed: a.landed } : {}),
      hasRun: x.hasRun || a.status === 'running',
    }))
    // Moved meanwhile (another session's write) to where the move isn't allowed.
    if (held !== undefined) return { result: held, isError: true as const }
    if (a.status === 'done' || a.status === 'failed') $.ui.toast(statusToast(t.n, a.status))
    const now = (await read($, todos)).find(x => x.n === t.n)
    return { result: `#${t.n} ${now?.title ?? t.title}: ${now?.status ?? t.status}` }
  }).catch(toolFailed)

  // A hook that throws is skipped, and the caller only hears that nothing
  // answered: the mod's own tools say what failed instead.
  on('tool.call', { tool: 'mcp__todo__drafts' as never }, async ($, e) => storeDrafts($, argsOf(e))).catch(toolFailed)

  // The drafter is the plugin's to spawn, never the model's to pick.
  on('agent.offer', async ($, e, next) => (e.agent === (await read($, drafterType)) && e.agent !== 'Explore' ? { isOffered: false } : next(e))).catch(
    (_, e, next) => next(e),
  )

  on('tool.call', { tool: 'mcp__todo__list' as never }, async $ => {
    const list = await read($, todos)
    // An MCP-style tool answers text (or content blocks), never a bare object.
    return { result: JSON.stringify(list.map(({ n, title, status, prompt, summary, mode }) => ({ n, title, status, prompt, summary, mode }))) }
  }).catch(toolFailed)

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
    // A drafting subagent is never a todo's run.
    if (/^\[todo-drafts:\d+\]/.test(e.description)) return ran
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
    if (id !== undefined && (await read($, drafters))[id]) {
      await drafterEnded($, id, e.isAborted || ('reason' in e && e.reason === 'refusal'), e.answer)
    } else if (id !== undefined) {
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
        // A lone background Agent's end isn't yet the todo's: whether its work
        // landed is Claude's to report (protocol step 6), so the todo stays
        // running until it does, with the answer's first line as a summary
        // that report may replace. A refusal can't have landed anything: its
        // todo fails at once.
        const t = (await read($, todos)).find(x => x.n === node.todoN)
        if (t?.mode === 'agent' && t.taskId === id && t.status === 'running') {
          const summary = cut(firstLine(e.answer), ANSWER_COLUMNS)
          await patchTodo($, t.n, x => (failed ? { ...x, status: 'failed', summary } : { ...x, summary }))
        }
      }
    }
    return next(e)
  }).catch((_, e, next) => next(e))

  // Any close: noshow's, the person's × or close key, an unload's.
  // The person's Escape (or ×) while the dialog shows closes the dialog,
  // not the pane, and the pane keeps the keys (see openDetail).
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && (await escapeDetail($))) return { value: undefined }
    const r = await next(e)
    await setPlaced($, false)
    return r
  }).catch((_, e, next) => next(e))

  // A /clear: note the ending id, so the next boot adopts its todos.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await $.store.set(CLEARED_FROM, e.sessionId)
    return next(e)
  }).catch((_, e, next) => next(e))

  // The person's own prompt lifts a standing Stop: send what it held, from a
  // timer, since a prompt submitted from inside this hook would wait on it.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isPerson && r.drop === undefined && (await read($, queued)).length > 0) {
      $.clock.after(0, () => void flushQueued($).catch(() => undefined))
    }
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
    // The ring shows only while the pane holds the keys.
    const at = e.props.isFocused ? await read($, ring) : null
    const u = await read($, ui)
    const tree = drawPane($, e, {
      queued: (await read($, queued)).map(q => q.n),
      me: await read($, me),
      fault: await read($, fault),
      ring: at,
      list: (await read($, todos)).filter(t => !gone.has(t.n)),
      nodes: await read($, agents),
      all: await read($, calls),
      u,
      cap: await read($, cpuCap),
      f: await read($, spin),
      turns: await read($, turns),
    })
    // The chip the ring was on is gone (it can't act now): move the ring to
    // its todo's header, or to the view toggle when the none view hid its
    // todo, from a timer, since a render never writes state. Once per
    // vanished key, so a refused move can't loop.
    const to = rehome(at, focusOrder(), viewIn(u).length === 0)
    if (to === undefined) rehomed = null
    else if (at !== rehomed) {
      rehomed = at
      $.clock.after(0, () => void rehomeRing($, at, to).catch(() => undefined))
    }
    return tree
  })
}

// The vanished key last handed on, so each is moved once.
let rehomed: string | null = null

async function rehomeRing($: $, from: string | null, to: string) {
  // Something else moved the ring meanwhile (a confirmation, a press): theirs stands.
  if ((await read($, ring)) !== from || focusOrder().includes(from ?? '')) return
  await focus($, to)
}
