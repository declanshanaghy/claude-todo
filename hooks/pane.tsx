import type { Color, ElementTable, EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, PaneUi, Todo, Turn } from '../types'
import { clean } from './detail'
import {
  CHIP,
  DIVIDER,
  SUMMARY,
  type Tally,
  type TipAt,
  type Tone,
  chipHint,
  chipSentence,
  markOf,
  markText,
  statusChip,
  statusGlyph,
  tally,
  tipLabel,
  viewOf,
  viewToggle,
  withTip,
} from './marks'
import { type Chip, offers } from './moves'
import {
  addTodo,
  askConfirm,
  cancelConfirm,
  deleteTodo,
  execTodo,
  fireBlock,
  fireNext,
  haltTodo,
  leaveTodo,
  openDetail,
  patchUi,
  renameTodo,
  resetTodo,
  restartTodo,
  resumeTodo,
  takeOver,
  toggle,
  toggleView,
  viewIn,
} from './register'

// What the render hook in register.tsx read from $.state for this draw.
export type PaneData = {
  // The todos whose prompt waits for the person's next message.
  queued: number[]
  // This session's id, to tell its in-flight todos from another session's.
  me: string
  // Why the database can't be used, when it can't.
  fault: string
  // The key of the element the focus ring is on, while the pane has the keys.
  ring: string | null
  list: Todo[]
  nodes: AgentNode[]
  all: Call[]
  turns: Turn[]
  u: PaneUi
  cap: number
  f: number
  // The list's scroll offset: its first row the window shows (see listWindow).
  offset: number
}

// Layout follows docs/mockup.html (scene 3, Drill down); glyphs and colors follow Claude
// Code's own transcript: its spinner, ⏺ tool rows and ⎿ results, theme keys only.
// Every status color and glyph, and the chips' fills, come from marks.tsx.

type $ = EngineInterface

export function callGlyph(s: Call['state'], f: number): [string, Color] {
  switch (s) {
    case 'run': return ['⏺', f % 2 ? 'inactive' : 'text']
    case 'ok': return ['⏺', 'success']
    case 'err': return ['⏺', 'error']
    case 'interrupted': return ['⏺', 'warning']
  }
}

// The focusable elements' keys in the order the last drawing placed them, for
// the arrow keys to walk (see the ui.scroll hook in register.tsx). Read from
// the finished tree, as an element is often built before its place is known.
let drawnOrder: string[] = []
export const focusOrder = () => drawnOrder

// The list's window as the last drawing placed it: how many rows the list
// has, how many the window under the header shows, the offset it drew at
// (clamped), and the row each focusable key sits on. The ui.scroll and
// ui.focus hooks move the offset from it, as a render never writes state.
export type ListWindow = { rows: number; height: number; offset: number; rowOf: Record<string, number> }
let drawnList: ListWindow = { rows: 0, height: 0, offset: 0, rowOf: {} }
export const listWindow = () => drawnList

// The offset that keeps `row` in a window of `height` rows now at `offset`.
export const showRow = (row: number, offset: number, height: number) =>
  row < offset ? row : row >= offset + height ? row - height + 1 : offset

function ringKeys(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) ringKeys(n, out)
  } else if (typeof node === 'object' && node !== null) {
    const el = node as { key?: unknown; props?: { key?: unknown; children?: unknown }; children?: unknown }
    const key = el.key ?? el.props?.key
    if (typeof key === 'string' && key.startsWith('ring:')) out.push(key.slice('ring:'.length))
    ringKeys(el.children ?? el.props?.children, out)
  }
  return out
}

// The columns the tree draws in: the pane's body less its paddingX of 1.
const PAD_X = 1

// Counted in graphemes, so a cut never splits a character; each Text's
// truncate-end still guards a wide one.
const graphemes = (s: string) => Array.from(new Intl.Segmenter().segment(s), x => x.segment)

// The cells a grapheme takes on the terminal: two for an emoji or a wide East
// Asian character, one otherwise. The header sums with it, so a wide mark or
// title character can't push the line past its width.
const WIDE = /\p{Emoji_Presentation}|️|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u
const cellsOf = (g: string) => (WIDE.test(g) ? 2 : 1)
const cells = (s: string) => graphemes(s).reduce((n, g) => n + cellsOf(g), 0)

// A todo's header line, sized to `width` so it never wraps: `▸ #3 Fix kitty
// tab titles ──── ▶ 2/5`. The title is cut with … where it doesn't fit, the
// rule fills the gap and is always at least two cells, and the status mark at
// the right is never cut. Every sum is in terminal cells, so a wide symbol or
// title character still fits. The pane draws the toggle and rule dim, the
// number, title and mark in the todo's status color.
export function headParts(n: number, title: string, right: string, width: number) {
  // The toggle and its space, `#N`, then a space either side of the rule and
  // the right side.
  const fixed = 2 + `#${n}`.length + 1 + 1 + cells(right)
  const room = width - fixed - 1 - 2
  let text = ''
  if (room >= 2 && cells(title) <= room) text = title
  else if (room >= 2) {
    // Whole graphemes while they and the … fit.
    let used = 0
    for (const g of graphemes(title)) {
      if (used + cellsOf(g) > room - 1) break
      text += g
      used += cellsOf(g)
    }
    text = `${text.trimEnd()}…`
  }
  const used = fixed + (text ? 1 + cells(text) : 0)
  return { title: text ? ` ${text}` : '', rule: ` ${'─'.repeat(Math.max(2, width - used))} ` }
}

// Text word-wrapped to `width` and kept to `max` lines, the last cut with …
// when there's more. Drawn line by line, so a long prompt never pushes the
// todos below it down the pane.
export function clampLines(text: string, width: number, max = 2) {
  const w = Math.max(2, width)
  const rows: string[][] = []
  let row: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let g = graphemes(word)
    while (g.length > 0) {
      const gap = row.length > 0 ? 1 : 0
      if (row.length + gap + g.length <= w) {
        if (gap) row.push(' ')
        row.push(...g)
        g = []
      } else if (row.length > 0) {
        rows.push(row)
        row = []
      } else {
        rows.push(g.slice(0, w))
        g = g.slice(w)
      }
    }
  }
  if (row.length > 0) rows.push(row)
  if (rows.length <= max) return rows.map(r => r.join(''))
  const kept = rows.slice(0, max).map(r => r.join(''))
  const last = graphemes(kept[max - 1] ?? '')
  kept[max - 1] = `${last.slice(0, w - 1).join('').trimEnd()}…`
  return kept
}

// An agent's turns and calls in time order; a step's text comes before its
// calls. The pane's last few lines and the call browser read the same list.
export type Entry = { at: number; o: number } & ({ turn: Turn; call?: undefined } | { call: Call; turn?: undefined })
export function timeline(agentId: string, all: readonly Call[], turns: readonly Turn[]): Entry[] {
  return [
    ...turns.filter(x => x.agentId === agentId).map((x, i): Entry => ({ at: x.startedAt, o: i * 2, turn: x })),
    ...all.filter(c => c.agentId === agentId).map((c, i): Entry => ({ at: c.startedAt, o: i * 2 + 1, call: c })),
  ].sort((x, y) => x.at - y.at || (x.turn ? -1 : 0) - (y.turn ? -1 : 0) || x.o - y.o)
}

// Where the ring goes when the chip it was on is no longer drawn (a todo's
// chip is left out while it can't act): to that todo's header. Under the none
// view no todo is drawn, so it goes to the view toggle that cycles to it.
// 🔥 Fire is a header control, never left out, only dimmed, so it needs no
// new home. Undefined while the ring is drawn, or when nothing fits.
export function rehome(ring: string | null, drawn: readonly string[], isNone = false) {
  if (ring === null || drawn.includes(ring)) return undefined
  if (isNone) return drawn.includes('view:all') ? 'view:all' : undefined
  const n = /^act:(\d+):/.exec(ring)?.[1]
  const to = n !== undefined ? `todo:${n}` : undefined
  return to !== undefined && drawn.includes(to) ? to : undefined
}

// The todo the ring is on, from any of its keys: its row, its actions, its
// subtasks line, one of its subtasks or that subtask's way into the browser.
export function ringTodo(ring: string | null, nodes: readonly AgentNode[]) {
  if (ring === null) return undefined
  const n = /^(?:todo|ren|act|subs):(\d+)/.exec(ring)?.[1]
  if (n !== undefined) return Number(n)
  const id = /^(?:ag|full):(.+)$/.exec(ring)?.[1]
  return id === undefined ? undefined : nodes.find(a => a.agentId === id)?.todoN
}

// The todos the view shows, in the order the list draws them: by number, done
// last. A todo the person is in the middle of stays whatever its status: one
// just stopped (asking what next) or the one the ring is on, so Pause or Stop
// never takes the row out from under the ring. The none view (every status
// off) shows no todo at all, not even those.
export function inView(list: readonly Todo[], view: readonly string[], keep: ReadonlySet<number>) {
  const on = new Set(view)
  if (on.size === 0) return []
  return list
    .filter(t => on.has(viewOf(t.status)) || keep.has(t.n))
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.n - b.n)
}

const noun = (n: number, word: string) => `${word}${n === 1 ? '' : 's'}`
const plural = (n: number, word: string) => `${n} ${noun(n, word)}`

// How many of a subtask's newest turns and calls its open row shows.
export const TAIL = 6

// The first line with text, for a one-line row; a turn's (prose) also drops
// its markdown marks.
const oneLine = (text: string) => clean(text).split('\n').map(l => l.trim()).find(Boolean) ?? ''
const gist = (text: string) => oneLine(text.replace(/[#*`]/g, ''))

// Every focusable item lights the same way: while the ring is on it, an
// orange [ ] in the cell on either side, as the ring's inversion alone is hard
// to see. The others keep those two cells blank, so a moving ring never shifts
// anything, and no item ever takes more than its own line. The call browser's
// fold toggles use it too.
export function ringBox({ Box, Text }: Pick<ElementTable, 'Box' | 'Text'>, ring: string | null, key: string, node: JSX.Element) {
  return ring === key ? (
    <Box key={`ring:${key}`} flexShrink={0}>
      <Text weight="bold" color="claude">[</Text>
      {node}
      <Text weight="bold" color="claude">]</Text>
    </Box>
  ) : (
    <Box key={`ring:${key}`} flexShrink={0} paddingX={1}>
      {node}
    </Box>
  )
}

export const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

// A list row, one line, and its indent: 0 for a todo's header and the rules,
// 2 for level 1, 4 for level 2 and 6 for level 3. Flat rather than nested
// boxes, so the window can count and scroll them a row at a time.
type Line = { indent: number; node: JSX.Element }
const lineAt = (indent: number) => (node: JSX.Element): Line => ({ indent, node })

export function drawPane($: $, e: RenderInput<'Pane'>, { queued, me, fault, ring, list, nodes, all, turns, u, cap, f, offset }: PaneData) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined

  const lit = (key: string, node: JSX.Element) => ringBox(els, ring, key, node)

  // An action chip fills with the color of the status it moves the todo into
  // (marks.tsx), so the buttons, rows and summaries share one palette. Its
  // word shows on hover, in a label placed by `at` (tipAt).
  const chip = (key: string, label: string, onPress: () => unknown, tone: Tone = 'stay', isDimmed = false, at: TipAt = { top: -1 }) =>
    lit(key, withTip(els, key, label, at, statusChip(els, key, label, onPress, tone, isDimmed, ring === key)))

  // Where a hover label opens for a chip whose box starts at column `x` of
  // the body: on the row above (every chip but the header's has the tree's
  // rows above it), shifted left where it would run past the pane's right
  // edge, which clips it.
  const tipAt = (x: number, word: string, top: 1 | -1 = -1): TipAt => ({ top, left: Math.min(0, e.props.bodyColumns - (x + cells(word) + 2)) })
  // A chip's cells, its ring's two included.
  const chipCells = (label: string) => cells(` ${CHIP[label]?.symbol ?? label} `) + 2

  const open = new Set(u.expanded)
  const agentView = e.props.view as { agentId?: string } | undefined

  // A todo's action rows, and the word of each chip they draw by its key, for
  // the hint line while the ring is on one.
  const actions = (t: Todo) => {
    const labels = new Map<string, string>()
    // The column the next chip's ring box starts at: the tree's padding and
    // level 1's indent, then what the row drew before it.
    let col = PAD_X + 2
    const btn = (k: string, label: string, onPress: () => unknown, tone: Tone = 'stay') => {
      const key = `act:${t.n}:${k}`
      labels.set(key, label)
      const at = tipAt(col + 1, label)
      col += chipCells(label) + 1
      return chip(key, label, onPress, tone, false, at)
    }
    const c = u.confirm?.n === t.n ? u.confirm.kind : null
    if (c === 'stop') {
      return {
        labels,
        rows: [
          <Text color="error">
            Stop #{t.n}? {chipSentence('Stop')}
          </Text>,
          <Box gap={1}>
            {btn('stopyes', 'Stop', () => haltTodo($, t, 'stopped'), 'stopped')}
            {btn('keep', 'Keep', () => cancelConfirm($, t.n, 'stop'))}
          </Box>,
        ],
      }
    }
    if (c === 'takeover') {
      return {
        labels,
        rows: [
          <Text color="error">
            Take over #{t.n}? {chipSentence('Takeover')}
          </Text>,
          <Box gap={1}>
            {btn('takeyes', 'Takeover', () => takeOver($, t), 'stopped')}
            {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'takeover'))}
          </Box>,
        ],
      }
    }
    // What the row offers comes from offers() (moves.ts), which the /todo
    // verbs check too, so a chip and its command can't disagree. Each chip's
    // fill is the color of the status it leads to.
    const make: Record<Chip, () => JSX.Element> = {
      // Exec and Auto start a run (through drafting), so both wear running's fill.
      exec: () => btn('exec', 'Exec', () => execTodo($, t, false), 'running'),
      auto: () => btn('auto', 'Auto', () => execTodo($, t, false, true), 'running'),
      rename: () => btn('rename', 'Rename', () => patchUi($, x => ({ ...x, renaming: t.n })), 'edit'),
      delete: () => btn('delete', 'Delete', () => askConfirm($, t.n, 'delete'), 'danger'),
      reset: () => btn('reset', 'Reset', () => resetTodo($, t)),
      pause: () => btn('pause', 'Pause', () => haltTodo($, t, 'paused'), 'paused'),
      stop: () => btn('stop', 'Stop', () => askConfirm($, t.n, 'stop'), 'stopped'),
      resume: () => btn('resume', 'Resume', () => resumeTodo($, t), 'running'),
      refine: () => btn('refine', 'Refine', () => execTodo($, t, true), 'drafting'),
      restart: () => btn('restart', 'Restart', () => restartTodo($, t), 'drafting'),
      leave: () => btn('leave', 'Leave', () => leaveTodo($, t.n)),
      // In flight in another session: its task ids aren't this one's to pause.
      takeover: () => btn('takeover', 'Takeover', () => askConfirm($, t.n, 'takeover'), 'stopped'),
      details: () => btn('details', 'Details', () => openDetail($, { kind: 'todo', n: t.n }), 'details'),
    }
    const on = offers(t, me, u.justStopped)
    // A hint leads the row where the todo is out of this pane's hands.
    const hint = on.includes('takeover')
      ? `${t.status} in another session`
      : t.status === 'drafting' || t.status === 'planning'
        ? queued.includes(t.n)
          ? 'queued: starts after your next message'
          : t.status === 'planning'
            ? 'planning in the chat…'
            : t.hasRun
              ? 'continuing in the chat…'
              : !t.isAuto
                ? 'answer the prompt question in the chat…'
                : t.prompt
                  ? 'starting with the first draft…'
                  : 'drafting the prompt…'
        : ''
    if (c === 'delete') {
      return {
        labels,
        rows: [
          <Text color="error">Delete "#{t.n} {t.title}"?</Text>,
          <Box gap={1}>
            {btn('deleteyes', 'Delete', () => deleteTodo($, t), 'danger')}
            {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'delete'))}
          </Box>,
        ],
      }
    }
    // One row, whatever the state: carry on, start over, put away, Details last.
    if (hint) col += cells(hint) + 1
    const chips = on.map(k => make[k]())
    return {
      labels,
      rows: [
        <Box gap={1}>
          {hint ? <Text dimColor>{hint}</Text> : ''}
          {chips}
        </Box>,
      ],
    }
  }

  // Level 1's first line while the ring is on one of the todo's chips: the
  // chip's symbol and word, then what it does, cut to the line.
  const hintLine = (n: number, label: string) => {
    const [name, does] = chipHint(label)
    return (
      <Text key={`hint:${n}`} wrap="truncate-end">
        {' '}
        <Text weight="semibold">{name}</Text>
        <Text dimColor>: {does}</Text>
      </Text>
    )
  }

  // The columns a lit item's content has: the body less its padding and the
  // ring's cell on either side.
  const inner = Math.max(0, e.props.bodyColumns - 2 * PAD_X - 2)
  const callsOf = (agentId: string) => all.filter(c => c.agentId === agentId).length

  // Level 3: a subtask's newest turns and calls, one line each. The way into
  // the full call browser, its ☰ Details, sits on the subtask's own row.
  const recent = (a: AgentNode) => {
    const entries = timeline(a.agentId, all, turns)
    const shown = entries.slice(-TAIL)
    const rows: JSX.Element[] = []
    if (entries.length > shown.length) rows.push(<Text dimColor> … {entries.length - shown.length} earlier</Text>)
    if (entries.length === 0) rows.push(<Text dimColor> No tool calls yet.</Text>)
    for (const x of shown) {
      if (x.turn) {
        rows.push(
          <Text wrap="truncate-end">
            <Text color="claude"> ⏺ </Text>
            {gist(x.turn.text)}
          </Text>,
        )
        continue
      }
      const c = x.call
      const [g, color] = callGlyph(c.state, f)
      rows.push(
        <Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color={color}> {g} </Text>
              <Text weight="semibold">{c.tool}</Text>
              <Text dimColor> {oneLine(c.arg)}</Text>
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor> {c.state === 'run' ? '…' : dur(c.ms)}</Text>
          </Box>
        </Box>,
      )
    }
    return rows
  }

  // Level 2: one focusable row per subtask, grouped by wave for a Workflow.
  const agentRows = (t: Todo, mine: AgentNode[]) => {
    let wave: number | undefined
    return mine.flatMap(a => {
      const out: Line[] = []
      const push = (x: JSX.Element) => out.push(lineAt(4)(x))
      if (t.mode === 'workflow' && a.wave !== undefined && a.wave !== wave) {
        wave = a.wave
        push(<Text dimColor> wave {a.wave}</Text>)
      }
      const id = `a${t.n}:${a.agentId}`
      const isOpen = open.has(id)
      // One row: the subtask's splitter, cut with … to the room left of its
      // ☰ Details, which sits whole at the right end, open or closed, as a
      // second focus stop. Escape from the browser puts the ring back on the row.
      push(
        <Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {lit(
              `ag:${a.agentId}`,
              <Box>
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Button key={`ag:${a.agentId}`} plain onPress={() => void toggle($, id)}>
                    <Text wrap="truncate-end">
                      <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                      {statusGlyph(els, a.status, f)} <Text color={a.kind === 'workflow' ? 'planMode' : 'permission'}>{a.name}</Text>
                      {a.isWorktree ? <Text color="warning"> ⎇</Text> : ''}
                    </Text>
                  </Button>
                </Box>
                <Box flexShrink={0}>
                  <Text dimColor> {plural(callsOf(a.agentId), 'call')}</Text>
                </Box>
              </Box>,
            )}
          </Box>
          <Box flexShrink={0}>
            {/* The subtask's ☰ Details, in the same symbol, word and tone as a
                todo's; flush right, so its label is anchored at its right edge. */}
            {chip(
              `full:${a.agentId}`,
              'Details',
              () => openDetail($, { kind: 'agent', agentId: a.agentId }, `ag:${a.agentId}`),
              'details',
              false,
              { top: -1, right: 0 },
            )}
          </Box>
        </Box>,
      )
      if (isOpen) out.push(...recent(a).map(lineAt(6)))
      return out
    })
  }

  // Level 0: the todo's one line, its own splitter. Pressing it opens or
  // closes the todo; closing it closes every level under it.
  const header = (t: Todo, isOpen: boolean, mine: AgentNode[]) => {
    const gc = markOf(t.status).color
    if (u.renaming === t.n && Input) {
      return lit(
        `ren:${t.n}`,
        <Box>
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          {statusGlyph(els, t.status, f)}
          <Text> #{t.n} </Text>
          <Input key={`ren:${t.n}`} value={t.title} submitLabel="rename" autoFocus onSubmit={v => void renameTodo($, t.n, v)} />
        </Box>,
      )
    }
    const done = mine.filter(a => a.status === 'done').length
    const isProgress = mine.length > 0 && t.status !== 'pending' && t.status !== 'done'
    const progress = isProgress ? ` ${done}/${mine.length}` : ''
    // The status drawn as its mark at the right end; the word stays the
    // line's label.
    const [right] = markText(t.status, progress, f)
    const p = headParts(t.n, t.title, right, inner)
    return lit(
      `todo:${t.n}`,
      <Button key={`todo:${t.n}`} label={`#${t.n} ${t.title}: ${t.status}${progress}`} plain onPress={() => void toggle($, `t${t.n}`)}>
        <Text wrap="truncate-end">
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text color={gc}>
            <Text weight="semibold">#{t.n}</Text>
            {p.title}
          </Text>
          <Text dimColor>{p.rule}</Text>
          <Text color={gc}>{right}</Text>
        </Text>
      </Button>,
    )
  }

  const todoRows = (t: Todo): Line[] => {
    const isOpen = open.has(`t${t.n}`)
    const mine = nodes.filter(a => a.todoN === t.n).sort((x, y) => x.startedAt - y.startedAt)
    const head = lineAt(0)(header(t, isOpen, mine))
    if (!isOpen) return [head]
    // Level 1: what it was asked to do, in 2 lines; how it ended; what can be
    // done now; and, once it has agents, the line that opens them.
    const subsOpen = open.has(`s${t.n}`)
    const calls = mine.reduce((n, a) => n + callsOf(a.agentId), 0)
    const done = mine.filter(a => a.status === 'done').length
    const acts = actions(t)
    // While the ring is on one of its chips, the first line says what that
    // chip does, in place of the prompt's first line or the usual hint: the
    // prompt keeps the lines it had less one, so level 1 keeps its size.
    const focused = ring === null ? undefined : acts.labels.get(ring)
    const promptLines = t.prompt ? clampLines(`“${clean(t.prompt)}”`, inner - 2) : []
    const promptRows = (rows: string[]) =>
      rows.map(l => (
        <Text dimColor wrap="truncate-end">
          {' '}
          {l}
        </Text>
      ))
    const level1: (JSX.Element | '')[] = [
      ...(focused !== undefined
        ? [hintLine(t.n, focused), ...(t.prompt && promptLines.length > 1 ? promptRows(clampLines(`“${clean(t.prompt)}”`, inner - 2, promptLines.length - 1)) : [])]
        : t.prompt
          ? promptRows(promptLines)
          : [
              t.status === 'prompting' ? (
                <Text color={markOf('prompting').color} italic>
                  {' '}
                  no prompt yet: drafting prompts…
                </Text>
              ) : t.status === 'pending' && t.drafts?.length ? (
                // Its drafts are in: Exec offers them rather than drafting one.
                // ▶ Exec asks which to run; ⚡ Auto and 🔥 Fire take drafts[0].
                <Text dimColor italic wrap="truncate-end">
                  {' '}
                  {plural(t.drafts.length, 'draft')}: ▶ Exec asks, ⚡/🔥 take the 1st
                </Text>
              ) : t.status === 'pending' ? (
                <Text dimColor italic>
                  {' '}
                  no prompt yet: ▶ Exec drafts one
                </Text>
              ) : (
                // Fired: its prompt is Claude's to settle, and Exec isn't the way on.
                <Text dimColor italic>
                  {' '}
                  {t.status === 'drafting' || t.status === 'planning' ? 'prompt being settled in the chat…' : 'prompt not recorded'}
                </Text>
              ),
            ]),
      t.status === 'done' && t.summary ? (
        <Text color={markOf('done').color} wrap="truncate-end">
          {' '}✓ {gist(t.summary)}
        </Text>
      ) : (
        ''
      ),
      ...acts.rows,
      mine.length > 0
        ? lit(
            `subs:${t.n}`,
            <Button key={`subs:${t.n}`} plain onPress={() => void toggle($, `s${t.n}`)}>
              <Text wrap="truncate-end">
                <Text dimColor>{subsOpen ? '▾ ' : '▸ '}</Text>
                {plural(mine.length, 'subtask')}
                <Text dimColor>
                  {' '}
                  · {done} done · {plural(calls, 'call')}
                  {t.mode === 'workflow' ? ' · workflow' : ''}
                </Text>
              </Text>
            </Button>,
          )
        : '',
    ]
    return [head, ...level1.filter((x): x is JSX.Element => x !== '').map(lineAt(2)), ...(subsOpen ? agentRows(t, mine) : [])]
  }

  // The tree's rule lines: a dim rule as wide as the tree's columns, cut
  // rather than wrapped. The header ends in a double `═` rule (`div2:head`),
  // drawn under the add element whatever the view shows: it parts the header
  // from the first todo, or from the empty note. The first todo then draws no
  // rule of its own; each later todo gets a single `─` above it, and the `N
  // hidden by the view` footer a double `═`. Not focusable, so a rule never
  // joins the ring's order, and never drawn inside a todo's levels or in the
  // dialog.
  const rule = (key: string, glyph: '─' | '═') => (
    <Box key={key} flexShrink={0} overflow="hidden">
      <Text color={DIVIDER} dimColor wrap="truncate-end">
        {glyph.repeat(Math.max(1, e.props.bodyColumns - 2 * PAD_X))}
      </Text>
    </Box>
  )
  const divider = (n: number) => rule(`div:${n}`, '─')

  // The view: what the header's toggles light, plus the todo in hand.
  const keep = new Set(u.justStopped)
  const held = ringTodo(ring, nodes)
  if (held !== undefined) keep.add(held)
  const view = viewIn(u)
  const shown = inView(list, view, keep)
  const hidden = list.length - shown.length
  const isAll = SUMMARY.every(v => view.includes(v))
  // The cycle's next view names the toggle: all → none → default → all.
  const cycle = isAll ? 'none' : view.length === 0 ? 'default' : 'all'
  // The body column toggle `i`'s mark starts at: the tree's padding, `N
  // Todos`, then each toggle before it with its ring's two cells.
  const toggleAt = (all: readonly Tally[], i: number) =>
    PAD_X + cells(plural(list.length, 'Todo')) + all.slice(0, i).reduce((x, m) => x + cells(markText(m.status, String(m.count))[0]) + 2, 0) + 1

  // The list under the header, one line per row: each todo's rule and rows,
  // then the hidden footer. The first todo draws no rule: the header's ═
  // rule above it stays fixed, so scrolling never moves it.
  const lines: Line[] = [
    ...shown.flatMap((t, i) => [...(i === 0 ? [] : [lineAt(0)(divider(t.n))]), ...todoRows(t)]),
    ...(hidden > 0 ? [lineAt(0)(rule('div2:hidden', '═')), lineAt(0)(<Text dimColor>{hidden} hidden by the view</Text>)] : []),
  ]
  // The header's rows, each one line: the counts and toggles, the add input
  // (or its note), the fault and Back while shown, the ═ rule, then, with
  // no todo shown, the empty note.
  const headRows = 3 + (shown.length === 0 ? 1 : 0) + (fault ? 1 : 0) + (agentView?.agentId ? 1 : 0)
  // The window shows what fits under the header, so the whole drawing stays
  // within the body and the engine never scrolls the header away; the list
  // scrolls inside it by `offset` (the ui.scroll and ui.focus hooks move it).
  const height = Math.min(lines.length, Math.max(1, e.props.scroll.bodyRows - headRows))
  const top = Math.min(Math.max(0, offset), Math.max(0, lines.length - height))
  const rowOf: Record<string, number> = {}
  lines.forEach((l, i) => {
    for (const k of ringKeys(l.node)) rowOf[k] = i
  })
  drawnList = { rows: lines.length, height, offset: top, rowOf }

  const tree = (
    <Box
      flexDirection="column"
      width={e.props.bodyColumns}
      paddingX={PAD_X}
    >
      {/* One line at any width: the count and the toggles take the room left of
          🔥 Fire and are clipped, never wrapped, so Fire sits flush at the
          right end. Centered, so `N Todos` and the chips share one baseline. */}
      <Box alignItems="center">
        <Box flexGrow={1} flexShrink={1} overflow="hidden" alignItems="center">
          <Box flexShrink={0}>
            <Text>
              <Text dimColor>{list.length}</Text>
              <Text weight="semibold"> {noun(list.length, 'Todo')}</Text>
            </Text>
          </Box>
          {/* One toggle per view, each its mark and count; then the cycle,
              named for the view a press makes: all, none while every view is
              lit, default while none is. The counts are the whole list's,
              whatever the view shows. */}
          {tally(list).map(m =>
            lit(
              `view:${m.status}`,
              <Box key={`tip:view:${m.status}`} flexShrink={0} hover={{ scope: `tip:view:${m.status}` }}>
                {viewToggle(els, m, view.includes(m.status), () => toggleView($, m.status))}
              </Box>,
            ),
          )}
          {lit(
            'view:all',
            <Button key="view:all" label={cycle} plain dimColor onPress={() => void toggleView($, 'all')}>
              <Text dimColor>{cycle}</Text>
            </Button>,
          )}
        </Box>
        {/* 🔥 Fire is `/todo exec auto` with no target: the next pending todo,
            in auto mode. It launches into running, so it wears running's
            color. A persistent header control, it is never hidden: while
            nothing is pending or the cap is full it is dimmed (disabled),
            still a focus stop, and a press only says why. */}
        {/* Its hover label opens on the row below, the header having none
            above, anchored at Fire's right edge, flush with the pane's. */}
        {fault ? '' : <Box flexShrink={0}>{chip('fire', 'Fire', () => fireNext($), 'running', fireBlock(list, nodes, cap) !== null, { top: 1, right: 0 })}</Box>}
        {/* The toggles' hover labels, here rather than beside each toggle:
            the box holding the toggles clips what leaves its one row. Each
            joins its toggle's hover group (`scope`), so the pointer on the
            toggle reveals it, on the row below. */}
        {tally(list).map((m, i, all) => {
          const x = toggleAt(all, i)
          return tipLabel(els, m.status, { top: 1, left: Math.min(x, e.props.bodyColumns - (cells(m.status) + 2)) - PAD_X }, `tip:view:${m.status}`)
        })}
      </Box>
      {fault ? (
        <Text color="error" wrap="truncate-end">
          ⚠ {fault}
        </Text>
      ) : (
        ''
      )}
      {Input && !fault ? (
        lit(
          'add',
          <Box>
            <Text color="claude">＋ </Text>
            <Input key="add" placeholder="add todo…" submitLabel="add" value="" autoFocus onSubmit={v => void addTodo($, v)} />
          </Box>,
        )
      ) : (
        <Text dimColor wrap="truncate-end">
          /todo add &lt;title&gt; adds a todo
        </Text>
      )}
      {agentView?.agentId ? chip('back', 'Back', () => $.ui.view({}), 'stay', false, tipAt(PAD_X + 1, 'Back')) : ''}
      {/* The header's last rule: the double ═ under the add element, above
          the empty note or the list's first todo, in every state. */}
      {rule('div2:head', '═')}
      {list.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          No todos yet. Type a title above.
        </Text>
      ) : (
        ''
      )}
      {list.length > 0 && shown.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          Nothing in this view.
        </Text>
      ) : (
        ''
      )}
      {/* The list's window: as tall as fits under the header, clipping the
          rows outside it. Every row is drawn, so each stays a focus stop the
          ring can reach; the negative margin is the scroll offset. */}
      {lines.length > 0 ? (
        <Box key="list" flexDirection="column" overflow="hidden" flexShrink={0} height={height}>
          <Box flexDirection="column" flexShrink={0} {...(top > 0 ? { marginTop: -top } : {})}>
            {lines.map(l => (l.indent === 0 ? l.node : <Box flexShrink={0} paddingLeft={l.indent}>{l.node}</Box>))}
          </Box>
        </Box>
      ) : (
        ''
      )}
    </Box>
  )
  drawnOrder = ringKeys(tree)
  return tree
}
