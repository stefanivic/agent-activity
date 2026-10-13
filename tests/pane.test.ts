import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PLUGIN = 'agent-activity'

const paneProps = (agentId?: string) => ({
  title: 'Subagents',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 80 },
  view: agentId === undefined ? {} : { agentId },
})

// Stands in for the engine beneath the plugin: a spawn answers an id per call.
const engineBeneath = (on: On) => {
  mock.clock(on)
  // A spawn the plugin itself makes arrives with no tool_use_id of its own.
  on('agent.spawn', (_$, e) => ({
    model: 'test-model',
    agentId: e.tool_use_id === undefined ? `agent-retry-${e.description}` : `agent-${e.tool_use_id}`,
  }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

const spawn = ($: Engine, id: string, description: string, permissionMode?: string) =>
  $.agent.spawn({
    tool_use_id: id,
    prompt: `Please ${description.toLowerCase()}.`,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  })

const complete = ($: Engine, agentId: string, answer: string, reason: 'answer' | 'error' = 'answer') =>
  $.turn.complete({
    answer,
    durationMs: 10,
    isAborted: false,
    turnId: `turn-${agentId}`,
    agentId,
    reason,
  })

const mountPane = <S extends (typeof SURFACES)[number]>($: Engine, surface: S, agentId?: string) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: 'agent-activity',
    props: paneProps(agentId),
  })

for (const surface of SURFACES) {
  test(`${surface}: the list has the summary, the filters and a card per agent`, async ($, on) => {
    engineBeneath(on)
    await spawn($, 'q', 'Quick')
    await spawn($, 'r', 'Reader')
    await complete($, 'agent-r', 'line one')
    const pane = await mountPane($, surface)

    expect(await pane.find({ type: 'Text', text: '2 subagents' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✓ 1 done' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⠋ 1 running' })).toBeDefined()
    expect((await pane.findAll({ type: 'Button' })).map(button => button.text)).toEqual(
      expect.arrayContaining(['All 2', 'Active 1', 'Finished 1', 'See full result', 'See activity']),
    )
    expect(await pane.find({ type: 'Text', text: 'line one' })).toBeDefined()

    await pane.press({ key: 'filter-finished' })
    expect(await pane.find({ type: 'Text', text: 'Reader' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Quick' })).toBeUndefined()
  })

  test(`${surface}: Clear finished drops the agents that ended and keeps the running`, async ($, on) => {
    engineBeneath(on)
    await spawn($, 'q', 'Quick')
    await spawn($, 'r', 'Reader')
    await complete($, 'agent-r', 'line one')
    const pane = await mountPane($, surface)

    await pane.press({ key: 'clear-finished' })
    expect(await pane.find({ type: 'Text', text: '1 subagent' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Quick' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Reader' })).toBeUndefined()
    // Nothing left to clear, so the button goes.
    expect(await pane.find({ key: 'clear-finished' })).toBeUndefined()
  })

  test(`${surface}: a card opens the agent's detail, and back returns`, async ($, on) => {
    engineBeneath(on)
    await spawn($, 's', 'Sleeper')
    const pane = await mountPane($, surface)

    await pane.press({ key: 'open-agent-s' })
    expect(await pane.find({ type: 'Text', text: 'Task Claude gave this agent' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Please sleeper.' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '1 of 1' })).toBeDefined()

    await pane.press({ key: 'back' })
    expect(await pane.find({ type: 'Text', text: '1 subagent' })).toBeDefined()
  })

  test(`${surface}: the detail view sends a message to the agent`, async ($, on) => {
    engineBeneath(on)
    const sent: { to: unknown; message: string }[] = []
    on('tool.call', { tool: 'SendMessage' }, (_$, e) => {
      sent.push({ to: e.to, message: e.message })

      return { result: { success: true } }
    })
    await spawn($, 's', 'Sleeper')
    const pane = await mountPane($, surface, 'agent-s')

    await pane.input({ key: 'message-agent-s', text: '  wrap it up  ' })
    expect(sent).toEqual([{ to: 'agent-s', message: 'wrap it up' }])
    expect(await pane.find({ type: 'Text', text: 'You: wrap it up' })).toBeDefined()

    // Sent drafts are cleared, so pressing Send again sends nothing.
    await pane.press({ key: 'send-agent-s' })
    expect(sent).toHaveLength(1)
  })

  test(`${surface}: Send now stops the agent, then sends the message`, async ($, on) => {
    engineBeneath(on)
    const calls: string[] = []
    on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
      calls.push(`stop ${e.task_id}`)

      return { result: { message: 'stopped', task_id: e.task_id ?? '', task_type: 'local_agent' } }
    })
    on('tool.call', { tool: 'SendMessage' }, (_$, e) => {
      calls.push(`send ${e.message}`)

      return { result: { success: true } }
    })
    await spawn($, 's', 'Sleeper')
    const pane = await mountPane($, surface, 'agent-s')

    await pane.input({ key: 'message-agent-s', text: 'stop sleeping', kind: 'change' })
    expect(calls).toEqual([])
    await pane.press({ key: 'send-now-agent-s' })
    expect(calls).toEqual(['stop agent-s', 'send stop sleeping'])
    expect(await pane.find({ type: 'Text', text: 'You, interrupting: stop sleeping' })).toBeDefined()
  })

  test(`${surface}: a message is asked once more when auto mode gives no verdict`, async ($, on) => {
    engineBeneath(on)
    const consents: (string | undefined)[] = []
    on('tool.call', { tool: 'SendMessage' }, (_$, e) => {
      // `consent` rides along at run time; the hook's input type leaves it out.
      consents.push((e as { consent?: string }).consent)

      return consents.length === 1
        ? { deny: 'The server-side auto mode classifier gave no verdict for SendMessage.' }
        : { result: { success: true } }
    })
    await spawn($, 's', 'Sleeper')
    const pane = await mountPane($, surface, 'agent-s')

    await pane.input({ key: 'message-agent-s', text: 'wrap it up' })
    expect(consents).toHaveLength(2)
    expect(consents[0]).toContain('send the subagent "Sleeper" (agent-s) this message from me: "wrap it up"')
    expect(await pane.find({ type: 'Text', text: 'You: wrap it up' })).toBeDefined()
  })

  test(`${surface}: a refused message stays in the box`, async ($, on) => {
    engineBeneath(on)
    let tries = 0
    on('tool.call', { tool: 'SendMessage' }, () => {
      tries += 1

      return { deny: 'Not allowed.' }
    })
    await spawn($, 's', 'Sleeper')
    const pane = await mountPane($, surface, 'agent-s')

    await pane.input({ key: 'message-agent-s', text: 'wrap it up' })
    expect(tries).toBe(1)
    expect((await pane.find({ key: 'message-agent-s' }))?.text).toBe('wrap it up')
    expect(await pane.find({ type: 'Text', text: 'You: wrap it up' })).toBeUndefined()
  })

  test(`${surface}: the transcript shows what the agent writes, as it streams`, async ($, on) => {
    engineBeneath(on)
    on('turn.step', async function* (_$, e) {
      yield { kind: 'text' as const, index: 0, text: 'Starting the ' }
      yield { kind: 'text' as const, index: 0, text: 'count now.' }

      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'Starting the count now.',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: {
          model: 'test-model',
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 0,
        },
      }
    })
    await spawn($, 's', 'Sleeper')
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1, agentId: 'agent-s' })
    const seen: string[] = []
    let read = await stream.next()
    while (read.done !== true) {
      if (read.value.kind === 'text') seen.push(read.value.text)
      read = await stream.next()
    }
    expect(seen).toEqual(['Starting the ', 'count now.'])
    // The reply reaches the engine unchanged through the plugin's hook.
    expect(read.value.answer).toBe('Starting the count now.')

    const pane = await mountPane($, surface, 'agent-s')
    expect(await pane.find({ type: 'Markdown', text: 'Starting the count now.' })).toBeDefined()
    await pane.unmount()

    const list = await mountPane($, surface)
    expect(await list.find({ type: 'Text', text: 'Starting the count now.' })).toBeDefined()
    // Tokens count up as each response lands, while the agent still runs.
    expect(await list.find({ type: 'Text', text: /2k tokens$/ })).toBeDefined()
    expect(await list.find({ type: 'Text', text: /^0 files read · 0 edited · 0 commands/ })).toBeDefined()
    expect(await list.find({ type: 'Text', text: '2k tokens used by all subagents' })).toBeDefined()
  })

  test(`${surface}: Try again starts a new agent with the same task`, async ($, on) => {
    on('agent.list', () => ({
      value: [{ id: 'agent-retry-Benchmark', description: 'Benchmark', type: 'general-purpose', status: 'running' as const }],
    }))
    engineBeneath(on)
    await spawn($, 'b', 'Benchmark')
    await complete($, 'agent-b', 'timed out after 120 s', 'error')
    const pane = await mountPane($, surface)

    await pane.press({ key: 'retry-agent-b' })
    expect(await pane.find({ type: 'Text', text: '2 subagents' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '⠋ 1 running' })).toBeDefined()
    expect(await pane.find({ key: 'open-agent-retry-Benchmark' })).toBeDefined()
  })

  test(`${surface}: Stop all stops each running agent`, async ($, on) => {
    engineBeneath(on)
    const stopped: (string | undefined)[] = []
    on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
      stopped.push(e.task_id)

      return { result: { message: 'stopped', task_id: e.task_id ?? '', task_type: 'local_agent' } }
    })
    await spawn($, 'q', 'Quick')
    await spawn($, 's', 'Sleeper')
    await spawn($, 'r', 'Reader')
    await complete($, 'agent-r', 'line one')
    const pane = await mountPane($, surface)

    await pane.press({ key: 'stop-all' })
    expect(stopped.sort()).toEqual(['agent-q', 'agent-s'])
  })

  test(`${surface}: a long list shows the agents that ended as single lines`, async ($, on) => {
    engineBeneath(on)
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await spawn($, id, `Agent ${id}`)
      await complete($, `agent-${id}`, `Result ${id}`)
    }
    await spawn($, 'g', 'Agent g')
    const pane = await mountPane($, surface)

    expect(await pane.find({ key: 'row-agent-a' })).toBeDefined()
    expect(await pane.find({ key: 'row-agent-g' })).toBeUndefined()
    expect(await pane.find({ key: 'open-agent-g' })).toBeDefined()

    await pane.press({ key: 'row-agent-a' })
    expect(await pane.find({ type: 'Text', text: 'Please agent a.' })).toBeDefined()
  })

  test(`${surface}: auto mode offers no message box or Try again, other modes do`, async ($, on) => {
    engineBeneath(on)
    await spawn($, 's', 'Sleeper', 'auto')
    const inAuto = await mountPane($, surface, 'agent-s')

    expect(await inAuto.find({ key: 'message-agent-s' })).toBeUndefined()
    expect(await inAuto.find({ key: 'send-agent-s' })).toBeUndefined()
    expect(await inAuto.find({ key: 'stop-agent-s' })).toBeDefined()
    expect(await inAuto.find({ type: 'Text', text: /work outside auto mode/ })).toBeDefined()
    await inAuto.unmount()

    await complete($, 'agent-s', 'cut short', 'error')
    const listInAuto = await mountPane($, surface)
    expect(await listInAuto.find({ key: 'retry-agent-s' })).toBeUndefined()
    await listInAuto.unmount()

    await spawn($, 'q', 'Quick', 'default')
    const inDefault = await mountPane($, surface, 'agent-q')
    expect(await inDefault.find({ key: 'message-agent-q' })).toBeDefined()
    expect(await inDefault.find({ key: 'send-now-agent-q' })).toBeDefined()
  })

  test(`${surface}: an agent's transcript open in the app shows its detail`, async ($, on) => {
    engineBeneath(on)
    await spawn($, 'q', 'Quick')
    await spawn($, 's', 'Sleeper')
    const pane = await mountPane($, surface, 'agent-q')

    expect(await pane.find({ type: 'Text', text: 'Please quick.' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Please sleeper.' })).toBeUndefined()
  })

  test(`${surface}: says so when there are no subagents`, async ($, on) => {
    engineBeneath(on)
    const pane = await mountPane($, surface)

    expect(await pane.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  })

  test(`${surface}: the band above the prompt sums up running agents`, async ($, on) => {
    engineBeneath(on)
    await spawn($, 'q', 'Quick')
    await spawn($, 'r', 'Reader')
    await complete($, 'agent-r', 'line one')
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: true,
        maxRows: 4,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 4 },
        view: {},
      },
    })

    expect(await band.find({ type: 'Text', text: '2 subagents' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '· 1 running' })).toBeDefined()
    expect(await band.find({ type: 'Button', text: 'Show' })).toBeDefined()
  })
}
