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
  hasRun: boolean
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
  input: string
  response?: string
  state: 'run' | 'ok' | 'err' | 'interrupted'
  ms?: number
  startedAt: number
}

export type PaneUi = {
  expanded: string[]
  confirm: { n: number; kind: 'stop' | 'delete' } | null
  renaming: number | null
  justStopped: number[]
}

declare module 'claude-code' {
  interface PluginState {
    todo: {
      todos: Shaped<Todo[]>
      agents: Shaped<AgentNode[]>
      calls: Shaped<Call[]>
      ui: Shaped<PaneUi>
      cpuCap: number
      spin: number
    }
  }
}
