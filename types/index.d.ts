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
  // Its agent can't be woken again (stopped by the person, or taken over from
  // another session): ▶ Resume starts a fresh agent on the work it kept.
  isAgentGone?: boolean
}

// A worktree a todo's agent left behind, found by its agent id in git.
export type Kept = { agentId: string; name: string; path: string; branch: string }

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
  // The pictures its result carried, by reference: never their bytes.
  images?: ImageRef[]
}

// A picture a call's result carried: the file it was read from, or the sidecar
// its base64 was spooled to (`spooled`), loaded only when the dialog draws it.
export type ImageRef = {
  name: string
  path: string
  // Its size in bytes, when known.
  bytes?: number
  // `image/png`, `image/jpeg`, …
  mediaType: string
  spooled?: boolean
}

// What an agent wrote between its tool calls: one model step's visible text.
// Kept in the calls table beside the calls, told apart by `kind`.
export type Turn = {
  kind: 'turn'
  id: string
  agentId: string
  text: string
  startedAt: number
}

export type Confirm = 'stop' | 'delete' | 'takeover'

// What the pane draws above each todo: a dim rule with its number and title
// set in, a plain dim rule, or nothing.
export type Dividers = 'titled' | 'line' | 'none'

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
      warned: string
      persisted: boolean
      db: { bin: string; file: string } | null
      agents: Shaped<AgentNode[]>
      calls: Shaped<Call[]>
      turns: Shaped<Turn[]>
      // The call browser's unfolded blocks, how many windows of older entries
      // it shows, and its thumbnails: an image's path to the PNG drawn for it
      // ('mem' held in memory, '' when it can't be drawn).
      unfolded: string[]
      earlier: number
      thumbs: Record<string, string>
      ui: Shaped<PaneUi>
      cpuCap: number
      spin: number
      detail: Detail
      // Whether a surface draws the pane now; the status line counts while not.
      placed: boolean
      // The key of the element the pane's focus ring is on.
      ring: string | null
      // A done todo's time in the tree in ms (0 keeps it), and the todos past it.
      ttl: number
      expired: number[]
      // What the pane draws above each todo.
      dividers: Dividers
    }
  }
}
