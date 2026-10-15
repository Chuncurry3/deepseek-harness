/** Loader-booted behavior of the relay chain continuation driver. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LoopService, { LoopError } from '@deepseek-ai/dsh-loop'
import type { LoopLedgerEntry, LoopView, StartLoopRequest } from '@deepseek-ai/dsh-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import * as LoopDriver from '../src/index.ts'

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
}

const sessionStubs = new WeakMap<Session, StubAgent>()

/** Build a registry-compatible agent around one concrete session. */
function stubAgentForSession(session: Session, ctx: Context): StubAgent {
  const existing = sessionStubs.get(session)
  if (existing !== undefined) return existing
  const inbox = createInboxStub()
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  const stub = { agent, session }
  sessionStubs.set(session, stub)
  return stub
}

/** One scripted child outcome consumed in spawn order. */
interface ScriptEntry {
  /** Structured report of a completed child; absent for failure outcomes. */
  readonly structured?: unknown
  /** Terminal stop reason; `completed` when absent. */
  readonly stopReason?: 'error' | 'aborted' | 'max-tokens' | 'refusal'
  /** Provider-authored diagnostic of a non-completed child. */
  readonly diagnostic?: string
  /** Settles the child only when this promise resolves; a never-resolving promise parks it in flight. */
  readonly gate?: Promise<void>
  /** Rejects the spawn itself. */
  readonly startError?: Error
  /** Rejects the run result on infrastructure. */
  readonly resultError?: Error
  /** Text of the child's assistant surface message, appended to its session. */
  readonly reportText?: string
  /** Rejects run disposal. */
  readonly disposeError?: Error
}

/** One recorded spawn request. */
interface SpawnRecord {
  readonly label: string | undefined
  readonly cwd: string
  readonly prompt: string
  readonly outputSchema: unknown
  readonly signal: AbortSignal | undefined
  readonly sessionId: SessionId
}

/** A default-schema-conforming worker report. */
const WORKER_REPORT = { status: 'ok', summary: 'the report is ready', evidence: ['draft.txt'], nextSteps: ['review it'] }

/** The round verdicts the scripted evaluator settles. */
const VERDICT_CONTINUE = { decision: 'continue', feedback: 'tighten the summary' }
const VERDICT_COMPLETE = { decision: 'complete' }
const VERDICT_BLOCKED = { decision: 'blocked', reason: 'the workspace is unreachable' }

/**
 * The scripted subagent provider: every spawn consumes the next script entry,
 * creates a real child session carrying the driver's prompt (and optionally a
 * final assistant report message), and settles per the entry.
 */
function stubProvider(ctx: Context, script: readonly ScriptEntry[]): {
  readonly provider: SubagentProvider
  readonly spawns: SpawnRecord[]
  readonly readDisposals: () => number
} {
  const spawns: SpawnRecord[] = []
  let disposals = 0
  const provider: SubagentProvider = {
    name: 'stub',
    capabilities: { agentOptions: false, outputSchema: true, depthLimit: false, toolFilter: false, persona: false, cwdOverride: true },
    // A spawned relay node starts fresh: it never sees the controlling conversation.
    inheritsParentContext: false,
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      const entry = script[spawns.length] ?? {}
      if (entry.startError !== undefined) return Promise.reject(entry.startError)
      const promptText = request.prompt[0]?.type === 'text' ? request.prompt[0].text : ''
      const id = SessionId(`lcd-child-${randomUUID()}`)
      const child = ctx.sessions.create(id, {
        meta: { ...request.cwd === undefined ? {} : { cwd: request.cwd }, parentSession: request.parent.session.id, origin: 'subagent', delegationDepth: 1 },
      })
      child.append('user/message', createUserMessage({
        content: [{ type: 'text', text: promptText }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      if (entry.reportText !== undefined) {
        child.append('assistant/message', {
          turn: 2,
          step: 1,
          stream: [],
          message: createMessage({
            role: 'assistant',
            content: [{ type: 'text', text: entry.reportText }],
            source: { kind: 'model', provider: 'stub', model: 'stub' },
          }),
        }, { surfaceOp: 'append' })
      }
      spawns.push({ label: request.label, cwd: request.cwd ?? '', prompt: promptText, outputSchema: request.outputSchema, signal: request.signal, sessionId: id })
      const settled = Promise.withResolvers<SubagentResult>()
      const output = entry.structured === undefined ? [] : [{ type: 'text' as const, text: JSON.stringify(entry.structured) }]
      const finish = (): void => {
        settled.resolve({
          output,
          stopReason: entry.stopReason ?? 'completed',
          ...entry.structured === undefined ? {} : { structured: entry.structured },
          ...entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic },
        })
      }
      if (entry.resultError !== undefined) {
        settled.reject(entry.resultError)
      } else if (entry.gate === undefined) {
        finish()
      } else {
        request.signal?.addEventListener('abort', () => { settled.resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
        void entry.gate.then(finish)
      }
      const run: SubagentRun = {
        id,
        localAgent: stubAgentForSession(child, ctx).agent,
        result: settled.promise,
        async dispose() {
          disposals += 1
          if (entry.disposeError !== undefined) throw entry.disposeError
        },
      }
      return Promise.resolve(run)
    },
  }
  return { provider, spawns, readDisposals: () => disposals }
}

/** One scripted checkpoint answerer surface shared by the factories below. */
interface Answerer {
  readonly seen: AskUserQuestionRequest[]
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/** Answerer consuming one scripted label per ask, defaulting to continue. */
function scriptedAnswerer(labels: readonly string[]): Answerer {
  const seen: AskUserQuestionRequest[] = []
  const queue = [...labels]
  return {
    seen,
    ask(request) {
      seen.push(request)
      const label = queue.shift() ?? 'continue'
      return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: [label] })) })
    },
  }
}

/** Answerer that never settles on its own and rejects when its ask window aborts, like a disconnecting UI. */
function gatedAnswerer(): Answerer {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    ask(request) {
      seen.push(request)
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new UserQuestionError('ask window closed', 'ASK_ABORTED'))
        }, { once: true })
      })
    },
  }
}

/** Answerer failing every ask. */
function failingAnswerer(error: () => Error): Answerer {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    ask(request) {
      seen.push(request)
      return Promise.reject(error())
    },
  }
}

/** Answerer whose first ask fails generically and whose later asks continue. */
function flakyAnswerer(): Answerer {
  const seen: AskUserQuestionRequest[] = []
  let asked = 0
  return {
    seen,
    ask(request) {
      seen.push(request)
      asked += 1
      if (asked === 1) return Promise.reject(new Error('answerer backend down'))
      return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: ['continue'] })) })
    },
  }
}

let loaderRoot: string | undefined
let context: Context | undefined
const workspaces: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (loaderRoot !== undefined) await rm(loaderRoot, { recursive: true, force: true })
  loaderRoot = undefined
  for (const dir of workspaces.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Boot one real Loader composition from in-memory module records. */
async function loadYaml(lines: readonly string[]): Promise<Context> {
  loaderRoot = await mkdtemp(join(tmpdir(), 'dsh-loop-driver-'))
  const configPath = join(loaderRoot, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(loaderRoot).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-loop', LoopService],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-session-query', TestSessionQuery],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-loop-chain-driver', LoopDriver],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** One freshly created enterable node workspace. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-loop-driver-ws-'))
  workspaces.push(dir)
  return dir
}

/** Options of one booted driver composition. */
interface BootOptions {
  /** yaml config lines nested under the dsh-loop entry. */
  readonly loopConfig?: readonly string[]
  /** Whether the driver entry loads; false boots services only for direct plugin mounting. */
  readonly withDriver?: boolean
  /** Whether the user-questions service composes; default true. */
  readonly withUserQuestions?: boolean
  /** Whether the session-query service composes; default true. */
  readonly withSessionQuery?: boolean
  /** The provider script; the default entry completes with a conforming report. */
  readonly script?: readonly ScriptEntry[]
  /** The checkpoint answerer, installed before any loop starts. */
  readonly answerer?: Answerer
  /** The controlling session's cwd; null leaves the session workspace-less. Defaults to a fresh scratch workspace. */
  readonly sessionCwd?: string | null
}

/** The booted test surface of one composition. */
interface Booted {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly spawns: SpawnRecord[]
  readonly readDisposals: () => number
  readonly driver: { dispose(): Promise<void> } | undefined
  readonly retireAgent: () => Promise<void>
}

/** Boot the full composition, register the stub provider, and register the controlling agent. */
async function boot(options: BootOptions = {}): Promise<Booted> {
  const lines = [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-loop'",
    ...(options.loopConfig ?? []),
    "- name: '@deepseek-ai/dsh-subagent'",
    ...(options.withSessionQuery === false ? [] : ["- name: '@deepseek-ai/dsh-session-query'"]),
    ...(options.withUserQuestions === false ? [] : ["- name: '@deepseek-ai/dsh-user-questions'"]),
    ...(options.withDriver === false ? [] : [
      "- name: '@deepseek-ai/dsh-loop-chain-driver'",
      '  config:',
      "    provider: 'stub'",
    ]),
  ]
  const ctx = await loadYaml(lines)
  const home = await workspace()
  const stub = stubProvider(ctx, options.script ?? [])
  ctx.subagents.registerProvider(stub.provider)
  if (options.answerer !== undefined) {
    ctx.on('user-questions/request', request => options.answerer!.ask(request))
  }
  const session = ctx.sessions.create(
    SessionId(`loop-driver-${randomUUID()}`),
    ...options.sessionCwd === null ? [] : [{ meta: { cwd: options.sessionCwd ?? home } }],
  )
  const controlling = stubAgentForSession(session, ctx)
  const retire = ctx.agents.register(controlling.agent)
  await retire
  let driver: { dispose(): Promise<void> } | undefined
  if (options.withDriver === false) {
    const fiber = await ctx.plugin(LoopDriver, { provider: 'stub' })
    driver = { dispose: () => fiber.dispose() }
  }
  return {
    ctx,
    session,
    agent: controlling.agent,
    spawns: stub.spawns,
    readDisposals: stub.readDisposals,
    driver,
    retireAgent: () => retire(),
  }
}

/** The current loop view and ledger of one controlling session. */
function loopOf(ctx: Context, session: Session): { readonly view: LoopView; readonly ledger: readonly LoopLedgerEntry[] } | undefined {
  const current = ctx.sessionProjections.stateOf(session, 'loop')?.current
  if (current === null || current === undefined || current.loop === undefined) return undefined
  const view = { loop: current.loop, createdAt: current.createdAt ?? 0, updatedAt: current.updatedAt ?? 0, activation: 'armed' }
  return { view: view as unknown as LoopView, ledger: current.ledger }
}

/** The settlements of one round in ledger order. */
function settlementsOf(ledger: readonly LoopLedgerEntry[], round: number): readonly LoopLedgerEntry[] {
  return ledger.filter(entry => entry.kind === 'settlement' && entry.round === round)
}

/** The recorded attempt failures of one node in ledger order. */
function attemptsOf(ledger: readonly LoopLedgerEntry[]): readonly LoopLedgerEntry[] {
  return ledger.filter(entry => entry.kind === 'attempt')
}

/** Wait until one condition holds. */
async function waitUntil(condition: () => void): Promise<void> {
  await vi.waitFor(condition)
}

/** A two-worker relay chain over the given workspaces. */
function chain(checkpoint: 'none' | 'node', cwd: string): StartLoopRequest['chain'] {
  return {
    objective: 'relay the monthly report',
    checkpoint,
    nodes: [
      { role: 'writer', prompt: 'Draft the report.', cwd },
      { role: 'reviewer', prompt: 'Review the draft.', carryOver: ['writer'], cwd },
    ],
  }
}

/** Build one start request over the given chain. */
function startRequest(chainDef: StartLoopRequest['chain'], scopes: readonly string[]): StartLoopRequest {
  return { objective: 'relay the monthly report', chain: chainDef, readScopes: [...scopes], writeScopes: [...scopes] }
}

describe('full round driving', () => {
  it('drives each worker then the evaluator, carries reports and feedback, and applies the verdict once per round', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'the review is done' } },
      { structured: VERDICT_CONTINUE },
      { structured: { ...WORKER_REPORT, summary: 'round two draft' } },
      { structured: { ...WORKER_REPORT, summary: 'round two review' } },
      { structured: VERDICT_COMPLETE },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      const state = loopOf(booted.ctx, booted.session)
      if (state?.view.loop.phase === 'blocked') throw new Error('BLOCKED1: ' + JSON.stringify(state.view.loop.blockedReason))
      expect(state?.view.loop.phase).toBe('complete')
    })

    const state = loopOf(booted.ctx, booted.session)!
    // Round 2 ended complete: only round 1's continue verdict advanced the count.
    expect(state.view.loop.roundsStarted).toBe(1)
    expect(booted.spawns).toHaveLength(6)
    expect(settlementsOf(state.ledger, 1).map(entry => entry.kind === 'settlement' && entry.role)).toEqual(['writer', 'reviewer', 'evaluator'])
    expect(settlementsOf(state.ledger, 2)).toHaveLength(3)

    // Round 1 writer: opening prompt names the round, node, and role.
    expect(booted.spawns[0]!.prompt).toContain('Relay loop round 1, node 1 of 3: "writer".')
    expect(booted.spawns[0]!.label).toBe('writer')
    expect(booted.spawns[0]!.cwd).toBe(alpha)
    expect(JSON.stringify(booted.spawns[0]!.outputSchema)).toContain('"summary"')
    // Round 1 reviewer: the writer's settlement report and child session carry over.
    expect(booted.spawns[1]!.prompt).toContain('node 2 of 3')
    expect(booted.spawns[1]!.prompt).toContain(JSON.stringify(WORKER_REPORT))
    expect(booted.spawns[1]!.prompt).toContain(String(booted.spawns[0]!.sessionId))
    // Round 1 evaluator: verdict schema and default instruction.
    expect(booted.spawns[2]!.label).toBe('evaluator')
    expect(JSON.stringify(booted.spawns[2]!.outputSchema)).toContain('"decision"')
    // Round 2 writer: the continue verdict's feedback carries forward.
    expect(booted.spawns[3]!.prompt).toContain('Relay loop round 2, node 1 of 3')
    expect(booted.spawns[3]!.prompt).toContain('Evaluator feedback from the round 1 verdict')
    expect(booted.spawns[3]!.prompt).toContain('tighten the summary')
    // Every attempt spawns a fresh child session.
    expect(new Set(booted.spawns.map(spawn => spawn.sessionId)).size).toBe(6)
  })

  it('drives without spawning when neither the chain nor the session declares a workspace', async () => {
    const booted = await boot({ script: [{ structured: WORKER_REPORT }], sessionCwd: null })
    const cwdless = { objective: 'relay', checkpoint: 'none', nodes: [{ role: 'writer', prompt: 'Draft.' }] } as const
    await booted.ctx.loops.start(booted.agent, startRequest(cwdless, []))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('node-failed')
    expect(view.loop.blockedReason?.message).toContain('has no workspace')
    expect(booted.spawns).toHaveLength(0)
  })

  it('keeps spawned child writes out of the controlling session log and keys the ledger by session identity', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const booted = await boot({ script: [{ structured: WORKER_REPORT }, { gate: parked }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(booted.spawns.length).toBe(2)
    })
    const child = booted.ctx.sessions.get(booted.spawns[0]!.sessionId)!
    // The child's model turns live in its own session log...
    expect(child.ownEvents().some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(true)
    // ...and never append into the controlling session's log, which carries only
    // loop records and the subagent catalog pointers.
    expect(booted.session.ownEvents().every(event => event.type.startsWith('loop/') || event.type === 'subagent/catalog')).toBe(true)
    // The child session owns no loop events: the ledger lives in the controlling
    // session's fold, so node identity is session-owned, not a bare global node index.
    expect(child.ownEvents().every(event => !event.type.startsWith('loop/'))).toBe(true)
    expect(loopOf(booted.ctx, child)).toBeUndefined()
    const state = loopOf(booted.ctx, booted.session)!
    expect(settlementsOf(state.ledger, 1).map(entry => entry.kind === 'settlement' && entry.nodeIndex)).toEqual([0])
    expect(settlementsOf(state.ledger, 1)[0]).toMatchObject({ childSessionId: booted.spawns[0]!.sessionId })
    await booted.retireAgent()
  })
})

describe('node retries and failure classification', () => {
  it('records the failure, retries with the failure reason in the prompt, and blocks node-failed when the epoch budget is exhausted', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { stopReason: 'error', diagnostic: 'model fault' },
      { stopReason: 'error' },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const state = loopOf(booted.ctx, booted.session)!
    const attempts = attemptsOf(state.ledger)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ kind: 'attempt', round: 1, nodeIndex: 0, attempt: 1, failure: { code: 'error', message: 'model fault' } })
    expect(attempts[1]).toMatchObject({ attempt: 2, failure: { code: 'error' } })
    // The retried spawn carries the recorded failure forward.
    expect(booted.spawns[1]!.prompt).toContain('Previous attempt failed and was not accepted: error: model fault')
    expect(booted.spawns).toHaveLength(2)
    expect(state.view.loop.blockedReason).toMatchObject({ code: 'node-failed' })
    expect(state.view.loop.blockedReason?.message).toContain('exhausted 2 retries')
  })

  it('blocks node-failed without spawning when the chain cwd does not exist', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    const missing = join(alpha, 'does-not-exist')
    const outside = { objective: 'relay', checkpoint: 'none', nodes: [{ role: 'writer', prompt: 'Draft.', cwd: missing }] } as const
    await booted.ctx.loops.start(booted.agent, startRequest(outside, [missing]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('node-failed')
    expect(view.loop.blockedReason?.message).toContain('could not spawn through provider "stub"')
    expect(booted.spawns).toHaveLength(0)
  })

  it('retries a completed child whose structured report violates the handoff schema', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: { status: 'ok' } },
      { structured: WORKER_REPORT },
      { structured: VERDICT_COMPLETE },
    ] })
    const single = { objective: 'relay', checkpoint: 'none', nodes: [{ role: 'writer', prompt: 'Draft.', cwd: alpha }] } as const
    await booted.ctx.loops.start(booted.agent, startRequest(single, [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    const state = loopOf(booted.ctx, booted.session)!
    const attempts = attemptsOf(state.ledger)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ kind: 'attempt', attempt: 1, failure: { code: 'invalid-report' } })
    expect(booted.spawns[1]!.prompt).toContain('Previous attempt failed and was not accepted: invalid-report')
    expect(booted.spawns).toHaveLength(3)
  })

  it('retries a completed child that produced no structured report', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      {},
      { structured: WORKER_REPORT },
      { structured: VERDICT_COMPLETE },
    ] })
    const single = { objective: 'relay', checkpoint: 'none', nodes: [{ role: 'writer', prompt: 'Draft.', cwd: alpha }] } as const
    await booted.ctx.loops.start(booted.agent, startRequest(single, [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    const attempts = attemptsOf(loopOf(booted.ctx, booted.session)!.ledger)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ failure: { code: 'missing-structured' } })
    expect(booted.spawns).toHaveLength(3)
  })

  it('blocks node-failed when the run result rejects on infrastructure', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ resultError: new Error('provider transport died') }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('node-failed')
    expect(view.loop.blockedReason?.message).toContain('run rejected on infrastructure: provider transport died')
    expect(attemptsOf(loopOf(booted.ctx, booted.session)!.ledger)).toHaveLength(0)
  })

  it('blocks node-failed immediately when the provider refuses the spawn', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ startError: new Error('provider out of capacity') }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('node-failed')
    expect(view.loop.blockedReason?.message).toContain('provider out of capacity')
    expect(booted.spawns).toHaveLength(0)
  })
})

describe('checkpoint parks and answers', () => {
  it('parks after each settled worker, asks the ordered options, and continues on the answer', async () => {
    const alpha = await workspace()
    const answerer = scriptedAnswerer(['continue', 'continue', 'continue', 'continue'])
    const booted = await boot({ answerer, script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_CONTINUE },
      { structured: { ...WORKER_REPORT, summary: 'round two draft' } },
      { structured: { ...WORKER_REPORT, summary: 'round two review' } },
      { structured: VERDICT_COMPLETE },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(answerer.seen.length).toBe(4)
    })
    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    // One ask per settled worker node before the evaluator, per round.
    expect(answerer.seen.map(request => request.questions[0]?.question)).toEqual([
      'Relay loop round 1: 1 of 3 nodes settled. Continue the relay, pause it, or terminate it?',
      'Relay loop round 1: 2 of 3 nodes settled. Continue the relay, pause it, or terminate it?',
      'Relay loop round 2: 1 of 3 nodes settled. Continue the relay, pause it, or terminate it?',
      'Relay loop round 2: 2 of 3 nodes settled. Continue the relay, pause it, or terminate it?',
    ])
    expect(answerer.seen[0]!.questions[0]!.options!.map(option => option.label)).toEqual(['continue', 'pause', 'terminate'])
    expect(answerer.seen[0]!.questions[0]!.header).toBe('Relay loop checkpoint')
    expect(booted.spawns).toHaveLength(6)
  })

  it('pauses the loop on a pause answer and stops driving', async () => {
    const alpha = await workspace()
    const answerer = scriptedAnswerer(['pause'])
    const booted = await boot({ answerer, script: [{ structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('paused')
    })
    expect(booted.spawns).toHaveLength(1)
  })

  it('clears the loop on a terminate answer and stops driving', async () => {
    const alpha = await workspace()
    const answerer = scriptedAnswerer(['terminate'])
    const booted = await boot({ answerer, script: [{ structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)).toBeUndefined()
    })
    expect(booted.spawns).toHaveLength(1)
  })

  it('re-issues the checkpoint ask when resume re-arms an awaiting-human loop', async () => {
    const alpha = await workspace()
    const answerer = flakyAnswerer()
    const booted = await boot({ answerer, script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    // The first ask fails generically: the loop parks awaiting-human, disarmed, with the ask closed.
    await waitUntil(() => {
      expect(answerer.seen.length).toBe(1)
    })
    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('awaiting-human')
    })
    const parked = loopOf(booted.ctx, booted.session)!.view
    expect(parked.loop.phase).toBe('awaiting-human')

    await booted.ctx.loops.resume(booted.agent, { id: parked.loop.id, revision: parked.loop.revision })

    await waitUntil(() => {
      expect(answerer.seen.length).toBe(2)
    })
    // The re-issued ask continues the round from the settled count.
    expect(answerer.seen[1]?.questions[0]?.question).toContain('round 1: 1 of 3 nodes settled')
    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    expect(booted.spawns).toHaveLength(3)
  })

  it('blocks checkpoint-provider-missing when the user-questions service is not composed', async () => {
    const alpha = await workspace()
    const booted = await boot({ withUserQuestions: false, script: [{ structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('checkpoint-provider-missing')
    expect(booted.spawns).toHaveLength(1)
  })

  it('blocks checkpoint-provider-missing when the ask rejects with NO_PROVIDER', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('checkpoint-provider-missing')
    expect(booted.spawns).toHaveLength(1)
  })

  it('warns and stays awaiting-human when the answerer fails generically', async () => {
    const alpha = await workspace()
    const answerer = failingAnswerer(() => new Error('answerer backend down'))
    const booted = await boot({ answerer, script: [{ structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(answerer.seen.length).toBe(1)
    })
    await new Promise(resolve => setImmediate(resolve))
    const state = loopOf(booted.ctx, booted.session)
    expect(state?.view.loop.phase).toBe('awaiting-human')
    expect(state?.view.loop.blockedReason).toBeUndefined()
    expect(booted.spawns).toHaveLength(1)
  })

  it('aborts the open ask and parks the pause when a concurrent pause wins the race', async () => {
    const alpha = await workspace()
    const answerer = gatedAnswerer()
    const booted = await boot({ answerer, script: [{ structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('node', alpha), [alpha]))

    await waitUntil(() => {
      expect(answerer.seen.length).toBe(1)
    })
    // The checkpoint parked the loop before the pause: pause the fresh revision.
    const parked = loopOf(booted.ctx, booted.session)!.view
    await booted.ctx.loops.pause(booted.agent, { id: parked.loop.id, revision: parked.loop.revision })

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('paused')
    })
    expect(booted.spawns).toHaveLength(1)
  })
})

describe('evaluator budget and verdict outcomes', () => {
  it('blocks report-budget before spawning the evaluator when the aggregate overflows the cap', async () => {
    const alpha = await workspace()
    const big = { status: 'ok', summary: 'x'.repeat(400), evidence: ['draft.txt'], nextSteps: ['review it'] }
    const booted = await boot({ loopConfig: ['  config:', '    maxEvaluatorInputChars: 120'], script: [
      { structured: big },
      { structured: big },
      { structured: VERDICT_CONTINUE },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.blockedReason?.code).toBe('report-budget')
    expect(state.view.loop.blockedReason?.message).toContain('exceeding the maxEvaluatorInputChars cap of 120')
    // Both workers settled; the evaluator never spawned.
    expect(booted.spawns.map(spawn => spawn.label)).toEqual(['writer', 'reviewer'])
  })

  it('blocks evaluator-blocked on a blocked verdict with its reason', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_BLOCKED },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason).toMatchObject({ code: 'evaluator-blocked', message: 'the workspace is unreachable' })
  })

  it('blocks evaluator-blocked with the generic message when the verdict carries no reason', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: { decision: 'blocked' } },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason).toMatchObject({ code: 'evaluator-blocked', message: 'round 1 evaluator verdict blocked the run' })
  })

  it('blocks round-limit when a continue verdict would exceed maxRounds', async () => {
    const alpha = await workspace()
    const booted = await boot({ loopConfig: ['  config:', '    defaultMaxRounds: 1'], script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_CONTINUE },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('round-limit')
    expect(view.loop.blockedReason?.message).toContain('reached its configured limit of 1 rounds')
  })
})

describe('restart and recovery', () => {
  /** The booted second context of one restart: services, stub provider, and the seeded controlling agent. */
  interface Rebooted {
    readonly ctx: Context
    readonly session: Session
    readonly agent: Agent
    readonly spawns: SpawnRecord[]
    readonly retire: () => Promise<void>
  }

  /** Boot one fresh context over the same module records and seed a session with captured events. */
  async function reboot(seed: readonly SessionEvent[], script: readonly ScriptEntry[]): Promise<Rebooted> {
    const booted = await boot({ script })
    const home = await workspace()
    const session = booted.ctx.sessions.create(SessionId(`loop-driver-${randomUUID()}`), { seed, meta: { cwd: home } })
    const controlling = stubAgentForSession(session, booted.ctx)
    const retire = booted.ctx.agents.register(controlling.agent)
    await retire
    return { ctx: booted.ctx, session, agent: controlling.agent, spawns: booted.spawns, retire: () => retire() }
  }

  it('does no work at load, disarms, and after resume recovers the in-flight child and enumerates crashed children', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const first = await boot({ script: [
      { gate: parked, reportText: JSON.stringify(WORKER_REPORT) },
      { structured: WORKER_REPORT },
    ] })
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(first.spawns.length).toBe(1)
    })
    // An unledgered child crashes between publication and the node-started append.
    const run = await first.ctx.subagents.start('stub', {
      parent: first.agent,
      prompt: [{ type: 'text', text: 'orphaned work' }],
      cwd: alpha,
      label: 'writer',
      signal: new AbortController().signal,
    })
    await run.result
    await run.dispose()

    const parentEvents = first.session.ownEvents()
    const childEvents = (first.ctx.sessions.get(first.spawns[0]!.sessionId))!.ownEvents()
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(parentEvents, [
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_CONTINUE },
      { structured: { ...WORKER_REPORT, summary: 'round two draft' } },
      { structured: { ...WORKER_REPORT, summary: 'round two review' } },
      { structured: VERDICT_COMPLETE },
    ])
    const warn = vi.spyOn(second.ctx.logger, 'warn')
    second.ctx.sessions.create(first.spawns[0]!.sessionId, { seed: childEvents })

    // Load disarms the resumed loop: no work happens before an explicit resume.
    await new Promise(resolve => setImmediate(resolve))
    expect(second.ctx.loops.activation(second.agent)).toBe('disarmed')
    expect(second.spawns).toHaveLength(0)

    const view = loopOf(second.ctx, second.session)!.view
    await second.ctx.loops.resume(second.agent, { id: view.loop.id, revision: view.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('complete')
    })
    const state = loopOf(second.ctx, second.session)!
    // The in-flight child settled from its recovered assistant report, without a respawn.
    const recovered = settlementsOf(state.ledger, 1).find(entry => entry.kind === 'settlement' && entry.nodeIndex === 0)
    expect(recovered).toMatchObject({ kind: 'settlement', attempt: 1, childSessionId: first.spawns[0]!.sessionId, report: WORKER_REPORT })
    // Round 1 spawned only the reviewer and evaluator; round 2 spawned all three nodes.
    expect(second.spawns.map(spawn => spawn.label)).toEqual(['reviewer', 'evaluator', 'writer', 'reviewer', 'evaluator'])
    // Only round 1's continue verdict advanced the count; round 2 ended complete.
    expect(state.view.loop.roundsStarted).toBe(1)
    // The unledgered crash was reported, never recovered or settled.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(run.id)))
    expect(state.ledger.some(entry => entry.kind === 'settlement' && entry.childSessionId === run.id)).toBe(false)
    await second.retire()
  })

  it('applies a pending evaluator verdict exactly once and drives the next round', async () => {
    const alpha = await workspace()
    const first = await boot({ script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_CONTINUE },
    ] })
    // Crash deterministically between the evaluator settlement and the verdict application.
    vi.spyOn(first.ctx.loops, 'advance').mockRejectedValueOnce(new LoopError('crash window', 'LOOP_STALE_REVISION'))
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(settlementsOf(loopOf(first.ctx, first.session)!.ledger, 1)).toHaveLength(3)
    })
    // The rejected advance left the verdict pending: roundsStarted still lags.
    const parentEvents = first.session.ownEvents()
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(parentEvents, [
      { structured: { ...WORKER_REPORT, summary: 'round two draft' } },
      { structured: { ...WORKER_REPORT, summary: 'round two review' } },
      { structured: VERDICT_COMPLETE },
    ])

    const before = loopOf(second.ctx, second.session)!.view
    expect(before.loop.roundsStarted).toBe(0)
    await second.ctx.loops.resume(second.agent, { id: before.loop.id, revision: before.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('complete')
    })
    const state = loopOf(second.ctx, second.session)!
    // The pending verdict advanced exactly one round; round 1 was never re-driven.
    expect(state.view.loop.roundsStarted).toBe(1)
    expect(second.spawns.map(spawn => spawn.label)).toEqual(['writer', 'reviewer', 'evaluator'])
    expect(second.spawns[0]!.prompt).toContain('Relay loop round 2, node 1 of 3')
    await second.retire()
  })

  it('grants fresh retries after a restart by lifting the epoch floor off pre-restart attempts', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    // Attempt 1 fails durably; attempt 2 spawns and parks, then the host crashes.
    const first = await boot({ script: [{ stopReason: 'error' }, { gate: parked }] })
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(first.spawns.length).toBe(2)
    })
    const parentEvents = first.session.ownEvents()
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(parentEvents, [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ])
    const view = loopOf(second.ctx, second.session)!.view
    await second.ctx.loops.resume(second.agent, { id: view.loop.id, revision: view.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('complete')
    })
    // The pre-restart closed attempt sits below the resume revision; the parked node-started
    // became an interrupted attempt, and the fresh retry still spawned within the budget.
    expect(second.spawns).toHaveLength(3)
    const state = loopOf(second.ctx, second.session)!
    expect(attemptsOf(state.ledger).map(entry => (entry as { failure?: { code?: string } }).failure?.code)).toEqual([
      'error', 'interrupted-by-shutdown',
    ])
    expect(settlementsOf(state.ledger, 1).find(entry => entry.nodeIndex === 0)?.attempt).toBe(3)
    await second.retire()
  })

  it('refuses to spawn when a resumed chain workspace falls outside the write scopes', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const first = await boot({ script: [{ gate: parked }] })
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(first.spawns.length).toBe(1)
    })
    // Forge the corrupt read path: the replayed chain declares a workspace outside the
    // frozen write scopes and the crashed spawn leaves no ledger record, so only the
    // driver's spawn-time scope re-assert can refuse it.
    const hostile = '/hostile-outside-write-scopes'
    const forged = first.session.ownEvents()
      .filter(event => event.type !== 'loop/node-started')
      .map((event) => {
        if (event.type !== 'loop/change' || event.data.operation === 'clear') return event
        const data = structuredClone(event.data)
        const nodes = data.loop.chain.nodes as unknown as { cwd?: string }[]
        for (const node of nodes) node.cwd = hostile
        return { ...event, data }
      })
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(forged, [{ structured: WORKER_REPORT }])
    const view = loopOf(second.ctx, second.session)!.view
    // The fold accepted the out-of-scope chain: structure validation never cross-checks scopes.
    expect(view.loop.chain.nodes.every(node => node.cwd === hostile)).toBe(true)
    expect(view.loop.writeScopes).toEqual([alpha])
    await second.ctx.loops.resume(second.agent, { id: view.loop.id, revision: view.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('blocked')
    })
    const state = loopOf(second.ctx, second.session)!
    expect(state.view.loop.blockedReason).toMatchObject({ code: 'node-failed' })
    expect(state.view.loop.blockedReason?.message).toContain('LOOP_SCOPE_VIOLATION')
    expect(state.view.loop.blockedReason?.message).toContain(hostile)
    // The refusal is non-retryable authorization: no spawn and no attempt consumed.
    expect(second.spawns).toHaveLength(0)
    expect(attemptsOf(state.ledger)).toHaveLength(0)
    await second.retire()
  })

  it('records an interrupted attempt and respawns when the crashed child left no report', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const first = await boot({ script: [{ gate: parked }] })
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(first.spawns.length).toBe(1)
    })
    const parentEvents = first.session.ownEvents()
    const childEvents = (first.ctx.sessions.get(first.spawns[0]!.sessionId))!.ownEvents()
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(parentEvents, [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ])
    second.ctx.sessions.create(first.spawns[0]!.sessionId, { seed: childEvents })

    const view = loopOf(second.ctx, second.session)!.view
    await second.ctx.loops.resume(second.agent, { id: view.loop.id, revision: view.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('complete')
    })
    const state = loopOf(second.ctx, second.session)!
    const attempts = attemptsOf(state.ledger)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ kind: 'attempt', nodeIndex: 0, attempt: 1, failure: { code: 'interrupted-by-shutdown' } })
    // The respawned writer settled on a fresh child session.
    const settled = settlementsOf(state.ledger, 1).find(entry => entry.kind === 'settlement' && entry.nodeIndex === 0)
    expect(settled).toMatchObject({ attempt: 2, report: WORKER_REPORT })
    await second.retire()
  })

  it('records an invalid-recovered-report attempt when the crashed child left unparseable output', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const first = await boot({ script: [{ gate: parked, reportText: 'not json at all' }] })
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(first.spawns.length).toBe(1)
    })
    const parentEvents = first.session.ownEvents()
    const childEvents = (first.ctx.sessions.get(first.spawns[0]!.sessionId))!.ownEvents()
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(parentEvents, [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ])
    second.ctx.sessions.create(first.spawns[0]!.sessionId, { seed: childEvents })

    const view = loopOf(second.ctx, second.session)!.view
    await second.ctx.loops.resume(second.agent, { id: view.loop.id, revision: view.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('complete')
    })
    const attempts = attemptsOf(loopOf(second.ctx, second.session)!.ledger)
    expect(attempts[0]).toMatchObject({ failure: { code: 'invalid-recovered-report' } })
    await second.retire()
  })

  it('records an invalid-recovered-report attempt when the recovered report violates the schema', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const first = await boot({ script: [{ gate: parked, reportText: JSON.stringify({ status: 'ok' }) }] })
    await first.ctx.loops.start(first.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(first.spawns.length).toBe(1)
    })
    const parentEvents = first.session.ownEvents()
    const childEvents = (first.ctx.sessions.get(first.spawns[0]!.sessionId))!.ownEvents()
    await first.retireAgent()
    await first.ctx.fiber.dispose()

    const second = await reboot(parentEvents, [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ])
    second.ctx.sessions.create(first.spawns[0]!.sessionId, { seed: childEvents })

    const view = loopOf(second.ctx, second.session)!.view
    await second.ctx.loops.resume(second.agent, { id: view.loop.id, revision: view.loop.revision })

    await waitUntil(() => {
      expect(loopOf(second.ctx, second.session)?.view.loop.phase).toBe('complete')
    })
    const attempts = attemptsOf(loopOf(second.ctx, second.session)!.ledger)
    expect(attempts[0]).toMatchObject({ failure: { code: 'invalid-recovered-report' } })
    expect(attempts[0]!.kind === 'attempt' && attempts[0]!.failure.message).toContain('summary')
    await second.retire()
  })
})

describe('lifecycle fences and containment', () => {
  it('aborts the in-flight child, records nothing, and disarms at driver teardown', async () => {
    const alpha = await workspace()
    const parked = new Promise<void>(() => {})
    const booted = await boot({ withDriver: false, script: [{ gate: parked }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(booted.spawns.length).toBe(1)
    })

    await booted.driver!.dispose()

    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.phase).toBe('active')
    expect(booted.ctx.loops.activation(booted.agent)).toBe('disarmed')
    expect(state.ledger.filter(entry => entry.kind !== 'node-started')).toHaveLength(0)
    expect(booted.spawns[0]!.signal?.aborted).toBe(true)
  })

  it('stops quietly and records nothing when the controlling agent is disposed mid-run', async () => {
    const alpha = await workspace()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const booted = await boot({ script: [{ gate, structured: WORKER_REPORT }] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(booted.spawns.length).toBe(1)
    })

    await booted.retireAgent()
    release()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.phase).toBe('active')
    expect(state.ledger.filter(entry => entry.kind !== 'node-started')).toHaveLength(0)
    // A later notification for the retired agent recreates no driving state.
    booted.ctx.emit('loop/changed', { agent: booted.agent, change: { operation: 'advance', ref: { id: state.view.loop.id, revision: state.view.loop.revision } } } as never)
    await new Promise(resolve => setImmediate(resolve))
    expect(booted.spawns).toHaveLength(1)
  })

  it('retries the aborted child when a plugin reports an agent error', async () => {
    const alpha = await workspace()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const booted = await boot({ script: [
      { gate, structured: WORKER_REPORT },
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ] })
    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(booted.spawns.length).toBe(1)
    })

    booted.spawns[0]!.signal!.addEventListener('abort', () => { release() }, { once: true })
    agentEvents(booted.ctx, booted.agent).emit('agent/error', { turn: 1, step: 1, error: new Error('post-turn flush failed') })

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    const attempts = attemptsOf(loopOf(booted.ctx, booted.session)!.ledger)
    expect(attempts[0]).toMatchObject({ failure: { code: 'aborted' } })
    expect(booted.spawns).toHaveLength(4)
  })

  it('blocks durability-failed when the pre-round flush fails', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    // The start's own mutation flush resolves; the driver's pre-round flush is the next call.
    vi.spyOn(booted.ctx.sessions, 'flush').mockImplementationOnce(() => Promise.resolve(true)).mockRejectedValueOnce(new Error('disk unavailable'))

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('durability-failed')
    expect(view.loop.blockedReason?.message).toContain('session flush before driving round 1 failed')
    expect(booted.spawns).toHaveLength(0)
  })

  it('stops without spawning when the loop pauses during the pre-round flush', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    let releaseFlush: () => void = () => {}
    const flushDone = new Promise<void>((resolve) => { releaseFlush = resolve })
    // The start's own mutation flush resolves; the driver's pre-round flush parks on the gate.
    vi.spyOn(booted.ctx.sessions, 'flush').mockImplementationOnce(() => Promise.resolve(true)).mockImplementationOnce(() => flushDone.then(() => true))

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('active')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    await booted.ctx.loops.pause(booted.agent, { id: view.loop.id, revision: view.loop.revision })
    releaseFlush()

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('paused')
    })
    expect(booted.spawns).toHaveLength(0)
    await booted.retireAgent()
  })

  it('quits the spawned child and warns when the node-started ledger append fails', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    vi.spyOn(booted.ctx.loops, 'appendNodeStarted').mockRejectedValueOnce(new LoopError('crash window', 'LOOP_STALE_REVISION'))

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(booted.readDisposals()).toBe(1)
    })
    // The spawn was disposed quietly and nothing was recorded for the round.
    expect(booted.spawns).toHaveLength(1)
    expect(loopOf(booted.ctx, booted.session)!.ledger).toHaveLength(0)
    await booted.retireAgent()
  })

  it('refuses to load with a blank configured provider name', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LoopService)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(LoopDriver, { provider: ' ' })).rejects.toThrow(
      'loop-chain-driver: config provider must be a non-blank subagent provider name',
    )
    await ctx.fiber.dispose()
  })

  it('contains a block failure as a warning and leaves the loop unblocked', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { stopReason: 'error' },
      { stopReason: 'error' },
    ] })
    const warn = vi.spyOn(booted.ctx.logger, 'warn')
    vi.spyOn(booted.ctx.loops, 'block').mockRejectedValue(new Error('lock contention'))

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(booted.spawns.length).toBe(2)
    })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.phase).toBe('active')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('loop-chain-driver'))
  })

  it('stops the pass quietly when a concurrent pause races the settlement', async () => {
    const alpha = await workspace()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const booted = await boot({ script: [{ gate, structured: WORKER_REPORT }] })
    const view = await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))
    await waitUntil(() => {
      expect(booted.spawns.length).toBe(1)
    })

    await booted.ctx.loops.pause(booted.agent, { id: view.loop.id, revision: view.loop.revision })
    release()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.phase).toBe('paused')
    expect(state.ledger.filter(entry => entry.kind === 'settlement')).toHaveLength(0)
    expect(booted.spawns).toHaveLength(1)
  })

  it('blocks node-failed when the invariant companion rejects a driver append', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_CONTINUE },
    ] })
    vi.spyOn(booted.ctx.loops, 'appendSettlement').mockRejectedValueOnce(new InvariantError('@deepseek-ai/dsh-loop-chain-driver', 'rejected settlement'))

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('blocked')
    })
    const view = loopOf(booted.ctx, booted.session)!.view
    expect(view.loop.blockedReason?.code).toBe('node-failed')
    expect(view.loop.blockedReason?.message).toContain('the invariant companion rejected a driver append')
    expect(booted.readDisposals()).toBe(1)
  })

  it('warns and keeps settling when run disposal fails', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: WORKER_REPORT, disposeError: new Error('dispose failed') },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ] })
    const warn = vi.spyOn(booted.ctx.logger, 'warn')

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    expect(booted.readDisposals()).toBe(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subagent run disposal failed'))
  })

  it('contains a synchronous scheduler startup failure', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    vi.spyOn(booted.ctx.agents, 'withoutInitiator').mockImplementationOnce(() => {
      throw 'scheduler closed'
    })

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(booted.ctx.loops.activation(booted.agent)).toBe('disarmed')
    })
    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.phase).toBe('active')
    expect(booted.spawns).toHaveLength(0)
  })

  it('contains an asynchronously rejected scheduler task', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [{ structured: WORKER_REPORT }] })
    vi.spyOn(booted.ctx.agents, 'withoutInitiator').mockImplementationOnce(
      () => Promise.reject(new Error('scheduler task rejected')),
    )

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(booted.ctx.loops.activation(booted.agent)).toBe('disarmed')
    })
    const state = loopOf(booted.ctx, booted.session)!
    expect(state.view.loop.phase).toBe('active')
    expect(booted.spawns).toHaveLength(0)
  })

  it('keeps driving the round when unledgered-child enumeration fails', async () => {
    const alpha = await workspace()
    const booted = await boot({ script: [
      { structured: WORKER_REPORT },
      { structured: { ...WORKER_REPORT, summary: 'reviewed' } },
      { structured: VERDICT_COMPLETE },
    ] })
    vi.spyOn(booted.ctx.subagents, 'listChildren').mockRejectedValueOnce(new Error('catalog unavailable'))

    await booted.ctx.loops.start(booted.agent, startRequest(chain('none', alpha), [alpha]))

    await waitUntil(() => {
      expect(loopOf(booted.ctx, booted.session)?.view.loop.phase).toBe('complete')
    })
    expect(booted.spawns).toHaveLength(3)
  })
})
