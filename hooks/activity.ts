import type { AgentInfo } from 'claude-code'

import type { AgentRow, Step, StepState, Todo } from '../types'

const MAX_AGENTS = 30
const MAX_STEPS = 200
const MAX_DETAIL = 160
const OUTPUT_LINES = 12

// The argument that says the most about a call, in the order tried.
const DETAIL_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'path',
  'url',
  'query',
  'description',
  'prompt',
] as const

const ENDED = new Set<AgentRow['status']>(['completed', 'failed', 'killed'])

export const isEnded = (row: AgentRow) => ENDED.has(row.status)

// What the person sees an agent as: its status, with "needs you" above it.
export type Phase = 'needs-you' | 'running' | 'failed' | 'stopped' | 'done'

export const phaseOf = (row: AgentRow): Phase => {
  if (row.status === 'completed') return 'done'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'killed') return 'stopped'

  return row.steps.some(step => step.state === 'running' && step.needsYou) ? 'needs-you' : 'running'
}

// Needs you first, then the running, then what ended; newest first in each.
const ORDER: Record<Phase, number> = { 'needs-you': 0, running: 1, failed: 2, stopped: 3, done: 4 }

export const sortForList = (list: readonly AgentRow[]): AgentRow[] =>
  list
    .map((row, index) => ({ row, index }))
    .sort((a, b) => ORDER[phaseOf(a.row)] - ORDER[phaseOf(b.row)] || b.index - a.index)
    .map(({ row }) => row)

export const countPhases = (list: readonly AgentRow[]): Record<Phase, number> => {
  const counts: Record<Phase, number> = { 'needs-you': 0, running: 0, failed: 0, stopped: 0, done: 0 }
  for (const row of list) counts[phaseOf(row)] += 1

  return counts
}

const single = (value: string) => value.trim().replace(/\s+/g, ' ')

const shorten = (value: string, max = MAX_DETAIL) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

export const describeCall = (args: Record<string, unknown>): string => {
  for (const key of DETAIL_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return shorten(single(value))
  }

  return ''
}

const lineCount = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value.split('\n').length : 0

// Lines a file edit adds and removes, from the call's own arguments.
export const editStats = (
  tool: string,
  args: Record<string, unknown>,
): { added: number; removed: number } | undefined => {
  if (tool === 'Edit') return { added: lineCount(args.new_string), removed: lineCount(args.old_string) }
  if (tool === 'Write') return { added: lineCount(args.content), removed: 0 }
  if (tool === 'MultiEdit' && Array.isArray(args.edits)) {
    return args.edits.reduce<{ added: number; removed: number }>(
      (sum, edit: Record<string, unknown>) => ({
        added: sum.added + lineCount(edit.new_string),
        removed: sum.removed + lineCount(edit.old_string),
      }),
      { added: 0, removed: 0 },
    )
  }

  return undefined
}

export const lastLines = (text: string, count = OUTPUT_LINES) =>
  text.trimEnd().split('\n').slice(-count).join('\n')

// "4 m 08 s", or "40 s" under a minute.
export const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60

  return minutes === 0 ? `${rest} s` : `${minutes} m ${String(rest).padStart(2, '0')} s`
}

// "3:41", a time within an agent's run.
export const formatClock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

export const elapsedOf = (row: AgentRow, now: number) => (row.endedAt ?? now) - row.startedAt

// How a step reads in the activity list (past) and as the current action (now).
export const stepWords = (step: Step): { past: string; now: string } => {
  const subject = step.detail
  switch (step.tool) {
    case 'Bash':
      return { past: `Ran ${subject}`, now: subject }
    case 'Read':
      return { past: `Read ${subject}`, now: `Reading ${subject}` }
    case 'Edit':
    case 'MultiEdit':
      return { past: `Edited ${subject}`, now: `Editing ${subject}` }
    case 'Write':
      return { past: `Wrote ${subject}`, now: `Writing ${subject}` }
    case 'Grep':
      return { past: `Searched for ${subject}`, now: `Searching for ${subject}` }
    case 'Glob':
      return { past: `Listed files matching ${subject}`, now: `Listing files matching ${subject}` }
    case 'WebFetch':
      return { past: `Fetched ${subject}`, now: `Fetching ${subject}` }
    case 'WebSearch':
      return { past: `Searched the web for ${subject}`, now: `Searching the web for ${subject}` }
    case 'TodoWrite':
      return { past: 'Updated its plan', now: 'Updating its plan' }
    case 'Text':
      return { past: subject, now: 'Writing a reply' }
    case 'Message':
      return { past: `You: ${subject}`, now: `Sending your message: ${subject}` }
    case 'MessageNow':
      return { past: `You, interrupting: ${subject}`, now: `Interrupting with your message: ${subject}` }
    case 'Agent':
      return { past: `Started a subagent: ${subject}`, now: `Starting a subagent: ${subject}` }
    default:
      return subject === ''
        ? { past: `Used ${step.tool}`, now: `Using ${step.tool}` }
        : { past: `${step.tool} ${subject}`, now: `${step.tool} ${subject}` }
  }
}

// What an agent asks the person to allow, as "wants to <this>".
export const wantsTo = (step: Step) => {
  const verb: Record<string, string> = {
    Bash: 'run',
    Read: 'read',
    Edit: 'edit',
    MultiEdit: 'edit',
    Write: 'write',
    WebFetch: 'fetch',
  }
  const subject = step.detail || step.tool

  return `${verb[step.tool] ?? `use ${step.tool} on`} ${subject}`
}

export const statsOf = (row: AgentRow) => {
  const paths = (tools: readonly string[]) =>
    new Set(row.steps.filter(step => tools.includes(step.tool)).map(step => step.detail)).size

  return {
    read: paths(['Read']),
    edited: paths(['Edit', 'MultiEdit', 'Write']),
    commands: row.steps.filter(step => step.tool === 'Bash').length,
  }
}

// The plan's progress, when the agent keeps one with TodoWrite.
export const planOf = (row: AgentRow) => {
  if (row.todos.length === 0) return undefined
  const done = row.todos.filter(todo => todo.status === 'completed').length
  const current = row.todos.find(todo => todo.status === 'in_progress')

  return { done, total: row.todos.length, current, step: Math.min(done + 1, row.todos.length) }
}

export const isText = (step: Step) => step.tool === 'Text'

// The newest tool call, open first: what a card shows as the agent's action.
export const currentStep = (row: AgentRow): Step | undefined => {
  const calls = row.steps.filter(step => !isText(step))

  return [...calls].reverse().find(step => step.state === 'running') ?? calls.at(-1)
}

export const latestText = (row: AgentRow): Step | undefined => row.steps.findLast(isText)

export const actionCount = (row: AgentRow) => row.steps.filter(step => !isText(step)).length

// Sets the text the agent has written so far in one block of its reply,
// adding the block the first time; leaves any approval asked alone.
export const writeText = (
  list: AgentRow[],
  agentId: string,
  block: { id: string; text: string; isDone: boolean },
  now: number,
): AgentRow[] =>
  withAgent(list, agentId, now, row => {
    const known = row.steps.some(step => step.id === block.id)
    const state = block.isDone ? ('done' as const) : ('running' as const)
    const steps = known
      ? row.steps.map(step =>
          step.id === block.id
            ? { ...step, detail: block.text, state, ...(block.isDone ? { endedAt: now } : {}) }
            : step,
        )
      : [
          ...row.steps,
          {
            id: block.id,
            tool: 'Text',
            detail: block.text,
            state,
            startedAt: now,
            needsYou: false,
            ...(block.isDone ? { endedAt: now } : {}),
          },
        ]

    return { ...row, steps: steps.slice(-MAX_STEPS) }
  })

const placeholder = (id: string, now: number): AgentRow => ({
  id,
  description: 'Subagent',
  type: 'agent',
  prompt: '',
  status: 'running',
  startedAt: now,
  steps: [],
  todos: [],
})

const withAgent = (
  list: AgentRow[],
  id: string,
  now: number,
  change: (row: AgentRow) => AgentRow,
): AgentRow[] => {
  const known = list.some(row => row.id === id)
  const rows = known ? list : [...list, placeholder(id, now)]

  return rows.map(row => (row.id === id ? change(row) : row)).slice(-MAX_AGENTS)
}

export const addAgent = (
  list: AgentRow[],
  agent: { id: string; description: string; type: string; prompt: string },
  now: number,
): AgentRow[] =>
  withAgent(list, agent.id, now, row => ({
    ...row,
    description: agent.description || row.description,
    type: agent.type || row.type,
    prompt: agent.prompt || row.prompt,
    status: 'running',
  }))

export const addStep = (list: AgentRow[], agentId: string, step: Step, now: number): AgentRow[] =>
  withAgent(list, agentId, now, row => ({
    ...row,
    status: isEnded(row) ? row.status : 'running',
    // A new call means any approval asked before it was answered.
    steps: [...row.steps.map(one => ({ ...one, needsYou: false })), step].slice(-MAX_STEPS),
  }))

export const setTodos = (list: AgentRow[], agentId: string, todos: Todo[]): AgentRow[] =>
  list.map(row => (row.id === agentId ? { ...row, todos } : row))

const changeStep = (
  list: AgentRow[],
  agentId: string,
  matches: (step: Step) => boolean,
  change: (step: Step) => Step,
): AgentRow[] =>
  list.map(row =>
    row.id === agentId
      ? { ...row, steps: row.steps.map(step => (matches(step) ? change(step) : step)) }
      : row,
  )

// An approval is asked by tool name alone, so it belongs to the newest open
// call of that tool.
export const markNeedsYou = (list: AgentRow[], agentId: string, tool: string, now: number): AgentRow[] => {
  const row = list.find(one => one.id === agentId)
  const step = row?.steps.findLast(one => one.state === 'running' && one.tool === tool)
  if (step === undefined) return list

  return changeStep(list, agentId, one => one.id === step.id, one => ({ ...one, needsYou: true, askedAt: now }))
}

// How long the agent has waited on the person, when it waits.
export const waitingFor = (row: AgentRow, now: number): number | undefined => {
  const asked = row.steps.find(step => step.state === 'running' && step.needsYou)?.askedAt

  return asked === undefined ? undefined : now - asked
}

export const tokenTotal = (usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) => usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

// Each model response's usage, as it lands, so a running agent's count grows.
export const addTokens = (list: AgentRow[], agentId: string, tokens: number): AgentRow[] =>
  list.map(row => (row.id === agentId ? { ...row, tokens: (row.tokens ?? 0) + tokens } : row))

export const clearNeedsYou = (list: AgentRow[], agentId: string): AgentRow[] =>
  changeStep(list, agentId, step => step.needsYou, step => ({ ...step, needsYou: false }))

export const endStep = (
  list: AgentRow[],
  agentId: string,
  stepId: string,
  end: { state: StepState; now: number; output?: string },
): AgentRow[] =>
  changeStep(
    list,
    agentId,
    step => step.id === stepId,
    step => ({
      ...step,
      state: end.state,
      endedAt: end.now,
      needsYou: false,
      ...(end.output !== undefined && end.output.trim() !== '' ? { output: lastLines(end.output) } : {}),
    }),
  )

const closeSteps = (steps: Step[], state: StepState, now: number): Step[] =>
  steps.map(step =>
    step.state === 'running' ? { ...step, state, endedAt: now, needsYou: false } : step,
  )

export const finishAgent = (
  list: AgentRow[],
  agentId: string,
  end: { answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; now: number },
): AgentRow[] =>
  withAgent(list, agentId, end.now, row => {
    const hasFailed = end.reason === 'error' || end.reason === 'refusal'
    const answer = end.answer.trim()

    return {
      ...row,
      status: end.reason === 'aborted' ? 'killed' : hasFailed ? 'failed' : 'completed',
      endedAt: end.now,
      ...(hasFailed ? { error: answer || 'The agent ended with an error.' } : {}),
      ...(!hasFailed && answer !== '' ? { answer } : {}),
      steps: closeSteps(row.steps, end.reason === 'answer' ? 'done' : 'stopped', end.now),
    }
  })

// Takes the engine's own status for every agent it still lists; returns the
// same array when nothing changed, so the caller can skip a redraw.
export const syncStatuses = (
  list: AgentRow[],
  infos: readonly AgentInfo[],
  now: number,
): AgentRow[] => {
  let hasChanged = false
  const next = list.map(row => {
    const info = infos.find(one => one.id === row.id)
    if (info === undefined || info.status === row.status) return row
    hasChanged = true
    const synced = { ...row, status: info.status }

    return isEnded(synced)
      ? { ...synced, endedAt: row.endedAt ?? now, steps: closeSteps(synced.steps, 'stopped', now) }
      : synced
  })

  return hasChanged ? next : list
}
