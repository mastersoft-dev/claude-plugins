import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { RelayBand, RelayMode, RelayPanel, RelaySummary, RelayTarget } from '../types'
import {
  buildDigest,
  clip,
  estimateTokens,
  formatMinutes,
  formatTokens,
  modelSummaryCost,
  lastAssistantAt,
  parseArgs,
  projectSlug,
  renderPrompt,
} from './digest'
import type { RelayArgs } from './digest'

type Engine = EngineInterface

type Launcher = 'herdr' | 'orca' | 'none'

const PANE = 'relay'
const TICK_MS = 60_000
const MINUTE_MS = 60_000
const CACHE_TTL_MS = 60 * MINUTE_MS
const BAND_MIN_TOKENS = 80_000
const GIT_LINES = 21
const PREVIEW_CHARS = 60
const PREVIEW_FILES = 3
const TOAST_MS = 8_000
const RUN_TIMEOUT_MS = 30_000
const AGENT_START_TIMEOUT_MS = 60_000
const TUI_IDLE_TIMEOUT_MS = 60_000
const ERROR_CHARS = 240
const AGENT_NAME_SUFFIX = 6
const FORK_TIMEOUT_MS = 120_000
const GIT_NOT_A_REPO_EXIT = 128
const CLAUDE_PREFIX = 'claude:'
const CURRENT_NOTE = 'here, current model'
const FAILED_PREFIX = 'Failed:'
const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
] as const
const AGENT_CLIS = [
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'gemini', label: 'Gemini' },
] as const
const LAUNCHER_NOTES: Record<Launcher, string> = {
  herdr: 'pane herdr',
  orca: 'Orca terminal',
  none: 'copy the prompt',
}
const SUMMARY_REQUEST = [
  'Write a handover summary for an agent that will continue this work in a new session, without access to this conversation.',
  'At most 250 words, as a list: goal, what is done, decisions made and why, what is left, open risks or doubts.',
  'Only facts present in the conversation. No preamble.',
].join(' ')

const EMPTY_PANEL: RelayPanel = {
  phase: 'idle',
  targets: [],
  target: '',
  mode: 'focused',
  summary: 'local',
  isWarm: false,
  idleMinutes: 0,
  contextTokens: 0,
  digest: null,
  transcriptPath: null,
  message: '',
}

const panel = atom({ plugin: 'relay', key: 'panel' } as const, EMPTY_PANEL)
const band = atom({ plugin: 'relay', key: 'band' } as const, null)
const lastActivityAt = atom({ plugin: 'relay', key: 'lastActivityAt' } as const, null)
const dismissedFor = atom({ plugin: 'relay', key: 'dismissedFor' } as const, null)
const knownTranscript = atom({ plugin: 'relay', key: 'transcriptPath' } as const, null)

let isRunning = false

async function detectLauncher($: Engine): Promise<Launcher> {
  if ((await $.env.get('HERDR_PANE_ID')) !== undefined) return 'herdr'
  if ((await $.env.get('ORCA_PANE_KEY')) !== undefined) return 'orca'
  return 'none'
}

async function isInstalled($: Engine, cli: string): Promise<boolean> {
  const found = await $.process.run(['which', cli], { timeoutMs: RUN_TIMEOUT_MS })
  return found.exitCode === 0
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runChecked($: Engine, argv: readonly string[], timeoutMs = RUN_TIMEOUT_MS): Promise<string> {
  const ran = await $.process.run(argv, { timeoutMs })
  if (ran.exitCode !== 0) {
    const detail = clip(ran.stderr.trim() || ran.stdout.trim(), ERROR_CHARS)
    throw new Error(`${argv.slice(0, 3).join(' ')} exited with ${ran.exitCode}: ${detail}`)
  }
  return ran.stdout
}

function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${what}: answer is not JSON (${clip(stdout, ERROR_CHARS)})`)
  }
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

async function cleanupAfter($: Engine, failure: unknown, argv: readonly string[]): Promise<never> {
  const reason = describeError(failure)
  try {
    await runChecked($, argv)
  } catch (cleanupFailure) {
    throw new Error(`${reason} (and closing the pane failed: ${describeError(cleanupFailure)})`)
  }
  throw new Error(reason)
}

function agentName(kind: string, now: number): string {
  return `relay-${kind}-${now.toString(36).slice(-AGENT_NAME_SUFFIX)}`
}

async function launchInHerdr($: Engine, kind: string, prompt: string, cwd: string): Promise<string> {
  const split = parseJson(
    await runChecked($, ['herdr', 'pane', 'split', '--current', '--direction', 'right', '--cwd', cwd, '--no-focus']),
    'herdr pane split',
  )
  const paneId = readPath(split, ['result', 'pane', 'pane_id'])
  if (typeof paneId !== 'string') throw new Error('herdr pane split returned no result.pane.pane_id')
  const name = agentName(kind, await $.clock.now())
  try {
    await runChecked($, ['herdr', 'agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', String(AGENT_START_TIMEOUT_MS)], AGENT_START_TIMEOUT_MS + RUN_TIMEOUT_MS)
    await runChecked($, ['herdr', 'agent', 'prompt', name, prompt])
  } catch (failure) {
    return cleanupAfter($, failure, ['herdr', 'pane', 'close', paneId])
  }
  return `pane herdr ${paneId}`
}

async function launchInOrca($: Engine, cli: string, prompt: string, cwd: string): Promise<string> {
  const created = parseJson(
    await runChecked($, ['orca', 'terminal', 'create', '--worktree', `path:${cwd}`, '--title', `relay ${cli}`, '--command', cli, '--json']),
    'orca terminal create',
  )
  const handle = readPath(created, ['result', 'terminal', 'handle'])
  if (typeof handle !== 'string') throw new Error('orca terminal create returned no result.terminal.handle')
  try {
    const waited = await $.process.run(
      ['orca', 'terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(TUI_IDLE_TIMEOUT_MS), '--json'],
      { timeoutMs: TUI_IDLE_TIMEOUT_MS + RUN_TIMEOUT_MS },
    )
    if (readPath(parseJson(waited.stdout, 'orca terminal wait'), ['result', 'wait', 'satisfied']) !== true) {
      throw new Error(`${cli} is not ready in the Orca terminal after ${TUI_IDLE_TIMEOUT_MS / 1000}s`)
    }
    const sent = parseJson(
      await runChecked($, ['orca', 'terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--json']),
      'orca terminal send',
    )
    if (readPath(sent, ['result', 'send', 'accepted']) !== true) {
      const refused = readPath(sent, ['result', 'send', 'refusedReason'])
      throw new Error(`Orca refused the prompt${typeof refused === 'string' ? `: ${refused}` : ''}`)
    }
  } catch (failure) {
    return cleanupAfter($, failure, ['orca', 'terminal', 'close', '--terminal', handle, '--json'])
  }
  return 'Orca terminal'
}

async function resolveTranscript($: Engine): Promise<string | null> {
  const known = await read($, knownTranscript)
  if (known !== null && (await $.fs.exists(known))) return known
  const home = await $.env.get('HOME')
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? null : `${home}/.claude`)
  if (configDir === null) return null
  const id = await $.session.id()
  for (const dir of new Set([await $.session.root(), await $.session.cwd()])) {
    const candidate = `${configDir}/projects/${projectSlug(dir)}/${id}.jsonl`
    if (await $.fs.exists(candidate)) return candidate
  }
  return null
}

async function activityAt($: Engine): Promise<number | null> {
  const at = await read($, lastActivityAt)
  if (at !== null) return at
  const path = await resolveTranscript($)
  if (path === null) return null
  const found = lastAssistantAt(await $.fs.read(path))
  if (found !== null) await update($, lastActivityAt, current => current ?? found)
  return found
}

type CacheReading = { activityAt: number; idleMs: number; isWarm: boolean; contextTokens: number }

async function readCache($: Engine): Promise<CacheReading | null> {
  const contextTokens = (await $.session.usage()).context.tokens ?? 0
  if (contextTokens === 0) return null
  const at = await activityAt($)
  if (at === null) return null
  const idleMs = Math.max(0, (await $.clock.now()) - at)
  return { activityAt: at, idleMs, isWarm: idleMs < CACHE_TTL_MS, contextTokens }
}

async function tick($: Engine): Promise<void> {
  const cache = await readCache($)
  if (cache === null) {
    $.ui.status(undefined)
    await update($, band, () => null)
    return
  }
  $.ui.status(
    cache.isWarm
      ? `relay: cache warm, expires in ${formatMinutes((CACHE_TTL_MS - cache.idleMs) / MINUTE_MS)}`
      : 'relay: cache cold',
  )
  const showBand = !cache.isWarm &&
    cache.contextTokens >= BAND_MIN_TOKENS &&
    (await read($, dismissedFor)) !== cache.activityAt
  const next: RelayBand | null = showBand
    ? { activityAt: cache.activityAt, idleMinutes: Math.floor(cache.idleMs / MINUTE_MS), contextTokens: cache.contextTokens }
    : null
  await update($, band, current => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
}

function logDebug($: Engine, what: string, error: unknown): void {
  $.ui.log(`relay: ${what}: ${describeError(error)}`, { to: 'debug' })
}

function tickSafely($: Engine): void {
  tick($).catch(error => logDebug($, 'cache check failed', error))
}

function guarded($: Engine, what: string, work: () => Promise<void>): void {
  work().catch(error => $.ui.toast(`Relay · ${what} failed: ${clip(describeError(error), ERROR_CHARS)}`, { timeoutMs: TOAST_MS }))
}

async function claudeTargets($: Engine): Promise<RelayTarget[]> {
  const current = (await $.session.model()).toLowerCase()
  return CLAUDE_MODELS.map(model => ({
    value: `${CLAUDE_PREFIX}${model.id}`,
    label: `Claude · ${model.label}`,
    note: current.includes(model.id) ? CURRENT_NOTE : 'here',
  }))
}

async function agentTargets($: Engine, launcher: Launcher): Promise<RelayTarget[]> {
  const found = await Promise.all(AGENT_CLIS.map(async cli => ((await isInstalled($, cli.id)) ? cli : null)))
  return found
    .filter(cli => cli !== null)
    .map(cli => ({ value: cli.id, label: cli.label, note: LAUNCHER_NOTES[launcher] }))
}

async function gitSnapshot($: Engine): Promise<string> {
  const ran = await $.process.run(['git', 'status', '--short', '--branch'], { cwd: await $.session.cwd(), timeoutMs: RUN_TIMEOUT_MS })
  if (ran.exitCode === GIT_NOT_A_REPO_EXIT) return ''
  if (ran.exitCode !== 0) throw new Error(`git status exited with ${ran.exitCode}: ${clip(ran.stderr.trim(), ERROR_CHARS)}`)
  return ran.stdout.split('\n').slice(0, GIT_LINES).join('\n')
}

async function readMessages($: Engine): Promise<SessionMessage[]> {
  return [...(await $.session.messages())]
}

function shouldAutoRun(args: RelayArgs, isWarm: boolean): boolean {
  return args.target !== undefined && !(args.summary === 'model' && !isWarm)
}

type Prepared = { prepared: RelayPanel; picked: RelayArgs }

async function preparePanel($: Engine, args: string): Promise<Prepared> {
  await update($, panel, () => ({ ...EMPTY_PANEL, phase: 'loading' }))
  const launcher = await detectLauncher($)
  const [claude, agents, messages, git, cache, transcriptPath] = await Promise.all([
    claudeTargets($),
    agentTargets($, launcher),
    readMessages($),
    gitSnapshot($),
    readCache($),
    resolveTranscript($),
  ])
  const targets = [...claude, ...agents]
  const picked = parseArgs(args, targets.map(target => target.value))
  const current = claude.find(target => target.note === CURRENT_NOTE) ?? claude[0]
  const isWarm = cache?.isWarm ?? false
  const contextTokens = cache?.contextTokens ?? 0
  const needsConfirm = picked.target !== undefined && !shouldAutoRun(picked, isWarm)
  const prepared: RelayPanel = {
    phase: messages.length === 0 ? 'idle' : 'ready',
    targets,
    target: picked.target ?? current?.value ?? '',
    mode: picked.mode ?? 'focused',
    summary: picked.summary ?? (picked.target === undefined && isWarm ? 'model' : 'local'),
    isWarm,
    idleMinutes: Math.floor((cache?.idleMs ?? 0) / MINUTE_MS),
    contextTokens,
    digest: buildDigest(messages, git),
    transcriptPath,
    message: messages.length === 0
      ? 'The session is empty: nothing to hand over.'
      : needsConfirm
        ? `On a cold cache the model summary costs ~${formatTokens(modelSummaryCost(contextTokens, false))} tokens: press Continue to confirm.`
        : '',
  }
  await update($, panel, () => prepared)
  return { prepared, picked }
}

async function sourceLabel($: Engine): Promise<string> {
  return `Claude Code ${await $.session.model()}, session ${await $.session.id()}`
}

async function buildPrompt($: Engine, state: RelayPanel, modelSummary: string | null): Promise<string> {
  if (state.digest === null) throw new Error('no local digest ready: reopen /relay')
  return renderPrompt({
    digest: state.digest,
    mode: state.mode,
    source: await sourceLabel($),
    transcriptPath: state.transcriptPath,
    modelSummary,
  })
}

async function withTimeout<T>($: Engine, work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: { cancel: () => void } | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`${what}: no answer after ${ms / 1000}s`)))
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    timer?.cancel()
  }
}

async function summarizeWithModel($: Engine): Promise<string> {
  const forked = await withTimeout($, $.model.fork({ prompt: SUMMARY_REQUEST }), FORK_TIMEOUT_MS, 'model summary')
  if (!forked.isAnswered) throw new Error(`model summary failed (${forked.reason})`)
  return forked.text
}

async function continueInClaude($: Engine, model: string, prompt: string): Promise<void> {
  const isSameModel = (await $.session.model()).toLowerCase().includes(model)
  await $.command.run({ command: 'clear' })
  if (!isSameModel) await $.command.run({ command: 'model', args: model })
  const filled = await $.prompt.fill({ text: prompt })
  if (!filled.isFilled) throw new Error(`the draft did not reach the prompt (${filled.refusal ?? 'refused by a plugin'})`)
  await $.ui.close({ id: PANE })
  $.ui.toast(`Relay · draft ready (~${formatTokens(estimateTokens(prompt))} tokens). Review it and press Enter.`, { timeoutMs: TOAST_MS })
}

async function continueElsewhere($: Engine, cli: string, prompt: string): Promise<void> {
  const launcher = await detectLauncher($)
  if (launcher === 'none') {
    const copied = await $.ui.copy({ text: prompt })
    if (!copied.isCopied) throw new Error(`copy to clipboard failed (${copied.reason})`)
    await $.ui.close({ id: PANE })
    $.ui.toast(`Relay · prompt on the clipboard. Start ${cli} and paste it.`, { timeoutMs: TOAST_MS })
    return
  }
  const cwd = await $.session.cwd()
  const where = launcher === 'herdr'
    ? await launchInHerdr($, cli, prompt, cwd)
    : await launchInOrca($, cli, prompt, cwd)
  await $.ui.close({ id: PANE })
  $.ui.toast(`Relay · handed to ${cli} (${where}), prompt sent.`, { timeoutMs: TOAST_MS })
}

async function copyAsFallback($: Engine, prompt: string): Promise<boolean> {
  if (prompt === '') return false
  try {
    return (await $.ui.copy({ text: prompt })).isCopied
  } catch (error) {
    logDebug($, 'fallback copy failed', error)
    return false
  }
}

async function runRelay($: Engine): Promise<void> {
  if (isRunning) return
  const state = await read($, panel)
  if (isRunning || state.phase !== 'ready' || state.digest === null) return
  isRunning = true
  let prompt = ''
  try {
    await update($, panel, (current): RelayPanel => ({ ...current, phase: 'working', message: 'Building the prompt…' }))
    const modelSummary = state.summary === 'model' ? await summarizeWithModel($) : null
    prompt = await buildPrompt($, state, modelSummary)
    if (state.target.startsWith(CLAUDE_PREFIX)) {
      await continueInClaude($, state.target.slice(CLAUDE_PREFIX.length), prompt)
    } else {
      await continueElsewhere($, state.target, prompt)
    }
    await update($, panel, () => EMPTY_PANEL)
  } catch (error) {
    const copied = await copyAsFallback($, prompt)
    const message = `${FAILED_PREFIX} ${clip(describeError(error), ERROR_CHARS)}${copied ? ' The prompt is on the clipboard.' : ''}`
    $.ui.toast(`Relay · ${message}`, { timeoutMs: TOAST_MS })
    await update($, panel, (current): RelayPanel => ({ ...current, phase: 'ready', message }))
  } finally {
    isRunning = false
  }
}

async function copyPrompt($: Engine): Promise<void> {
  const state = await read($, panel)
  const copied = await $.ui.copy({ text: await buildPrompt($, state, null) })
  if (!copied.isCopied) throw new Error(`copy to clipboard (${copied.reason})`)
  $.ui.toast('Relay · prompt copied.')
}

async function openPanel($: Engine, args: string): Promise<void> {
  if (isRunning) {
    $.ui.toast('Relay · a handover is already running.')
    return
  }
  await $.ui.open({ id: PANE, title: 'Relay', focus: true, closeOnEscape: true })
  let ready: Prepared
  try {
    ready = await preparePanel($, args)
  } catch (error) {
    await update($, panel, () => ({ ...EMPTY_PANEL, message: `Cannot read the session: ${clip(describeError(error), ERROR_CHARS)}` }))
    return
  }
  if (ready.prepared.phase === 'ready' && shouldAutoRun(ready.picked, ready.prepared.isWarm)) await runRelay($)
}

function setChoice($: Engine, patch: Partial<Pick<RelayPanel, 'target' | 'mode' | 'summary'>>): void {
  void update($, panel, current => ({ ...current, ...patch, message: '' }))
}

function previewLine(label: string, value: string): { label: string; value: string } {
  return { label, value: clip(value.replace(/\s+/g, ' '), PREVIEW_CHARS) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relay',
      description: 'Continue in a fresh session without re-reading this one',
      argumentHint: '[opus|sonnet|codex|opencode|gemini] [focused|full] [local|model]',
    })
    $.clock.every(TICK_MS, () => tickSafely($))
    tickSafely($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await update($, knownTranscript, () => e.transcript_path)
    await update($, lastActivityAt, () => null)
    return next(e)
  }).catch(($, e, next) => {
    logDebug($, 'transcript path not saved', 'classic.SessionStart')
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await update($, knownTranscript, () => e.transcript_path)
    return next(e)
  }).catch(($, e, next) => {
    logDebug($, 'transcript path not saved', 'classic.Stop')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, lastActivityAt, () => now)
      tickSafely($)
    }
    return done
  })

  on('command.run', { command: 'relay' }, async ($, e) => {
    $.clock.after(0, () => guarded($, 'opening', () => openPanel($, e.args)))
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, band)
    if (shown === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexWrap="wrap" columnGap={1}>
        <Text color="warning">◷ cache expired {formatMinutes(shown.idleMinutes)} ago</Text>
        <Text dimColor>· {formatTokens(shown.contextTokens)} of context: replying here writes it all to cache again ·</Text>
        <Text color="suggestion">/relay</Text>
        <Text dimColor>restarts from a digest</Text>
        <Button key="relay-open" label="Open" onPress={() => guarded($, 'opening', () => openPanel($, ''))} />
        <Button
          key="relay-hide"
          label="Hide"
          onPress={() => {
            guarded($, 'hiding', () => update($, dismissedFor, () => shown.activityAt).then(() => tickSafely($)))
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, panel)
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Relay runs in the terminal or the desktop app.</Text>
    }
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    if (state.phase === 'loading' || state.phase === 'idle') {
      return state.message === '' ? <Text dimColor>Reading the session…</Text> : <Text color="error">{state.message}</Text>
    }
    const digest = state.digest
    const cacheLine = state.contextTokens === 0
      ? 'No turns yet: no cache to protect.'
      : `Cache ${state.isWarm ? 'warm' : 'cold'} · idle ${formatMinutes(state.idleMinutes)} · ${formatTokens(state.contextTokens)} of context`
    const cost = formatTokens(modelSummaryCost(state.contextTokens, state.isWarm))
    const localTokens = digest === null
      ? 0
      : estimateTokens(renderPrompt({ digest, mode: state.mode, source: '', transcriptPath: state.transcriptPath, modelSummary: null }))
    const preview = digest === null
      ? []
      : [
          previewLine('Goal', digest.goal || '(none)'),
          previewLine('Latest', digest.recentPrompts.at(-1) ?? digest.goal),
          previewLine('Files', digest.files.length === 0 ? '(none)' : `${digest.files.length}: ${digest.files.slice(-PREVIEW_FILES).map(path => path.split('/').at(-1)).join(', ')}`),
          previewLine('Failed', digest.failed.length === 0 ? '(none)' : digest.failed.at(-1) ?? ''),
          previewLine('Git', digest.git.split('\n')[0] ?? ''),
        ]
    const isBusy = state.phase === 'working'
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text color={state.isWarm ? 'success' : 'warning'}>{cacheLine}</Text>
        <Box flexDirection="column">
          <Text dimColor>CONTINUE IN</Text>
          <Select
            key="target"
            autoFocus
            value={state.target}
            options={state.targets.map(target => ({ value: target.value, label: `${target.label} · ${target.note}` }))}
            onSelect={value => setChoice($, { target: value })}
          />
        </Box>
        <Box flexDirection="column">
          <Text dimColor>TRANSCRIPT READING</Text>
          <Select
            key="mode"
            value={state.mode}
            options={[
              { value: 'focused', label: 'Focused · only the missing details' },
              { value: 'full', label: 'Full · all of it before starting' },
            ]}
            onSelect={value => setChoice($, { mode: value as RelayMode })}
          />
        </Box>
        <Box flexDirection="column">
          <Text dimColor>SUMMARY</Text>
          <Select
            key="summary"
            value={state.summary}
            options={[
              { value: 'local', label: 'Local · 0 tokens' },
              { value: 'model', label: `From the model · ~${cost} (${state.isWarm ? 'cache warm' : 'cache cold'})` },
            ]}
            onSelect={value => setChoice($, { summary: value as RelaySummary })}
          />
        </Box>
        <Box flexDirection="column">
          <Text dimColor>PREVIEW · ~{formatTokens(localTokens)} TOKENS</Text>
          {preview.map(row => (
            <Text>
              <Text dimColor>{row.label.padEnd(10)}</Text>
              {row.value}
            </Text>
          ))}
        </Box>
        {state.message !== '' && <Text color={state.message.startsWith(FAILED_PREFIX) ? 'error' : 'subtle'}>{state.message}</Text>}
        <Box columnGap={2}>
          <Button key="go" label={isBusy ? 'Working…' : 'Continue'} variant="primary" onPress={() => guarded($, 'handover', () => runRelay($))} />
          <Button key="copy" label="Copy prompt" onPress={() => guarded($, 'copy', () => copyPrompt($))} />
        </Box>
      </Box>
    )
  })
}
