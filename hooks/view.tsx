import type { Color, Elements } from 'claude-code'

import type { AgentRow, Filter, Step } from '../types'
import {
  actionCount,
  countPhases,
  currentStep,
  elapsedOf,
  formatClock,
  formatDuration,
  formatTokens,
  isEnded,
  isText,
  latestText,
  phaseOf,
  planOf,
  sortForList,
  statsOf,
  stepWords,
  waitingFor,
  wantsTo,
} from './activity'
import type { Phase } from './activity'

export type Ui = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Code' | 'Markdown' | 'Input'>

export type Actions = {
  setFilter: (filter: Filter) => void
  open: (id: string | null) => void
  stop: (id: string) => void
  draft: (id: string, text: string) => void
  // Sends `text`, or else the agent's saved draft; `isNow` interrupts what the
  // agent is doing first.
  send: (id: string, isNow: boolean, text?: string) => void
  // Drops every agent that ended from the panel; running ones stay.
  clearFinished: () => void
  // Starts a new agent with the same task as one that ended.
  retry: (id: string) => void
  stopAll: () => void
}

// Each phase has its own symbol and word, so none depends on color alone.
const PHASE: Record<Phase, { glyph: string; label: string; color: Color }> = {
  'needs-you': { glyph: '!', label: 'Needs you', color: 'warning' },
  running: { glyph: '⠋', label: 'Running', color: 'suggestion' },
  failed: { glyph: '✗', label: 'Failed', color: 'error' },
  stopped: { glyph: '■', label: 'Stopped', color: 'inactive' },
  done: { glyph: '✓', label: 'Done', color: 'success' },
}

// The order of the summary bar and its legend, as in the design.
const LEGEND: readonly Phase[] = ['done', 'running', 'needs-you', 'failed', 'stopped']

const STEP_GLYPH: Record<Step['state'], { glyph: string; color: Color }> = {
  running: { glyph: '⠋', color: 'suggestion' },
  done: { glyph: '✓', color: 'success' },
  error: { glyph: '✗', color: 'error' },
  denied: { glyph: '⊘', color: 'warning' },
  stopped: { glyph: '■', color: 'inactive' },
}

const TOOL_GLYPH: Record<string, string> = {
  Bash: '$',
  Read: '▤',
  Edit: '✎',
  MultiEdit: '✎',
  Write: '+',
  Grep: '⌕',
  Glob: '⌕',
  WebFetch: '↓',
  WebSearch: '⌕',
  TodoWrite: '☰',
  Agent: '→',
  Message: '›',
  MessageNow: '»',
}

// The newest entries the transcript draws; older ones are counted above them.
const TRANSCRIPT_ENTRIES = 60

const FILTERS: readonly { id: Filter; label: string; hotkey: string }[] = [
  { id: 'all', label: 'All', hotkey: '1' },
  { id: 'active', label: 'Active', hotkey: '2' },
  { id: 'finished', label: 'Finished', hotkey: '3' },
]

// Past this many agents in view, the ones that ended show as single lines.
const COMPACT_AFTER = 6

const matchesFilter = (row: AgentRow, filter: Filter) =>
  filter === 'all' || (filter === 'active' ? !isEnded(row) : isEnded(row))

// A bar of `total` segments, `filled` of them in `color`, fit to `width` cells.
const Segments = (
  ui: Ui,
  key: string,
  parts: readonly { count: number; color: Color }[],
  width: number,
) => {
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (total === 0) return null
  const cell = Math.max(1, Math.floor((width - (total - 1)) / total))
  const { Box, Text } = ui

  return (
    <Box key={key} flexDirection="row" gap={1}>
      {parts.flatMap((part, index) =>
        Array.from({ length: part.count }, (_, at) => (
          <Text key={`${key}-${index}-${at}`} color={part.color}>
            {'━'.repeat(cell)}
          </Text>
        )),
      )}
    </Box>
  )
}

const planBar = (ui: Ui, row: AgentRow, width: number) => {
  const plan = planOf(row)
  if (plan === undefined) return null
  const { Box, Text } = ui
  const phase = phaseOf(row)
  const label = plan.current?.activeForm ?? plan.current?.content

  return (
    <Box flexDirection="column">
      {Segments(
        ui,
        `plan-${row.id}`,
        [
          { count: plan.done, color: phase === 'stopped' ? 'inactive' : 'suggestion' },
          { count: plan.total - plan.done, color: 'subtle' },
        ],
        width,
      )}
      <Text>
        <Text dimColor>
          Step {plan.step} of {plan.total}
          {label !== undefined ? ' · ' : ''}
        </Text>
        {label !== undefined && <Text bold>{label}</Text>}
      </Text>
    </Box>
  )
}

const nowLine = (step: Step) => `${TOOL_GLYPH[step.tool] ?? '›'} ${stepWords(step).now}`

const header = (ui: Ui, row: AgentRow, now: number, isLarge: boolean) => {
  const { Box, Text } = ui
  const phase = PHASE[phaseOf(row)]
  const meta = [
    row.type,
    phaseOf(row) === 'stopped'
      ? `stopped at ${formatDuration(elapsedOf(row, now))}`
      : phaseOf(row) === 'needs-you'
        ? `waiting ${formatDuration(waitingFor(row, now) ?? 0)}`
        : formatDuration(elapsedOf(row, now)),
    ...(isLarge && row.tokens !== undefined ? [`${formatTokens(row.tokens)} tokens`] : []),
  ].join(' · ')

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text color={phase.color} bold>
            {phase.glyph}
          </Text>
          <Text bold wrap="truncate-end">
            {row.description}
          </Text>
        </Box>
        <Text color={phase.color} bold>
          {phase.label}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          {meta}
        </Text>
      </Box>
    </Box>
  )
}

const card = (ui: Ui, row: AgentRow, now: number, width: number, actions: Actions) => {
  const { Box, Text, Button, Code } = ui
  const phase = phaseOf(row)
  const step = currentStep(row)
  const said = latestText(row)
  const stats = statsOf(row)
  const inner = Math.max(10, width - 4)

  return (
    <Box
      key={`card-${row.id}`}
      flexDirection="column"
      borderStyle={phase === 'needs-you' ? 'bold' : 'round'}
      borderColor={phase === 'needs-you' || phase === 'failed' ? PHASE[phase].color : 'subtle'}
      paddingX={1}
      gap={1}
    >
      {header(ui, row, now, false)}

      {phase === 'needs-you' && step !== undefined && (
        <Box flexDirection="column">
          <Text>Wants to {wantsTo(step)}</Text>
          <Text dimColor>Allow or deny it in Claude's permission prompt.</Text>
        </Box>
      )}

      {phase === 'running' && (
        <Box flexDirection="column" gap={1}>
          {planBar(ui, row, inner)}
          {said !== undefined && (
            <Text italic dimColor wrap="wrap">
              {said.detail.trim().split('\n').slice(-2).join('\n')}
            </Text>
          )}
          {step !== undefined && <Code source={nowLine(step)} wrap="truncate-end" />}
          <Text dimColor>
            {stats.read} files read · {stats.edited} edited · {stats.commands} commands
            {row.tokens !== undefined ? ` · ${formatTokens(row.tokens)} tokens` : ''}
          </Text>
        </Box>
      )}

      {phase === 'done' && row.answer !== undefined && (
        <Text wrap="wrap">{row.answer.split('\n').slice(0, 3).join('\n')}</Text>
      )}

      {phase === 'failed' && (
        <Code source={(row.error ?? 'The agent failed.').split('\n').slice(0, 4).join('\n')} wrap="wrap" />
      )}

      <Box flexDirection="row" gap={2}>
        <Button key={`open-${row.id}`} label={phase === 'done' ? 'See full result' : 'See activity'} onPress={() => actions.open(row.id)} />
        {!isEnded(row) && (
          <Button key={`stop-${row.id}`} label="Stop" plain onPress={() => actions.stop(row.id)} />
        )}
        {canRetry(row) && (
          <Button key={`retry-${row.id}`} label="Try again" plain onPress={() => actions.retry(row.id)} />
        )}
      </Box>
    </Box>
  )
}

const canRetry = (row: AgentRow) => (phaseOf(row) === 'failed' || phaseOf(row) === 'stopped') && row.prompt !== ''

// One line an agent, for a long list: what it is and where it stands.
const summaryOf = (row: AgentRow, now: number) => {
  const step = currentStep(row)
  const firstLine = (text: string | undefined) => text?.trim().split('\n')[0] ?? ''
  switch (phaseOf(row)) {
    case 'needs-you':
      return step === undefined ? 'needs you' : `wants to ${wantsTo(step)}`
    case 'running':
      return step === undefined ? 'starting' : stepWords(step).now
    case 'done':
      return firstLine(row.answer) || 'done'
    case 'failed':
      return `failed: ${firstLine(row.error) || 'no reason given'}`
    case 'stopped':
      return `stopped at ${formatDuration(elapsedOf(row, now))}`
  }
}

const compactRow = (ui: Ui, row: AgentRow, now: number, actions: Actions) => {
  const { Box, Text, Button } = ui
  const phase = PHASE[phaseOf(row)]

  return (
    <Box key={`compact-${row.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
      <Button key={`row-${row.id}`} plain onPress={() => actions.open(row.id)}>
        <Text color={phase.color} bold>
          {phase.glyph}
        </Text>{' '}
        <Text bold>{row.description}</Text>
        <Text dimColor> · {summaryOf(row, now)}</Text>
      </Button>
      <Text dimColor>{formatClock(elapsedOf(row, now))}</Text>
    </Box>
  )
}

export const listView = (
  ui: Ui,
  state: { list: AgentRow[]; filter: Filter; now: number; width: number },
  actions: Actions,
) => {
  const { Box, Text, Button } = ui
  const { list, filter, now, width } = state
  const counts = countPhases(list)
  const firstStart = Math.min(...list.map(row => row.startedAt))
  const lastEnd = list.every(isEnded) ? Math.max(...list.map(row => row.endedAt ?? now)) : now
  const active = list.filter(row => !isEnded(row)).length
  const tokens = list.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
  const shown = sortForList(list).filter(row => matchesFilter(row, filter))
  const sizes: Record<Filter, number> = { all: list.length, active, finished: list.length - active }

  if (list.length === 0) {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>No subagents yet. They show here as they start.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {list.length} subagent{list.length === 1 ? '' : 's'}
          </Text>
          <Text dimColor>{formatClock(lastEnd - firstStart)} elapsed</Text>
        </Box>
        {Segments(
          ui,
          'summary',
          LEGEND.map(phase => ({ count: counts[phase], color: PHASE[phase].color })),
          width,
        )}
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {LEGEND.filter(phase => counts[phase] > 0).map(phase => (
            <Text
              key={`legend-${phase}`}
              color={phase === 'needs-you' ? PHASE[phase].color : undefined}
              bold={phase === 'needs-you'}
              dimColor={phase !== 'needs-you'}
            >
              {PHASE[phase].glyph} {counts[phase]} {PHASE[phase].label.toLowerCase()}
            </Text>
          ))}
        </Box>
      </Box>

      <Box flexDirection="row" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Box flexDirection="row" gap={1}>
          {FILTERS.map(one => (
            <Button
              key={`filter-${one.id}`}
              label={`${one.label} ${sizes[one.id]}`}
              hotkey={one.hotkey}
              variant={filter === one.id ? 'primary' : 'secondary'}
              onPress={() => actions.setFilter(one.id)}
            />
          ))}
        </Box>
        {sizes.finished > 0 && (
          <Button key="clear-finished" label="Clear finished" hotkey="c" plain onPress={actions.clearFinished} />
        )}
      </Box>

      {shown.length === 0 && <Text dimColor>None here.</Text>}
      {shown.map(row =>
        shown.length > COMPACT_AFTER && isEnded(row) ? compactRow(ui, row, now, actions) : card(ui, row, now, width, actions),
      )}

      {(tokens > 0 || active > 0) && (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text dimColor>{tokens > 0 ? `${formatTokens(tokens)} tokens used by all subagents` : ''}</Text>
          {active > 0 && <Button key="stop-all" label="Stop all" onPress={actions.stopAll} />}
        </Box>
      )}
    </Box>
  )
}

const section = (ui: Ui, title: string, aside?: string) => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold dimColor>
        {title.toUpperCase()}
      </Text>
      {aside !== undefined && <Text dimColor>{aside}</Text>}
    </Box>
  )
}

export const detailView = (
  ui: Ui,
  state: { list: AgentRow[]; row: AgentRow; now: number; width: number; draft: string; canMessage: boolean },
  actions: Actions,
) => {
  const { Box, Text, Button, Code, Markdown, Input } = ui
  const { list, row, now, width, draft, canMessage } = state
  const ordered = sortForList(list)
  const at = ordered.findIndex(one => one.id === row.id)
  const previous = ordered[at - 1]
  const next = ordered[at + 1]
  const phase = phaseOf(row)
  const step = currentStep(row)
  const hiddenEntries = Math.max(0, row.steps.length - TRANSCRIPT_ENTRIES)
  const plan = planOf(row)

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Button key="back" label="‹ All subagents" hotkey="b" plain onPress={() => actions.open(null)} />
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {at + 1} of {ordered.length}
          </Text>
          {previous !== undefined && (
            <Button key="previous" label="↑" hotkey="k" plain onPress={() => actions.open(previous.id)} />
          )}
          {next !== undefined && <Button key="next" label="↓" hotkey="j" plain onPress={() => actions.open(next.id)} />}
        </Box>
      </Box>

      {header(ui, row, now, true)}
      {planBar(ui, row, width)}
      <Box flexDirection="column" gap={1}>
        {canMessage && (
          <Input
            key={`message-${row.id}`}
            label="Message this agent"
            placeholder={isEnded(row) ? 'A message resumes this agent' : 'Tell this agent something'}
            value={draft}
            onInput={text => actions.draft(row.id, text)}
            onSubmit={text => actions.send(row.id, false, text)}
          />
        )}
        <Box flexDirection="row" gap={1}>
          {canMessage && (
            <Button key={`send-${row.id}`} label="Send" variant="primary" onPress={() => actions.send(row.id, false)} />
          )}
          {canMessage && !isEnded(row) && (
            <Button key={`send-now-${row.id}`} label="Send now" onPress={() => actions.send(row.id, true)} />
          )}
          {!isEnded(row) && (
            <Button key={`stop-${row.id}`} label="■ Stop" hotkey="x" plain onPress={() => actions.stop(row.id)} />
          )}
          {canRetry(row) && (
            <Button key={`retry-${row.id}`} label="Try again" hotkey="r" onPress={() => actions.retry(row.id)} />
          )}
        </Box>
        {canMessage && !isEnded(row) && (
          <Text dimColor>
            Send delivers it when the agent next checks in. Send now interrupts what it is doing first.
          </Text>
        )}
        {!canMessage && (
          <Text dimColor>
            Messaging a subagent from here works outside auto mode. Switch modes to send it a message.
          </Text>
        )}
      </Box>

      {!isEnded(row) && step !== undefined && (
        <Box flexDirection="column">
          {section(ui, 'Now', step.state === 'running' ? formatClock(now - step.startedAt) : undefined)}
          {step.needsYou && (
            <Text color="warning" bold>
              ! Waiting for you to allow or deny this in Claude's permission prompt
            </Text>
          )}
          <Code source={nowLine(step)} wrap="wrap" />
        </Box>
      )}

      {phase === 'done' && row.answer !== undefined && latestText(row) === undefined && (
        <Box flexDirection="column">
          {section(ui, 'Result')}
          <Markdown text={row.answer} />
        </Box>
      )}

      {phase === 'failed' && (
        <Box flexDirection="column">
          {section(ui, 'Error')}
          <Code source={row.error ?? 'The agent failed.'} wrap="wrap" />
        </Box>
      )}

      {plan !== undefined && (
        <Box flexDirection="column">
          {section(ui, 'Plan')}
          {row.todos.map((todo, index) => (
            <Box key={`todo-${index}`} flexDirection="row" gap={1}>
              <Text
                color={
                  todo.status === 'completed' ? 'success' : todo.status === 'in_progress' ? 'suggestion' : 'inactive'
                }
              >
                {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '⠋' : '○'}
              </Text>
              <Text bold={todo.status === 'in_progress'} dimColor={todo.status === 'pending'}>
                {todo.content}
              </Text>
              {todo.status === 'in_progress' && <Text color="suggestion">now</Text>}
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="column" gap={1}>
        {section(ui, 'Transcript', `${actionCount(row)} actions`)}
        {row.prompt !== '' && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text bold>Task Claude gave this agent</Text>
            <Text wrap="wrap">{row.prompt}</Text>
          </Box>
        )}
        {hiddenEntries > 0 && <Text dimColor>… {hiddenEntries} earlier entries</Text>}
        {row.steps.slice(hiddenEntries).map(one =>
          isText(one) ? (
            <Box key={`step-${one.id}`} flexDirection="row" gap={1}>
              <Text color={one.state === 'running' ? 'suggestion' : 'text'}>●</Text>
              <Box flexDirection="column" flexShrink={1}>
                <Markdown key={`text-${one.id}`} text={one.detail} />
              </Box>
            </Box>
          ) : (
            <Box key={`step-${one.id}`} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Box flexDirection="row" gap={1} flexShrink={1}>
                  <Text color={STEP_GLYPH[one.state].color}>{STEP_GLYPH[one.state].glyph}</Text>
                  <Text wrap="truncate-end">{stepWords(one).past}</Text>
                </Box>
                <Box flexDirection="row" gap={1}>
                  {one.needsYou && <Text color="warning">needs you</Text>}
                  {one.added !== undefined && one.added > 0 && <Text color="diffAdded">+{one.added}</Text>}
                  {one.removed !== undefined && one.removed > 0 && <Text color="diffRemoved">−{one.removed}</Text>}
                  <Text dimColor>{formatClock(one.startedAt - row.startedAt)}</Text>
                </Box>
              </Box>
              {one.output !== undefined && (one.tool === 'Bash' || one.state !== 'done') && (
                <Box paddingLeft={2}>
                  <Code source={one.output} wrap="truncate-end" />
                </Box>
              )}
            </Box>
          ),
        )}
      </Box>
    </Box>
  )
}

// The one line above the prompt while subagents run.
export const bandView = (
  ui: Ui,
  state: { list: AgentRow[] },
  actions: { show: () => void },
) => {
  const { Box, Text, Button } = ui
  const { list } = state
  const counts = countPhases(list)
  const waiting = sortForList(list).find(row => phaseOf(row) === 'needs-you')
  const waitingStep = waiting === undefined ? undefined : currentStep(waiting)
  const words = LEGEND.filter(phase => counts[phase] > 0).map(phase => ({
    phase,
    text: `${counts[phase]} ${PHASE[phase].label.toLowerCase()}`,
  }))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color="suggestion">⠋</Text>
        <Text bold>
          {list.length} subagent{list.length === 1 ? '' : 's'}
        </Text>
        {words.map(word => (
          <Text key={`band-${word.phase}`} color={PHASE[word.phase].color}>
            · {word.text}
          </Text>
        ))}
        <Button key="show" label="Show" plain onPress={actions.show} />
      </Box>
      {waiting !== undefined && waitingStep !== undefined && (
        <Text color="warning">
          ! {waiting.description} wants to {wantsTo(waitingStep)} · allow or deny it in the prompt
        </Text>
      )}
    </Box>
  )
}
