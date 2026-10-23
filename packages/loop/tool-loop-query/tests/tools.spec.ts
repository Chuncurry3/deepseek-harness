/** Lineage and scope authorization of the two loop session query tools. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import LoopService from '@deepseek-ai/dsh-loop'
import { normalizeScopePath } from '@deepseek-ai/dsh-loop/paths'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine, { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionSearchPage,
  SessionSurfaceSnapshot,
} from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolLoopQuery from '@deepseek-ai/dsh-tool-loop-query'

/** Concrete engine: the loop query tools use only the filter, read, and observation lanes. */
class HarnessQuery extends SessionQueryEngine {
  /** When set, every surface read resolves to this other session, standing in for a source swap. */
  swapSurfaceTo: SessionIdValue | undefined

  override async readSurface(sessionId: SessionIdValue): Promise<SessionSurfaceSnapshot> {
    return super.readSurface(this.swapSurfaceTo ?? sessionId)
  }

  override searchSessions(): Promise<SessionSearchPage<never>> {
    return Promise.reject(new Error('loop query tools never use full-text session search'))
  }

  override searchEvents(): Promise<SessionEventSearchPage> {
    return Promise.reject(new Error('loop query tools never use full-text event search'))
  }
}

interface Harness {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly root: string
  readonly scopes: string
  readonly caller: Session
  readonly callerAgent: Agent
}

const contexts: Context[] = []
const roots: string[] = []
let calls = 0

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stubAgent(session: Session, ctx: Context): Agent {
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** One live session with an optional workspace and parent, plus its registered agent. */
async function sessionWith(
  mounted: { readonly ctx: Context },
  id: string,
  cwd: string | undefined,
  parentSession?: SessionIdValue,
): Promise<{ readonly session: Session; readonly agent: Agent }> {
  const session = mounted.ctx.sessions.create(SessionId(id), {
    meta: {
      ...cwd === undefined ? {} : { cwd },
      ...parentSession === undefined ? {} : { parentSession },
    },
  })
  const agent = stubAgent(session, mounted.ctx)
  await mounted.ctx.agents.register(agent)
  return { session, agent }
}

/** Durable parent-owned catalog fact declaring one direct child. */
function catalog(parent: Session, child: Session): void {
  parent.append('subagent/catalog', {
    version: 0,
    childId: child.id,
    childCreatedAt: child.header.createdAt,
    mode: 'one-shot',
  })
}

/** One open model step carrying a user message, the shape surface reads fold. */
function openStep(session: Session, text: string): void {
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  session.append('step/start', { turn: 1, step: 1 })
}

async function mount(config: ToolLoopQuery.Config = {}, enforceDeadline = false): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (enforceDeadline) await ctx.plugin(TimeoutPolicy)
  await ctx.plugin(HarnessQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LoopService)
  const fiber = await ctx.plugin(ToolLoopQuery, config)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-loop-query-'))
  roots.push(root)
  const scopes = join(root, 'granted')
  mkdirSync(scopes)
  const caller = await sessionWith({ ctx }, 'caller', root)
  return { ctx, fiber, root, scopes, caller: caller.session, callerAgent: caller.agent }
}

/** Start the caller's run with one granted read scope and the caller workspace as write scope. */
async function startRun(
  mounted: Harness,
  readScopes: readonly string[] = [normalizeScopePath(mounted.scopes)],
): Promise<void> {
  await mounted.ctx.loops.start(mounted.callerAgent, {
    objective: 'relay the report',
    chain: { objective: 'relay the report', checkpoint: 'none', nodes: [{ role: 'worker', prompt: 'Work.' }] },
    readScopes,
    writeScopes: [normalizeScopePath(mounted.root)],
  })
}

function call(
  mounted: Harness,
  name: string,
  args: unknown,
  agent: Agent = mounted.callerAgent,
): Promise<ToolExecutionResult> {
  return mounted.ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`call-${++calls}`),
    signal: new AbortController().signal,
    agent,
  })
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function refusal(result: ToolExecutionResult): { code: string | undefined; message: string } {
  return {
    code: result.isError ? result.error.info?.code : undefined,
    message: text(result).replace(/^Error: /, ''),
  }
}

/** The scope-refusal message both tools produce for an unknown or out-of-scope target. */
function scopeMessage(id: string, scopes: readonly string[]): string {
  return `loop session tools are refused: target session "${id}" is unknown, or its workspace is outside the run's read scopes [${scopes.join(', ')}] and is not the caller's workspace`
}

describe('@deepseek-ai/dsh-tool-loop-query registration', () => {
  it('registers both tools with pinned descriptions, generic presenters, and disposes them', async () => {
    const mounted = await mount()
    expect(ToolLoopQuery.name).toBe('tool-loop-query')
    expect(ToolLoopQuery.inject).toEqual(['tools', 'sessionQuery', 'sessionProjections', 'subagents'])
    expect('default' in ToolLoopQuery).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(ToolLoopQuery)).toBe(ToolLoopQuery)

    expect(mounted.ctx.tools.schemas().map(schema => schema.name))
      .toEqual(['loop_session_search', 'loop_session_read'])
    const search = mounted.ctx.tools.get('loop_session_search')
    const read = mounted.ctx.tools.get('loop_session_read')
    expect(search?.description).toBe(
      "Usable only inside a current run's lineage, every other call refused. "
      + 'Search the sessions this run may read (its frozen read scopes plus your own workspace) for literal text, '
      + 'and return each matching event with its session id and sequence number so loop_session_read can pull it.',
    )
    expect(read?.description).toBe(
      "Usable only inside a current run's lineage, every other call refused. "
      + 'Read one session this run may read: its current model surface, or one exact event with optional neighboring events.',
    )
    expect(search?.timeoutMs).toBe(30_000)
    expect(read?.timeoutMs).toBeUndefined()
    expect(search?.parameters).not.toHaveProperty('properties.cursor')
    expect(search?.parameters).not.toHaveProperty('properties.limit')
    expect(search?.parameters).not.toHaveProperty('properties.cwd')
    expect(search?.output.render({}, 'rendered')).toEqual([{ type: 'text', text: 'rendered' }])
    expect(read?.isConcurrencySafe?.({})).toBe(true)

    expect(search?.presentCall?.({ query: 'needle' }))
      .toEqual({ card: 'generic', kind: 'search', title: 'Search relay-run sessions', rawInput: 'needle' })
    expect(read?.presentCall?.({}))
      .toEqual({ card: 'generic', kind: 'read', title: 'Read current session' })
    expect(read?.presentCall?.({ session_id: 'input' }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Read session input', rawInput: 'input' })
    expect(read?.presentCall?.({ seq: 4 }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Read event 4', rawInput: { seq: 4 } })
    expect(read?.presentCall?.({ session_id: 'input', seq: 4 }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Read event 4', rawInput: { session_id: 'input', seq: 4 } })
    expect(read?.presentCall?.({ seq: 'x' })).toBeUndefined()

    await mounted.fiber.dispose()
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual([])
  })

  it('keeps the search lane exclusive and the exact read parallel', async () => {
    const mounted = await mount()
    const mode = (name: string, args: unknown) => mounted.ctx.tools.executionMode({
      name,
      arguments: args,
      callId: ToolCallId(`mode-${name}`),
      signal: new AbortController().signal,
      agent: mounted.callerAgent,
    })
    expect(mode('loop_session_search', { query: 'q' })).toEqual({ kind: 'exclusive' })
    expect(mode('loop_session_read', {})).toEqual({ kind: 'parallel' })
  })

  it('fails invalid direct config before registering anything', async () => {
    const mounted = await mount()
    for (const maxSearchResults of [0, 1.5, Number.NaN]) {
      expect(() => { ToolLoopQuery.apply(mounted.ctx, { maxSearchResults }) }).toThrow('maxSearchResults')
    }
    for (const searchTimeoutMs of [0, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => { ToolLoopQuery.apply(mounted.ctx, { searchTimeoutMs }) }).toThrow('searchTimeoutMs')
    }
    expect(() => { ToolLoopQuery.apply(new Context(), {}) }).toThrow()
    expect(new ToolLoopQuery.Config({})).toEqual({ maxSearchResults: 100, searchTimeoutMs: 30_000 })
  })
})

describe('loop query lineage authorization', () => {
  it('refuses a caller outside any run lineage and names lineage', async () => {
    const mounted = await mount()
    const plain = await sessionWith(mounted, 'plain', mounted.root)
    for (const [name, args] of [['loop_session_search', { query: 'needle' }], ['loop_session_read', {}]] as const) {
      expect(refusal(await call(mounted, name, args, plain.agent))).toEqual({
        code: 'LOOP_QUERY_LINEAGE_REFUSED',
        message: 'loop session tools are refused: session "plain" is not inside a current run\'s lineage',
      })
    }
  })

  it('refuses a caller whose header claims a run it is not catalogued under', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const impostor = await sessionWith(mounted, 'impostor', mounted.root, mounted.caller.id)
    expect(refusal(await call(mounted, 'loop_session_read', {}, impostor.agent))).toEqual({
      code: 'LOOP_QUERY_LINEAGE_REFUSED',
      message: 'loop session tools are refused: session "impostor" is not a descendant child of the controlling session "caller"',
    })
  })

  it('stops a cyclic parent chain and refuses it', async () => {
    const mounted = await mount()
    const first = await sessionWith(mounted, 'cycle-a', mounted.root, SessionId('cycle-b'))
    await sessionWith(mounted, 'cycle-b', mounted.root, first.session.id)
    expect(refusal(await call(mounted, 'loop_session_read', {}, first.agent))).toEqual({
      code: 'LOOP_QUERY_LINEAGE_REFUSED',
      message: 'loop session tools are refused: session "cycle-a" is not inside a current run\'s lineage',
    })
  })

  it('serves the controlling session and a catalogued grandchild', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const input = await sessionWith(mounted, 'input', mounted.scopes)
    openStep(input.session, 'the quarterly needle lives here')
    const child = await sessionWith(mounted, 'child', mounted.root, mounted.caller.id)
    catalog(mounted.caller, child.session)
    const grandchild = await sessionWith(mounted, 'grandchild', mounted.root, child.session.id)
    catalog(child.session, grandchild.session)

    for (const agent of [mounted.callerAgent, child.agent, grandchild.agent]) {
      const result = await call(mounted, 'loop_session_search', { query: 'needle' }, agent)
      expect(refusal(result).code).toBeUndefined()
      expect(text(result)).toContain(`Session input — ${mounted.scopes}`)
      expect(text(result)).toContain('Snippet: the quarterly needle lives here')
    }
  })
})

describe('loop query scope authorization', () => {
  it('refuses a caller without an agent binding', async () => {
    const mounted = await mount()
    const result = await mounted.ctx.tools.execute({
      name: 'loop_session_read',
      arguments: {},
      callId: ToolCallId('agentless'),
      signal: new AbortController().signal,
    })
    expect(refusal(result)).toEqual({
      code: 'LOOP_QUERY_AGENT_REQUIRED',
      message: 'loop session tools require an agent-bound caller',
    })
  })

  it('refuses a target whose workspace no longer resolves', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const vanished = await sessionWith(mounted, 'vanished', join(mounted.root, 'deleted-workspace'))
    openStep(vanished.session, 'needle in a deleted workspace')
    const scopes = [normalizeScopePath(mounted.scopes)]
    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'vanished' }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('vanished', scopes),
    })
    expect(text(await call(mounted, 'loop_session_search', { query: 'needle' })))
      .toBe('No matching events in the sessions this run may read.')
  })

  it('refuses a surface read that resolves to a different session than the authorized target', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const target = await sessionWith(mounted, 'swapped', mounted.scopes)
    openStep(target.session, 'needle in the authorized session')
    const other = await sessionWith(mounted, 'other-surface', mounted.scopes)
    openStep(other.session, 'needle in the swapped session')
    const engine = mounted.ctx.get('sessionQuery') as HarnessQuery
    engine.swapSurfaceTo = other.session.id

    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'swapped' }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('swapped', [normalizeScopePath(mounted.scopes)]),
    })
  })

  it('refuses a target workspace outside the scopes and outside the caller workspace', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const outside = mkdtempSync(join(tmpdir(), 'dsh-tool-loop-query-outside-'))
    roots.push(outside)
    const target = await sessionWith(mounted, 'outside', outside)
    openStep(target.session, 'a needle nobody may read')
    const scopes = [normalizeScopePath(mounted.scopes)]

    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'outside' }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('outside', scopes),
    })
    expect(refusal(await call(mounted, 'loop_session_search', { query: 'needle', session_ids: ['outside'] }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('outside', scopes),
    })
    expect(refusal(await call(mounted, 'loop_session_search', { query: 'needle', session_ids: ['missing'] }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('missing', scopes),
    })
    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'ghost', seq: 0 }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('ghost', scopes),
    })
    expect(text(await call(mounted, 'loop_session_search', { query: 'needle' })))
      .toBe('No matching events in the sessions this run may read.')
  })

  it('serves a realpath-equivalent target inside a granted scope and the caller workspace lane', async () => {
    const mounted = await mount()
    const real = join(mounted.root, 'real-scope')
    mkdirSync(real)
    const link = join(mounted.root, 'scope-link')
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    await startRun(mounted, [normalizeScopePath(real)])

    const linked = await sessionWith(mounted, 'linked', link)
    openStep(linked.session, 'needle through a symlink')
    const own = join(mounted.root, 'own-workspace')
    mkdirSync(own)
    const ownSession = await sessionWith(mounted, 'own', own)
    openStep(ownSession.session, 'needle in the caller workspace')
    const child = await sessionWith(mounted, 'scope-child', own, mounted.caller.id)
    catalog(mounted.caller, child.session)

    const search = await call(mounted, 'loop_session_search', { query: 'needle' }, child.agent)
    expect(refusal(search).code).toBeUndefined()
    expect(text(search)).toContain(`Session linked — ${link}`)
    expect(text(search)).toContain('needle through a symlink')
    expect(text(search)).toContain('needle in the caller workspace')

    const read = await call(mounted, 'loop_session_read', { session_id: 'linked' }, child.agent)
    expect(refusal(read).code).toBeUndefined()
    expect(text(read)).toContain(`Session linked — ${link}`)
    expect(text(read)).toContain('needle through a symlink')
  })
})

describe('loop_session_search results', () => {
  it('renders matches grouped by session with a cap notice', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    await startRun(mounted)
    const first = await sessionWith(mounted, 'first', mounted.scopes)
    openStep(first.session, 'needle one')
    openStep(first.session, 'needle two')
    const second = await sessionWith(mounted, 'second', mounted.scopes)
    openStep(second.session, 'needle three')

    const rendered = text(await call(mounted, 'loop_session_search', { query: 'needle' }))
    expect(rendered).toContain('Loop session search results (2 matches in 2 sessions):')
    expect(rendered).toContain(`Session second — ${mounted.scopes}`)
    expect(rendered).toContain(`Session first — ${mounted.scopes}`)
    expect(rendered).toMatch(/1\. seq \d+ \| user\/message \| current \| \d{4}-/)
    expect(rendered).toContain('Snippet: needle three')
    expect(rendered).toContain('Result cap reached. Narrow the query or name fewer sessions.')
    expect(rendered).not.toContain('needle two')

    const bounded = await call(mounted, 'loop_session_search', { query: 'needle', session_ids: ['second'] })
    expect(text(bounded)).toContain('Loop session search results (1 matches in 1 sessions):')
    expect(text(bounded)).toContain('Session second — ')
    expect(text(bounded)).toContain('needle three')

    const typed = await call(mounted, 'loop_session_search', {
      query: 'needle',
      event_types: ['user/message'],
      surfaces: ['current'],
    })
    expect(text(typed)).toContain('needle one')
    expect(text(await call(mounted, 'loop_session_search', { query: 'needle', event_types: ['assistant/message'] })))
      .toBe('No matching events in the sessions this run may read.')
    expect(text(await call(mounted, 'loop_session_search', { query: 'needle', surfaces: ['log-only'] })))
      .toBe('No matching events in the sessions this run may read.')
  })

  it('scans each named session once when the model repeats an id', async () => {
    const mounted = await mount({ maxSearchResults: 10 })
    await startRun(mounted)
    const repeated = await sessionWith(mounted, 'repeated', mounted.scopes)
    openStep(repeated.session, 'needle once')
    openStep(repeated.session, 'needle twice')

    const rendered = text(await call(mounted, 'loop_session_search', {
      query: 'needle',
      session_ids: ['repeated', 'repeated'],
    }))
    expect(rendered).toContain('Loop session search results (2 matches in 1 sessions):')
    expect(rendered).toContain('needle once')
    expect(rendered).toContain('needle twice')
    expect(rendered).not.toContain('Result cap reached')
  })

  it('serves a result set exactly at the cap without the notice', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    await startRun(mounted)
    const exact = await sessionWith(mounted, 'exact', mounted.scopes)
    openStep(exact.session, 'needle one')
    openStep(exact.session, 'needle two')

    const rendered = text(await call(mounted, 'loop_session_search', { query: 'needle' }))
    expect(rendered).toContain('Loop session search results (2 matches in 1 sessions):')
    expect(rendered).toContain('needle one')
    expect(rendered).toContain('needle two')
    expect(rendered).not.toContain('Result cap reached')
  })

  it('groups hits from two sessions and truncates a long snippet', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const long = await sessionWith(mounted, 'long', mounted.scopes)
    openStep(long.session, `needle ${'x'.repeat(400)}`)
    const other = await sessionWith(mounted, 'other', mounted.scopes)
    openStep(other.session, 'needle short')
    openStep(other.session, 'needle again')

    const rendered = text(await call(mounted, 'loop_session_search', { query: 'needle' }))
    expect(rendered).toContain('Loop session search results (3 matches in 2 sessions):')
    expect(rendered).toContain(`Session long — ${mounted.scopes}`)
    expect(rendered).toContain(`Session other — ${mounted.scopes}`)
    expect(rendered.match(/^Session other — /gmu)).toHaveLength(1)
    const snippet = rendered.split('\n').find(line => line.includes('xxxx'))
    expect(snippet).toHaveLength('   Snippet: '.length + 201)
    expect(snippet?.endsWith('…')).toBe(true)
  })

  it('rejects blank, NUL, and empty list arguments before touching the corpus', async () => {
    const mounted = await mount()
    await startRun(mounted)
    expect(refusal(await call(mounted, 'loop_session_search', { query: '   ' }))).toEqual({
      code: 'LOOP_QUERY_INVALID_QUERY',
      message: 'loop_session_search: query must contain non-whitespace text',
    })
    expect(refusal(await call(mounted, 'loop_session_search', { query: 'bad\0query' }))).toEqual({
      code: 'LOOP_QUERY_INVALID_QUERY',
      message: 'loop_session_search: query must not contain NUL',
    })
    for (const args of [{ session_ids: [] }, { event_types: [] }, { surfaces: [] }]) {
      const result = await call(mounted, 'loop_session_search', { query: 'needle', ...args })
      expect(refusal(result).code).toBe('LOOP_QUERY_INVALID_ARGS')
    }
    expect(refusal(await call(mounted, 'loop_session_search', { query: 'needle', surfaces: ['archived'] })).code)
      .toBe('INVALID_ARGS')
    expect(refusal(await call(mounted, 'loop_session_search', {})).code).toBe('INVALID_ARGS')
  })
})

describe('loop_session_read results', () => {
  it('reads the calling session surface without a target id and reports an empty log', async () => {
    const mounted = await mount()
    await startRun(mounted)
    openStep(mounted.caller, 'needle in my own session')
    const rendered = text(await call(mounted, 'loop_session_read', {}))
    expect(rendered).toContain(`Session caller — ${mounted.root}`)
    expect(rendered).toMatch(/Captured through seq \d+; 1 current surface events:/)
    expect(rendered).toContain('needle in my own session')

    await sessionWith(mounted, 'empty', mounted.scopes)
    expect(text(await call(mounted, 'loop_session_read', { session_id: 'empty' })))
      .toContain('Captured through seq none; 0 current surface events:')
  })

  it('reads one exact event with neighboring events on both sides', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const target = await sessionWith(mounted, 'events', mounted.scopes)
    openStep(target.session, 'first needle')
    openStep(target.session, 'second needle')

    const only = await call(mounted, 'loop_session_read', { session_id: 'events', seq: 1 })
    expect(text(only)).toContain('Target event seq 1:')
    expect(text(only)).toContain('"type": "user/message"')
    expect(text(only)).not.toContain('Before:')
    expect(text(only)).not.toContain('After:')

    const middle = await call(mounted, 'loop_session_read', { session_id: 'events', seq: 1, before: 1, after: 1 })
    expect(text(middle)).toContain('Before:')
    expect(text(middle)).toContain('seq 0 | turn/start |')
    expect(text(middle)).toContain('After:')
    expect(text(middle)).toContain('seq 2 | step/start |')

    const last = await call(mounted, 'loop_session_read', { session_id: 'events', seq: 5, before: 1 })
    expect(text(last)).toContain('Before:')
    expect(text(last)).toContain('seq 4 | user/message |')
    expect(text(last)).not.toContain('After:')
  })

  it('rejects neighbor arguments without seq and negative counts', async () => {
    const mounted = await mount()
    await startRun(mounted)
    expect(refusal(await call(mounted, 'loop_session_read', { before: 1 }))).toEqual({
      code: 'LOOP_QUERY_INVALID_ARGS',
      message: 'loop_session_read: before and after require seq',
    })
    expect(refusal(await call(mounted, 'loop_session_read', { seq: -1 }))).toEqual({
      code: 'LOOP_QUERY_INVALID_ARGS',
      message: 'loop_session_read: seq must be a non-negative safe integer',
    })
    expect(refusal(await call(mounted, 'loop_session_read', { seq: 1, before: -1 })).message)
      .toBe('loop_session_read: before must be a non-negative safe integer')
    expect(refusal(await call(mounted, 'loop_session_read', { seq: 1, after: 2 ** 53 })).message)
      .toBe('loop_session_read: after must be a non-negative safe integer')
  })

  it('rejects a raw-event window the engine would refuse and serves the documented bound', async () => {
    const mounted = await mount()
    await startRun(mounted)
    expect(refusal(await call(mounted, 'loop_session_read', { seq: 0, before: 51 }))).toEqual({
      code: 'LOOP_QUERY_INVALID_ARGS',
      message: 'loop_session_read: before must be no greater than 50',
    })
    expect(refusal(await call(mounted, 'loop_session_read', { seq: 0, after: 51 }))).toEqual({
      code: 'LOOP_QUERY_INVALID_ARGS',
      message: 'loop_session_read: after must be no greater than 50',
    })

    openStep(mounted.caller, 'needle inside the bound')
    const bounded = await call(mounted, 'loop_session_read', { seq: 1, before: 50, after: 50 })
    expect(refusal(bounded).code).toBeUndefined()
    expect(text(bounded)).toContain('Target event seq 1:')
    expect(text(bounded)).toContain('needle inside the bound')
  })

  it('settles a missing event and a missing engine session as the scope refusal', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const scopes = [normalizeScopePath(mounted.scopes)]
    openStep(mounted.caller, 'needle in my own session')

    expect(refusal(await call(mounted, 'loop_session_read', { seq: 999 }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('caller', scopes),
    })

    const readableTarget = await sessionWith(mounted, 'readable', mounted.scopes)
    openStep(readableTarget.session, 'readable needle')
    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'readable', seq: 999 }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('readable', scopes),
    })

    await sessionWith(mounted, 'incomplete', mounted.scopes)
    vi.spyOn(mounted.ctx.sessionQuery, 'readSurface').mockRejectedValueOnce(
      new SessionQueryError('session "incomplete" not found', 'SESSION_QUERY_SESSION_NOT_FOUND'),
    )
    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'incomplete' }))).toEqual({
      code: 'LOOP_QUERY_SCOPE_REFUSED',
      message: scopeMessage('incomplete', scopes),
    })

    vi.spyOn(mounted.ctx.sessionQuery, 'readEvent').mockRejectedValueOnce(
      new SessionQueryError('persisted log is unreadable', 'SESSION_QUERY_CORRUPT_SESSION'),
    )
    expect(refusal(await call(mounted, 'loop_session_read', { session_id: 'readable', seq: 0 }))).toEqual({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
      message: 'persisted log is unreadable',
    })
  })

  it('renders a surface line without text for a contentless event and a workspace-less caller', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const blank = await sessionWith(mounted, 'blank', mounted.scopes)
    blank.session.append('turn/start', { turn: 1 })
    blank.session.append(
      'user/message',
      createUserMessage({ content: [], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    const rendered = text(await call(mounted, 'loop_session_read', { session_id: 'blank' }))
    expect(rendered).toContain('Captured through seq 1; 1 current surface events:')
    expect(rendered).toContain('1. seq 1 | user/message |')

    const workspaceLess = await sessionWith(mounted, 'workspace-less', undefined, mounted.caller.id)
    catalog(mounted.caller, workspaceLess.session)
    expect(text(await call(mounted, 'loop_session_read', {}, workspaceLess.agent)))
      .toContain('Session workspace-less — no workspace')
  })
})

describe('loop query runs that are not current', () => {
  it('refuses a caller whose controlling session cleared its loop', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const child = await sessionWith(mounted, 'after-clear', mounted.root, mounted.caller.id)
    catalog(mounted.caller, child.session)
    expect(refusal(await call(mounted, 'loop_session_read', {}, child.agent)).code).toBeUndefined()

    const ref = mounted.ctx.sessionProjections.stateOf(mounted.caller, 'loop')?.current?.loop
    if (ref === undefined) throw new Error('no current loop')
    await mounted.ctx.loops.clear(mounted.callerAgent, { id: ref.id, revision: ref.revision })
    expect(refusal(await call(mounted, 'loop_session_read', {}, child.agent))).toEqual({
      code: 'LOOP_QUERY_LINEAGE_REFUSED',
      message: 'loop session tools are refused: session "after-clear" is not inside a current run\'s lineage',
    })
  })
  it('keeps serving a run a lifecycle verb paused', async () => {
    const mounted = await mount()
    await startRun(mounted)
    const child = await sessionWith(mounted, 'paused-child', mounted.root, mounted.caller.id)
    catalog(mounted.caller, child.session)
    openStep(child.session, 'needle while paused')

    const ref = mounted.ctx.sessionProjections.stateOf(mounted.caller, 'loop')?.current?.loop
    if (ref === undefined) throw new Error('no current loop')
    await mounted.ctx.loops.pause(mounted.callerAgent, { id: ref.id, revision: ref.revision })

    expect(text(await call(mounted, 'loop_session_search', { query: 'needle' }, child.agent)))
      .toContain('needle while paused')
    expect(text(await call(mounted, 'loop_session_read', { session_id: 'paused-child', seq: 1 }, child.agent)))
      .toContain('needle while paused')
  })
})

describe('loop query tool deadline', () => {
  it('times out a stalled search through the shared tool deadline policy', async () => {
    const timeoutMs = 1_234
    const mounted = await mount({ searchTimeoutMs: timeoutMs }, true)
    await startRun(mounted)
    vi.useFakeTimers()

    const started = Promise.withResolvers<undefined>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    let deadlineSignal: AbortSignal | undefined
    vi.spyOn(mounted.ctx.sessionQuery, 'observeSession').mockImplementation(async (_id, options) => {
      const signal = options?.signal
      if (signal === undefined) throw new Error('expected a deadline signal')
      deadlineSignal = signal
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      started.resolve(undefined)
      await aborted
      abortObserved.resolve(undefined)
      await cleanup.promise
      signal.throwIfAborted()
      throw new Error('unreachable after the deadline')
    })

    const pending = call(mounted, 'loop_session_search', { query: 'needle' })
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )
    await started.promise
    await vi.advanceTimersByTimeAsync(timeoutMs)
    await abortObserved.promise

    expect(settled).toBe(false)
    expect(deadlineSignal?.reason).toBeInstanceOf(TimeoutReason)
    expect(deadlineSignal?.reason).toMatchObject({ code: 'TOOL_TIMEOUT', timeoutMs })

    cleanup.resolve(undefined)
    expect(refusal(await pending)).toEqual({
      code: 'TOOL_TIMEOUT',
      message: `tool call timed out after ${timeoutMs}ms`,
    })
  })
})
