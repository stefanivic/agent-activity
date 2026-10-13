import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Step, Todo } from '../types'
import {
  addAgent,
  addTokens,
  addStep,
  clearNeedsYou,
  describeCall,
  editStats,
  endStep,
  finishAgent,
  isEnded,
  markNeedsYou,
  setTodos,
  syncStatuses,
  tokenTotal,
  writeText,
} from './activity'
import { bandView, detailView, listView } from './view'
import type { Actions } from './view'

const PANE = 'agent-activity'
const TITLE = 'Subagents'
const TICK_MS = 1000
const TEXT_FLUSH_MS = 250

const agents = atom({ plugin: 'agent-activity', key: 'agents' } as const, [])
const filter = atom({ plugin: 'agent-activity', key: 'filter' } as const, 'all')
const openId = atom({ plugin: 'agent-activity', key: 'openId' } as const, null)
const clock = atom({ plugin: 'agent-activity', key: 'now' } as const, 0)
const drafts = atom({ plugin: 'agent-activity', key: 'drafts' } as const, {})
const mode = atom({ plugin: 'agent-activity', key: 'mode' } as const, null)

// Auto mode's classifier refuses a message the panel sends, and an agent it
// starts again, as no request in the conversation asked for either, so there
// the panel offers neither the message box nor Try again.
const AUTO_MODE = 'auto'

// These hooks only watch: if one fails, the call goes on as if it were not here.
const passThrough = <E, R>(_: unknown, e: E, next: (e: E) => Promise<R>) => next(e)

// The reason a refused call gives, for the toast.
const refusal = (ran: { deny?: string; text?: string }) => ran.deny ?? ran.text ?? 'no reason given'

const isRefused = (ran: { deny?: string; isError?: true }) => ran.deny !== undefined || ran.isError === true

// Auto mode's classifier sometimes gives no verdict and asks for the same call
// once more; any other refusal stands.
const isNoVerdict = (ran: { deny?: string; text?: string }) => /gave no verdict/i.test(refusal(ran))

const callOnceMore = async <R extends { deny?: string; isError?: true; text?: string }>(
  call: () => Promise<R>,
) => {
  const ran = await call()

  return isRefused(ran) && isNoVerdict(ran) ? call() : ran
}

// The person's own request, in words the permission check reads as theirs.
const agentName = (row: AgentRow | undefined, id: string) =>
  row === undefined ? `the subagent ${id}` : `the subagent "${row.description}" (${id})`

// Resolves whether the agent was stopped, saying why not in a toast.
const stopAgent = async ($: EngineInterface, id: string, consent: string) => {
  const ran = await callOnceMore(() => $.tool.call({ tool: 'TaskStop', task_id: id, consent }))
  if (isRefused(ran)) {
    $.ui.toast(`Could not stop the agent: ${refusal(ran)}`)

    return false
  }

  return true
}

// A message to a running agent reaches it when it next checks in; one to an
// agent that ended resumes it. "Send now" stops the agent first, so the
// message resumes it at once, cutting short the call it was making.
const sendDraft = async ($: EngineInterface, id: string, isNow: boolean, typed?: string) => {
  const text = (typed ?? (await read($, drafts))[id] ?? '').trim()
  if (text === '') return
  const row = (await read($, agents)).find(one => one.id === id)
  const name = agentName(row, id)
  const isInterrupting = isNow && row !== undefined && !isEnded(row)
  if (
    isInterrupting &&
    !(await stopAgent(
      $,
      id,
      `In the Subagents pane I pressed "Send now": stop ${name} now so it can be resumed with my message: "${text}"`,
    ))
  ) {
    return
  }

  const ran = await callOnceMore(() =>
    $.tool.call({
      tool: 'SendMessage',
      to: id,
      message: text,
      summary: 'Message from the Subagents pane',
      consent: `In the Subagents pane I pressed "${isNow ? 'Send now' : 'Send'}": send ${name} this message from me: "${text}"`,
    }),
  )
  if (isRefused(ran)) {
    $.ui.toast(
      isInterrupting
        ? `Stopped the agent, but could not send the message (it is kept in the box): ${refusal(ran)}`
        : `Could not send the message (it is kept in the box): ${refusal(ran)}`,
    )
    await update($, drafts, all => ({ ...all, [id]: text }))
    return
  }

  const now = await $.clock.now()
  const sent: Step = {
    id: `message-${now}`,
    tool: isInterrupting ? 'MessageNow' : 'Message',
    detail: text,
    state: 'done',
    startedAt: now,
    endedAt: now,
    needsYou: false,
  }
  await update($, agents, list => addStep(list, id, sent, now))
  await update($, drafts, all => ({ ...all, [id]: '' }))
}

// Starts a new agent with the task, type and name of one that ended.
const retryAgent = async ($: EngineInterface, id: string) => {
  const list = await read($, agents)
  const row = list.find(one => one.id === id)
  if (row === undefined || row.prompt === '') return
  const started = await $.agent.spawn({ prompt: row.prompt, description: row.description, subagentType: row.type })
  if (started.deny !== undefined) {
    $.ui.toast(`Could not start the agent again: ${started.deny}`)
    return
  }
  // The spawn names its agent, or the agent list does: the newest one by this
  // name that the panel does not hold yet.
  const known = new Set(list.map(one => one.id))
  const agentId =
    started.agentId ??
    (await $.agent.list()).findLast(info => !known.has(info.id) && info.description === row.description)?.id
  if (agentId === undefined) {
    $.ui.toast('Started the agent again, but could not find it to follow here.')
    return
  }
  const now = await $.clock.now()
  // A spawn this plugin makes passes its own agent.spawn hook, so it is added here.
  await update($, agents, list =>
    addAgent(list, { id: agentId, description: row.description, type: row.type, prompt: row.prompt }, now),
  )
  await update($, openId, open => (open === id ? agentId : open))
}

// Stops each running agent in turn; one that will not stop says so in a toast.
const stopAll = async ($: EngineInterface) => {
  const running = (await read($, agents)).filter(row => !isEnded(row))
  for (const row of running) {
    await stopAgent($, row.id, `In the Subagents pane I pressed "Stop all": stop ${agentName(row, row.id)}.`)
  }
}

const actionsFor = ($: EngineInterface): Actions => ({
  setFilter: value => void update($, filter, () => value),
  retry: id => void retryAgent($, id).catch(error => $.ui.toast(`Could not start the agent again: ${String(error)}`)),
  stopAll: () => void stopAll($).catch(error => $.ui.toast(`Could not stop the agents: ${String(error)}`)),
  clearFinished: () =>
    void (async () => {
      const ended = new Set((await read($, agents)).filter(isEnded).map(row => row.id))
      await update($, agents, list => list.filter(row => !ended.has(row.id)))
      await update($, drafts, all => Object.fromEntries(Object.entries(all).filter(([id]) => !ended.has(id))))
      // Back to the list if the agent open in the detail view was cleared.
      await update($, openId, id => (id !== null && ended.has(id) ? null : id))
    })().catch(error => $.ui.toast(`Could not clear the finished agents: ${String(error)}`)),
  open: id => void update($, openId, () => id),
  stop: id =>
    void read($, agents).then(list =>
      stopAgent($, id, `In the Subagents pane I pressed "Stop": stop ${agentName(list.find(one => one.id === id), id)}.`),
    ),
  draft: (id, text) => void update($, drafts, all => ({ ...all, [id]: text })),
  send: (id, isNow, text) =>
    void sendDraft($, id, isNow, text).catch(error => $.ui.toast(`Could not send the message: ${String(error)}`)),
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Show what each subagent is doing in a live pane',
    })

    // Each second while an agent runs: move the clock the drawings count from,
    // and take the engine's own status, which catches an agent stopped from
    // the app or one waiting on its own background work.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const list = await read($, agents)
        if (list.length === 0 || list.every(isEnded)) return
        const now = await $.clock.now()
        const infos = await $.agent.list()
        await update($, agents, rows => syncStatuses(rows, infos, now))
        await update($, clock, () => now)
      })().catch(error => $.ui.log(`agent-activity: the status tick failed: ${String(error)}`))
    })

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Subagents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const { agentId } = started
    const { permissionMode } = e
    if (permissionMode !== undefined) await update($, mode, () => permissionMode)
    if (agentId !== undefined) {
      const now = await $.clock.now()
      await update($, clock, () => now)
      await update($, agents, list =>
        addAgent(
          list,
          { id: agentId, description: e.description, type: e.subagentType, prompt: e.prompt },
          now,
        ),
      )
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return started
  }).catch(passThrough)

  on('tool.call', async ($, e, next) => {
    const { agentId } = e
    if (agentId === undefined) return next(e)

    const args = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    const step: Step = {
      id: e.tool_use_id,
      tool: e.tool,
      detail: describeCall(args),
      state: 'running',
      startedAt: now,
      needsYou: false,
      ...editStats(e.tool, args),
    }
    await update($, agents, list => addStep(list, agentId, step, now))
    if (e.tool === 'TodoWrite') {
      const todos: Todo[] = e.todos.map(todo => ({ ...todo }))
      await update($, agents, list => setTodos(list, agentId, todos))
    }

    try {
      const ran = await next(e)
      const state = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'done'
      const output = ran.deny ?? (e.tool === 'Bash' || state === 'error' ? ran.text : undefined)
      const endedAt = await $.clock.now()
      await update($, agents, list =>
        endStep(list, agentId, step.id, { state, now: endedAt, ...(output !== undefined ? { output } : {}) }),
      )

      return ran
    } catch (error) {
      const endedAt = await $.clock.now()
      await update($, agents, list =>
        endStep(list, agentId, step.id, { state: 'error', now: endedAt, output: String(error) }),
      )
      throw error
    }
  }).catch(passThrough)

  // A subagent's reply as it streams: each text block becomes a step, written
  // a few times a second while it grows and once more when the step ends.
  on('turn.step', async function* ($, e, next) {
    const { agentId } = e
    const stream = next(e)
    if (agentId === undefined) return yield* stream

    const blocks = new Map<number, string>()
    const blockId = (index: number) => `text-${e.turnId}-${e.index}-${index}`
    let flushedAt = 0
    const flush = async (isDone: boolean) => {
      if (blocks.size === 0) return
      const now = await $.clock.now()
      flushedAt = now
      await update($, agents, list =>
        [...blocks].reduce(
          (rows, [index, text]) => writeText(rows, agentId, { id: blockId(index), text, isDone }, now),
          list,
        ),
      )
    }

    // Read by hand rather than with for-await, which drops the result the
    // stream returns: the reply has to reach the engine unchanged.
    try {
      for (;;) {
        const read = await stream.next()
        if (read.done) {
          const { usage } = read.value
          if (usage !== null) await update($, agents, list => addTokens(list, agentId, tokenTotal(usage)))

          return read.value
        }
        const chunk = read.value
        yield chunk
        if (chunk.kind !== 'text') continue
        blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text)
        if ((await $.clock.now()) - flushedAt >= TEXT_FLUSH_MS) await flush(false)
      }
    } finally {
      await flush(true)
    }
  })

  // Raised when the person is about to be asked to allow a call. The hook never
  // sees the answer itself: a later call of the agent, or this call ending,
  // is what clears it.
  on('classic.PermissionRequest', async ($, e, next) => {
    // An approval request names the session's permission mode, as each spawn
    // does; between the two the panel goes on the last one seen.
    const seen = e.permission_mode
    if (seen !== undefined) await update($, mode, () => seen)
    const agentId = e.agent_id
    if (agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agents, list => markNeedsYou(list, agentId, e.tool_name, now))
    }
    const decided = await next(e)
    if (agentId !== undefined && decided.decision !== undefined) {
      await update($, agents, list => clearNeedsYou(list, agentId))
    }

    return decided
  }).catch(passThrough)

  on('turn.complete', async ($, e, next) => {
    const { agentId } = e
    if (agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agents, list => finishAgent(list, agentId, { answer: e.answer, reason: e.reason, now }))
      await update($, clock, () => now)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    const ui = $.ui.resolve(e)
    const list = await read($, agents)
    const now = Math.max(await read($, clock), ...list.map(row => row.endedAt ?? 0))
    const width = e.props.bodyColumns
    const actions = actionsFor($)
    // An agent's transcript open in the app picks the agent, else the last one
    // opened here.
    const wanted = e.props.view.agentId ?? (await read($, openId))
    const row = list.find(one => one.id === wanted)
    const canAct = (await read($, mode)) !== AUTO_MODE

    return row === undefined
      ? listView(ui, { list, filter: await read($, filter), now, width, canAct }, actions)
      : detailView(
          ui,
          {
            list,
            row,
            now,
            width,
            draft: (await read($, drafts))[row.id] ?? '',
            canAct,
          },
          actions,
        )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, agents)
    if (e.props.hasSurvey || list.every(isEnded)) return next(e)
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)

    return bandView($.ui.resolve(e), { list }, {
      show: () => void $.ui.open({ id: PANE, title: TITLE }),
    })
  })
}
