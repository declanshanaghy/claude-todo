import type { Color, EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, PaneUi, Todo } from '../types'
import {
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
  toggle,
} from './register'

// What the render hook in register.tsx read from $.state for this draw.
export type PaneData = {
  list: Todo[]
  nodes: AgentNode[]
  all: Call[]
  u: PaneUi
  cap: number
  f: number
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
    case 'running': return [SPIN[f % SPIN.length]!, 'claude']
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

type Tone = 'primary' | 'danger' | 'default'
const TONE: Record<Tone, Color> = { primary: 'claude', danger: 'error', default: 'subtle' }

export const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export function drawPane($: $, e: RenderInput<'Pane'>, { list, nodes, all, u, cap, f }: PaneData) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined

  // A filled chip reads as a button: a plain Button (no [ ] brackets) whose one
  // Text child carries the fill; the focus ring inverts it.
  const chip = (key: string, label: string, onPress: () => unknown, tone: Tone = 'default') => (
    <Button key={key} label={label} plain onPress={() => void onPress()}>
      <Text bold backgroundColor={TONE[tone]} color="inverseText">
        {` ${label} `}
      </Text>
    </Button>
  )

  const open = new Set(u.expanded)
  const view = e.props.view as { agentId?: string } | undefined
  const count = (s: Todo['status']) => list.filter(t => t.status === s).length

  const actions = (t: Todo) => {
    const btn = (k: string, label: string, onPress: () => unknown, tone: Tone = 'default') => (
      chip(`act:${t.n}:${k}`, label, onPress, tone)
    )
    const details = btn('details', 'Details', () => openDetail($, { kind: 'todo', n: t.n }))
    const c = u.confirm?.n === t.n ? u.confirm.kind : null
    if (c === 'stop') {
      return [
        <Text color="error">Stop #{t.n}? Execution halts; the todo is kept.</Text>,
        <Box gap={1}>
          {btn('stopyes', '■ Stop', () => haltTodo($, t, 'stopped'), 'danger')}
          {btn('keep', 'Keep running', () => cancelConfirm($, t.n, 'stop'), 'primary')}
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
            {btn('resume', '▶ Resume', () => resumeTodo($, t), 'primary')}
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
            {btn('refine', '✎ Refine prompt & restart', () => execTodo($, t, true), 'primary')}
            {btn('restart', '↻ Restart as-is', () => restartTodo($, t))}
            {details}
          </Box>,
          <Box gap={1}>
            {t.taskId && btn('resume', '▶ Resume', () => resumeTodo($, t))}
            {fresh &&
              btn('leave', 'Leave stopped', async () => {
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
        <Box paddingLeft={2}>
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
      )
      return out
    })
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
        <Box>
          <Text color={gc}>{g}</Text>
          <Text> #{t.n} </Text>
          <Input key={`ren:${t.n}`} value={t.title} submitLabel="rename" autoFocus onSubmit={v => void renameTodo($, t.n, v)} />
        </Box>
      ) : (
        <Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Button key={`todo:${t.n}`} plain onPress={() => void toggle($, `t${t.n}`)}>
              <Text wrap="truncate-end">
                <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                <Text color={gc}>{g}</Text> <Text bold>#{t.n}</Text> {t.title}
              </Text>
            </Button>
          </Box>
          <Box flexShrink={0}>{right}</Box>
        </Box>
      )
    if (!isOpen) return [head]
    return [
      head,
      <Box paddingLeft={2} flexDirection="column">
        {actions(t)}
      </Box>,
      ...agentRows(t),
    ]
  }

  return (
    <Box
      flexDirection="column"
      width={e.props.bodyColumns}
      paddingX={1}
    >
      <Box>
        <Box flexGrow={1}>
          <Text>
            <Text bold>Todos </Text>
            <Text dimColor>{list.length} · </Text>
            <Text color="claude">▶{count('running')}</Text> <Text color="warning">⏸{count('paused')}</Text>{' '}
            <Text color="error">■{count('stopped')}</Text> <Text color="success">✓{count('done')}</Text>
          </Text>
        </Box>
        <Text dimColor>cap {cap} agents</Text>
      </Box>
      {Input ? (
        <Box>
          <Text color="claude">＋ </Text>
          <Input key="add" placeholder="add todo…" submitLabel="add" value="" autoFocus onSubmit={v => void addTodo($, v)} />
        </Box>
      ) : (
        <Text dimColor>/todo add &lt;title&gt; adds a todo</Text>
      )}
      {view?.agentId ? chip('back', '↩ Main conversation', () => $.ui.view({})) : ''}
      <Text> </Text>
      {list.length === 0 ? <Text dimColor>No todos yet. Type a title above.</Text> : ''}
      {list.flatMap(todoRows)}
    </Box>
  )
}
