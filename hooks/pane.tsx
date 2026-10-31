import type { Color, EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, PaneUi, Todo } from '../types'
import {
  addTodo,
  askConfirm,
  cancelConfirm,
  deleteTodo,
  execTodo,
  haltTodo,
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

// Layout and glyphs follow docs/mockup.html (scene M3).
const SPIN = ['◐', '◓', '◑', '◒']
const CALLS_SHOWN = 60

type $ = EngineInterface

function todoGlyph(s: Todo['status'], f: number): [string, Color] {
  switch (s) {
    case 'pending': return ['○', 'inactive']
    case 'drafting': return ['✎', 'suggestion']
    case 'planning': return ['◇', 'planMode']
    case 'running': return [SPIN[f]!, 'suggestion']
    case 'paused': return ['⏸', 'warning']
    case 'stopped': return ['■', 'error']
    case 'done': return ['✓', 'success']
    case 'failed': return ['✗', 'error']
  }
}

function agentGlyph(s: AgentNode['status'], f: number): [string, Color] {
  return s === 'running' ? [SPIN[f]!, 'suggestion'] : todoGlyph(s, f)
}

function callGlyph(s: Call['state'], f: number): [string, Color] {
  switch (s) {
    case 'run': return [SPIN[f]!, 'suggestion']
    case 'ok': return ['✓', 'success']
    case 'err': return ['✗', 'error']
    case 'interrupted': return ['⏸', 'warning']
  }
}

const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export function drawPane($: $, e: RenderInput<'Pane'>, { list, nodes, all, u, cap, f }: PaneData) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Code } = els
  const Input = 'Input' in els ? els.Input : undefined

  const open = new Set(u.expanded)
  const view = e.props.view as { agentId?: string } | undefined
  const count = (s: Todo['status']) => list.filter(t => t.status === s).length

  const actions = (t: Todo) => {
    const btn = (k: string, label: string, onPress: () => unknown, primary = false) => (
      <Button key={`act:${t.n}:${k}`} label={label} variant={primary ? 'primary' : undefined} onPress={() => void onPress()} />
    )
    const c = u.confirm?.n === t.n ? u.confirm.kind : null
    if (c === 'stop') {
      return [
        <Text color="error">Stop #{t.n}? Execution halts; the todo is kept.</Text>,
        <Box gap={1}>
          {btn('stopyes', '■ Stop', () => haltTodo($, t, 'stopped'))}
          {btn('keep', 'Keep running', () => cancelConfirm($, t.n, 'stop'), true)}
        </Box>,
      ]
    }
    if (c === 'delete') {
      return [
        <Text color="error">Delete "#{t.n} {t.title}"?</Text>,
        <Box gap={1}>
          {btn('deleteyes', '✕ Delete', () => deleteTodo($, t))}
          {btn('cancel', 'Cancel', () => cancelConfirm($, t.n, 'delete'), true)}
        </Box>,
      ]
    }
    switch (t.status) {
      case 'pending':
        return [
          <Box gap={1}>
            {btn('exec', '▶ Exec', () => execTodo($, t, false), true)}
            {btn('rename', '✎ Rename', () => patchUi($, x => ({ ...x, renaming: t.n })))}
            {!t.hasRun && btn('delete', '✕ Delete', () => askConfirm($, t.n, 'delete'))}
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
            {btn('stop', '■ Stop', () => askConfirm($, t.n, 'stop'))}
          </Box>,
        ]
      case 'paused':
        return [
          <Box gap={1}>
            {btn('resume', '▶ Resume', () => resumeTodo($, t), true)}
            {btn('stop', '■ Stop', () => askConfirm($, t.n, 'stop'))}
          </Box>,
        ]
      case 'stopped':
      case 'failed': {
        const fresh = u.justStopped.includes(t.n)
        return [
          ...(fresh ? [<Text color="suggestion">Stopped. What next?</Text>] : []),
          <Box gap={1}>
            {btn('refine', '✎ Refine prompt & restart', () => execTodo($, t, true), true)}
            {btn('restart', '↻ Restart as-is', () => restartTodo($, t))}
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
        return []
    }
  }

  const callRows = (a: AgentNode) => {
    const mine = all.filter(c => c.agentId === a.agentId).slice(-CALLS_SHOWN)
    return mine.flatMap(c => {
      const [g, gc] = callGlyph(c.state, f)
      const isOpen = open.has(`c${c.id}`)
      const row = (
        <Box paddingLeft={6}>
          <Box flexGrow={1}>
            <Button key={`call:${c.id}`} plain onPress={() => void toggle($, `c${c.id}`)}>
              <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
              <Text color={gc}>{g}</Text> <Text bold>{c.tool}</Text> <Text dimColor>{c.arg}</Text>
            </Button>
          </Box>
          <Text dimColor> {c.state === 'ok' || c.state === 'err' ? dur(c.ms) : ''}</Text>
        </Box>
      )
      if (!isOpen) return [row]
      return [
        row,
        <Box paddingLeft={8} flexDirection="column">
          <Text dimColor>input</Text>
          <Code source={c.input} language="json" />
          <Text dimColor>response</Text>
          {c.state === 'run' ? <Text color="suggestion">running…</Text> : <Code source={c.response ?? ''} />}
        </Box>,
      ]
    })
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
      const isOpen = open.has(`a${a.agentId}`)
      const n = all.filter(c => c.agentId === a.agentId).length
      out.push(
        <Box paddingLeft={2}>
          <Box flexGrow={1}>
            <Button key={`ag:${a.agentId}`} plain onPress={() => void toggle($, `a${a.agentId}`)}>
              <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
              <Text color={gc}>{g}</Text> <Text color={a.kind === 'workflow' ? 'planMode' : 'permission'}>{a.name}</Text>
              {a.isWorktree ? <Text color="warning"> ⎇ worktree</Text> : ''}
            </Button>
          </Box>
          <Text dimColor> {n} calls</Text>
        </Box>,
      )
      if (isOpen) {
        out.push(...callRows(a))
        out.push(
          <Box paddingLeft={6}>
            {a.kind === 'agent' ? (
              <Button key={`view:${a.agentId}`} label="↗ Transcript" onPress={() => void $.ui.view({ agentId: a.agentId })} />
            ) : (
              <Text dimColor>(workflow agent · traced here, no transcript view)</Text>
            )}
          </Box>,
        )
      }
      return out
    })
  }

  const todoRows = (t: Todo) => {
    const [g, gc] = todoGlyph(t.status, f)
    const isOpen = open.has(`t${t.n}`)
    const mine = nodes.filter(a => a.todoN === t.n)
    const done = mine.filter(a => a.status === 'done').length
    const right =
      t.status === 'done' && t.summary ? (
        <Text color="success" wrap="truncate-end"> {t.summary}</Text>
      ) : mine.length > 0 && t.status !== 'pending' ? (
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
          <Box flexGrow={1}>
            <Button key={`todo:${t.n}`} plain onPress={() => void toggle($, `t${t.n}`)}>
              <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
              <Text color={gc}>{g}</Text> <Text bold>#{t.n}</Text> {t.title}
            </Button>
          </Box>
          {right}
        </Box>
      )
    if (!isOpen) return [head]
    return [
      head,
      ...(t.prompt
        ? [
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">“{t.prompt}”</Text>
            </Box>,
          ]
        : []),
      <Box paddingLeft={2} flexDirection="column">
        {actions(t)}
      </Box>,
      ...agentRows(t),
    ]
  }

  return (
    <Box flexDirection="column" width={e.props.bodyColumns}>
      <Box>
        <Box flexGrow={1}>
          <Text>
            <Text dimColor>{list.length} · </Text>
            <Text color="suggestion">▶{count('running')}</Text> <Text color="warning">⏸{count('paused')}</Text>{' '}
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
      {view?.agentId ? <Button key="back" label="↩ Main conversation" onPress={() => void $.ui.view({})} /> : ''}
      <Text> </Text>
      {list.length === 0 ? <Text dimColor>No todos yet. Type a title above.</Text> : ''}
      {list.flatMap(todoRows)}
    </Box>
  )
}
