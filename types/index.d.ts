export type TodoStatus =
  | 'pending'
  | 'drafting'
  | 'planning'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'done'
  | 'failed'

export type Todo = {
  n: number
  title: string
  status: TodoStatus
  prompt?: string
  mode?: 'agent' | 'workflow'
  // Agent/Workflow tool calls made for this todo; agent.spawn links by them.
  toolUseIds: string[]
  // What TaskStop takes: the Workflow's taskId, or the background Agent's id.
  taskId?: string
  runId?: string
  scriptPath?: string
  summary?: string
  // Its git branch, and the commit it pushed to the base branch once landed.
  branch?: string
  landed?: string
  // When it turned done; the tree hides it once its time there is up.
  doneAt?: number
  hasRun: boolean
  // The session that put it in flight; another session shows it, and can take
  // it over.
  owner?: string
}

export type AgentNode = {
  agentId: string
  todoN: number
  parentAgentId?: string
  name: string
  wave?: number
  kind: 'agent' | 'workflow'
  isWorktree: boolean
  status: 'running' | 'paused' | 'stopped' | 'done' | 'failed'
  startedAt: number
}

export type Call = {
  id: string
  agentId: string
  tool: string
  arg: string
  // Each argument, stringified and capped, for the detail dialog.
  fields: { k: string; v: string }[]
  filePath?: string
  response?: string
  state: 'run' | 'ok' | 'err' | 'interrupted'
  ms?: number
  startedAt: number
}

export type Confirm = 'stop' | 'delete' | 'takeover'

export type PaneUi = {
  expanded: string[]
  confirm: { n: number; kind: Confirm } | null
  renaming: number | null
  justStopped: number[]
  // /todo noshow: keep the pane closed until /todo show.
  isHidden: boolean
}

// What the view-only detail dialog shows.
export type Detail = { kind: 'agent'; agentId: string } | { kind: 'todo'; n: number } | null

declare module 'claude-code' {
  // Merges into the engine's own interface, which a type alias can't.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface PluginState {
    todo: {
      // This session's copy of its directory's todos; the database holds them.
      list: Shaped<Todo[]>
      // Before 0.3: the session's own todos, migrated at session start.
      todos: Shaped<Todo[]>
      // The list's directory, the session root it came from, and the rev and
      // last call seq this copy stands at; stamp is the file's last mtimes.
      dir: string
      root: string
      rev: number
      seq: number
      stamp: string
      me: string
      fault: string
      persisted: boolean
      db: { bin: string; file: string } | null
      agents: Shaped<AgentNode[]>
      calls: Shaped<Call[]>
      ui: Shaped<PaneUi>
      cpuCap: number
      spin: number
      detail: Detail
      // The key of the element the pane's focus ring is on.
      ring: string | null
      // A done todo's time in the tree in ms (0 keeps it), and the todos past it.
      ttl: number
      expired: number[]
    }
  }
}
