import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Draft, Project } from '../types'

const MS_BINARY = 'ms'
const MS_TIMEOUT_MS = 90_000
const SEARCH_LIMIT = 10
const INSTALLS_LIMIT = 50
const INSTALL_SEPARATOR = ' @ '
const COMPLETED = 'completata'
const UNAUTHORIZED = /HTTP 401/
const LOGIN_HINT = 'GEWEB token missing or expired: run `! ms login`, then try again'
const ACTIVITIES = 'api/hr/attivita-temporale/'

/** Runs a host command by argv, as `$.process.run` does. */
export type Runner = (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>

type Autocomplete = { results: { id: number; text: string; note?: string | null }[] }

/** The message of a rejection, without the `Error:` prefix. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isAutocomplete = (value: unknown): value is Autocomplete =>
  typeof value === 'object' && value !== null && Array.isArray((value as Autocomplete).results)

/**
 * Runs `ms geweb raw` and parses its JSON answer, null for an empty body (a
 * write `ms` reports as `HTTP 204`); rejects with an actionable message.
 */
const raw = async (
  run: Runner,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string> = {},
  body?: object,
): Promise<unknown> => {
  const argv = [MS_BINARY, 'geweb', 'raw', method, path]
  for (const [key, value] of Object.entries(query)) argv.push('--query', `${key}=${value}`)
  if (body !== undefined) argv.push('--data', '-')
  const result = await run(argv, {
    stdin: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: MS_TIMEOUT_MS,
  }).catch((error: unknown) => {
    throw new Error(`\`${MS_BINARY} geweb raw ${method} ${path}\` did not complete: ${errorText(error)}`)
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n')[0] || `exit code ${result.exitCode}`
    throw new Error(UNAUTHORIZED.test(result.stderr) ? LOGIN_HINT : `${method} ${path} failed: ${detail}`)
  }
  if (result.stdout.trim() === '') return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${method} ${path} answered something that is not JSON`)
  }
}

const autocomplete = async (run: Runner, model: string, query: Record<string, string>) => {
  const answer = await raw(run, 'GET', `api/autocomplete/hr/${model}/`, { limit: String(SEARCH_LIMIT), ...query })
  if (!isAutocomplete(answer)) throw new Error(`the ${model} autocomplete answered an unexpected shape`)
  return answer.results
}

/** Open GEWEB projects matching the words, as `(customer) - [code] name`. */
export const searchProjects = async (run: Runner, words: string): Promise<Project[]> =>
  (await autocomplete(run, 'Progetto', { term: words })).map(r => ({ id: r.id, label: r.text }))

/**
 * The open GEWEB project a git remote is linked to (`hr/GitRepo.progetto`),
 * found through the autocomplete endpoint since the GitRepo API is admin-only.
 */
export const projectOfRemote = async (run: Runner, canonical: string): Promise<Project | undefined> => {
  const repos = await autocomplete(run, 'GitRepo', { filters: JSON.stringify({ remote_url: canonical }) })
  const code = repos.find(r => r.text === canonical)?.note?.match(/\[([^\]]+)\]/)?.[1]
  if (code === undefined) return undefined
  const matches = (await searchProjects(run, code)).filter(p => p.label.includes(`[${code}]`))
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * The customers a git remote is installed at (`hr/Istanza`, through its local
 * copy's GitRepo), each named once; an Istanza reads `<project> @ <customer>`.
 */
export const customersOfRemote = async (run: Runner, canonical: string): Promise<string[]> => {
  const installs = await autocomplete(run, 'Istanza', {
    limit: String(INSTALLS_LIMIT),
    filters: JSON.stringify({ gitrepo_instance__gitrepo__remote_url: canonical }),
  })
  const names = installs.map(i => i.text.split(INSTALL_SEPARATOR).at(-1)?.trim() ?? '').filter(Boolean)
  return [...new Set(names)]
}

/** Creates the draft's activity on the live timesheet, empty; resolves its id. */
export const createActivity = async (run: Runner, draft: Draft): Promise<number> => {
  const created = await raw(run, 'POST', ACTIVITIES, {}, {
    descrizione: draft.descrizione,
    progetto: draft.project.id,
    data: draft.day,
    ora: draft.startHour,
  })
  const id = typeof created === 'object' && created !== null ? (created as { id?: unknown }).id : undefined
  if (typeof id !== 'number') throw new Error('creating the activity answered no id: check GEWEB before booking again')
  return id
}

/**
 * Adds the draft's minutes to its activity and marks it completed. Resolves a
 * warning when a step failed; the activity stays recorded either way, so it is
 * never created twice.
 */
export const fillActivity = async (run: Runner, id: number, draft: Draft): Promise<string | undefined> => {
  try {
    await raw(run, 'POST', `${ACTIVITIES}${id}/aggiungi_tempo/`, {}, { minuti: draft.minutes, data: draft.day })
  } catch (error) {
    return `activity ${id} created, but adding ${draft.minutes} min failed (${errorText(error)}): check it in GEWEB`
  }
  try {
    await raw(run, 'POST', `${ACTIVITIES}${id}/set_stato/`, {}, { stato: COMPLETED })
  } catch (error) {
    return `activity ${id} booked, but left open (${errorText(error)})`
  }
  return undefined
}
