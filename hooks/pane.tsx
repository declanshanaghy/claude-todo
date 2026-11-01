import type { Color, ElementTable, EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, PaneUi, Todo, Turn } from '../types'
import { clean } from './detail'
import { type Tone, markOf, markText, statusChip, statusGlyph, tallySummary } from './marks'
import {
  INFLIGHT,
  addTodo,
  askConfirm,
  cancelConfirm,
  collapse,
  deleteTodo,
  execTodo,
  fireBlock,
  fireNext,
  haltTodo,
  openDetail,
  patchUi,
  renameTodo,
  restartTodo,
  resumeTodo,
  setTodoStatus,
  takeOver,
  toggle,
} from './register'

// What the render hook in register.tsx read from $.state for this draw.
export type PaneData = {
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
  // The session's title, drawn at the header's right; '' draws none.
  sessionTitle: string
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// How many of a subtask's newest turns and calls its open row shows.
export const TAIL = 6

// The first line with text, for a one-line row; a turn's (prose) also drops
// its markdown marks.
const oneLine = (text: string) => clean(text).split('\n').map(l => l.trim()).find(Boolean) ?? ''
const gist = (text: string) => oneLine(text.replace(/[#*`]/g, ''))

// Every focusable item lights the same way: while the ring is on it, a
// rounded border in Claude's color, as the ring's inversion alone is hard to
// see. The others keep a blank cell on each side in its place, so a moving
// ring never shifts anything. The call browser's fold toggles use it too.
export function ringBox({ Box }: Pick<ElementTable, 'Box'>, ring: string | null, key: string, node: JSX.Element) {
  return ring === key ? (
    <Box key={`ring:${key}`} borderStyle="round" borderColor="claude">
      {node}
    </Box>
  ) : (
    <Box key={`ring:${key}`} padding={1}>
      {node}
    </Box>
  )
}

export const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export function drawPane($: $, e: RenderInput<'Pane'>, { me, fault, ring, list, nodes, all, turns, u, cap, f, sessionTitle }: PaneData) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined

  const lit = (key: string, node: JSX.Element) => ringBox(els, ring, key, node)

  // An action chip fills with the color of the status it moves the todo into
  // (marks.tsx), so the buttons, rows and summaries share one palette.
  const chip = (key: string, label: string, onPress: () => unknown, tone: Tone = 'neutral', isDimmed = false) =>
    lit(key, statusChip(els, key, label, onPress, tone, isDimmed))

  const open = new Set(u.expanded)
  const view = e.props.view as { agentId?: string } | undefined

  const actions = (t: Todo) => {
    const btn = (k: string, label: string, onPress: () => unknown, tone: Tone = 'neutral') => (
      chip(`act:${t.n}:${k}`, label, onPress, tone)
    )
    const details = btn('details', 'Details', () => openDetail($, { kind: 'todo', n: t.n }))
    const c = u.confirm?.n === t.n ? u.confirm.kind : null
    if (c === 'stop') {
      return [
        <Text color="error">Stop #{t.n}? Execution halts; the todo is kept.</Text>,
        <Box gap={1}>
          {btn('stopyes', 'Stop', () => haltTodo($, t, 'stopped'), 'stopped')}
          {btn('keep', 'Keep', () => cancelConfirm($, t.n, 'stop'))}
        </Box>,
      ]
    }
    if (c === 'takeover') {
      return [
        <Text color="error">Take over #{t.n}? It's marked stopped here; its run in the other session isn't stopped.</Text>,
        <Box gap={1}>
          {btn('takeyes', 'Takeover', () => takeOver($, t), 'stopped')}
          {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'takeover'))}
        </Box>,
      ]
    }
    // In flight in another session: its task ids aren't this one's to pause.
    if (INFLIGHT.has(t.status) && t.owner !== undefined && t.owner !== me) {
      return [
        <Box gap={1}>
          <Text dimColor>{t.status} in another session</Text>
          {btn('takeover', 'Takeover', () => askConfirm($, t.n, 'takeover'), 'stopped')}
          {details}
        </Box>,
      ]
    }
    if (c === 'delete') {
      return [
        <Text color="error">Delete "#{t.n} {t.title}"?</Text>,
        <Box gap={1}>
          {btn('deleteyes', 'Delete', () => deleteTodo($, t), 'danger')}
          {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'delete'))}
        </Box>,
      ]
    }
    switch (t.status) {
      case 'pending':
        return [
          <Box gap={1}>
            {btn('exec', 'Exec', () => execTodo($, t, false), 'running')}
            {/* Auto goes straight to running, so it wears running's fill too. */}
            {btn('auto', 'Auto', () => execTodo($, t, false, true), 'running')}
            {btn('rename', 'Rename', () => patchUi($, x => ({ ...x, renaming: t.n })))}
            {!t.hasRun && btn('delete', 'Delete', () => askConfirm($, t.n, 'delete'), 'danger')}
            {details}
          </Box>,
        ]
      case 'drafting':
      case 'planning':
        return [
          <Box gap={1}>
            <Text dimColor>{t.status === 'planning' ? 'planning in the chat…' : t.hasRun ? 'continuing in the chat…' : 'answer the prompt question in the chat…'}</Text>
            {btn('reset', 'Reset', () => setTodoStatus($, t.n, t.hasRun ? 'stopped' : 'pending'))}
          </Box>,
        ]
      case 'running':
        return [
          <Box gap={1}>
            {btn('pause', 'Pause', () => haltTodo($, t, 'paused'), 'paused')}
            {btn('stop', 'Stop', () => askConfirm($, t.n, 'stop'), 'stopped')}
            {details}
          </Box>,
        ]
      case 'paused':
        return [
          <Box gap={1}>
            {btn('resume', 'Resume', () => resumeTodo($, t), 'running')}
            {btn('stop', 'Stop', () => askConfirm($, t.n, 'stop'), 'stopped')}
            {details}
          </Box>,
        ]
      case 'stopped':
      case 'failed': {
        const fresh = u.justStopped.includes(t.n)
        return [
          ...(fresh ? [<Text color="suggestion">Stopped. What next?</Text>] : []),
          <Box gap={1}>
            {btn('refine', 'Refine', () => execTodo($, t, true), 'drafting')}
            {btn('restart', 'Restart', () => restartTodo($, t), 'drafting')}
            {details}
          </Box>,
          <Box gap={1}>
            {(t.taskId !== undefined || t.isAgentGone === true) && btn('resume', 'Resume', () => resumeTodo($, t), 'running')}
            {fresh &&
              btn('leave', 'Leave', async () => {
                await patchUi($, x => ({
                  ...x,
                  justStopped: x.justStopped.filter(n => n !== t.n),
                  expanded: collapse(x.expanded, `t${t.n}`),
                }))
              })}
          </Box>,
        ]
      }
      case 'done':
        return [<Box gap={1}>{details}</Box>]
    }
  }

  // The columns a lit item's content has: the body less its padding and the
  // ring's cell on either side.
  const inner = Math.max(0, e.props.bodyColumns - 2 * PAD_X - 2)
  const callsOf = (agentId: string) => all.filter(c => c.agentId === agentId).length

  // Level 3: a subtask's newest turns and calls, one line each, and the way
  // into the full call browser. Escape there puts the ring back on its row.
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
    rows.push(
      <Box>
        {chip(`full:${a.agentId}`, 'Full transcript', () =>
          openDetail($, { kind: 'agent', agentId: a.agentId }, `ag:${a.agentId}`),
        )}
      </Box>,
    )
    return (
      <Box paddingLeft={2} flexDirection="column">
        {rows}
      </Box>
    )
  }

  // Level 2: one focusable row per subtask, grouped by wave for a Workflow.
  const agentRows = (t: Todo, mine: AgentNode[]) => {
    let wave: number | undefined
    return mine.flatMap(a => {
      const out: JSX.Element[] = []
      if (t.mode === 'workflow' && a.wave !== undefined && a.wave !== wave) {
        wave = a.wave
        out.push(<Text dimColor> wave {a.wave}</Text>)
      }
      const id = `a${t.n}:${a.agentId}`
      const isOpen = open.has(id)
      out.push(
        lit(
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
        ),
      )
      if (isOpen) out.push(recent(a))
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

  const todoRows = (t: Todo) => {
    const isOpen = open.has(`t${t.n}`)
    const mine = nodes.filter(a => a.todoN === t.n).sort((x, y) => x.startedAt - y.startedAt)
    const head = header(t, isOpen, mine)
    if (!isOpen) return [head]
    // Level 1: what it was asked to do, in 2 lines; how it ended; what can be
    // done now; and, once it has agents, the line that opens them.
    const subsOpen = open.has(`s${t.n}`)
    const calls = mine.reduce((n, a) => n + callsOf(a.agentId), 0)
    const done = mine.filter(a => a.status === 'done').length
    return [
      head,
      <Box paddingLeft={2} flexDirection="column">
        {t.prompt ? (
          clampLines(`“${clean(t.prompt)}”`, inner - 2).map(l => (
            <Text dimColor wrap="truncate-end">
              {' '}
              {l}
            </Text>
          ))
        ) : (
          <Text dimColor italic>
            {' '}
            no prompt yet: ▶ Exec drafts one
          </Text>
        )}
        {t.status === 'done' && t.summary ? (
          <Text color={markOf('done').color} wrap="truncate-end">
            {' '}✓ {gist(t.summary)}
          </Text>
        ) : (
          ''
        )}
        {actions(t)}
        {mine.length > 0
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
          : ''}
        {subsOpen ? (
          <Box paddingLeft={2} flexDirection="column">
            {agentRows(t, mine)}
          </Box>
        ) : (
          ''
        )}
      </Box>,
    ]
  }

  const tree = (
    <Box
      flexDirection="column"
      width={e.props.bodyColumns}
      paddingX={PAD_X}
    >
      {/* Centered: 🔥 Fire's ring box keeps a blank cell above and below it,
          so top-aligned, the chip sat a row below Todos and its counts. */}
      <Box alignItems="center">
        <Box flexGrow={1}>
          <Text>
            <Text weight="semibold">Todos </Text>
            <Text dimColor>{list.length} · </Text>
            {tallySummary(els, list)}
          </Text>
        </Box>
        {/* 🔥 Fire is `/todo exec auto` with no target: the next pending todo,
            in auto mode. It launches into running, so it wears running's
            color, dimmed while nothing is pending or the cap is full; the cap
            itself is only told when a press is refused, not drawn. */}
        {fault ? '' : <Box flexShrink={0}>{chip('fire', 'Fire', () => fireNext($), 'running', fireBlock(list, nodes, cap) !== null)}</Box>}
        {/* The engine's frame takes only a plain tab label, drawn while more
            than one pane is open, so the title rides the header's right end in
            the prompt bar's border color, cut short before it wraps. */}
        {sessionTitle ? (
          <Box flexShrink={1} overflow="hidden" marginLeft={1}>
            <Text color="promptBorder" wrap="truncate-end">
              {sessionTitle}
            </Text>
          </Box>
        ) : (
          ''
        )}
      </Box>
      {fault ? <Text color="error">⚠ {fault}</Text> : ''}
      {Input && !fault ? (
        lit(
          'add',
          <Box>
            <Text color="claude">＋ </Text>
            <Input key="add" placeholder="add todo…" submitLabel="add" value="" autoFocus onSubmit={v => void addTodo($, v)} />
          </Box>,
        )
      ) : (
        <Text dimColor>/todo add &lt;title&gt; adds a todo</Text>
      )}
      {view?.agentId ? chip('back', 'Back', () => $.ui.view({})) : ''}
      <Text> </Text>
      {list.length === 0 ? <Text dimColor>No todos yet. Type a title above.</Text> : ''}
      {list.flatMap(todoRows)}
    </Box>
  )
  drawnOrder = ringKeys(tree)
  return tree
}
