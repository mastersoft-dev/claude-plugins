import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const COLD_AT = '2026-10-06T09:46:00Z'
const WARM_AT = '2026-10-06T11:50:00Z'
const SCROLL = { offset: 0, bodyRows: 40 }
const PANE_PROPS = { title: 'Relay', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} } as const
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 160, scroll: SCROLL, view: {} } as const

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Add CSV export to orders', toolUses: [] },
  {
    role: 'assistant',
    text: 'Two tests fail on formatDate.',
    toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'src/export.ts' }, text: 'ok' }],
  },
]

type Recorded = { argv: string[][]; commands: string[]; fills: string[]; forks: number; copies: number; closes: number; toasts: string[] }

type SessionOptions = { lastAssistant: string; env?: Record<string, string>; fillRefused?: boolean; notPlaced?: boolean; agentStartFails?: boolean }

type TestClock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }

function ran(exitCode: number, stdout: string) {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function fakeSession(on: On, options: SessionOptions) {
  const recorded: Recorded = { argv: [], commands: [], fills: [], forks: 0, copies: 0, closes: 0, toasts: [] }
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u', ...options.env })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', (_$, e) => {
    recorded.commands.push(e.command)
    return {}
  })
  on('ui.open', () => ({ value: options.notPlaced === true ? { isPlaced: false, reason: 'narrow terminal' } : { isPlaced: true } }))
  on('ui.close', () => {
    recorded.closes += 1
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    recorded.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => {
    recorded.copies += 1
    return { value: { isCopied: true } }
  })
  on('prompt.fill', (_$, e) => {
    recorded.fills.push(e.text)
    return options.fillRefused === true ? { isFilled: false, refusal: 'dialog' as const } : { isFilled: true }
  })
  on('model.fork', () => {
    recorded.forks += 1
    return { value: { isAnswered: true, text: 'summary', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 148_000, window: 1_000_000 }, rateLimits: [] } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: `{"type":"user","timestamp":"${COLD_AT}"}\n{"type":"assistant","timestamp":"${options.lastAssistant}"}\n` }))
  on('process.run', (_$, e) => {
    recorded.argv.push([...e.argv])
    if (e.argv[0] === 'which') return { value: ran(e.argv[1] === 'codex' ? 0 : 1, '') }
    if (e.argv[0] === 'herdr' && e.argv[1] === 'pane' && e.argv[2] === 'split') return { value: ran(0, '{"result":{"pane":{"pane_id":"w1:p9"}}}') }
    if (e.argv[0] === 'herdr' && e.argv[2] === 'start' && options.agentStartFails === true) return { value: ran(1, 'agent did not start') }
    if (e.argv[0] === 'herdr') return { value: ran(0, '{}') }
    return { value: ran(0, '## feat/csv\n M src/export.ts\n') }
  })
  return { clock, recorded }
}

async function runRelayCommand($: Engine, clock: TestClock, args: string) {
  await $.command.run({ command: 'relay', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.advance(0)
  await clock.settle()
}

async function mountPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'relay', surface, component: 'Pane', requestId: 'relay', props: PANE_PROPS })
}

test('/relay on a cold session opens the pane with local summary preselected and installed agents only', async ($, on) => {
  const { clock } = fakeSession(on, { lastAssistant: COLD_AT })
  await runRelayCommand($, clock, '')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    for (const key of ['target', 'mode', 'summary', 'go', 'copy']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /Cache cold · idle 2h 14m · 148k/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toContain('OpenCode')
    expect(JSON.stringify(await ui.drawn())).toContain('Codex')
    await ui.unmount()
  }
})

test('a cold session with a large context raises the band', async ($, on) => {
  const { clock } = fakeSession(on, { lastAssistant: COLD_AT })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'relay', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ key: 'relay-open' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cache expired 2h 14m ago/ })).toBeDefined()
  await ui.unmount()
})

test('Continue clears, fills the draft once even when pressed twice, and never forks on a cold cache', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT })
  await runRelayCommand($, clock, '')
  const ui = await mountPane($)
  await Promise.all([ui.press({ key: 'go' }), ui.press({ key: 'go' })])

  expect(recorded.commands.filter(command => command === 'clear')).toHaveLength(1)
  expect(recorded.fills).toHaveLength(1)
  expect(recorded.fills[0]).toContain('read-only')
  expect(recorded.forks).toBe(0)
})

test('/relay codex model on a cold cache waits for confirmation instead of forking', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT })
  await runRelayCommand($, clock, 'codex model')
  const ui = await mountPane($)

  expect(recorded.forks).toBe(0)
  expect(await ui.find({ type: 'Text', text: /press Continue to confirm/ })).toBeDefined()
})

test('a warm cache preselects the model summary when /relay opens the pane', async ($, on) => {
  const { clock } = fakeSession(on, { lastAssistant: WARM_AT })
  await runRelayCommand($, clock, '')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeDefined()
  expect(JSON.stringify(await ui.find({ key: 'summary' }))).toContain('"value":"model"')
})

test('a refused draft keeps the pane open with the error and the prompt on the clipboard', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT, fillRefused: true })
  await runRelayCommand($, clock, '')
  const ui = await mountPane($)
  await ui.press({ key: 'go' })

  expect(recorded.copies).toBe(1)
  expect(recorded.closes).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Failed: the draft did not reach the prompt/ })).toBeDefined()
})

test('/relay sonnet clears, switches the model and fills the draft, warning when the model did not change', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT })
  await runRelayCommand($, clock, 'sonnet')

  expect(recorded.commands).toEqual(['clear', 'model'])
  expect(recorded.fills).toHaveLength(1)
  expect(recorded.closes).toBe(1)
  expect(recorded.toasts.at(-1)).toContain('did not switch it')
})

test('a pane that cannot be placed stops /relay before any handover', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT, notPlaced: true })
  await runRelayCommand($, clock, 'sonnet')

  expect(recorded.commands).toEqual([])
  expect(recorded.fills).toHaveLength(0)
  expect(recorded.toasts.at(-1)).toContain('narrow terminal')
})

test('outside herdr and Orca /relay codex puts the prompt on the clipboard', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT })
  await runRelayCommand($, clock, 'codex')

  expect(recorded.copies).toBe(1)
  expect(recorded.argv.some(argv => argv[0] === 'herdr' || argv[0] === 'orca')).toBe(false)
  expect(recorded.commands).not.toContain('clear')
})

test('a herdr agent that fails to start closes the pane it split', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT, env: { HERDR_PANE_ID: 'w1:p1' }, agentStartFails: true })
  await runRelayCommand($, clock, 'codex')

  const herdr = recorded.argv.filter(argv => argv[0] === 'herdr').map(argv => argv.slice(0, 3).join(' '))
  expect(herdr).toEqual(['herdr pane split', 'herdr agent start', 'herdr pane close'])
  expect(recorded.toasts.at(-1)).toContain('handover failed')
})

test('an unknown argument opens the pane with a note instead of handing over', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT })
  await runRelayCommand($, clock, 'gemini')
  const ui = await mountPane($)

  expect(recorded.fills).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Not an installed target, mode or summary: gemini/ })).toBeDefined()
})

test('inside herdr /relay codex splits a pane, starts codex there and prompts it', async ($, on) => {
  const { clock, recorded } = fakeSession(on, { lastAssistant: COLD_AT, env: { HERDR_PANE_ID: 'w1:p1' } })
  await runRelayCommand($, clock, 'codex')

  const herdr = recorded.argv.filter(argv => argv[0] === 'herdr').map(argv => argv.slice(0, 3).join(' '))
  expect(herdr).toEqual(['herdr pane split', 'herdr agent start', 'herdr agent prompt'])
  const start = recorded.argv.find(argv => argv[1] === 'agent' && argv[2] === 'start') ?? []
  expect(start[start.indexOf('--pane') + 1]).toBe('w1:p9')
  expect(start[start.indexOf('--kind') + 1]).toBe('codex')
})
