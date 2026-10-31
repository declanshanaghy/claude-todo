import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'todo',
  component: 'Pane',
  requestId: 'todo',
  props: {
    title: 'Todos',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// Each hook stands for the engine beneath the plugin.
function engine(on: On, submitted: string[], panes = { opens: [] as string[], closes: [] as string[] }, ownClock = true) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__todo__${e.name}` } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '10\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  if (ownClock) on('clock.every', () => ({ value: undefined }))
  on('ui.open', (_, e) => (panes.opens.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (panes.closes.push(e.id), { value: undefined }))
  on('ui.focus', () => ({}) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  let t = 1000
  if (ownClock) on('clock.now', () => ({ value: (t += 250) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type T$ = Parameters<TestBody>[0]

const start = ($: T$) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const todo = ($: T$, args: string) => $.command.run({ command: 'todo', args } as never)

test('M1: /todo add stores a title-only todo and the pane lists it', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Fix kitty tab titles')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /cap 6 agents/ }))?.text).toBe('cap 6 agents')
  expect(submitted).toHaveLength(0)
  await ui.unmount()
})

test('M1: the pane input adds a todo', async ($, on) => {
  engine(on, [])
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'add', text: 'Count md files' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await ui.unmount()
})

test('M2: Exec submits the exec protocol and marks the todo drafting', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  await start($)
  await todo($, 'add Fix kitty tab titles')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:exec' })

  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('Execute todo #1 "Fix kitty tab titles"')
  expect(submitted[0]).toContain('[todo:1]')
  expect(await ui.find({ type: 'Button', key: 'act:1:reset' })).toBeDefined()
  await ui.unmount()
})

test('M3: a tagged Agent links its spawn and its tool calls show under it', async ($, on) => {
  engine(on, [])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'a.md\nb.md', stderr: '' } as never, text: 'a.md\nb.md' }))
  await start($)
  await todo($, 'add Count md files')

  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count md files', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count md files', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls *.md', agentId: 'ag1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  expect(await ui.find({ type: 'Button', key: 'act:1:pause' })).toBeDefined()
  // The tree keeps the subtask to one line: no tool call rows, no code.
  expect(await ui.find({ type: 'Button', key: 'call:c1' })).toBeUndefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()

  // Pressing the subtask turns the pane into the view-only call browser.
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Code', text: /ls \*\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /a\.md/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('M5: Stop asks first, keeps the todo, and offers what next', async ($, on) => {
  engine(on, [])
  const stopped: string[] = []
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    stopped.push(String(e.task_id))
    return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_agent' } }
  })
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count', prompt: 'count', subagent_type: 'general-purpose' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:stop' })
  expect(await ui.find({ type: 'Button', key: 'act:1:keep' })).toBeDefined()
  expect(stopped).toHaveLength(0)
  await ui.press({ key: 'act:1:stopyes' })
  expect(stopped).toEqual(['ag1'])
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:refine' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act:1:leave' })).toBeDefined()
  await ui.unmount()
})

test('M6: Delete is pre-exec only and confirms first', async ($, on) => {
  engine(on, [])
  await start($)
  await todo($, 'add Fix kitty tab titles')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:delete' })
  expect(await ui.find({ type: 'Button', key: 'act:1:cancel' })).toBeDefined()
  await ui.press({ key: 'act:1:deleteyes' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()
})

test('M4: Pause stops the task, Resume asks Claude to continue it', async ($, on) => {
  const submitted: string[] = []
  engine(on, submitted)
  const stopped: string[] = []
  on('tool.call', { tool: 'Workflow' }, () => ({
    result: { status: 'async_launched', taskId: 'task9', runId: 'wf_abc', scriptPath: '/tmp/s.js' } as never,
  }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    stopped.push(String(e.task_id))
    return { result: { message: 'stopped', task_id: String(e.task_id), task_type: 'local_workflow' } }
  })
  await start($)
  await todo($, 'add Migrate statusline')
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu1', script: "export const meta = { name: 'todo-1-statusline', description: 'x' }" } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'act:1:pause' })
  expect(stopped).toEqual(['task9'])
  await ui.press({ key: 'act:1:resume' })
  expect(submitted.at(-1)).toContain('resumeFromRunId: "wf_abc"')
  expect(await ui.find({ type: 'Button', key: 'act:1:pause' })).toBeDefined()
  await ui.unmount()
})

test('show / noshow: noshow keeps the pane closed until show', async ($, on) => {
  const opens: string[] = []
  const closes: string[] = []
  engine(on, [], { opens, closes })
  await start($)
  opens.length = 0
  expect((await todo($, 'noshow')).text).toContain('hidden')
  expect(closes).toEqual(['todo'])
  await todo($, 'add Quiet one')
  expect(opens).toHaveLength(0)
  expect((await todo($, 'show')).text).toBe('Todo pane shown.')
  expect(opens).toEqual(['todo'])
  await todo($, 'add Loud one')
  expect(opens).toEqual(['todo', 'todo'])
})

test('M3: Esc (the pane losing the keys) closes the call browser', async ($, on) => {
  engine(on, [], undefined, false)
  const clock = mock.clock(on, { now: 1000 })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  await start($)
  await todo($, 'add Count md files')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu1', description: '[todo:1] Count', prompt: 'count', subagent_type: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'count', description: '[todo:1] Count', tool_use_id: 'tu1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo:1' })
  await ui.press({ key: 'ag:ag1' })
  expect(await ui.find({ type: 'Button', key: 'todo:1' })).toBeUndefined()
  await ui.unmount()

  const blurred = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: false }, surface: 'terminal' })
  await clock.advance(1)
  await blurred.unmount()
  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await back.find({ type: 'Button', key: 'todo:1' })).toBeDefined()
  await back.unmount()
})
