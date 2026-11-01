import type { EngineInterface } from 'claude-code'

import type { AgentNode, Call, Todo, Turn } from '../types'

// The backlog's one home: a SQLite file shared by every session and every copy
// of the mod, driven through the sqlite3 CLI. A run is one process, so no
// transaction spans the mod's own logic: a todo write names the directory's
// `rev` it was computed from, and a guard row aborts it when another session
// moved the list in between (the caller re-reads and tries again).
//
// Each script opens with `-- op <json>`, the request it carries: the tests'
// engine answers from that line, as it can't run a process.

type $ = EngineInterface

export type Op =
  | { kind: 'read'; dir: string; keep: number }
  | { kind: 'calls'; dir: string; after: number; limit: number }
  | { kind: 'todos'; dir: string; rev: number; put: Todo[]; del: number[] }
  | { kind: 'agents'; dir: string; session: string; put: AgentNode[]; del: string[] }
  | { kind: 'call'; dir: string; session: string; put: Call }
  // An agent's turn text shares the calls table (and so its paging, window and
  // cascade), its body marked `kind: 'turn'`.
  | { kind: 'turn'; dir: string; session: string; put: Turn }
  | { kind: 'import'; dir: string; rev: number; id: string; at: number; backup: Todo[]; put: Todo[] }
  | { kind: 'backups' }
  | { kind: 'drop'; ids: string[] }

export type Snapshot = { rev: number; todos: Todo[]; agents: AgentNode[]; floor: number; top: number }
export type Page = { rows: ((Call | Turn) & { seq: number })[]; last: number | null }
export type Backup = { id: string; dir: string; at: number }

export class DbError extends Error {}

const SCHEMA = `.bail on
.timeout 5000
.output /dev/null
PRAGMA journal_mode = WAL;
.output stdout
CREATE TABLE IF NOT EXISTS dirs (dir TEXT PRIMARY KEY, rev INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS todos (dir TEXT NOT NULL, n INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (dir, n));
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, dir TEXT NOT NULL, todo_n INTEGER NOT NULL, session TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, dir TEXT NOT NULL, agent_id TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS calls_dir_seq ON calls (dir, seq);
CREATE INDEX IF NOT EXISTS calls_agent ON calls (agent_id);
CREATE TABLE IF NOT EXISTS migrated (id TEXT PRIMARY KEY, dir TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, dir TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TEMP TABLE guard (ok INTEGER CHECK (ok));
`

const q = (s: string) => `'${s.replace(/'/g, "''")}'`
// Its input reaches SQL text, and a todo's number can arrive from a model's
// tool call: anything that isn't a number writes 0.
const int = (n: unknown) => String(Math.trunc(Number(n)) || 0)
const body = (v: unknown) => q(JSON.stringify(v))
const list = (xs: string[]) => `(${xs.join(', ')})`

// Bumps the directory's rev only from the one it was read at; a miss writes 0
// to the guard, whose CHECK ends the run before COMMIT.
const bump = (dir: string, rev: number) => `INSERT OR IGNORE INTO dirs VALUES (${q(dir)}, 0);
UPDATE dirs SET rev = rev + 1 WHERE dir = ${q(dir)} AND rev = ${int(rev)};
INSERT INTO guard VALUES (changes());
`

const putTodos = (dir: string, put: Todo[], verb: string) =>
  put.map(t => `${verb} INTO todos VALUES (${q(dir)}, ${int(t.n)}, ${body(t)});\n`).join('')

export function sql(op: Op): string {
  switch (op.kind) {
    case 'read': {
      const d = q(op.dir)
      return `SELECT json_object(
  'rev', coalesce((SELECT rev FROM dirs WHERE dir = ${d}), 0),
  'todos', (SELECT json_group_array(json(body)) FROM (SELECT body FROM todos WHERE dir = ${d} ORDER BY n)),
  'agents', (SELECT json_group_array(json(body)) FROM agents WHERE dir = ${d}),
  'floor', coalesce((SELECT seq FROM calls WHERE dir = ${d} ORDER BY seq DESC LIMIT 1 OFFSET ${int(op.keep - 1)}), 0),
  'top', coalesce((SELECT max(seq) FROM calls WHERE dir = ${d}), 0));
`
    }
    case 'calls':
      return `SELECT json_object('rows', json_group_array(json_set(json(body), '$.seq', seq)), 'last', max(seq))
  FROM (SELECT body, seq FROM calls WHERE dir = ${q(op.dir)} AND seq > ${int(op.after)} ORDER BY seq LIMIT ${int(op.limit)});
`
    case 'todos':
      return `BEGIN IMMEDIATE;
${bump(op.dir, op.rev)}${op.del.length ? `DELETE FROM todos WHERE dir = ${q(op.dir)} AND n IN ${list(op.del.map(int))};\n` : ''}${putTodos(op.dir, op.put, 'INSERT OR REPLACE')}COMMIT;
`
    case 'agents': {
      const gone = list(op.del.map(q))
      return `BEGIN IMMEDIATE;
${op.put.map(a => `INSERT OR REPLACE INTO agents VALUES (${q(a.agentId)}, ${q(op.dir)}, ${int(a.todoN)}, ${q(op.session)}, ${body(a)});\n`).join('')}${
        op.del.length ? `DELETE FROM agents WHERE id IN ${gone};\nDELETE FROM calls WHERE agent_id IN ${gone};\n` : ''
      }COMMIT;
`
    }
    case 'call':
    case 'turn': {
      const c = op.put
      return `INSERT OR REPLACE INTO calls VALUES (${q(c.id)}, ${q(op.dir)}, ${q(c.agentId)}, ${q(op.session)}, (SELECT coalesce(max(seq), 0) + 1 FROM calls), ${body(c)});
`
    }
    case 'import':
      // `migrated` is the run-once guard: a second import of the same source
      // fails on its key, before anything is written.
      return `BEGIN IMMEDIATE;
INSERT INTO migrated VALUES (${q(op.id)}, ${q(op.dir)}, ${int(op.at)});
INSERT INTO backups VALUES (${q(op.id)}, ${q(op.dir)}, ${int(op.at)}, ${body(op.backup)});
${bump(op.dir, op.rev)}${putTodos(op.dir, op.put, 'INSERT')}COMMIT;
`
    case 'backups':
      return `SELECT json_group_array(json_object('id', id, 'dir', dir, 'at', at)) FROM backups;
`
    case 'drop':
      return op.ids.length ? `DELETE FROM backups WHERE id IN ${list(op.ids.map(q))};\n` : ''
  }
}

export const script = (op: Op) => `-- op ${JSON.stringify(op)}\n${SCHEMA}${sql(op)}`

// ---------- the file and the binary ----------

// Every run names its own directory: by default a run starts in the
// session's, and when that is gone (a worktree removed under the session)
// the spawn fails with ENOENT though the binary is there. Nothing here
// depends on the cwd, so '/' always exists and always works.
export const CWD = { cwd: '/' } as const

export async function locate($: $): Promise<{ bin: string; file: string } | string> {
  const home = (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const folder = `${config}/plugins/data/todo`
  let bin: string | undefined
  for (const b of ['/usr/bin/sqlite3', 'sqlite3']) {
    try {
      if ((await $.process.run([b, '-version'], CWD)).exitCode === 0) {
        bin = b
        break
      }
    } catch {
      // try the next one
    }
  }
  if (!bin) return 'sqlite3 was not found; todos are read-only until it is installed'
  try {
    const r = await $.process.run(['mkdir', '-p', folder], CWD)
    if (r.exitCode !== 0) return `can't create ${folder}: ${r.stderr.trim()}`
  } catch (err) {
    return `can't create ${folder}: ${String(err)}`
  }
  return { bin, file: `${folder}/todo.db` }
}

type Where = { bin: string; file: string }

async function run($: $, at: Where, op: Op) {
  const r = await $.process.run([at.bin, '-batch', at.file], { ...CWD, stdin: script(op) })
  return r
}

async function must($: $, at: Where, op: Op) {
  const r = await run($, at, op)
  if (r.exitCode !== 0) throw new DbError(r.stderr.trim() || `sqlite3 exited ${r.exitCode}`)
  return r.stdout.trim()
}

// ---------- the calls the mod makes ----------

export async function snapshot($: $, at: Where, dir: string, keep: number): Promise<Snapshot> {
  type Raw = Omit<Snapshot, 'todos' | 'agents'> & { todos: Todo[] | null; agents: AgentNode[] | null }
  const v = JSON.parse(await must($, at, { kind: 'read', dir, keep })) as Raw
  return { ...v, todos: v.todos ?? [], agents: v.agents ?? [] }
}

export async function callsAfter($: $, at: Where, dir: string, after: number, limit: number): Promise<Page> {
  return JSON.parse(await must($, at, { kind: 'calls', dir, after, limit })) as Page
}

// False when another session moved the directory's list since `rev`.
export async function writeTodos($: $, at: Where, dir: string, rev: number, put: Todo[], del: number[]) {
  const r = await run($, at, { kind: 'todos', dir, rev, put, del })
  if (r.exitCode === 0) return true
  if (r.stderr.includes('CHECK constraint failed')) return false
  throw new DbError(r.stderr.trim() || `sqlite3 exited ${r.exitCode}`)
}

export async function writeAgents($: $, at: Where, dir: string, session: string, put: AgentNode[], del: string[]) {
  if (put.length || del.length) await must($, at, { kind: 'agents', dir, session, put, del })
}

export async function writeCall($: $, at: Where, dir: string, session: string, put: Call) {
  await must($, at, { kind: 'call', dir, session, put })
}

export async function writeTurn($: $, at: Where, dir: string, session: string, put: Turn) {
  await must($, at, { kind: 'turn', dir, session, put })
}

// 'done': this source was imported before; 'moved': the list changed since `rev`.
export async function importTodos(
  $: $,
  at: Where,
  op: Omit<Extract<Op, { kind: 'import' }>, 'kind'>,
): Promise<'ok' | 'done' | 'moved'> {
  const r = await run($, at, { kind: 'import', ...op })
  if (r.exitCode === 0) return 'ok'
  if (r.stderr.includes('UNIQUE constraint failed: migrated')) return 'done'
  if (r.stderr.includes('CHECK constraint failed')) return 'moved'
  throw new DbError(r.stderr.trim() || `sqlite3 exited ${r.exitCode}`)
}

export async function backups($: $, at: Where): Promise<Backup[]> {
  return JSON.parse(await must($, at, { kind: 'backups' })) as Backup[]
}

export async function dropBackups($: $, at: Where, ids: string[]) {
  if (ids.length) await must($, at, { kind: 'drop', ids })
}
