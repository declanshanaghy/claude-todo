import type { EngineInterface, RenderInput } from 'claude-code'

import type { AgentNode, Call, Detail, ImageRef, Todo, Turn } from '../types'
import { altOf, sourceOf } from './images'
import { statusGlyph } from './marks'
import { callGlyph, dur, ringBox } from './pane'
import { showEarlier, unfold } from './register'

// The detail dialog, drawn in place of the tree. It reads like Claude Code's
// transcript: the agent's own text between its tool calls, each call with its
// input and its ⎿ result. Long blocks fold to a preview behind a toggle, the
// one thing there is to press: tab walks the toggles, enter flips one, the
// arrows scroll, and Escape (the pane losing the keys) closes the dialog.

export type DetailData = {
  detail: Detail
  list: Todo[]
  nodes: AgentNode[]
  all: Call[]
  turns: Turn[]
  ring: string | null
  unfolded: string[]
  earlier: number
  thumbs: Record<string, string>
  // Filled with the images drawn that need a PNG made, for the caller to make.
  want: ImageRef[]
}

// Arguments that read as prose wrap as text; the rest are drawn as code.
const PROSE = new Set(['prompt', 'description', 'query', 'question', 'message', 'summary'])
const LANG: Record<string, string> = { command: 'bash', script: 'javascript' }
const FILE_BODY = new Set(['content', 'old_string', 'new_string'])

// A folded block shows this much; a window is this many entries, newest last.
const PREVIEW_LINES = 6
const PREVIEW_CHARS = 600
export const WINDOW = 40
// What one drawing may hold is 100000 characters: entries stop short of it.
const BUDGET = 80000
const THUMB = { columns: 24, rows: 8 }

// An optional prop, given only when it has a value.
const opt = <K extends string>(k: K, v: string | undefined): Partial<Record<K, string>> =>
  v === undefined ? {} : ({ [k]: v } as Record<K, string>)

// Code and Markdown take tab and newline as their only control characters, so
// a tool's colours and carriage returns are dropped.
// What Code and Markdown take: no control or format character but tab and
// newline, or the host refuses the whole drawing and the dialog can't close.
// Terminal escapes go whole first; then every other C0/C1 control, format mark
// (zero-width, bidi), lone surrogate half (a cut can split a pair) and
// line/paragraph separator.
export const clean = (s: string) =>
  s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{C}\t\n]|[\p{Zl}\p{Zp}]/gu, '')

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

// Markdown in a response: a heading, a fence, a table, or a list with
// emphasis or links. A shell's or a file's text is drawn as code all the same.
export function readsAsMarkdown(text: string) {
  if (/^#{1,6} \S/m.test(text) || /^```/m.test(text) || /^\|.*\|\s*\n\|[\s:|-]+\|\s*$/m.test(text)) return true
  const items = text.match(/^\s*(?:[-*+]|\d+\.) \S/gm)?.length ?? 0
  return items >= 2 && /\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`/.test(text)
}

const isLong = (text: string) => text.length > PREVIEW_CHARS || text.split('\n').length > PREVIEW_LINES

// The first lines of a block; a fence the cut leaves open is closed.
export function previewOf(text: string, isMarkdown = false) {
  let head = text.split('\n').slice(0, PREVIEW_LINES).join('\n')
  if (head.length > PREVIEW_CHARS) head = `${head.slice(0, PREVIEW_CHARS - 1)}…`
  if (isMarkdown && (head.match(/^```/gm)?.length ?? 0) % 2 === 1) head += '\n```'
  return head
}

export function drawDetail($: EngineInterface, e: RenderInput<'Pane'>, data: DetailData) {
  const els = $.ui.resolve(e)
  const { Box, Text, Code, Markdown, Button } = els
  // Every table names every element, an omitted one drawing a fragment: only
  // the terminal's draws a picture.
  const Image = e.surface === 'terminal' && 'Image' in els ? els.Image : undefined
  const { detail, list, nodes, all, turns, ring, thumbs, want } = data
  const open = new Set(data.unfolded)
  const width = e.props.bodyColumns
  const heading = (label: string) => (
    <Box marginTop={1}>
      <Text weight="semibold" color="claude">
        {label}
      </Text>
    </Box>
  )
  const hasToggles = { is: false }
  const footer = () => (
    <Box marginTop={1}>
      <Text dimColor>esc closes · ↑↓ or a swipe scrolls{hasToggles.is ? ' · tab, then enter, unfolds' : ''}</Text>
    </Box>
  )

  // The characters this drawing holds so far, against BUDGET.
  let spent = 0
  const spend = (s: string) => ((spent += s.length), s)

  const toggle = (key: string, label: string, onPress: () => unknown) => {
    hasToggles.is = true
    return ringBox(
      els,
      ring,
      key,
      <Button key={key} label={label} plain onPress={() => void onPress()}>
        <Text color={ring === key ? 'claude' : 'subtle'}>{label}</Text>
      </Button>,
    )
  }

  // A block folded to its first lines until its toggle unfolds it.
  const fold = (id: string, text: string, draw: (shown: string) => JSX.Element, isMarkdown = false) => {
    // Cleaned after the cut: a slice can split a surrogate pair.
    if (!isLong(text)) return draw(clean(spend(text)))
    const isOpen = open.has(id)
    const shown = isOpen ? text : previewOf(text, isMarkdown)
    const more = text.split('\n').length - shown.split('\n').length
    const label = isOpen ? '▴ fold' : more > 0 ? `… +${more} lines` : '… more'
    return (
      <Box flexDirection="column">
        {draw(clean(spend(shown)))}
        {toggle(`fold:${id}`, label, () => unfold($, id))}
      </Box>
    )
  }

  const picture = (im: ImageRef, key: string) => {
    const alt = altOf(im)
    const source = Image ? sourceOf(im, thumbs) : undefined
    if (Image && thumbs[im.path] === undefined) want.push(im)
    return Image && source ? (
      <Image key={key} source={source} columns={THUMB.columns} rows={THUMB.rows} alt={alt} />
    ) : (
      <Text dimColor wrap="truncate-middle">
        ▣ {alt}
      </Text>
    )
  }

  // One step of the agent's own text, as the transcript draws a reply.
  const turnBlock = (t: Turn) => {
    const text = clean(t.text)
    return (
      <Box marginTop={1}>
        <Box flexShrink={0}>
          <Text>⏺ </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {fold(t.id, text, s => <Markdown text={s} />, true)}
        </Box>
      </Box>
    )
  }

  // One call: its ⏺ row, its input, and its ⎿ result.
  const callBlock = (c: Call) => {
    const [g, gc] = callGlyph(c.state, 0)
    const byKey = Object.fromEntries(c.fields.map(x => [x.k, x.v]))
    const oldS = byKey['old_string']
    const newS = byKey['new_string']
    const isEdit = c.tool === 'Edit' && oldS !== undefined && newS !== undefined
    const fields = c.fields.filter(x => !(isEdit && (x.k === 'old_string' || x.k === 'new_string')))
    const response = clean(c.response ?? '')
    const json = pretty(response)
    const isMd = !json && c.tool !== 'Read' && readsAsMarkdown(response)
    const result =
      c.state === 'run' ? (
        <Text dimColor>Running…</Text>
      ) : response === '' && !c.images?.length ? (
        <Text dimColor>(empty)</Text>
      ) : response === '' ? (
        ''
      ) : json ? (
        fold(`${c.id}:out`, json, s => <Code source={s} language="json" />)
      ) : isMd ? (
        fold(`${c.id}:out`, response, s => <Markdown text={s} />, true)
      ) : (
        fold(`${c.id}:out`, response, s => <Code source={s} {...opt('path', c.tool === 'Read' ? c.filePath : undefined)} />)
      )
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={gc}>{g}</Text> <Text weight="semibold">{spend(c.tool)}</Text>
          <Text dimColor>
            {' · '}
            {c.state === 'run' ? 'running' : c.state}
            {c.ms !== undefined ? ` · ${dur(c.ms)}` : ''}
          </Text>
        </Text>
        <Box flexDirection="column" paddingLeft={2}>
          {fields.length === 0 ? <Text dimColor>(no arguments)</Text> : ''}
          {fields.map(x => {
            const v = clean(x.v)
            const isShort = !v.includes('\n') && v.length + x.k.length + 2 <= width - 6
            if (PROSE.has(x.k)) {
              return (
                <Box flexDirection="column">
                  <Text dimColor>{x.k}</Text>
                  {fold(`${c.id}:in:${x.k}`, v, s => <Text wrap="wrap">{s}</Text>)}
                </Box>
              )
            }
            if (isShort && !LANG[x.k]) {
              return (
                <Text wrap="wrap">
                  <Text dimColor>{x.k}: </Text>
                  {spend(v)}
                </Text>
              )
            }
            return (
              <Box flexDirection="column">
                <Text dimColor>{x.k}</Text>
                {fold(`${c.id}:in:${x.k}`, v, s => (
                  <Code source={s} {...opt('language', LANG[x.k])} {...opt('path', FILE_BODY.has(x.k) ? c.filePath : undefined)} />
                ))}
              </Box>
            )
          })}
          {isEdit
            ? fold(
                `${c.id}:diff`,
                `${oldS}\n${newS}`,
                // A folded diff is the hunk of each side's first lines, so it parses.
                () => {
                  const isOpen = open.has(`${c.id}:diff`)
                  const half = Math.ceil(PREVIEW_LINES / 2)
                  const o = isOpen ? clean(oldS) : clean(oldS).split('\n').slice(0, half).join('\n')
                  const n = isOpen ? clean(newS) : clean(newS).split('\n').slice(0, half).join('\n')
                  return <Code source={clean(editDiff(o, n))} format="diff" {...opt('path', c.filePath)} />
                },
              )
            : ''}
        </Box>
        <Box>
          <Box flexShrink={0}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {result}
            {c.state === 'run' ? '' : (c.images ?? []).map((im, k) => picture(im, `img:${c.id}:${k}`))}
          </Box>
        </Box>
      </Box>
    )
  }

  if (detail?.kind === 'agent') {
    const a = nodes.find(x => x.agentId === detail.agentId)
    if (!a) return <Text dimColor>That subtask is no longer kept.</Text>
    const t = list.find(x => x.n === a.todoN)
    const mine = all.filter(c => c.agentId === a.agentId)
    // Turns and calls in time order; a step's text comes before its calls.
    type Entry = { at: number; o: number } & ({ turn: Turn; call?: undefined } | { call: Call; turn?: undefined })
    const entries: Entry[] = [
      ...turns.filter(x => x.agentId === a.agentId).map((x, i): Entry => ({ at: x.startedAt, o: i * 2, turn: x })),
      ...mine.map((c, i): Entry => ({ at: c.startedAt, o: i * 2 + 1, call: c })),
    ].sort((x, y) => x.at - y.at || (x.turn ? -1 : 0) - (y.turn ? -1 : 0) || x.o - y.o)
    // The newest windows, newest last, drawn until the budget is spent.
    const window = entries.slice(-WINDOW * (1 + data.earlier))
    const drawn: JSX.Element[] = []
    let isCut = false
    for (let i = window.length - 1; i >= 0; i--) {
      const x = window[i]
      if (!x) continue
      const before = spent
      const el = x.turn ? turnBlock(x.turn) : callBlock(x.call)
      if (spent > BUDGET && drawn.length > 0) {
        spent = before
        isCut = true
        break
      }
      drawn.unshift(el)
    }
    const hidden = entries.length - drawn.length
    const said = turns.filter(x => x.agentId === a.agentId).length
    return (
      <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor="claude">
        <Text wrap="truncate-end">
          {statusGlyph(els, a.status)} <Text weight="semibold">{a.name}</Text>
          {a.isWorktree ? <Text color="warning"> ⎇ worktree</Text> : ''}
        </Text>
        <Text dimColor wrap="truncate-end">
          {a.kind === 'workflow' ? `workflow agent${a.wave !== undefined ? ` · wave ${a.wave}` : ''}` : 'agent'} · {a.status} · {mine.length} tool calls
          {said ? ` · ${said} turns` : ''}
          {t ? ` · #${t.n} ${t.title}` : ''}
        </Text>
        {entries.length === 0 ? <Text dimColor>No tool calls yet.</Text> : ''}
        {hidden > 0 && isCut ? (
          <Text dimColor>▴ {hidden} earlier entries past what one drawing holds: fold some to see them</Text>
        ) : hidden > 0 ? (
          toggle('fold:earlier', `▴ ${hidden} earlier entries`, () => showEarlier($))
        ) : (
          ''
        )}
        {drawn}
        {footer()}
      </Box>
    )
  }

  if (detail?.kind === 'todo') {
    const t = list.find(x => x.n === detail.n)
    if (!t) return <Text dimColor>That todo is gone.</Text>
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
          {statusGlyph(els, t.status)} <Text weight="semibold">#{t.n} {t.title}</Text>
        </Text>
        <Text dimColor>
          {t.status} · {t.mode === 'workflow' ? 'Workflow' : t.mode === 'agent' ? 'single Agent' : 'not launched yet'}
        </Text>

        {heading('Prompt')}
        <Text wrap="wrap">{t.prompt ?? '(none yet: chosen when you exec it)'}</Text>

        {t.summary ? heading('Summary') : ''}
        {t.summary ? <Text wrap="wrap">{t.summary}</Text> : ''}

        {t.taskId || t.runId || t.branch ? heading('Run') : ''}
        {kv('task', t.taskId)}
        {kv('workflow run', t.runId)}
        {kv('script', t.scriptPath)}
        {kv('branch', t.branch)}
        {kv('landed', t.landed)}

        {mine.length > 0 ? heading(`Agents (${mine.length})`) : ''}
        {mine.map(a => {
          const n = all.filter(c => c.agentId === a.agentId).length
          return (
            <Text wrap="truncate-end">
              {statusGlyph(els, a.status)} {a.wave !== undefined ? `w${a.wave} ` : ''}
              <Text color={a.kind === 'workflow' ? 'planMode' : 'permission'}>{a.name}</Text>
              {a.isWorktree ? <Text color="warning"> ⎇</Text> : ''}
              <Text dimColor> · {n} calls</Text>
            </Text>
          )
        })}
        {footer()}
      </Box>
    )
  }

  return <Text dimColor>Nothing selected.</Text>
}
