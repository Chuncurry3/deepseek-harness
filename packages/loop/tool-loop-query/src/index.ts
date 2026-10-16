/**
 * Model-facing query tools for one relay run: `loop_session_search` and
 * `loop_session_read` register globally on `ctx.tools` and authorize every
 * call in the executor against the calling session's run lineage and the
 * run's frozen read scopes.
 * @module @deepseek-ai/dsh-tool-loop-query
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LoopSnapshot } from '@deepseek-ai/dsh-loop'
import { normalizeScopePath } from '@deepseek-ai/dsh-loop/paths'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEventType, SessionHeader, SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
import {
  extractSessionEventText,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionQueryErrorCode,
  SessionEventResultFilter,
  SessionEventSearchDocument,
  SessionEventSurface,
  SessionEventWindow,
  SessionRecord,
  SessionSurfaceSnapshot,
} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-loop-query'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'sessionQuery', 'sessionProjections', 'subagents']

/** Default cap on the matching events one search call returns. */
export const DEFAULT_MAX_SEARCH_RESULTS = 100

/** Default cooperative deadline for one search call. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

/**
 * Model-facing refusal and input-failure codes. Each refusal names its reason
 * in the message: lineage for a caller outside a run, scope for a target the
 * run may not read.
 */
export type LoopQueryErrorCode =
  | 'LOOP_QUERY_AGENT_REQUIRED'
  | 'LOOP_QUERY_LINEAGE_REFUSED'
  | 'LOOP_QUERY_SCOPE_REFUSED'
  | 'LOOP_QUERY_INVALID_QUERY'
  | 'LOOP_QUERY_INVALID_ARGS'

/** Arguments of the literal-text search lane. */
interface SearchArgs {
  readonly query: string
  readonly session_ids?: string[]
  readonly event_types?: string[]
  readonly surfaces?: SessionEventSurface[]
}

/** Arguments of the exact read lane. */
interface ReadArgs {
  readonly session_id?: string
  readonly seq?: number
  readonly before?: number
  readonly after?: number
}

/** Result-count and deadline bounds a deployment selects for the in-run read tools. */
export interface Config {
  /** Most matching events one `loop_session_search` call returns. Defaults to 100. */
  maxSearchResults?: number
  /** Cooperative deadline for one `loop_session_search` call, in milliseconds. Defaults to 30000. */
  searchTimeoutMs?: number
}

/* jscpd:ignore-start -- deliberate mirror of tool-session-query's search bounds: the plan
   mandates the same field names and defaults so the two tools read alike to a deployment. */
/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
  searchTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SEARCH_TIMEOUT_MS),
})
/* jscpd:ignore-end */

/** Characters of one event's semantic text rendered as a one-line excerpt. */
const EXCERPT_CHARS = 200

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Both descriptions open with the relay-loop note's refusal sentence, pinned
 * verbatim: a model outside a run's lineage must learn from the description
 * alone that the call will be refused.
 */
const SEARCH_DESCRIPTION =
  "Usable only inside an active run's lineage, every other call refused. "
  + 'Search the sessions this run may read (its frozen read scopes plus your own workspace) for literal text, '
  + 'and return each matching event with its session id and sequence number so loop_session_read can pull it.'

const READ_DESCRIPTION =
  "Usable only inside an active run's lineage, every other call refused. "
  + 'Read one session this run may read: its current model surface, or one exact event with optional neighboring events.'

const searchParameters = {
  query: { type: 'string', required: true, description: 'Literal text to find in event text; matched case-insensitively.' },
  session_ids: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional readable session ids to search; an unreadable named id refuses the call.',
  },
  event_types: { type: 'array', items: { type: 'string' }, description: 'Event types to include.' },
  surfaces: {
    type: 'array',
    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
    description: 'Event surfaces to include.',
  },
} as const

const readParameters = {
  session_id: { type: 'string', description: 'Target session id. Omit for the calling session.' },
  seq: {
    type: 'integer',
    description: "Target event sequence number. Omit to read the target session's current model surface; the calling session when session_id is omitted.",
  },
  before: { type: 'integer', description: 'Number of preceding raw events to summarize. Requires seq.' },
  after: { type: 'integer', description: 'Number of following raw events to summarize. Requires seq.' },
} as const

/** Register both model-facing loop query tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  ctx.tools.register(defineTool({
    name: 'loop_session_search',
    description: SEARCH_DESCRIPTION,
    parameters: searchParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.deadlineMs,
    execute: (args, exec) => searchSessions(ctx, args, exec, resolved.resultCap),
    presentCall: presentSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'loop_session_read',
    description: READ_DESCRIPTION,
    parameters: readParameters,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => readSession(ctx, args, exec),
    presentCall: presentReadCall,
  }))
}

function resolveConfig(config: Config): { readonly resultCap: number; readonly deadlineMs: number } {
  const resultCap = config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
  const deadlineMs = config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  if (!Number.isSafeInteger(resultCap) || resultCap < 1) {
    throw new TypeError('tool-loop-query: maxSearchResults must be a positive safe integer')
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `tool-loop-query: searchTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return { resultCap, deadlineMs }
}

/**
 * Read authority of the run whose lineage contains the caller.
 */
interface RunAuthority {
  /** Controlling session that owns the current loop. */
  readonly controllingId: SessionIdValue
  /** The run's frozen read scopes, realpath-normalized at start. */
  readonly scopes: readonly string[]
  /** Scopes plus the caller's own workspace, the complete readable set. */
  readonly readable: readonly string[]
}

interface SearchHit {
  readonly session: SessionRecord
  readonly event: SessionEventSearchDocument
}

/**
 * Resolve the caller's run from the current-loop projection up its parent chain.
 * @param ctx - context carrying the Session query service.
 * @param callerId - calling session id.
 * @param signal - cancellation forwarded to each observation.
 * @returns the controlling session and its loop, or undefined outside any run.
 */
async function controllingRun(
  ctx: Context,
  callerId: SessionIdValue,
  signal: AbortSignal,
): Promise<{ readonly controllingId: SessionIdValue; readonly loop: LoopSnapshot } | undefined> {
  const visited = new Set<SessionIdValue>()
  let current: SessionIdValue | undefined = callerId
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    using observed = await ctx.sessionQuery.observeSession(current, { signal })
    const loop = observed.projections?.values.loop?.loop
    if (loop !== undefined) return { controllingId: current, loop }
    current = observed.header.parentSession
  }
  return undefined
}

function callerSession(exec: ToolRunContext): Session {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError('loop session tools require an agent-bound caller', 'LOOP_QUERY_AGENT_REQUIRED')
  }
  return agent.session
}

/**
 * Authorize the caller as a member of one active run's lineage.
 *
 * The parent chain from the current-loop projection finds the candidate
 * controlling session; the subagent catalog then proves membership, so a
 * session that only claims the parent in its own header is refused.
 * @param ctx - context carrying the Session query and subagent services.
 * @param caller - calling session.
 * @param signal - cancellation forwarded to catalog reads.
 * @returns the run's frozen read authority.
 * @throws {@link HarnessError} code LOOP_QUERY_LINEAGE_REFUSED outside a run.
 */
async function runAuthority(ctx: Context, caller: Session, signal: AbortSignal): Promise<RunAuthority> {
  const run = await controllingRun(ctx, caller.id, signal)
  if (run === undefined) throw lineageRefused(caller.id)
  if (run.controllingId !== caller.id) {
    const descendants = await ctx.subagents.listDescendants(run.controllingId, signal)
    if (!descendants.some(entry => entry.kind === 'child' && entry.id === caller.id)) {
      throw lineageRefused(caller.id, run.controllingId)
    }
  }
  const workspace = normalizePath(caller.header.cwd)
  return {
    controllingId: run.controllingId,
    scopes: run.loop.readScopes,
    readable: [...run.loop.readScopes, ...workspace === undefined ? [] : [workspace]],
  }
}

/** realpath-normalize one path, or undefined when it does not resolve. */
function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    return normalizeScopePath(path)
  } catch {
    // A vanished or unreadable workspace grants nothing; the caller's scopes
    // still apply. Only realpathSync's ENOENT and permission failures reach here.
    return undefined
  }
}

/** Whether the caller may read one session: itself, or a workspace inside its readable set. */
function readable(
  authority: RunAuthority,
  callerId: SessionIdValue,
  targetId: SessionIdValue,
  cwd: string | undefined,
): boolean {
  if (targetId === callerId) return true
  const normalized = normalizePath(cwd)
  return normalized !== undefined && authority.readable.includes(normalized)
}

function lineageRefused(callerId: SessionIdValue, controllingId?: SessionIdValue): HarnessError {
  return new HarnessError(
    controllingId === undefined
      ? `loop session tools are refused: session "${callerId}" is not inside an active run's lineage`
      : `loop session tools are refused: session "${callerId}" is not a descendant child of the controlling session "${controllingId}"`,
    'LOOP_QUERY_LINEAGE_REFUSED',
  )
}

function unreadableTarget(targetId: SessionIdValue, authority: RunAuthority): HarnessError {
  return new HarnessError(
    `loop session tools are refused: target session "${targetId}" is unknown, or its workspace is outside the run's read scopes [${authority.scopes.join(', ')}] and is not the caller's workspace`,
    'LOOP_QUERY_SCOPE_REFUSED',
  )
}

function invalid(code: LoopQueryErrorCode, message: string): HarnessError {
  return new HarnessError(message, code)
}

/** Reject a blank or NUL-carrying query before it reaches the provider. */
function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length === 0) throw invalid('LOOP_QUERY_INVALID_QUERY', 'loop_session_search: query must contain non-whitespace text')
  if (query.includes('\0')) throw invalid('LOOP_QUERY_INVALID_QUERY', 'loop_session_search: query must not contain NUL')
  return query
}

/** Reject an empty list-valued argument instead of silently matching nothing. */
function requiredList<T>(name: string, values: readonly T[]): readonly T[] {
  if (values.length === 0) throw invalid('LOOP_QUERY_INVALID_ARGS', `loop_session_search: ${name} must not be empty`)
  return values
}

/** Reject a negative or non-integer read argument. */
function requiredCount(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid('LOOP_QUERY_INVALID_ARGS', `loop_session_read: ${name} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Reject a raw-event window the engine would refuse, as a tool argument error.
 *
 * The bound is the engine's documented default (`SESSION_QUERY_READ_WINDOW_MAX`
 * in `@deepseek-ai/dsh-session-query`), so the model gets a loop-owned argument
 * message instead of the engine's `SESSION_QUERY_INVALID_WINDOW` vocabulary.
 */
function requiredWindow(name: string, value: number): number {
  const count = requiredCount(name, value)
  if (count > SESSION_QUERY_READ_WINDOW_MAX) {
    throw invalid(
      'LOOP_QUERY_INVALID_ARGS',
      `loop_session_read: ${name} must be no greater than ${SESSION_QUERY_READ_WINDOW_MAX}`,
    )
  }
  return count
}

function requestedIds(values: readonly string[] | undefined): readonly SessionIdValue[] | undefined {
  if (values === undefined) return undefined
  return requiredList('session_ids', values).map(value => SessionId(value))
}

function eventFilters(args: SearchArgs, query: string): SessionEventResultFilter[] {
  const filters: SessionEventResultFilter[] = [{ kind: 'text', text: query }]
  if (args.event_types !== undefined) {
    // Event type names are merge-extensible, so the model names literals: an
    // unknown name matches no event instead of failing the call.
    filters.push({ kind: 'type', values: [...requiredList('event_types', args.event_types)] as SessionEventType[] })
  }
  if (args.surfaces !== undefined) {
    filters.push({ kind: 'surface', values: [...requiredList('surfaces', args.surfaces)] })
  }
  return filters
}

/**
 * Select the sessions one search may scan.
 *
 * The complete corpus listing is the provider-independent way to compare
 * realpath-normalized workspaces; a named id outside the readable set refuses
 * the call instead of silently searching less.
 */
async function searchCandidates(
  ctx: Context,
  authority: RunAuthority,
  callerId: SessionIdValue,
  requested: readonly SessionIdValue[] | undefined,
  signal: AbortSignal,
): Promise<SessionRecord[]> {
  const records = await ctx.sessionQuery.filterSessions([], signal)
  if (requested === undefined) {
    return records.filter(record => readable(authority, callerId, record.header.id, record.header.cwd))
  }
  const byId = new Map(records.map(record => [record.header.id, record]))
  return [...new Set(requested)].map((id) => {
    const record = byId.get(id)
    if (record === undefined || !readable(authority, callerId, id, record.header.cwd)) {
      throw unreadableTarget(id, authority)
    }
    return record
  })
}

async function searchSessions(
  ctx: Context,
  args: SearchArgs,
  exec: ToolRunContext,
  maxResults: number,
): Promise<string> {
  const caller = callerSession(exec)
  const authority = await runAuthority(ctx, caller, exec.signal)
  const query = normalizeQuery(args.query)
  const filters = eventFilters(args, query)
  const candidates = await searchCandidates(ctx, authority, caller.id, requestedIds(args.session_ids), exec.signal)
  const hits: SearchHit[] = []
  let capped = false
  scan: for (const record of candidates) {
    const documents = await ctx.sessionQuery.filterEvents(record.header.id, filters)
    for (const document of documents) {
      if (hits.length === maxResults) {
        capped = true
        break scan
      }
      hits.push({ session: record, event: document })
    }
  }
  return renderSearch(hits, capped)
}

async function readSession(ctx: Context, args: ReadArgs, exec: ToolRunContext): Promise<string> {
  const caller = callerSession(exec)
  const authority = await runAuthority(ctx, caller, exec.signal)
  const targetId = args.session_id === undefined ? caller.id : SessionId(args.session_id)
  const seq = args.seq === undefined ? undefined : SessionSeq(requiredCount('seq', args.seq))
  const before = args.before === undefined ? undefined : requiredWindow('before', args.before)
  const after = args.after === undefined ? undefined : requiredWindow('after', args.after)
  if (seq === undefined && (before !== undefined || after !== undefined)) {
    throw invalid('LOOP_QUERY_INVALID_ARGS', 'loop_session_read: before and after require seq')
  }
  if (targetId !== caller.id) {
    const [record] = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [targetId] }], exec.signal)
    if (record === undefined || !readable(authority, caller.id, targetId, record.header.cwd)) {
      throw unreadableTarget(targetId, authority)
    }
  }
  if (seq === undefined) {
    const surface = await readOrRefuse(() => ctx.sessionQuery.readSurface(targetId), targetId, authority)
    assertObserved(authority, caller.id, targetId, surface.session)
    return renderSurface(surface)
  }
  const window = await readOrRefuse(async () => ctx.sessionQuery.readEvent({
    sessionId: targetId,
    seq,
    ...before === undefined ? {} : { before },
    ...after === undefined ? {} : { after },
  }, exec.signal), targetId, authority)
  assertObserved(authority, caller.id, targetId, window.session)
  return renderEvent(window)
}

/** Engine failures that must not tell a caller whether a session or an event exists. */
const NOT_FOUND_CODES: ReadonlySet<SessionQueryErrorCode> = new Set([
  'SESSION_QUERY_EVENT_NOT_FOUND',
  'SESSION_QUERY_SESSION_NOT_FOUND',
])

/**
 * Run one engine read, settling its not-found vocabulary as the tool's refusal.
 *
 * A target the run may not read and a target with nothing at the requested
 * position settle identically, so neither engine code nor message reaches the
 * model.
 */
async function readOrRefuse<T>(
  operation: () => Promise<T>,
  targetId: SessionIdValue,
  authority: RunAuthority,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof SessionQueryError && NOT_FOUND_CODES.has(error.code)) {
      throw unreadableTarget(targetId, authority)
    }
    throw error
  }
}

/** Re-check the observed header so a source swap cannot widen the authorization. */
function assertObserved(
  authority: RunAuthority,
  callerId: SessionIdValue,
  targetId: SessionIdValue,
  header: SessionHeader,
): void {
  if (header.id !== targetId || !readable(authority, callerId, targetId, header.cwd)) {
    throw unreadableTarget(targetId, authority)
  }
}

function workspaceText(header: SessionHeader): string {
  return header.cwd ?? 'no workspace'
}

function formatTime(time: number): string {
  return new Date(time).toISOString()
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`
}

function renderSearch(hits: readonly SearchHit[], capped: boolean): string {
  if (hits.length === 0) return 'No matching events in the sessions this run may read.'
  const sessions = new Set(hits.map(hit => hit.session.header.id))
  const lines = [`Loop session search results (${hits.length} matches in ${sessions.size} sessions):`]
  let opened: SessionIdValue | undefined
  for (const [index, hit] of hits.entries()) {
    if (hit.session.header.id !== opened) {
      opened = hit.session.header.id
      lines.push(`Session ${opened} — ${workspaceText(hit.session.header)}`)
    }
    lines.push(
      `${index + 1}. seq ${hit.event.seq} | ${hit.event.type} | ${hit.event.surface} | ${formatTime(hit.event.time)}`,
      `   Snippet: ${excerpt(hit.event.text)}`,
    )
  }
  if (capped) lines.push('', 'Result cap reached. Narrow the query or name fewer sessions.')
  return lines.join('\n')
}

function renderSurface(surface: SessionSurfaceSnapshot): string {
  const lines = [
    `Session ${surface.session.id} — ${workspaceText(surface.session)}`,
    `Captured through seq ${surface.capturedThroughSeq ?? 'none'}; ${surface.events.length} current surface events:`,
  ]
  for (const [index, event] of surface.events.entries()) {
    lines.push(`${index + 1}. seq ${event.seq} | ${event.type} | ${formatTime(event.time)}`)
    const text = excerpt(extractSessionEventText(event))
    if (text.length > 0) lines.push(`   ${text}`)
  }
  return lines.join('\n')
}

function renderNeighbor(event: SessionEventWindow['events'][number]): string {
  return `seq ${event.seq} | ${event.type} | ${formatTime(event.time)} | ${excerpt(extractSessionEventText(event))}`
}

function renderEvent(window: SessionEventWindow): string {
  const target = window.target
  const lines = [
    `Session ${window.session.id} — ${workspaceText(window.session)}`,
    `Target event seq ${target.seq}:`,
    '```json',
    JSON.stringify(target, null, 2),
    '```',
  ]
  const before = window.events.filter(event => event.seq < target.seq)
  const after = window.events.filter(event => event.seq > target.seq)
  if (before.length > 0) lines.push('', 'Before:', ...before.map(renderNeighbor))
  if (after.length > 0) lines.push('', 'After:', ...after.map(renderNeighbor))
  return lines.join('\n')
}

function presentSearchCall(args: SearchArgs): GenericCallView {
  return { card: 'generic', kind: 'search', title: 'Search relay-run sessions', rawInput: args.query }
}

function presentReadCall(args: ReadArgs): GenericCallView {
  if (args.seq === undefined) {
    return {
      card: 'generic',
      kind: 'read',
      title: args.session_id === undefined ? 'Read current session' : `Read session ${args.session_id}`,
      ...args.session_id === undefined ? {} : { rawInput: args.session_id },
    }
  }
  return {
    card: 'generic',
    kind: 'read',
    title: `Read event ${args.seq}`,
    rawInput: {
      ...args.session_id === undefined ? {} : { session_id: args.session_id },
      seq: args.seq,
    },
  }
}
