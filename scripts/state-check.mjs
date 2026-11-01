#!/usr/bin/env node
// Checks the todo state machine with TLA+'s model checker, TLC: the
// stateDiagram-v2 in docs/architecture.md against the moves the code makes,
// listed in hooks/transitions.json. See docs/state-validation.md.
//
//   node scripts/state-check.mjs
//
// Generates one TLA+ spec holding both machines, has TLC explore every state
// of each from every starting state, and reports:
//   - transitions only one of the two has
//   - states nothing reaches from [*]
//   - dead ends (no way out but staying put) and stuck states (no path to an
//     end, [*])
// Exits 1 when it finds any. Needs a JDK: $JAVA_HOME, then Homebrew's
// keg-only openjdk, then `java` on PATH. tla2tools.jar is fetched once into
// .cache/tla (gitignored) and checked against its pinned hash.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const TLA_VERSION = 'v1.7.4'
const TLA_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar`
const TLA_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'

const root = fileURLToPath(new URL('..', import.meta.url))
const cache = join(root, '.cache', 'tla')
const START = 'new'
const END = 'gone'

// ---------- the two machines ----------

// `A --> B: label` lines of the first mermaid block that is a stateDiagram-v2.
function diagramEdges() {
  const doc = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8')
  const block = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => /^\s*stateDiagram-v2/m.test(b))
  if (!block) throw new Error('docs/architecture.md has no mermaid stateDiagram-v2 block')
  const edges = []
  for (const line of block.split('\n')) {
    const m = /^\s*(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)\s*(?::\s*(.*))?$/.exec(line)
    if (m) edges.push({ from: m[1], to: m[2], by: (m[3] ?? '').trim() })
  }
  return edges
}

function codeEdges() {
  const table = JSON.parse(readFileSync(join(root, 'hooks', 'transitions.json'), 'utf8'))
  return { edges: table.transitions, unconstrained: table.unconstrained ?? [] }
}

// [*] stands for two different things: before the todo exists, and after.
const node = (s, isFrom) => (s === '[*]' ? (isFrom ? START : END) : s)
const pairs = (edges) => edges.map((e) => [node(e.from, true), node(e.to, false)])

// ---------- the spec ----------

const q = (s) => JSON.stringify(s)
const set = (ps) => `{${[...new Set(ps.map(([a, b]) => `<<${q(a)}, ${q(b)}>>`))].join(', ')}}`

function spec(states, diagram, code) {
  return `---- MODULE TodoStates ----
EXTENDS TLC
States == {${states.map(q).join(', ')}}
Diagram == ${set(diagram)}
Code == ${set(code)}
Edges == [diagram |-> Diagram, code |-> Code]

\\* m: which machine; o: the state it started in; s: where it is now.
VARIABLES m, o, s
Init == m \\in {"diagram", "code"} /\\ o \\in States /\\ s = o
Next == \\E e \\in Edges[m] : e[1] = s /\\ s' = e[2] /\\ UNCHANGED <<m, o>>

\\* One line per transition only one of the two machines has.
ASSUME \\A p \\in Diagram \\ Code : PrintT(<<"onlyDiagram", p[1], p[2]>>)
ASSUME \\A p \\in Code \\ Diagram : PrintT(<<"onlyCode", p[1], p[2]>>)
====
`
}

// ---------- the tools ----------

function findJava() {
  const tries = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', 'java'),
    '/opt/homebrew/opt/openjdk/bin/java',
    '/usr/local/opt/openjdk/bin/java',
    'java',
  ].filter(Boolean)
  // macOS's /usr/bin/java is a stub that fails without a JDK installed, so
  // each candidate has to answer -version.
  const java = tries.find((j) => spawnSync(j, ['-version'], { stdio: 'ignore' }).status === 0)
  if (!java) throw new Error('no JDK found: set JAVA_HOME, or `brew install openjdk`')
  return java
}

async function fetchJar() {
  const jar = join(cache, `tla2tools-${TLA_VERSION}.jar`)
  if (!existsSync(jar)) {
    mkdirSync(cache, { recursive: true })
    const r = await fetch(TLA_URL)
    if (!r.ok) throw new Error(`fetching ${TLA_URL}: ${r.status}`)
    writeFileSync(jar, Buffer.from(await r.arrayBuffer()))
  }
  const sum = createHash('sha256').update(readFileSync(jar)).digest('hex')
  if (sum !== TLA_SHA256) {
    rmSync(jar)
    throw new Error(`tla2tools.jar's sha256 is ${sum}, not the pinned ${TLA_SHA256}`)
  }
  return jar
}

function runTlc(java, jar, dir) {
  const r = spawnSync(java, ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-deadlock', '-workers', '1', '-cleanup', '-dump', 'states', 'TodoStates'], {
    cwd: dir,
    encoding: 'utf8',
  })
  const out = `${r.stdout}${r.stderr}`
  if (r.status !== 0) throw new Error(`TLC failed (${r.status}):\n${out}`)
  return { out, dump: readFileSync(join(dir, 'states.dump'), 'utf8') }
}

// ---------- reading TLC's answers ----------

// The pairs TLC printed under `tag`, one <<"tag", "from", "to">> a line.
const printed = (out, tag) =>
  [...out.matchAll(new RegExp(`^<<\\s*"${tag}", "([^"]+)", "([^"]+)">>$`, 'gm'))].map((m) => [m[1], m[2]])

// Each dumped state is three conjuncts: m, o and s.
function reached(dump) {
  const states = []
  for (const block of dump.split(/^State \d+:$/m).slice(1)) {
    const v = Object.fromEntries([...block.matchAll(/^\/\\ (\w+) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]]))
    states.push(v)
  }
  // machine → origin → the states it can get to
  const by = {}
  for (const { m, o, s } of states) ((by[m] ??= {})[o] ??= new Set()).add(s)
  return { count: states.length, by }
}

// ---------- main ----------

const diagram = diagramEdges()
const { edges: code, unconstrained } = codeEdges()
const states = [...new Set([START, END, ...[...pairs(diagram), ...pairs(code)].flat()])]
const dir = join(cache, 'run')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'TodoStates.tla'), spec(states, pairs(diagram), pairs(code)))
writeFileSync(join(dir, 'TodoStates.cfg'), 'INIT Init\nNEXT Next\n')

const { out, dump } = runTlc(findJava(), await fetchJar(), dir)
const { count, by } = reached(dump)
const findings = []
const show = (s) => (s === START || s === END ? '[*]' : s)
const labels = (edges, [a, b]) =>
  edges.filter((e) => node(e.from, true) === a && node(e.to, false) === b).map((e) => e.by || '(no label)').join(' · ')

console.log(`TLC ${TLA_VERSION}: ${count} distinct states over ${states.length - 2} todo states, two machines\n`)
for (const [tag, edges, what] of [
  ['onlyCode', code, 'in the code, not the diagram'],
  ['onlyDiagram', diagram, 'in the diagram, not the code'],
]) {
  for (const p of printed(out, tag)) findings.push(`${show(p[0])} → ${show(p[1])} is ${what}: ${labels(edges, p)}`)
}
for (const m of ['diagram', 'code']) {
  const from = by[m] ?? {}
  const live = from[START] ?? new Set()
  // A state only the other machine has is already a mismatch above.
  const own = new Set(pairs(m === 'diagram' ? diagram : code).flat())
  for (const s of own) {
    if (s === START || s === END) continue
    const to = from[s] ?? new Set([s])
    if (!live.has(s)) findings.push(`${m}: ${s} is unreachable from [*]`)
    if ([...to].every((x) => x === s)) findings.push(`${m}: ${s} is a dead end (nothing leaves it)`)
    else if (!to.has(END)) findings.push(`${m}: ${s} is stuck (no path to [*])`)
  }
}
for (const u of unconstrained) console.log(`note: ${u.by} (${u.at}) ${u.note}`)
if (unconstrained.length) console.log('')
if (findings.length === 0) {
  console.log('No mismatches, unreachable, dead or stuck states.')
} else {
  console.log(`${findings.length} findings:`)
  for (const f of findings) console.log(`- ${f}`)
  process.exitCode = 1
}
