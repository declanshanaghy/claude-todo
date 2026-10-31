import type { EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, Detail, Todo } from '../types'
import { callGlyph, dur, todoGlyph } from './pane'

// The view-only detail dialog, drawn in place of the tree: no Buttons or
// fields, so the keys only scroll it, and Escape (the pane losing the keys)
// closes it.

export type DetailData = {
  detail: Detail
  list: Todo[]
  nodes: AgentNode[]
  all: Call[]
}

// Arguments that read as prose wrap as text; the rest are drawn as code.
const PROSE = new Set(['prompt', 'description', 'query', 'question', 'message', 'summary'])
const LANG: Record<string, string> = { command: 'bash', script: 'javascript' }
const FILE_BODY = new Set(['content', 'old_string', 'new_string'])

function editDiff(oldS: string, newS: string) {
  const o = oldS.split('\n')
  const n = newS.split('\n')
  return [`@@ -1,${o.length} +1,${n.length} @@`, ...o.map(l => `-${l}`), ...n.map(l => `+${l}`)].join('\n')
}

function pretty(text: string) {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return undefined
  }
}

export function drawDetail($: EngineInterface, e: RenderInput<'Pane'>, { detail, list, nodes, all }: DetailData) {
  const { Box, Text, Code } = $.ui.resolve(e)
  const width = e.props.bodyColumns
  const heading = (label: string) => (
    <Box marginTop={1}>
      <Text bold color="claude">
        {label}
      </Text>
    </Box>
  )
  const footer = <Box marginTop={1}><Text dimColor>esc closes · ↑↓ PgUp PgDn scroll</Text></Box>

  // One call: a rule naming it, then its input and response.
  const callBlock = (c: Call, i: number, count: number) => {
    const [g, gc] = callGlyph(c.state, 0)
    const byKey = Object.fromEntries(c.fields.map(x => [x.k, x.v]))
    const isEdit = c.tool === 'Edit' && byKey.old_string !== undefined && byKey.new_string !== undefined
    const fields = c.fields.filter(x => !(isEdit && (x.k === 'old_string' || x.k === 'new_string')))
    const response = c.response ?? ''
    const json = pretty(response)
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          <Text dimColor>── {i + 1}/{count} </Text>
          <Text color={gc}>{g}</Text> <Text bold>{c.tool}</Text>
          <Text dimColor>
            {'  '}
            {c.state === 'run' ? 'running' : c.state}
            {c.ms !== undefined ? ` · ${dur(c.ms)}` : ''} ──
          </Text>
        </Text>
        {fields.length === 0 ? <Text dimColor>(no arguments)</Text> : ''}
        {fields.map(x => {
          const isShort = !x.v.includes('\n') && x.v.length + x.k.length + 2 <= width - 4
          if (PROSE.has(x.k)) {
            return (
              <Box flexDirection="column">
                <Text dimColor>{x.k}</Text>
                <Text wrap="wrap">{x.v}</Text>
              </Box>
            )
          }
          if (isShort && !LANG[x.k]) {
            return (
              <Text wrap="wrap">
                <Text dimColor>{x.k}: </Text>
                {x.v}
              </Text>
            )
          }
          return (
            <Box flexDirection="column">
              <Text dimColor>{x.k}</Text>
              <Code source={x.v} language={LANG[x.k]} path={FILE_BODY.has(x.k) ? c.filePath : undefined} />
            </Box>
          )
        })}
        {isEdit ? <Code source={editDiff(byKey.old_string!, byKey.new_string!)} format="diff" path={c.filePath} /> : ''}
        <Text dimColor>⎿ response</Text>
        {c.state === 'run' ? (
          <Text dimColor>Running…</Text>
        ) : response === '' ? (
          <Text dimColor>(empty)</Text>
        ) : json ? (
          <Code source={json} language="json" />
        ) : (
          <Code source={response} path={c.tool === 'Read' ? c.filePath : undefined} />
        )}
      </Box>
    )
  }

  if (detail?.kind === 'agent') {
    const a = nodes.find(x => x.agentId === detail.agentId)
    if (!a) return <Text dimColor>That subtask is no longer kept.</Text>
    const t = list.find(x => x.n === a.todoN)
    const mine = all.filter(c => c.agentId === a.agentId)
    const [g, gc] = todoGlyph(a.status, 0)
    return (
      <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor="claude">
        <Text wrap="truncate-end">
          <Text color={gc}>{g}</Text> <Text bold>{a.name}</Text>
          {a.isWorktree ? <Text color="warning"> ⎇ worktree</Text> : ''}
        </Text>
        <Text dimColor wrap="truncate-end">
          {a.kind === 'workflow' ? `workflow agent${a.wave !== undefined ? ` · wave ${a.wave}` : ''}` : 'agent'} · {a.status} · {mine.length} tool calls
          {t ? ` · #${t.n} ${t.title}` : ''}
        </Text>
        {mine.length === 0 ? <Text dimColor>No tool calls yet.</Text> : ''}
        {mine.map((c, i) => callBlock(c, i, mine.length))}
        {footer}
      </Box>
    )
  }

  if (detail?.kind === 'todo') {
    const t = list.find(x => x.n === detail.n)
    if (!t) return <Text dimColor>That todo is gone.</Text>
    const [g, gc] = todoGlyph(t.status, 0)
    const mine = nodes.filter(a => a.todoN === t.n).sort((x, y) => x.startedAt - y.startedAt)
    const kv = (k: string, v?: string) =>
      v ? (
        <Text wrap="truncate-middle">
          <Text dimColor>{k}: </Text>
          {v}
        </Text>
      ) : (
        ''
      )

    return (
      <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor="claude">
        <Text>
          <Text color={gc}>{g}</Text> <Text bold>#{t.n} {t.title}</Text>
        </Text>
        <Text dimColor>
          {t.status} · {t.mode === 'workflow' ? 'Workflow' : t.mode === 'agent' ? 'single Agent' : 'not launched yet'}
        </Text>

        {heading('Prompt')}
        <Text wrap="wrap">{t.prompt ?? '(none yet: chosen when you exec it)'}</Text>

        {t.summary ? heading('Summary') : ''}
        {t.summary ? <Text wrap="wrap">{t.summary}</Text> : ''}

        {t.taskId || t.runId ? heading('Run') : ''}
        {kv('task', t.taskId)}
        {kv('workflow run', t.runId)}
        {kv('script', t.scriptPath)}

        {mine.length > 0 ? heading(`Agents (${mine.length})`) : ''}
        {mine.map(a => {
          const [ag, agc] = todoGlyph(a.status, 0)
          const n = all.filter(c => c.agentId === a.agentId).length
          return (
            <Text wrap="truncate-end">
              <Text color={agc}>{ag}</Text> {a.wave !== undefined ? `w${a.wave} ` : ''}
              <Text color={a.kind === 'workflow' ? 'planMode' : 'permission'}>{a.name}</Text>
              {a.isWorktree ? <Text color="warning"> ⎇</Text> : ''}
              <Text dimColor> · {n} calls</Text>
            </Text>
          )
        })}
        {footer}
      </Box>
    )
  }

  return <Text dimColor>Nothing selected.</Text>
}
