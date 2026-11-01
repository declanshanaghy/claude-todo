import type { Color, ElementTable } from 'claude-code'

import type { Todo, TodoStatus, View } from '../types'

// The mod's one palette. Every status has one symbol, one color and that
// color's focused twin, and everything that names a status reads them from
// here: the todo and agent rows, the todo header lines, the pane's header
// summary, the status line, the done/failed toasts, and the action chips,
// which fill with the color of the status they move the todo into. Nothing
// else hard-codes a status color, so no two places can drift.
//
// The colors are raw hex, not theme keys: the theme's keys cluster (three
// greens, two reds) and have no lighter twin of each, so the hues couldn't be
// spread evenly. So the statuses and the chip tones below sit 30° apart round
// the color wheel, every one at 85% saturation and 64% lightness but stopped,
// a pure red. A raw hex color is a Color the engine paints as is. `focus` is
// the same hue with its lightness raised halfway to white: what a chip under
// the focus ring or the pointer brightens to (statusChip).
export type Mark = { symbol: string; color: Color; focus: Color }

// Stopped's red, pure, so a stopped todo never reads as a failed one: stopped,
// its ■ Stop chips and its header toggle all share it.
export const STOP_RED: Color = '#ff0000'

export const MARK: Record<TodoStatus, Mark> = {
  // Added, its background drafter still writing its prompt drafts: the
  // circle filling in toward pending's full one, in a color of its own, as
  // nothing may start it yet. 240°.
  prompting: { symbol: '◔', color: '#5555f1', focus: '#aaaaf8' },
  // The palette's one grey, which no chip ever fills with (GREYS).
  pending: { symbol: '●', color: '#8b919c', focus: '#c5c8ce' },
  drafting: { symbol: '✎', color: '#55a3f1', focus: '#aad1f8' }, // 210°
  planning: { symbol: '◇', color: '#55f1a3', focus: '#aaf8d1' }, // 150°
  // A row spins instead while it runs (SPIN), in this color. Green, as Exec,
  // Auto, Fire and Resume start a run and their chips share it. 120°.
  running: { symbol: '▶', color: '#55f155', focus: '#aaf8aa' },
  paused: { symbol: '⏸', color: '#f1f155', focus: '#f8f8aa' }, // 60°
  stopped: { symbol: '■', color: STOP_RED, focus: '#ff8080' }, // 0°
  // Landed on the base branch: a purple, 150° from running's green, so a done
  // row never reads as a running one. 270°.
  done: { symbol: '✓', color: '#a355f1', focus: '#d1aaf8' },
  failed: { symbol: '✗', color: '#f1a355', focus: '#f8d1aa' }, // 30°
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

// The rules the tree draws (a double ═ under the header and above the hidden
// footer, a single ─ between todos): one dim line in the theme's subtle grey,
// so it parts the todos without reading as a status or as a button.
export const DIVIDER: Color = 'subtle'

// A chip's tone: the status its action moves the todo into, `danger` for one
// that destroys it (Delete), `details` for ☰ Details (a todo's or a subtask's), `edit` for ✎ Rename, or
// `stay` for any other chip that changes no status (↺ Reset, ✓ Leave, ↩
// Keep/Cancel/Back).
export type Tone = TodoStatus | 'danger' | 'details' | 'edit' | 'stay'

// Grey and dim mean disabled, so an enabled chip never wears them: these are
// the theme's greys and pending's, which only a dimmed chip (statusChip's
// isDimmed), the divider and pending's mark may use. The tones below avoid
// them all.
export const GREYS: readonly Color[] = ['subtle', 'inactive', 'promptBorder', MARK.pending.color]

// A dimmed (disabled) chip's fill: a grey, so it reads as a button that can't
// act. Its symbol is an emoji (🔥), which a terminal draws in its own colors
// whatever the text's color or dim, so only the cell's fill can mute it.
export const DISABLED_FILL: Color = 'subtle'

// The chips that move no status still each wear a hue of their own, on the
// same wheel as the statuses, so none reads as disabled: Rename a lime (90°),
// Details a cyan (180°), the rest a magenta (300°), and Delete a rose (330°),
// apart from failed's orange and stopped's red.
const TONE: Record<'danger' | 'details' | 'edit' | 'stay', Pick<Mark, 'color' | 'focus'>> = {
  danger: { color: '#f155a3', focus: '#f8aad1' },
  details: { color: '#55f1f1', focus: '#aaf8f8' },
  edit: { color: '#a3f155', focus: '#d1f8aa' },
  stay: { color: '#f155f1', focus: '#f8aaf8' },
}

const toneOf = (tone: Tone) => (tone in TONE ? TONE[tone as keyof typeof TONE] : MARK[tone as TodoStatus])

export const toneColor = (tone: Tone): Color => toneOf(tone).color

// A tone's focused twin: the same hue, lighter.
export const toneFocus = (tone: Tone): Color => toneOf(tone).focus

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
// compact. Its word, the key here, is the one name every place uses: the
// Button's label (for screen readers and tests), the label a hover reveals,
// and, with what the chip does, the todo's hint line while the focus ring is
// on it. The README's Buttons bullet lists the same table. No two actions
// share a symbol. The safe "no" choices (Keep, Cancel, Back) all step back
// with ↩. A confirmation asks in the words of its chip's `does`. 🔥 ⚡ ✨ are
// two cells wide, which needs no sums here: a chip is its own flex item,
// measured by the engine.
export const CHIP: Readonly<Record<string, { symbol: string; does: string }>> = {
  Exec: { symbol: '▶', does: 'run it, picking or writing its prompt first' },
  Auto: { symbol: '⚡', does: 'run it on its first draft, asking nothing' },
  Fire: { symbol: '🔥', does: 'auto-run the lowest-numbered pending todo' },
  Rename: { symbol: '✎', does: 'give the todo a new title' },
  Refine: { symbol: '✨', does: 'rework its prompt in the chat, then run it' },
  Restart: { symbol: '↻', does: 'run it again from a fresh start' },
  Resume: { symbol: '⏵', does: 'pick its run up where it left off' },
  Pause: { symbol: '⏸', does: 'halt it, keeping its run to resume' },
  Stop: { symbol: '■', does: 'execution halts; the todo is kept' },
  Delete: { symbol: '✕', does: 'remove the todo for good' },
  Takeover: { symbol: '⇄', does: "it's marked stopped here; its run in the other session isn't stopped" },
  Details: { symbol: '☰', does: 'browse its prompt, subtasks and calls' },
  Reset: { symbol: '↺', does: 'take it back from the chat' },
  Keep: { symbol: '↩', does: 'leave it as it is' },
  Cancel: { symbol: '↩', does: 'leave it as it is' },
  Back: { symbol: '↩', does: 'back to the list' },
  Leave: { symbol: '✓', does: 'fold it away as it is' },
}

export const CHIP_SYMBOL: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(CHIP).map(([w, c]) => [w, c.symbol]))

// What a chip does as a sentence, which its confirmation asks with.
export const chipSentence = (label: string) => {
  const does = CHIP[label]?.does ?? ''
  return `${does.charAt(0).toUpperCase()}${does.slice(1)}.`
}

// The todo's hint line while the ring is on one of its chips: `✎ Rename: give
// the todo a new title`.
export const chipHint = (label: string) => [`${CHIP[label]?.symbol ?? ''} ${label}`.trim(), CHIP[label]?.does ?? ''] as const

// The hover label: a chip's word, revealed while the pointer is on the chip.
// Absolute, so it takes no row and moves nothing. The pane clips it, so the
// caller opens it on a row with room (`top` 1 below, -1 above) and shifts it
// left (`left` below 0), or anchors it at the chip's right edge (`right` 0),
// near the pane's right edge. A quiet label: the theme's plain text in
// italics, with no fill, as grey reads as disabled (GREYS); its cell of space
// either side parts it from the line it covers.
export type TipAt = { top: 1 | -1; left?: number; right?: number }

export const TIP: Color = 'text'

export const tipLabel = ({ Box, Text }: Pick<ElementTable, 'Box' | 'Text'>, word: string, at: TipAt, scope?: string) => (
  <Box
    position="absolute"
    top={at.top}
    {...(at.right === undefined ? { left: at.left ?? 0 } : { right: at.right })}
    display="none"
    hover={scope === undefined ? { display: 'flex' } : { display: 'flex', scope }}
    flexShrink={0}
  >
    <Text color={TIP} italic>
      {` ${word} `}
    </Text>
  </Box>
)

// A chip and its hover label in one keyed Box: the key makes the Box a hover
// scope, so the pointer anywhere on the chip reveals the label, with no hook
// run and no redraw.
export const withTip = ({ Box, Text }: Pick<ElementTable, 'Box' | 'Text'>, key: string, word: string, at: TipAt, node: JSX.Element) => (
  <Box key={`tip:${key}`} flexShrink={0}>
    {node}
    {tipLabel({ Box, Text }, word, at)}
  </Box>
)

// A filled chip reads as a button: a plain Button (no [ ] brackets) whose one
// Text child carries the tone's fill around its symbol, padded a cell each
// side. A todo's action chip that can't act now is never drawn: it is left
// out instead. A persistent header control (🔥 Fire) is never hidden: while
// it can't act it is dimmed: its tone's fill gives way to a grey one
// (DISABLED_FILL) under dim text, and it stays pressable, so the ring still
// reaches it and a press says why. Grey and dim are the only disabled look:
// an enabled chip always fills with a tone's color, and no tone is grey
// (GREYS).
//
// The engine inverts a Button under the focus ring or the pointer, which
// would swap the fill with the dark text and turn the chip black. So the chip
// the ring is on (`isFocused`), and any chip while the pointer is on it (its
// `hover`, which the nearest keyed Box scopes: withTip's, holding this chip
// and its label alone), is drawn already inverted, in its tone's focused
// color. Inverting it again changes nothing, so it brightens either way.
export const lifted = (tone: Tone) => ({ inverse: true, color: toneFocus(tone), backgroundColor: 'inverseText' as Color })

// A dimmed chip under the ring or the pointer, drawn already inverted the
// same way, so the engine's inversion leaves its grey fill grey.
export const greyed = { inverse: true, color: DISABLED_FILL, backgroundColor: 'inverseText' as Color, dimColor: true }

export const statusChip = (
  { Text, Button }: Pick<ElementTable, 'Text' | 'Button'>,
  key: string,
  label: string,
  onPress: () => unknown,
  tone: Tone = 'stay',
  isDimmed = false,
  isFocused = false,
) =>
  isDimmed ? (
    <Button key={key} label={label} plain dimColor onPress={() => void onPress()}>
      {isFocused ? (
        <Text weight="semibold" {...greyed}>
          {` ${CHIP_SYMBOL[label] ?? label} `}
        </Text>
      ) : (
        <Text weight="semibold" backgroundColor={DISABLED_FILL} color="inverseText" dimColor hover={greyed}>
          {` ${CHIP_SYMBOL[label] ?? label} `}
        </Text>
      )}
    </Button>
  ) : (
    <Button key={key} label={label} plain onPress={() => void onPress()}>
      {isFocused ? (
        <Text weight="semibold" {...lifted(tone)}>
          {` ${CHIP_SYMBOL[label] ?? label} `}
        </Text>
      ) : (
        <Text weight="semibold" backgroundColor={toneColor(tone)} color="inverseText" hover={lifted(tone)}>
          {` ${CHIP_SYMBOL[label] ?? label} `}
        </Text>
      )}
    </Button>
  )
