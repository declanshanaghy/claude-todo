import type { Color, EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, Dividers, PaneUi, Todo } from '../types'
import {
  INFLIGHT,
  addTodo,
  askConfirm,
  cancelConfirm,
  deleteTodo,
  execTodo,
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
  u: PaneUi
  cap: number
  f: number
  // What to draw above each todo.
  dividers: Dividers
}

// Layout follows docs/mockup.html (scene M3); glyphs and colors follow Claude
// Code's own transcript: its spinner, ⏺ tool rows and ⎿ results, theme keys only.
export const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']

type $ = EngineInterface

export function todoGlyph(s: Todo['status'], f: number): [string, Color] {
  switch (s) {
    case 'pending': return ['○', 'inactive']
    case 'drafting': return ['✎', 'suggestion']
    case 'planning': return ['◇', 'planMode']
    case 'running': return [SPIN[f % SPIN.length] ?? '·', 'claude']
    case 'paused': return ['⏸', 'warning']
    case 'stopped': return ['■', 'error']
    case 'done': return ['⏺', 'success']
    case 'failed': return ['✗', 'error']
  }
}

function agentGlyph(s: AgentNode['status'], f: number): [string, Color] {
  return todoGlyph(s, f)
}

export function callGlyph(s: Call['state'], f: number): [string, Color] {
  switch (s) {
    case 'run': return ['⏺', f % 2 ? 'inactive' : 'text']
    case 'ok': return ['⏺', 'success']
    case 'err': return ['⏺', 'error']
    case 'interrupted': return ['⏺', 'warning']
  }
}

// A chip's fill. resume, restart, refine and details are their actions' own
// colors (green, orange, yellow, teal), the same wherever they're drawn.
type Tone = 'primary' | 'danger' | 'default' | 'resume' | 'restart' | 'refine' | 'details'
const TONE: Record<Tone, Color> = {
  primary: 'claude',
  danger: 'error',
  default: 'subtle',
  resume: 'success',
  restart: 'claude',
  refine: 'warning',
  details: 'planMode',
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

// The rule above a todo, sized to `width` so it never wraps: `── #3 Fix kitty
// tab titles ─────`, the title cut with … where it doesn't fit, always ending
// on a little rule. Counted in graphemes, so a cut never splits a character;
// the Text's truncate-end still guards a wide one.
const graphemes = (s: string) => Array.from(new Intl.Segmenter().segment(s), x => x.segment)

export function dividerParts(n: number, title: string, width: number) {
  const num = `#${n}`
  const lead = '── '
  // Room left for the title once the lead, number, two spaces and a tail of
  // at least two rule cells are in.
  const room = width - lead.length - num.length - 2 - 2
  const chars = graphemes(title)
  const text = room < 2 ? '' : chars.length <= room ? title : `${chars.slice(0, room - 1).join('').trimEnd()}…`
  const used = lead.length + num.length + 1 + (text ? graphemes(text).length + 1 : 0)
  return { lead, num, text: text ? ` ${text} ` : ' ', tail: '─'.repeat(Math.max(0, width - used)) }
}

export const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export function drawPane($: $, e: RenderInput<'Pane'>, { me, fault, ring, list, nodes, all, u, cap, f, dividers }: PaneData) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined

  // Every focusable item lights the same way: while the ring is on it, a
  // rounded border in Claude's color, as the ring's inversion alone is hard to
  // see. The others keep a blank cell on each side in its place, so a moving
  // ring never shifts anything.
  const lit = (key: string, node: JSX.Element) =>
    ring === key ? (
      <Box key={`ring:${key}`} borderStyle="round" borderColor="claude">
        {node}
      </Box>
    ) : (
      <Box key={`ring:${key}`} padding={1}>
        {node}
      </Box>
    )

  // A filled chip reads as a button: a plain Button (no [ ] brackets) whose one
  // Text child carries the fill.
  const chip = (key: string, label: string, onPress: () => unknown, tone: Tone = 'default') =>
    lit(
      key,
      <Button key={key} label={label} plain onPress={() => void onPress()}>
        <Text weight="semibold" backgroundColor={TONE[tone]} color="inverseText">
          {` ${label} `}
        </Text>
      </Button>,
    )

  const open = new Set(u.expanded)
  const view = e.props.view as { agentId?: string } | undefined
  const count = (s: Todo['status']) => list.filter(t => t.status === s).length

  const actions = (t: Todo) => {
    const btn = (k: string, label: string, onPress: () => unknown, tone: Tone = 'default') => (
      chip(`act:${t.n}:${k}`, label, onPress, tone)
    )
    const details = btn('details', 'Details', () => openDetail($, { kind: 'todo', n: t.n }), 'details')
    const c = u.confirm?.n === t.n ? u.confirm.kind : null
    if (c === 'stop') {
      return [
        <Text color="error">Stop #{t.n}? Execution halts; the todo is kept.</Text>,
        <Box gap={1}>
          {btn('stopyes', '■ Stop', () => haltTodo($, t, 'stopped'), 'danger')}
          {btn('keep', 'Keep', () => cancelConfirm($, t.n, 'stop'), 'primary')}
        </Box>,
      ]
    }
    if (c === 'takeover') {
      return [
        <Text color="error">Take over #{t.n}? It's marked stopped here; its run in the other session isn't stopped.</Text>,
        <Box gap={1}>
          {btn('takeyes', '⇄ Takeover', () => takeOver($, t), 'danger')}
          {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'takeover'), 'primary')}
        </Box>,
      ]
    }
    // In flight in another session: its task ids aren't this one's to pause.
    if (INFLIGHT.has(t.status) && t.owner !== undefined && t.owner !== me) {
      return [
        <Box gap={1}>
          <Text dimColor>{t.status} in another session</Text>
          {btn('takeover', '⇄ Takeover', () => askConfirm($, t.n, 'takeover'))}
          {details}
        </Box>,
      ]
    }
    if (c === 'delete') {
      return [
        <Text color="error">Delete "#{t.n} {t.title}"?</Text>,
        <Box gap={1}>
          {btn('deleteyes', '✕ Delete', () => deleteTodo($, t), 'danger')}
          {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'delete'), 'primary')}
        </Box>,
      ]
    }
    switch (t.status) {
      case 'pending':
        return [
          <Box gap={1}>
            {btn('exec', '▶ Exec', () => execTodo($, t, false), 'primary')}
            {btn('rename', '✎ Rename', () => patchUi($, x => ({ ...x, renaming: t.n })))}
            {!t.hasRun && btn('delete', '✕ Delete', () => askConfirm($, t.n, 'delete'), 'danger')}
            {details}
          </Box>,
        ]
      case 'drafting':
      case 'planning':
        return [
          <Box gap={1}>
            <Text dimColor>{t.status === 'drafting' ? 'answer the prompt question in the chat…' : 'planning in the chat…'}</Text>
            {btn('reset', 'Reset', () => setTodoStatus($, t.n, t.hasRun ? 'stopped' : 'pending'))}
          </Box>,
        ]
      case 'running':
        return [
          <Box gap={1}>
            {btn('pause', '⏸ Pause', () => haltTodo($, t, 'paused'))}
            {btn('stop', '■ Stop', () => askConfirm($, t.n, 'stop'), 'danger')}
            {details}
          </Box>,
        ]
      case 'paused':
        return [
          <Box gap={1}>
            {btn('resume', '▶ Resume', () => resumeTodo($, t), 'resume')}
            {btn('stop', '■ Stop', () => askConfirm($, t.n, 'stop'), 'danger')}
            {details}
          </Box>,
        ]
      case 'stopped':
      case 'failed': {
        const fresh = u.justStopped.includes(t.n)
        return [
          ...(fresh ? [<Text color="suggestion">Stopped. What next?</Text>] : []),
          <Box gap={1}>
            {btn('refine', '✎ Refine', () => execTodo($, t, true), 'refine')}
            {btn('restart', '↻ Restart', () => restartTodo($, t), 'restart')}
            {details}
          </Box>,
          <Box gap={1}>
            {t.taskId && btn('resume', '▶ Resume', () => resumeTodo($, t), 'resume')}
            {fresh &&
              btn('leave', 'Leave', async () => {
                await patchUi($, x => ({
                  ...x,
                  justStopped: x.justStopped.filter(n => n !== t.n),
                  expanded: x.expanded.filter(id => id !== `t${t.n}`),
                }))
              })}
          </Box>,
        ]
      }
      case 'done':
        return [<Box gap={1}>{details}</Box>]
    }
  }

  const agentRows = (t: Todo) => {
    const mine = nodes.filter(a => a.todoN === t.n).sort((x, y) => x.startedAt - y.startedAt)
    let wave: number | undefined
    return mine.flatMap(a => {
      const out = []
      if (t.mode === 'workflow' && a.wave !== undefined && a.wave !== wave) {
        wave = a.wave
        out.push(
          <Box paddingLeft={2}>
            <Text dimColor>── wave {a.wave} ──</Text>
          </Box>,
        )
      }
      const [g, gc] = agentGlyph(a.status, f)
      const n = all.filter(c => c.agentId === a.agentId).length
      // A subtask is one line; its tool calls are browsed in the dialog.
      out.push(
        <Box paddingLeft={2} flexDirection="column">
          {lit(
            `ag:${a.agentId}`,
            <Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Button key={`ag:${a.agentId}`} plain onPress={() => void openDetail($, { kind: 'agent', agentId: a.agentId })}>
                  <Text wrap="truncate-end">
                    <Text color={gc}>{g}</Text> <Text color={a.kind === 'workflow' ? 'planMode' : 'permission'}>{a.name}</Text>
                    {a.isWorktree ? <Text color="warning"> ⎇</Text> : ''}
                  </Text>
                </Button>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor> {n} calls</Text>
              </Box>
            </Box>,
          )}
        </Box>,
      )
      return out
    })
  }

  // A dim rule above each todo, outside every lit() box and keyed without
  // ring:, so it's never focusable and the arrow keys' order and the room kept
  // around focusable items stay as they were.
  const ruleWidth = Math.max(0, e.props.bodyColumns - 2 * PAD_X)
  const divider = (t: Todo, color: Color) => {
    if (dividers === 'none') return []
    if (dividers === 'line') {
      return [
        <Box key={`div:${t.n}`}>
          <Text dimColor wrap="truncate-end">{'─'.repeat(ruleWidth)}</Text>
        </Box>,
      ]
    }
    const p = dividerParts(t.n, t.title, ruleWidth)
    return [
      <Box key={`div:${t.n}`}>
        <Text wrap="truncate-end">
          <Text dimColor>{p.lead}</Text>
          <Text color={color}>{p.num}</Text>
          <Text dimColor>{p.text}{p.tail}</Text>
        </Text>
      </Box>,
    ]
  }

  const todoRows = (t: Todo) => {
    const [g, gc] = todoGlyph(t.status, f)
    const isOpen = open.has(`t${t.n}`)
    const mine = nodes.filter(a => a.todoN === t.n)
    const done = mine.filter(a => a.status === 'done').length
    const right =
      mine.length > 0 && t.status !== 'pending' && t.status !== 'done' ? (
        <Text color={gc}> {t.status} {done}/{mine.length}</Text>
      ) : (
        <Text dimColor> {t.status}</Text>
      )
    const head =
      u.renaming === t.n && Input ? (
        lit(
          `ren:${t.n}`,
          <Box>
            <Text color={gc}>{g}</Text>
            <Text> #{t.n} </Text>
            <Input key={`ren:${t.n}`} value={t.title} submitLabel="rename" autoFocus onSubmit={v => void renameTodo($, t.n, v)} />
          </Box>,
        )
      ) : (
        lit(
          `todo:${t.n}`,
          <Box>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button key={`todo:${t.n}`} plain onPress={() => void toggle($, `t${t.n}`)}>
                <Text wrap="truncate-end">
                  <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                  <Text color={gc}>{g}</Text> <Text weight="semibold">#{t.n}</Text> {t.title}
                </Text>
              </Button>
            </Box>
            <Box flexShrink={0}>{right}</Box>
          </Box>,
        )
      )
    if (!isOpen) return [...divider(t, gc), head]
    return [
      ...divider(t, gc),
      head,
      <Box paddingLeft={2} flexDirection="column">
        {actions(t)}
      </Box>,
      ...agentRows(t),
    ]
  }

  const tree = (
    <Box
      flexDirection="column"
      width={e.props.bodyColumns}
      paddingX={PAD_X}
    >
      <Box>
        <Box flexGrow={1}>
          <Text>
            <Text weight="semibold">Todos </Text>
            <Text dimColor>{list.length} · </Text>
            <Text color="claude">▶{count('running')}</Text> <Text color="warning">⏸{count('paused')}</Text>{' '}
            <Text color="error">■{count('stopped')}</Text> <Text color="success">✓{count('done')}</Text>
          </Text>
        </Box>
        <Text dimColor>cap {cap} agents</Text>
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
      {view?.agentId ? chip('back', '↩ Back', () => $.ui.view({})) : ''}
      <Text> </Text>
      {list.length === 0 ? <Text dimColor>No todos yet. Type a title above.</Text> : ''}
      {list.flatMap(todoRows)}
    </Box>
  )
  drawnOrder = ringKeys(tree)
  return tree
}
