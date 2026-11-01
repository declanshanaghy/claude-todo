import type { Color } from 'claude-code'

import type { Todo, TodoStatus } from '../types'

// One symbol and one theme color per status, for everything that names a
// status: the todo and agent rows, the pane's header summary, the status line,
// the done/failed toasts. Read them from here so no two places drift.
export type Mark = { symbol: string; color: Color }

export const MARK: Record<TodoStatus, Mark> = {
  pending: { symbol: '○', color: 'inactive' },
  drafting: { symbol: '✎', color: 'suggestion' },
  planning: { symbol: '◇', color: 'planMode' },
  // A row spins instead while it runs (SPIN in pane.tsx), in this color.
  running: { symbol: '▶', color: 'claude' },
  paused: { symbol: '⏸', color: 'warning' },
  stopped: { symbol: '■', color: 'error' },
  done: { symbol: '✓', color: 'success' },
  failed: { symbol: '✗', color: 'error' },
}

// The statuses the summaries count, in their order. The header and the status
// line both draw exactly these, so either one reads the same.
export const SUMMARY: readonly TodoStatus[] = ['running', 'paused', 'stopped', 'done', 'pending']

export type Tally = Mark & { status: TodoStatus; count: number }

export const tally = (list: readonly Todo[]): Tally[] =>
  SUMMARY.map(status => ({ status, ...MARK[status], count: list.filter(t => t.status === status).length }))

// The summary as plain text, for places that can't color it.
export const tallyText = (list: readonly Todo[]) => tally(list).map(m => `${m.symbol}${m.count}`).join(' ')
