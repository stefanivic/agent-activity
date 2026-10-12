import { describe, expect, test } from 'claude-code/testing'

import type { AgentRow, Step } from '../types'
import {
  addAgent,
  addTokens,
  addStep,
  countPhases,
  describeCall,
  editStats,
  endStep,
  finishAgent,
  formatClock,
  formatDuration,
  markNeedsYou,
  phaseOf,
  planOf,
  setTodos,
  sortForList,
  syncStatuses,
  waitingFor,
  wantsTo,
} from '../hooks/activity'

const step = (id: string, tool = 'Bash', detail = ''): Step => ({
  id,
  tool,
  detail,
  state: 'running',
  startedAt: 0,
  needsYou: false,
})

const agent = (id: string, description = id) => ({
  id,
  description,
  type: 'general-purpose',
  prompt: `Task for ${description}`,
})

describe('formatting', () => {
  test('describes a call by its most telling argument', () => {
    expect(describeCall({ command: 'ls  -la\n  /tmp' })).toBe('ls -la /tmp')
    expect(describeCall({ file_path: '/a/notes.txt', old_string: 'x' })).toBe('/a/notes.txt')
    expect(describeCall({ unrelated: 1 })).toBe('')
    expect(describeCall({ command: 'x'.repeat(500) }).length).toBe(160)
  })

  test('counts the lines an edit adds and removes', () => {
    expect(editStats('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc' })).toEqual({ added: 3, removed: 2 })
    expect(editStats('Write', { content: 'one\ntwo' })).toEqual({ added: 2, removed: 0 })
    expect(editStats('Read', { file_path: 'x' })).toBeUndefined()
  })

  test('writes durations as the design does', () => {
    expect(formatDuration(248_000)).toBe('4 m 08 s')
    expect(formatDuration(40_000)).toBe('40 s')
    expect(formatClock(221_000)).toBe('3:41')
  })

  test('says what an agent wants to do', () => {
    expect(wantsTo(step('t', 'Bash', 'go test ./...'))).toBe('run go test ./...')
    expect(wantsTo(step('t', 'Edit', 'docs/auth.md'))).toBe('edit docs/auth.md')
  })
})

describe('agent rows', () => {
  test('a spawn adds a running row with its task', () => {
    const [row] = addAgent([], agent('a1', 'Quick'), 5)
    expect(row).toMatchObject({ id: 'a1', description: 'Quick', status: 'running', startedAt: 5 })
    expect(row?.prompt).toBe('Task for Quick')
  })

  test('an approval marks the newest open call of that tool, and the next call clears it', () => {
    let list = addAgent([], agent('a1'), 0)
    list = addStep(list, 'a1', step('t1', 'Read'), 0)
    list = addStep(list, 'a1', step('t2', 'Edit'), 0)
    list = markNeedsYou(list, 'a1', 'Edit', 10_000)
    expect(list[0] && phaseOf(list[0])).toBe('needs-you')
    expect(list[0] && waitingFor(list[0], 50_000)).toBe(40_000)

    list = addStep(list, 'a1', step('t3', 'Bash'), 1)
    expect(list[0] && phaseOf(list[0])).toBe('running')
  })

  test('an approval that ends with its call stops needing you', () => {
    let list = addAgent([], agent('a1'), 0)
    list = addStep(list, 'a1', step('t1', 'Bash'), 0)
    list = markNeedsYou(list, 'a1', 'Bash', 0)
    list = endStep(list, 'a1', 't1', { state: 'done', now: 3, output: 'a\nb\n' })
    expect(list[0]?.steps[0]).toMatchObject({ state: 'done', needsYou: false, output: 'a\nb', endedAt: 3 })
    expect(list[0] && phaseOf(list[0])).toBe('running')
  })

  test('finishing keeps the reply and the tokens, and closes open steps', () => {
    let list = addAgent([], agent('a1'), 0)
    list = addStep(list, 'a1', step('t1'), 0)
    const [done] = finishAgent(addTokens(list, 'a1', 1200), 'a1', { answer: ' done \n', reason: 'answer', now: 9 })
    expect(done).toMatchObject({ status: 'completed', answer: 'done', tokens: 1200, endedAt: 9 })
    expect(done?.steps[0]?.state).toBe('done')

    const [failed] = finishAgent(list, 'a1', { answer: 'timed out', reason: 'error', now: 9 })
    expect(failed).toMatchObject({ status: 'failed', error: 'timed out' })

    const [stopped] = finishAgent(list, 'a1', { answer: '', reason: 'aborted', now: 9 })
    expect(stopped?.status).toBe('killed')
    expect(stopped?.steps[0]?.state).toBe('stopped')
  })

  test('the engine status wins, and no change keeps the same array', () => {
    let list = addAgent([], agent('a1'), 0)
    list = addStep(list, 'a1', step('t1'), 0)
    const info = { id: 'a1', description: 'a1', type: 'general-purpose' }

    expect(syncStatuses(list, [{ ...info, status: 'running' }], 5)).toBe(list)
    const [synced] = syncStatuses(list, [{ ...info, status: 'killed' }], 5)
    expect(synced).toMatchObject({ status: 'killed', endedAt: 5 })
    expect(synced?.steps[0]?.state).toBe('stopped')
  })

  test('a todo list becomes the plan', () => {
    const list = setTodos(addAgent([], agent('a1'), 0), 'a1', [
      { content: 'Read', activeForm: 'Reading', status: 'completed' },
      { content: 'Test', activeForm: 'Testing', status: 'in_progress' },
      { content: 'Report', activeForm: 'Reporting', status: 'pending' },
    ])
    const plan = list[0] && planOf(list[0])
    expect(plan).toMatchObject({ done: 1, total: 3, step: 2 })
    expect(plan?.current?.activeForm).toBe('Testing')
  })

  test('the list puts needs you first, then running, then ended', () => {
    let list: AgentRow[] = []
    list = finishAgent(addAgent(list, agent('done'), 0), 'done', { answer: 'ok', reason: 'answer', now: 1 })
    list = addAgent(list, agent('run'), 0)
    list = addStep(addAgent(list, agent('ask'), 0), 'ask', step('t1', 'Edit'), 0)
    list = markNeedsYou(list, 'ask', 'Edit', 0)
    list = finishAgent(addAgent(list, agent('fail'), 0), 'fail', { answer: 'x', reason: 'error', now: 1 })

    expect(sortForList(list).map(row => row.id)).toEqual(['ask', 'run', 'fail', 'done'])
    expect(countPhases(list)).toEqual({ 'needs-you': 1, running: 1, failed: 1, stopped: 0, done: 1 })
  })
})
