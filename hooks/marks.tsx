import type { Color, ElementTable } from 'claude-code'

import type { Todo, TodoStatus } from '../types'

// The mod's one palette. Every status has one symbol and one theme color, and
// everything that names a status reads them from here: the todo and agent
// rows, the dividers, the pane's header summary, the status line, the
// done/failed toasts, and the action chips, which fill with the color of the
// status they move the todo into. Nothing else hard-codes a status color, so
// no two places can drift.
export type Mark = { symbol: string; color: Color }

export const MARK: Record<TodoStatus, Mark> = {
  pending: { symbol: '○', color: 'inactive' },
  drafting: { symbol: '✎', color: 'suggestion' },
  planning: { symbol: '◇', color: 'planMode' },
  // A row spins instead while it runs (SPIN), in this color. Green, as Exec
  // and Resume start a run and their chips share it.
  running: { symbol: '▶', color: 'success' },
  paused: { symbol: '⏸', color: 'warning' },
  stopped: { symbol: '■', color: 'error' },
  // Landed on the base branch: the merged color, so it never reads as running.
  done: { symbol: '✓', color: 'merged' },
  failed: { symbol: '✗', color: 'error' },
}

// Claude Code's own spinner, which a running row draws in place of ▶.
export const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']

export const markOf = (s: TodoStatus): Mark => MARK[s]

// The glyph a row shows for a status at animation frame `f`.
export function glyphOf(s: TodoStatus, f = 0): [string, Color] {
  const { symbol, color } = MARK[s]
  return [s === 'running' ? (SPIN[f % SPIN.length] ?? symbol) : symbol, color]
}

export const countOf = (list: readonly Todo[], s: TodoStatus) => list.filter(t => t.status === s).length

// The statuses the summaries count, in their order. The header and the status
// line both draw exactly these, so either one reads the same.
export const SUMMARY: readonly TodoStatus[] = ['running', 'paused', 'stopped', 'done', 'pending']

export type Tally = Mark & { status: TodoStatus; count: number }

export const tally = (list: readonly Todo[]): Tally[] => SUMMARY.map(status => ({ status, ...MARK[status], count: countOf(list, status) }))

// The summary as plain text, for places that can't color it (the status line).
export const tallyText = (list: readonly Todo[]) => tally(list).map(m => `${m.symbol}${m.count}`).join(' ')

// The toast for a todo that settled: its mark, number and status.
export const statusToast = (n: number, s: TodoStatus) => `${MARK[s].symbol} #${n} ${s}`

// A chip's tone: the status its action moves the todo into, `danger` for one
// that destroys it (Delete), or `neutral` for one that changes no status.
export type Tone = TodoStatus | 'danger' | 'neutral'

export const toneColor = (tone: Tone): Color => (tone === 'danger' ? 'error' : tone === 'neutral' ? 'subtle' : MARK[tone].color)

// ---------- widgets, for any surface that embeds the palette ----------

type Els = Pick<ElementTable, 'Text'>

// A status's glyph in its color; a running one spins at frame `f`.
export function statusGlyph({ Text }: Els, s: TodoStatus, f = 0) {
  const [g, color] = glyphOf(s, f)
  return <Text color={color}>{g}</Text>
}

// The colored counts, as Text children to set inside a line of text:
// `▶1 ⏸0 ■2 ✓4 ○3`.
export const tallySummary = ({ Text }: Els, list: readonly Todo[]) =>
  tally(list).map((m, i) => (
    <Text color={m.color}>
      {i > 0 ? ' ' : ''}
      {m.symbol}
      {m.count}
    </Text>
  ))

// A filled chip reads as a button: a plain Button (no [ ] brackets) whose one
// Text child carries the tone's fill. A dimmed chip (one that can't act now)
// drops the fill for dim text in the tone's color, so it still says what it
// would do; it stays pressable, so the focus ring still reaches it.
export const statusChip = (
  { Text, Button }: Pick<ElementTable, 'Text' | 'Button'>,
  key: string,
  label: string,
  onPress: () => unknown,
  tone: Tone = 'neutral',
  isDimmed = false,
) =>
  isDimmed ? (
    <Button key={key} label={label} plain dimColor onPress={() => void onPress()}>
      <Text weight="semibold" color={toneColor(tone)} dimColor>
        {` ${label} `}
      </Text>
    </Button>
  ) : (
    <Button key={key} label={label} plain onPress={() => void onPress()}>
      <Text weight="semibold" backgroundColor={toneColor(tone)} color="inverseText">
        {` ${label} `}
      </Text>
    </Button>
  )
