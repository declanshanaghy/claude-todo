import type { Todo } from '../types'
import { type End, TABLE } from './transitions'

// What a todo may do next: the chips its row offers (which the /todo verbs
// share, so a chip and its command can't disagree), and the status moves the
// table in hooks/transitions.json allows (which every status write passes).

export const INFLIGHT = new Set<Todo['status']>(['drafting', 'planning', 'running', 'paused'])

// In flight in session `owner` other than `me`: its task ids aren't this
// session's. A todo paused before it ever ran (paused for a new session) has
// no run to take, so any session may start it.
export const isOwnedElsewhere = (t: Todo, me: string) =>
  INFLIGHT.has(t.status) && t.owner !== undefined && t.owner !== me && !(t.status === 'paused' && !t.hasRun)

// What ⏵ Resume is offered for, in the pane and by /todo resume: a paused
// todo, or a stopped or failed one with an agent to wake or work it kept.
export const canResume = (t: Todo) =>
  t.status === 'paused' || ((t.status === 'stopped' || t.status === 'failed') && (t.taskId !== undefined || t.isAgentGone === true))

// A todo row's action chips, each a /todo verb of the same name.
export type Chip = 'exec' | 'auto' | 'rename' | 'delete' | 'reset' | 'pause' | 'stop' | 'resume' | 'refine' | 'restart' | 'leave' | 'takeover' | 'details'

// The chips a todo's row offers, in the row's order: carry on, start over,
// put away or destroy, Details last. `justStopped` are the todos stopped
// here a moment ago, which offer ✓ Leave. A chip is offered only where it
// can act. Stop, Delete and Takeover ask first in the pane, while their
// commands, already explicit, act at once.
export function offers(t: Todo, me: string, justStopped: readonly number[]): Chip[] {
  if (isOwnedElsewhere(t, me)) return ['takeover', 'details']
  switch (t.status) {
    case 'prompting':
    case 'pending':
      // Nothing may start a prompting todo until its drafts turn it pending.
      return [...(t.status === 'pending' ? (['exec', 'auto'] as const) : []), 'rename', ...(t.hasRun ? [] : (['delete'] as const)), 'details']
    case 'drafting':
    case 'planning':
      return ['reset']
    case 'running':
      return ['pause', 'stop', 'details']
    case 'paused':
      return ['resume', 'stop', 'details']
    case 'stopped':
    case 'failed':
      return [
        ...(canResume(t) ? (['resume'] as const) : []),
        'refine',
        'restart',
        ...(justStopped.includes(t.n) ? (['leave'] as const) : []),
        'details',
      ]
    case 'done':
      return ['details']
  }
}

// ---------- the guard ----------

// Whether hooks/transitions.json allows a todo to go `from` → `to`. A write
// that keeps the status isn't a move, so it always may.
export const canMove = (from: End, to: End) => from === to || TABLE.transitions.some(m => m.from === from && m.to === to)

// Where a todo `from` may go, in the table's order.
export const movesFrom = (from: End) => [...new Set(TABLE.transitions.filter(m => m.from === from && m.to !== from).map(m => m.to))]

const shown = (s: End) => (s === '[*]' ? 'removed' : s)

// What a refused move says: the move, and the moves the table does allow.
export function moveRefusal(n: number, from: End, to: End) {
  const can = movesFrom(from).map(shown)
  return `#${n} can't go from ${from} to ${shown(to)}: from ${from} it can only go to ${can.length ? can.join(', ') : 'nowhere'}.`
}
