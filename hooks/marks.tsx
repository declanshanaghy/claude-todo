import type { Color, ElementTable } from 'claude-code'

import type { Todo, TodoStatus, View } from '../types'

// The mod's one palette. Every status has one symbol and one theme color, and
// everything that names a status reads them from here: the todo and agent
// rows, the todo header lines, the pane's header summary, the status line, the
// done/failed toasts, and the action chips, which fill with the color of the
// status they move the todo into. Nothing else hard-codes a status color, so
// no two places can drift.
export type Mark = { symbol: string; color: Color }

export const MARK: Record<TodoStatus, Mark> = {
  // Added, its background drafter still writing its prompt drafts: the
  // circle filling in toward pending's full one, in a color of its own, as
  // nothing may start it yet.
  prompting: { symbol: '◔', color: 'remember' },
  pending: { symbol: '●', color: 'inactive' },
  drafting: { symbol: '✎', color: 'suggestion' },
  planning: { symbol: '◇', color: 'planMode' },
  // A row spins instead while it runs (SPIN), in this color. Green, as Exec,
  // Auto, Fire and Resume start a run and their chips share it.
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

// A status's mark with what follows it, the one way any place spells a status
// in symbols: a todo header's right end (`▶ 2/5`, `✓`), each summary count
// (`▶1`), the status line. Running spins at frame `f` where the caller animates
// one; a static place passes none and draws ▶. The word stays the label.
export function markText(s: TodoStatus, rest = '', f?: number): [string, Color] {
  const [g, color] = f === undefined ? [MARK[s].symbol, MARK[s].color] : glyphOf(s, f)
  return [`${g}${rest}`, color]
}

// The views the pane's header toggles, one per status the summaries count,
// in their order; drafting and planning count (and show) as running. The
// header and the status line both draw exactly these, so either one reads the
// same, and their counts add up to the whole list.
export type { View }

export const SUMMARY: readonly View[] = ['running', 'prompting', 'pending', 'failed', 'paused', 'stopped', 'done']

// What a fresh pane shows: the work that's live or waiting on you, a todo
// still being prompted included. Paused, stopped and done todos are a toggle
// away.
export const DEFAULT_VIEW: readonly View[] = ['running', 'prompting', 'pending', 'failed']

export const viewOf = (s: TodoStatus): View => (s === 'drafting' || s === 'planning' ? 'running' : s)

export const countOf = (list: readonly Todo[], v: View) => list.filter(t => viewOf(t.status) === v).length

export type Tally = Mark & { status: View; count: number }

export const tally = (list: readonly Todo[]): Tally[] => SUMMARY.map(status => ({ status, ...MARK[status], count: countOf(list, status) }))

// A count as drawn: its status's mark and the number, `▶1`.
const tallyMark = (m: Tally) => markText(m.status, String(m.count))[0]

// The summary as plain text, for places that can't color it (the status line).
export const tallyText = (list: readonly Todo[]) => tally(list).map(tallyMark).join(' ')

// The toast for a todo that settled: its mark, number and status.
export const statusToast = (n: number, s: TodoStatus) => `${MARK[s].symbol} #${n} ${s}`

// The rules the tree draws (a single ─ between todos, a double ═ above the
// first todo and the hidden footer): one dim line in
// the theme's subtle color, the same grey the neutral chips wear, so it parts
// the todos without reading as a status.
export const DIVIDER: Color = 'subtle'

// A chip's tone: the status its action moves the todo into, `danger` for one
// that destroys it (Delete), `details` for ☰ Details, or `neutral` for any
// other chip that changes no status.
export type Tone = TodoStatus | 'danger' | 'details' | 'neutral'

// Details moves no status, so it wears a teal of its own instead of the
// neutral grey. The theme's one true teal is planMode, which planning's mark
// owns, so it takes ide, the theme's nearest distinct cyan.
const TONE: Record<'danger' | 'details' | 'neutral', Color> = { danger: 'error', details: 'ide', neutral: 'subtle' }

export const toneColor = (tone: Tone): Color => (tone in TONE ? TONE[tone as keyof typeof TONE] : MARK[tone as TodoStatus].color)

// ---------- widgets, for any surface that embeds the palette ----------

type Els = Pick<ElementTable, 'Text'>

// A status's glyph in its color; a running one spins at frame `f`.
export function statusGlyph({ Text }: Els, s: TodoStatus, f = 0) {
  const [g, color] = glyphOf(s, f)
  return <Text color={color}>{g}</Text>
}

// A view's toggle: its mark and count in its color, `▶1`. Lit while the view
// shows its todos; dim and struck through while it hides them. A Button with
// its view's name as label, so the focus ring and a screen reader reach it.
export const viewToggle = (
  { Text, Button }: Pick<ElementTable, 'Text' | 'Button'>,
  m: Tally,
  isShown: boolean,
  onPress: () => unknown,
) => (
  <Button key={`view:${m.status}`} label={m.status} plain onPress={() => void onPress()}>
    {isShown ? (
      <Text color={m.color}>{tallyMark(m)}</Text>
    ) : (
      <Text color={m.color} dimColor strikethrough>
        {tallyMark(m)}
      </Text>
    )}
  </Button>
)

// Each action chip draws one symbol, not its word, so a row of them stays
// compact; the word stays the Button's label, for screen readers and tests.
// No two actions share a symbol. The safe "no" choices (Keep, Cancel, Back)
// all step back with ↩, and a confirmation row spells out what its ■, ✕ or
// ⇄ will do beside it. 🔥 ⚡ ✨ are two cells wide, which needs no sums here:
// a chip is its own flex item, measured by the engine.
export const CHIP_SYMBOL: Readonly<Record<string, string>> = {
  Exec: '▶',
  Auto: '⚡',
  Fire: '🔥',
  Rename: '✎',
  Refine: '✨',
  Restart: '↻',
  Resume: '⏵',
  Pause: '⏸',
  Stop: '■',
  Delete: '✕',
  Takeover: '⇄',
  Details: '☰',
  Reset: '↺',
  Keep: '↩',
  Cancel: '↩',
  Back: '↩',
  Leave: '✓',
  'Full transcript': '↗',
}

// A filled chip reads as a button: a plain Button (no [ ] brackets) whose one
// Text child carries the tone's fill around its symbol, padded a cell each
// side. A todo's action chip that can't act now is never drawn: it is left
// out instead. A persistent header control (🔥 Fire) is never hidden: while
// it can't act it is dimmed, dropping the fill for dim text in its tone's
// color, and stays pressable, so the ring still reaches it and a press says
// why.
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
        {` ${CHIP_SYMBOL[label] ?? label} `}
      </Text>
    </Button>
  ) : (
    <Button key={key} label={label} plain onPress={() => void onPress()}>
      <Text weight="semibold" backgroundColor={toneColor(tone)} color="inverseText">
        {` ${CHIP_SYMBOL[label] ?? label} `}
      </Text>
    </Button>
  )
