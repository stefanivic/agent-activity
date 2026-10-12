export type StepState = 'running' | 'done' | 'error' | 'denied' | 'stopped'

export type Step = {
  id: string
  tool: string
  detail: string
  state: StepState
  startedAt: number
  endedAt?: number
  // The person was asked to approve this call and has not been seen to answer.
  needsYou: boolean
  // When that approval was asked.
  askedAt?: number
  // The last lines of what the call returned (a command's output, an error).
  output?: string
  added?: number
  removed?: number
}

export type Todo = {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentRowStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

export type AgentRow = {
  id: string
  description: string
  type: string
  prompt: string
  status: AgentRowStatus
  startedAt: number
  endedAt?: number
  steps: Step[]
  todos: Todo[]
  answer?: string
  error?: string
  tokens?: number
}

export type Filter = 'all' | 'active' | 'finished'

declare module 'claude-code' {
  interface PluginState {
    'agent-activity': {
      agents: AgentRow[]
      filter: Filter
      // The agent open in the detail view; null shows the list.
      openId: string | null
      // The time the drawings measure elapsed time against, moved each second
      // while an agent runs.
      now: number
      // What the person has typed to each agent and not sent yet, by agent id.
      drafts: Record<string, string>
      // The session's permission mode as last seen on a call; null before any.
      mode: string | null
    }
  }
}
