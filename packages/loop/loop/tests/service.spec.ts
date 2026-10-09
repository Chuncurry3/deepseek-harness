/** Loader-booted and unit behavior of the ctx.loops relay-loop service. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LoopService, {
  LOOP_CHANGE_VERSION,
  LoopId,
  applyLoopProjection,
  decodeLoopChange,
  foldLoop,
  loopProjectionDefinition,
} from '@deepseek-ai/dsh-loop'
import type {
  LoopProjectionState,
  LoopRef,
  LoopSnapshotChangeMeta,
  LoopView,
  StartLoopRequest,
} from '@deepseek-ai/dsh-loop'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

interface StubAgent {
  agent: Agent
  session: Session
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

/** Build a registry-compatible agent around one session-store session. */
function stubAgent(rawId: string, ctx: Context, seed?: readonly SessionEvent[]): StubAgent {
  const session = ctx.sessions.create(SessionId(rawId), { ...(seed === undefined ? {} : { seed }) })
  return stubAgentForSession(session, ctx)
}

async function harness(config: { defaultMaxRounds?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LoopService, config)
  const stub = stubAgent(`loop-test-${randomUUID()}`, ctx)
  await ctx.agents.register(stub.agent)
  return { ctx, ...stub }
}

const CHAIN = {
  objective: 'relay the monthly report',
  checkpoint: 'none',
  nodes: [
    { role: 'writer', prompt: 'Draft the report.', cwd: 'E:/work/alpha', inputs: [{ session: SessionId('sess-writer-1') }] },
    { role: 'reviewer', prompt: 'Review the draft.', carryOver: ['writer'], cwd: 'E:/work/alpha' },
  ],
} as const

/** Build one valid start request with optional overrides. */
function startRequest(overrides: Partial<StartLoopRequest> = {}): StartLoopRequest {
  return {
    objective: 'relay the monthly report',
    chain: CHAIN,
    readScopes: ['E:/work/alpha'],
    writeScopes: ['E:/work/alpha'],
    ...overrides,
  }
}

/** Extract the compare-and-set ref of one live view. */
function refOf(view: LoopView): LoopRef {
  return { id: view.loop.id, revision: view.loop.revision }
}

/** Structurally clone one projection state the way a cache row would. */
function cloneState(state: LoopProjectionState): LoopProjectionState {
  return JSON.parse(JSON.stringify(state)) as LoopProjectionState
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one real Loader composition from in-memory module records. */
async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-loop-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-loop', LoopService],
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

const COMPOSITION_YAML: readonly string[] = [
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-agent'",
  "- name: '@deepseek-ai/dsh-loop'",
  '  config:',
  '    defaultMaxRounds: 7',
]

/** Register one stub agent on one loaded composition. */
async function compositionStub(loaded: Context): Promise<StubAgent> {
  const stub = stubAgentForSession(loaded.sessions.create(SessionId(`loop-loader-${randomUUID()}`)), loaded)
  await loaded.agents.register(stub.agent)
  return stub
}

describe('real Loader composition', () => {
  it('boots the loop service with validated config and serves ctx.loops', async () => {
    const loaded = await loadYaml(COMPOSITION_YAML)
    const stub = await compositionStub(loaded)

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('loops')).toBeInstanceOf(LoopService)
    expect(loaded.loops.resolved).toMatchObject({
      defaultMaxRounds: 7,
      maxNodeRetries: 2,
      maxHandoffChars: 16384,
      maxEvaluatorInputChars: 65536,
    })

    const view = await loaded.loops.start(stub.agent, startRequest())
    expect(view).toMatchObject({
      loop: { revision: 1, phase: 'active', maxRounds: 7, roundsStarted: 0 },
      activation: 'armed',
    })
    expect(view.loop.id).toMatch(/^loop-/)
    const events = stub.session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['loop/change'])
    const change = decodeLoopChange(events[0]?.data)
    expect(change).toMatchObject({ operation: 'create', loop: { id: view.loop.id, revision: 1 } })
    expect(foldLoop(events)).toMatchObject({ loop: { id: view.loop.id, revision: 1 } })
  })

  it('enforces the CAS contract through the composition', async () => {
    const loaded = await loadYaml(COMPOSITION_YAML)
    const stub = await compositionStub(loaded)

    const view = await loaded.loops.start(stub.agent, startRequest())
    const ref = refOf(view)
    await expect(loaded.loops.start(stub.agent, startRequest())).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_ALREADY_EXISTS' }),
    )

    const paused = await loaded.loops.pause(stub.agent, ref)
    expect(paused).toMatchObject({ loop: { revision: 2, phase: 'paused' }, activation: 'disarmed' })
    const resumed = await loaded.loops.resume(stub.agent, refOf(paused))
    expect(resumed).toMatchObject({ loop: { revision: 3, phase: 'active' }, activation: 'armed' })

    await expect(loaded.loops.pause(stub.agent, refOf(paused))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_STALE_REVISION' }),
    )

    await loaded.loops.clear(stub.agent, refOf(resumed))
    const events = stub.session.snapshotEvents()
    const last = events.at(-1)
    expect(last?.type).toBe('loop/change')
    if (last?.type === 'loop/change') {
      expect(decodeLoopChange(last.data)).toMatchObject({
        operation: 'clear',
        cleared: { id: view.loop.id, revision: 4 },
      })
    }
    expect(loaded.sessionProjections.stateOf(stub.session, 'loop')?.current).toBeNull()
  })

  it('never serializes process-local activation into the durable events', async () => {
    const loaded = await loadYaml(COMPOSITION_YAML)
    const stub = await compositionStub(loaded)

    const view = await loaded.loops.start(stub.agent, startRequest())
    await loaded.loops.pause(stub.agent, refOf(view))
    await loaded.loops.resume(stub.agent, { id: view.loop.id, revision: 2 })
    await loaded.loops.appendNodeStarted(stub.agent, {
      kind: 'node-started',
      loopId: view.loop.id,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 3)

    const serialized = JSON.stringify(stub.session.snapshotEvents())
    expect(serialized).not.toContain('activation')
    expect(loaded.loops.activation(stub.agent)).toBe('armed')
  })
})
describe('LoopService mutations', () => {
  it('does not activate without the required projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LoopService)
    expect(ctx.get('loops')).toBeUndefined()
  })

  it('applies the configured default and writes one durable loop change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const { ctx, agent, session } = await harness({ defaultMaxRounds: 17 })
    const seen: string[] = []
    ctx.on('loop/changed', ({ change }) => { seen.push(change.operation) })

    const view = await ctx.loops.start(agent, startRequest({ objective: '  finish the feature  ' }))

    expect(view).toMatchObject({
      loop: {
        revision: 1,
        phase: 'active',
        objective: 'finish the feature',
        maxRounds: 17,
        roundsStarted: 0,
        checkpoint: 'none',
      },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      activation: 'armed',
    })
    expect(view.loop.id).toMatch(/^loop-/)
    expect(seen).toEqual(['create'])
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['loop/change'])
    const event = session.snapshotEvents()[0]
    expect(event?.type).toBe('loop/change')
    if (event?.type !== 'loop/change') throw new Error('expected durable loop change')
    const change = decodeLoopChange(event.data)
    if (change === undefined) throw new Error('expected decoded loop change')
    expect(change).toMatchObject({ operation: 'create', loop: { id: view.loop.id, revision: 1 } })
    expect(foldLoop(session.snapshotEvents())).toMatchObject({ loop: { id: view.loop.id, revision: 1 }, ledger: [] })

    const state = ctx.sessionProjections.stateOf(session, 'loop')
    expect(state).toMatchObject({
      current: {
        loop: { id: view.loop.id, revision: 1 },
        ledger: [],
        lastRef: { id: view.loop.id, revision: 1 },
      },
      seenLoopIds: [view.loop.id],
      failure: null,
    })
  })

  it('uses 20 rounds by default and validates start input inside start', async () => {
    const { ctx, agent } = await harness()
    expect(ctx.loops.resolved).toMatchObject({
      defaultMaxRounds: 20,
      maxNodeRetries: 2,
      maxHandoffChars: 16384,
      maxEvaluatorInputChars: 65536,
    })
    await expect(ctx.loops.start(agent, startRequest({ objective: '   ' }))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_INVALID_CHAIN' }),
    )
    await expect(ctx.loops.start(agent, startRequest({ maxRounds: 0 }))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_INVALID_CHAIN' }),
    )
    await expect(ctx.loops.start(agent, startRequest({ maxRounds: 1.5 }))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_INVALID_CHAIN' }),
    )
    await expect(ctx.loops.start(agent, startRequest({
      maxRounds: Number.MAX_SAFE_INTEGER + 1,
    }))).rejects.toThrow(expect.objectContaining({ code: 'LOOP_INVALID_CHAIN' }))
    const view = await ctx.loops.start(agent, startRequest())
    expect(view.loop.maxRounds).toBe(20)
  })

  it('also resolves the defaults when constructed directly without Cordis config normalization', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const stub = stubAgent(`loop-direct-${randomUUID()}`, ctx)
    await ctx.agents.register(stub.agent)
    const loops = new LoopService(ctx)
    const view = await loops.start(stub.agent, startRequest({ objective: 'direct' }))
    expect(view).toMatchObject({ loop: { objective: 'direct', maxRounds: 20 }, activation: 'armed' })
  })

  it('rejects invalid direct configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await expect(ctx.plugin(LoopService, { defaultMaxRounds: -1 })).rejects.toThrow(
      /loop config defaultMaxRounds must be a positive safe integer/,
    )
  })

  it('restores a seeded loop with activation disarmed and arms on request', async () => {
    const first = await harness()
    const created = await first.ctx.loops.start(first.agent, startRequest())

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LoopService)
    const stub = stubAgent(`loop-seeded-${randomUUID()}`, ctx, first.session.snapshotEvents())
    await ctx.agents.register(stub.agent)

    expect(ctx.loops.activation(stub.agent)).toBe('disarmed')
    const state = ctx.sessionProjections.stateOf(stub.session, 'loop')
    expect(state?.current).toMatchObject({ loop: { id: created.loop.id, revision: 1 } })
    ctx.loops.arm(stub.agent, { id: created.loop.id, revision: 1 })
    expect(ctx.loops.activation(stub.agent)).toBe('armed')
    ctx.loops.disarm(stub.agent)
    expect(ctx.loops.activation(stub.agent)).toBe('disarmed')
  })

  it('rejects start when a chain node works outside the write scopes', async () => {
    const { ctx, agent, session } = await harness()
    const chain = {
      ...CHAIN,
      nodes: [
        { role: 'writer', prompt: 'Draft the report.', cwd: 'E:/work/beta' },
        { role: 'reviewer', prompt: 'Review the draft.', carryOver: ['writer'], cwd: 'E:/work/alpha' },
      ],
    }
    await expect(ctx.loops.start(agent, startRequest({ chain }))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_SCOPE_VIOLATION' }),
    )
    await expect(ctx.loops.start(agent, startRequest({ writeScopes: [] }))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_SCOPE_VIOLATION' }),
    )
    expect(session.snapshotEvents()).toEqual([])
    const view = await ctx.loops.start(agent, startRequest({
      chain: { ...CHAIN, nodes: [{ role: 'writer', prompt: 'Draft the report.' }] },
    }))
    expect(view.loop.phase).toBe('active')
  })

  it('rejects start when the chain fails fold validation', async () => {
    const { ctx, agent, session } = await harness()
    await expect(ctx.loops.start(agent, startRequest({
      chain: { ...CHAIN, nodes: [] },
    }))).rejects.toThrow(/non-empty array/)
    await expect(ctx.loops.start(agent, startRequest({
      chain: { ...CHAIN, nodes: [
        { role: 'writer', prompt: 'Draft.' },
        { role: 'writer', prompt: 'Again.' },
      ] },
    }))).rejects.toThrow(/role must be unique/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('rejects the second start and replaces a completed loop', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    await expect(ctx.loops.start(agent, startRequest())).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_ALREADY_EXISTS' }),
    )

    const completed = await ctx.loops.complete(agent, refOf(view))
    expect(completed.loop.phase).toBe('complete')

    const fresh = await ctx.loops.start(agent, startRequest({ objective: 'a fresh run' }))
    expect(fresh.loop.id).not.toBe(view.loop.id)
    expect(fresh.loop).toMatchObject({ revision: 1, phase: 'active' })
    const state = ctx.sessionProjections.stateOf(session, 'loop')
    expect(state?.seenLoopIds).toEqual([view.loop.id, fresh.loop.id])
    expect(foldLoop(session.snapshotEvents()).loop?.id).toBe(fresh.loop.id)
  })

  it('requires a current loop and an exact ref for every mutation', async () => {
    const { ctx, agent } = await harness()
    await expect(ctx.loops.pause(agent, { id: LoopId('loop-none'), revision: 1 })).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_NOT_FOUND' }),
    )
    const view = await ctx.loops.start(agent, startRequest())
    await expect(ctx.loops.pause(agent, { id: LoopId('loop-other'), revision: 1 })).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_STALE_REVISION' }),
    )
    await expect(ctx.loops.pause(agent, { id: view.loop.id, revision: 5 })).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_STALE_REVISION' }),
    )
    expect(() => { ctx.loops.arm(agent, { id: view.loop.id, revision: 2 }) }).toThrow(
      expect.objectContaining({ code: 'LOOP_STALE_REVISION' }),
    )
  })

  it('pause and resume write revisions 2 and 3 with activation edges', async () => {
    const { ctx, agent, session } = await harness()
    const seen: string[] = []
    ctx.on('loop/changed', ({ change }) => { seen.push(change.operation) })
    const view = await ctx.loops.start(agent, startRequest())

    const paused = await ctx.loops.pause(agent, refOf(view))
    expect(paused).toMatchObject({ loop: { revision: 2, phase: 'paused' }, activation: 'disarmed' })
    expect(ctx.loops.activation(agent)).toBe('disarmed')

    const resumed = await ctx.loops.resume(agent, refOf(paused))
    expect(resumed).toMatchObject({ loop: { revision: 3, phase: 'active' }, activation: 'armed' })
    expect(ctx.loops.activation(agent)).toBe('armed')

    expect(seen).toEqual(['create', 'pause', 'resume'])
    const events = session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['loop/change', 'loop/change', 'loop/change'])
    expect(events.map(event => event.type === 'loop/change' ? decodeLoopChange(event.data)?.operation : undefined))
      .toEqual(['create', 'pause', 'resume'])
    expect(paused.createdAt).toBe(view.createdAt)
    expect(resumed.createdAt).toBe(view.createdAt)
  })
  it('resume rejects redundant and off-table phases', async () => {
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    await expect(ctx.loops.resume(agent, refOf(view))).rejects.toThrow(/already active and armed/)

    const completed = await ctx.loops.complete(agent, refOf(view))
    await expect(ctx.loops.resume(agent, refOf(completed))).rejects.toThrow(/cannot resume from phase "complete"/)
  })

  it('resume rejects an exhausted round budget', async () => {
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest({ maxRounds: 1 }))
    const advanced = await ctx.loops.advance(agent, refOf(view))
    expect(advanced.loop.roundsStarted).toBe(1)
    const paused = await ctx.loops.pause(agent, refOf(advanced))
    await expect(ctx.loops.resume(agent, refOf(paused))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_INVALID_TRANSITION' }),
    )
  })

  it('awaitHuman and continueFromHuman move the human checkpoint phases', async () => {
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest())

    const awaiting = await ctx.loops.awaitHuman(agent, refOf(view))
    expect(awaiting).toMatchObject({ loop: { revision: 2, phase: 'awaiting-human' }, activation: 'armed' })
    await expect(ctx.loops.continueFromHuman(agent, refOf(view))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_STALE_REVISION' }),
    )

    const continued = await ctx.loops.continueFromHuman(agent, refOf(awaiting))
    expect(continued).toMatchObject({ loop: { revision: 3, phase: 'active' }, activation: 'armed' })

    const paused = await ctx.loops.pause(agent, refOf(continued))
    await expect(ctx.loops.awaitHuman(agent, refOf(paused))).rejects.toThrow(/cannot await-human from phase/)
  })

  it('resume from awaiting-human keeps the ask open', async () => {
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    const awaiting = await ctx.loops.awaitHuman(agent, refOf(view))
    const resumed = await ctx.loops.resume(agent, refOf(awaiting))
    expect(resumed).toMatchObject({ loop: { revision: 3, phase: 'awaiting-human' }, activation: 'armed' })
  })

  it('advance consumes the round budget of the active loop', async () => {
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest({ maxRounds: 2 }))

    const first = await ctx.loops.advance(agent, refOf(view))
    expect(first.loop).toMatchObject({ revision: 2, phase: 'active', roundsStarted: 1 })
    expect(first.activation).toBe('armed')

    const second = await ctx.loops.advance(agent, refOf(first))
    expect(second.loop.roundsStarted).toBe(2)
    await expect(ctx.loops.advance(agent, refOf(second))).rejects.toThrow(/exhausted 2 rounds/)

    const paused = await ctx.loops.pause(agent, refOf(second))
    await expect(ctx.loops.advance(agent, refOf(paused))).rejects.toThrow(/cannot advance from phase/)
  })

  it('complete closes the active loop and disarms it', async () => {
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    const completed = await ctx.loops.complete(agent, refOf(view))
    expect(completed).toMatchObject({ loop: { revision: 2, phase: 'complete' }, activation: 'disarmed' })
    await expect(ctx.loops.complete(agent, refOf(completed))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_INVALID_TRANSITION' }),
    )

    const second = await ctx.loops.start(agent, startRequest({ objective: 'complete from paused' }))
    const paused = await ctx.loops.pause(agent, refOf(second))
    await expect(ctx.loops.complete(agent, refOf(paused))).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_INVALID_TRANSITION' }),
    )
  })

  it('block records the durable reason and disarms, and a resumed loop drops it', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    const reason = { code: 'node-failed', message: 'writer failed after three attempts' } as const

    const blocked = await ctx.loops.block(agent, refOf(view), reason)
    expect(blocked).toMatchObject({
      loop: { revision: 2, phase: 'blocked', blockedReason: reason },
      activation: 'disarmed',
    })
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('loop/change')
    if (event?.type === 'loop/change') {
      expect(decodeLoopChange(event.data)).toMatchObject({ operation: 'block', loop: { blockedReason: reason } })
    }

    const resumed = await ctx.loops.resume(agent, refOf(blocked))
    expect(resumed.loop).toMatchObject({ revision: 3, phase: 'active' })
    expect(resumed.loop.blockedReason).toBeUndefined()
    expect(foldLoop(session.snapshotEvents()).loop?.blockedReason).toBeUndefined()

    await expect(ctx.loops.block(agent, refOf(resumed), { code: 'bogus', message: 'nope' } as never)).rejects.toThrow(
      /known loop block code/,
    )

    const paused = await ctx.loops.pause(agent, refOf(resumed))
    const blockedAgain = await ctx.loops.block(agent, refOf(paused), { code: 'round-limit', message: 'budget spent' })
    expect(blockedAgain.loop.phase).toBe('blocked')
    await expect(ctx.loops.block(agent, refOf(blockedAgain), { code: 'node-failed', message: 'again' })).rejects.toThrow(
      /cannot block from phase "blocked"/,
    )
  })

  it('clear writes the tombstone and allows a fresh loop', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())

    await ctx.loops.clear(agent, refOf(view))
    const events = session.snapshotEvents()
    const last = events.at(-1)
    expect(last?.type).toBe('loop/change')
    if (last?.type === 'loop/change') {
      expect(decodeLoopChange(last.data)).toMatchObject({
        operation: 'clear',
        cleared: { id: view.loop.id, revision: 2 },
      })
    }
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.current).toBeNull()
    await expect(ctx.loops.pause(agent, { id: view.loop.id, revision: 2 })).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_NOT_FOUND' }),
    )

    session.append('loop/node-started', {
      kind: 'node-started',
      version: 1,
      loopId: view.loop.id,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
      atRevision: 1,
    })
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.current).toBeNull()

    const fresh = await ctx.loops.start(agent, startRequest({ objective: 'after clear' }))
    expect(fresh.loop).toMatchObject({ revision: 1, phase: 'active' })

    const paused = await ctx.loops.pause(agent, refOf(fresh))
    await ctx.loops.clear(agent, refOf(paused))
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.current).toBeNull()
  })

  it('clamps mutation timestamps across backward wall-clock movement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
    const { ctx, agent } = await harness()
    const view = await ctx.loops.start(agent, startRequest())

    vi.setSystemTime(1_700_000_000_000)
    const paused = await ctx.loops.pause(agent, refOf(view))
    expect(paused.updatedAt).toBe(view.updatedAt)
    expect(paused.createdAt).toBe(view.createdAt)

    vi.setSystemTime(1_700_000_200_000)
    const resumed = await ctx.loops.resume(agent, refOf(paused))
    expect(resumed.updatedAt).toBe(1_700_000_200_000)
    expect(resumed.createdAt).toBe(view.createdAt)
  })

  it('contains loop/changed listener failures without failing the commit', async () => {
    const { ctx, agent } = await harness()
    const seen: string[] = []
    ctx.on('loop/changed', () => { throw new Error('broken observer') })
    ctx.on('loop/changed', ({ change }) => { seen.push(change.operation) })

    const view = await ctx.loops.start(agent, startRequest())
    await ctx.loops.pause(agent, refOf(view))
    expect(seen).toEqual(['create', 'pause'])
  })

  it('flush failure disarms, keeps the committed event, and rethrows', async () => {
    const { ctx, agent, session } = await harness()
    const stopFlushFailure = ctx.on('session/flush', () => Promise.reject(new Error('disk unavailable')))

    await expect(ctx.loops.start(agent, startRequest())).rejects.toThrow(/disk unavailable/)
    expect(ctx.loops.activation(agent)).toBe('disarmed')
    const events = session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['loop/change'])
    const current = ctx.sessionProjections.stateOf(session, 'loop')?.current
    expect(current?.loop).toMatchObject({ revision: 1 })

    stopFlushFailure()
    if (current === undefined || current === null || current.loop === undefined) {
      throw new Error('expected current loop')
    }
    ctx.loops.arm(agent, { id: current.loop.id, revision: current.loop.revision })
    expect(ctx.loops.activation(agent)).toBe('armed')
    const paused = await ctx.loops.pause(agent, { id: current.loop.id, revision: current.loop.revision })
    expect(paused.loop).toMatchObject({ revision: 2, phase: 'paused' })
  })

  it('recheck rejects when an external change supersedes the commit', async () => {
    const { ctx, agent, session } = await harness()
    ctx.on('session/flush', (flushed) => {
      if (flushed !== session) return
      const current = ctx.sessionProjections.stateOf(session, 'loop')?.current
      if (current?.loop === undefined || current.createdAt === undefined || current.updatedAt === undefined) return
      const superseding: LoopSnapshotChangeMeta = {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'pause',
        loop: { ...current.loop, revision: 2, phase: 'paused' },
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      }
      session.append('loop/change', superseding)
    })

    await expect(ctx.loops.start(agent, startRequest())).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_STALE_REVISION' }),
    )
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.current?.loop).toMatchObject({
      revision: 2,
      phase: 'paused',
    })
  })
  it('appends node ledger records with fold-grade validation', async () => {
    const { ctx, agent, session } = await harness()
    const seen: string[] = []
    ctx.on('loop/changed', ({ change }) => { seen.push(change.operation) })
    const view = await ctx.loops.start(agent, startRequest())
    const loopId = view.loop.id

    await ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)
    let state = ctx.sessionProjections.stateOf(session, 'loop')
    expect(state?.current?.ledger).toEqual([{
      kind: 'node-started',
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: 'sess-writer-1',
      cwd: 'E:/work/alpha',
      atRevision: 1,
    }])

    await ctx.loops.appendAttempt(agent, {
      kind: 'attempt',
      loopId,
      round: 1,
      nodeIndex: 0,
      attempt: 1,
      failure: { code: 'child-failed', message: 'writer crashed' },
    }, 1)
    state = ctx.sessionProjections.stateOf(session, 'loop')
    expect(state?.current?.ledger).toHaveLength(1)
    expect(state?.current?.ledger[0]).toMatchObject({ kind: 'attempt', failure: { code: 'child-failed' } })

    await expect(ctx.loops.appendSettlement(agent, {
      kind: 'settlement',
      loopId,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
      report: { summary: 'drafted' },
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_INVALID_TRANSITION' }))

    await ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 1,
      role: 'reviewer',
      attempt: 1,
      childSessionId: SessionId('sess-reviewer-1'),
      cwd: 'E:/work/alpha',
    }, 1)
    await ctx.loops.appendSettlement(agent, {
      kind: 'settlement',
      loopId,
      round: 1,
      nodeIndex: 1,
      role: 'reviewer',
      attempt: 1,
      childSessionId: SessionId('sess-reviewer-1'),
      cwd: 'E:/work/alpha',
      report: 'reviewed',
    }, 1)
    state = ctx.sessionProjections.stateOf(session, 'loop')
    expect(state?.current?.ledger).toHaveLength(2)

    expect(seen).toEqual(['create'])
    expect(foldLoop(session.snapshotEvents()).ledger).toHaveLength(2)
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'loop/change',
      'loop/node-started',
      'loop/attempt',
      'loop/node-started',
      'loop/node',
    ])
  })

  it('rejects ledger records that break the fold rules', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    const loopId = view.loop.id

    await ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)

    await expect(ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_ALREADY_EXISTS' }))

    await expect(ctx.loops.appendAttempt(agent, {
      kind: 'attempt',
      loopId,
      round: 1,
      nodeIndex: 1,
      attempt: 1,
      failure: { code: 'child-failed', message: 'no node started' },
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_INVALID_TRANSITION' }))

    await expect(ctx.loops.appendSettlement(agent, {
      kind: 'settlement',
      loopId,
      round: 2,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
      report: 'reviewed',
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_INVALID_TRANSITION' }))

    await expect(ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId: 'loop-other' as typeof loopId,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_NOT_FOUND' }))

    await expect(ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 2,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 2)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_STALE_REVISION' }))

    await expect(ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 3,
      role: '',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)).rejects.toThrow(/must be a non-empty string/)

    await expect(ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 4,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 0)).rejects.toThrow(/atRevision must be a positive/)

    await ctx.loops.clear(agent, refOf(view))
    await expect(ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId,
      round: 1,
      nodeIndex: 5,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_NOT_FOUND' }))
    expect(session.snapshotEvents()).toHaveLength(3)
  })

  it('accepts ledger records stamped at an older loop revision', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    const paused = await ctx.loops.pause(agent, refOf(view))

    await ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId: view.loop.id,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)
    expect(paused.loop.revision).toBe(2)
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.current?.ledger).toHaveLength(1)
  })

  it('requires the exact live registry instance for reads and mutations', async () => {
    const { ctx, agent } = await harness()
    const impostor = { ...agent, session: Session.create(agent.id) } as Agent
    await expect(ctx.loops.start(impostor, startRequest())).rejects.toThrow(
      expect.objectContaining({ code: 'LOOP_AGENT_NOT_LIVE' }),
    )
    expect(() => ctx.loops.activation(impostor)).toThrow(
      expect.objectContaining({ code: 'LOOP_AGENT_NOT_LIVE' }),
    )
    expect(() => { ctx.loops.arm(impostor, { id: LoopId('loop-none'), revision: 1 }) }).toThrow(
      expect.objectContaining({ code: 'LOOP_AGENT_NOT_LIVE' }),
    )
    expect(() => { ctx.loops.disarm(impostor) }).toThrow(
      expect.objectContaining({ code: 'LOOP_AGENT_NOT_LIVE' }),
    )
    await expect(ctx.loops.appendNodeStarted(impostor, {
      kind: 'node-started',
      loopId: 'loop-none' as never,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)).rejects.toThrow(expect.objectContaining({ code: 'LOOP_AGENT_NOT_LIVE' }))
  })

  it('removes the service and projection with the providing fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LoopService)
    const first = ctx.loops
    const stub = stubAgent(`loop-hmr-${randomUUID()}`, ctx)
    await ctx.agents.register(stub.agent)
    const view = await ctx.loops.start(stub.agent, startRequest())

    await fiber.dispose()
    expect(ctx.get('loops')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(stub.session, 'loop')).toBeUndefined()
    await expect(first.start(stub.agent, startRequest())).rejects.toThrow(/loop projection is not registered/)

    await ctx.plugin(LoopService)
    expect(ctx.loops).not.toBe(first)
    expect(ctx.loops.activation(stub.agent)).toBe('disarmed')
    const resumed = await ctx.loops.resume(stub.agent, refOf(view))
    expect(resumed.loop).toMatchObject({ id: view.loop.id, revision: 2, phase: 'active' })
    expect(ctx.loops.activation(stub.agent)).toBe('armed')
  })
  it('disarms on external loop changes while the commit keeps its seq guard', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    expect(ctx.loops.activation(agent)).toBe('armed')

    session.append('loop/change', {
      kind: 'loop/change',
      version: LOOP_CHANGE_VERSION,
      operation: 'pause',
      loop: { ...view.loop, revision: 2, phase: 'paused' },
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    })
    expect(ctx.loops.activation(agent)).toBe('disarmed')
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.current?.loop).toMatchObject({ revision: 2 })

    const resumed = await ctx.loops.resume(agent, { id: view.loop.id, revision: 2 })
    expect(resumed.loop).toMatchObject({ id: view.loop.id, revision: 3, phase: 'active' })
    expect(ctx.loops.activation(agent)).toBe('armed')
  })

  it('isolates corrupt external loop events in the projection failure', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())

    // external corruption entered the log outside this process's append
    // path; the retained failure is reproduced by injecting it into the
    // live cell the way a replayed corrupt stream would have left it
    const state = ctx.sessionProjections.stateOf(session, 'loop')
    if (state === undefined) throw new Error('expected loop projection state')
    Object.assign(state, { failure: 'loop replay failed at session event 1: unsupported loop change version 99' })
    expect(state.current?.loop).toMatchObject({ id: view.loop.id })

    await expect(ctx.loops.start(agent, startRequest())).rejects.toThrow(/loop replay failed at session event 1/)
    // deliberately malformed: an externally corrupted record can never satisfy
    // the typed payload, so the double cast keeps it on the SessionEvent side
    const later = { type: 'loop/change', seq: 1, time: 2, data: { kind: 'loop/change', version: 98 } } as unknown as SessionEvent
    expect(applyLoopProjection(state, later)).toBe(state)
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('a fork folds loop events only from the seed boundary and starts a fresh run', async () => {
    const parent = await harness()
    const view = await parent.ctx.loops.start(parent.agent, startRequest())
    const inherited = parent.session.snapshotEvents()

    const child = parent.ctx.sessions.create(SessionId(`loop-fork-${randomUUID()}`), {
      seed: inherited,
      inheritedEventCount: SessionLogOffset(inherited.length),
      meta: { parentSession: parent.session.id, isSeeded: true },
    })
    const stub = stubAgentForSession(child, parent.ctx)
    await parent.ctx.agents.register(stub.agent)

    expect(parent.ctx.sessionProjections.stateOf(child, 'loop')?.current).toBeNull()
    const fresh = await parent.ctx.loops.start(stub.agent, startRequest({ objective: 'a fork run' }))
    expect(fresh.loop).toMatchObject({ revision: 1, phase: 'active' })
    expect(fresh.loop.id).not.toBe(view.loop.id)
    expect(parent.ctx.sessionProjections.stateOf(child, 'loop')?.seenLoopIds).toEqual([fresh.loop.id])
  })

  it('applyLoopProjection skips inherited loop events with the same reference', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    await ctx.loops.appendNodeStarted(agent, {
      kind: 'node-started',
      loopId: view.loop.id,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
    }, 1)
    const inherited = session.snapshotEvents()
    const forkState: LoopProjectionState = {
      current: null,
      seenLoopIds: [],
      failure: null,
      inheritedEventCount: SessionLogOffset(inherited.length),
    }
    for (const candidate of inherited) {
      expect(applyLoopProjection(forkState, candidate)).toBe(forkState)
    }
  })

  it('applyLoopProjection skips unrelated events with the same reference', async () => {
    const { ctx, agent, session } = await harness()
    await ctx.loops.start(agent, startRequest())
    const before = ctx.sessionProjections.stateOf(session, 'loop')

    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'loop')).toBe(before)
  })

  it('applyLoopProjection preserves the lastRef-free restored current through ledger events', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    const seeded = ctx.sessionProjections.stateOf(session, 'loop')
    if (seeded === undefined || seeded.current === null) throw new Error('expected current loop projection')

    session.append('loop/node-started', {
      kind: 'node-started',
      version: 1,
      loopId: view.loop.id,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: SessionId('sess-writer-1'),
      cwd: 'E:/work/alpha',
      atRevision: 1,
    })
    const event = session.snapshotEvents().find(candidate => candidate.type === 'loop/node-started')
    if (event === undefined) throw new Error('expected ledger event')

    const restored = cloneState(seeded)
    if (restored.current === null) throw new Error('expected current loop projection')
    delete (restored.current as { lastRef?: LoopRef }).lastRef
    const next = applyLoopProjection(restored, event)
    expect(next.current?.lastRef).toBeUndefined()
    expect(next.current?.ledger).toHaveLength(1)
    expect(next.failure).toBeNull()
  })

  it('validates persisted projection rows through the state and wire parses', async () => {
    const { ctx, agent, session } = await harness()
    const view = await ctx.loops.start(agent, startRequest())
    await ctx.loops.pause(agent, refOf(view))
    const state = ctx.sessionProjections.stateOf(session, 'loop')
    if (state === undefined || state.current === null) throw new Error('expected current loop projection')
    const current = state.current
    if (current.loop === undefined) throw new Error('expected current loop snapshot')
    const currentLoopId = current.loop.id

    expect(loopProjectionDefinition.stateSchema.parse(state)).toEqual(state)
    expect(loopProjectionDefinition.wire?.viewSchema.parse(current)).toEqual(current)
    expect(loopProjectionDefinition.wire?.viewSchema.parse(null)).toBeNull()
    expect(loopProjectionDefinition.wire?.viewSchema.parse({ ledger: [] })).toEqual({ ledger: [] })
    expect(loopProjectionDefinition.wire?.view(state)).toBe(current)
    expect(loopProjectionDefinition.stateSchema.parse({
      current: null,
      seenLoopIds: ['x'],
      failure: null,
      inheritedEventCount: 0,
    })).toEqual({ current: null, seenLoopIds: ['x'], failure: null, inheritedEventCount: 0 })

    const parseState = (value: unknown) => loopProjectionDefinition.stateSchema.parse(value)
    const parseView = (value: unknown) => loopProjectionDefinition.wire?.viewSchema.parse(value)

    expect(() => parseView({ ...current, updatedAt: -1 })).toThrow(/loop projection updatedAt must be a non-negative/)
    expect(() => parseView({ ...current, lastRef: { id: 'x', revision: 0 } })).toThrow(
      /loop projection lastRef revision must be a positive/,
    )

    expect(() => parseState(42)).toThrow(/must be a JSON record/)
    expect(() => parseView(42)).toThrow(/must be a JSON record/)
    expect(() => parseState({})).toThrow(/must carry field current/)
    expect(() => parseState({ ...state, extra: 1 })).toThrow(/cannot carry field extra/)
    expect(() => parseState({ ...cloneState(state), failure: 42 })).toThrow(/failure must be a non-empty string/)
    expect(() => parseState({ ...cloneState(state), seenLoopIds: 'x' })).toThrow(/seenLoopIds must be an array/)
    expect(() => parseState({ ...cloneState(state), seenLoopIds: ['a', 'a'] })).toThrow(/must be unique/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ledger: [], createdAt: 1 },
    })).toThrow(/together/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, updatedAt: (current.createdAt ?? 0) - 1 },
    })).toThrow(/cannot precede createdAt/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, ledger: 'x' },
    })).toThrow(/ledger must be an array/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, lastRef: { id: 'x' } },
    })).toThrow(/lastRef must carry field revision/)
    expect(() => parseState({
      ...cloneState(state),
      seenLoopIds: [],
    })).toThrow(/retained among seenLoopIds/)

    const entry = {
      kind: 'node-started',
      loopId: currentLoopId,
      round: 1,
      nodeIndex: 0,
      role: 'writer',
      attempt: 1,
      childSessionId: 'sess-writer-1',
      cwd: 'E:/work/alpha',
      atRevision: 1,
    }
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, ledger: [entry, entry] },
    })).toThrow(/duplicate key/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, ledger: [{ ...entry, kind: 'bogus' }] },
    })).toThrow(/unknown kind/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, ledger: [{ ...entry, role: '' }] },
    })).toThrow(/non-empty string/)
    expect(() => parseState({ current: { ledger: [entry] }, seenLoopIds: [currentLoopId], failure: null, inheritedEventCount: 0 }))
      .toThrow(/ledger entry requires a current loop/)
    expect(() => parseState({ ...cloneState(state), inheritedEventCount: -1 }))
      .toThrow(/inheritedEventCount must be a non-negative/)
    expect(() => parseState({
      ...cloneState(state),
      current: { ...current, loop: { ...current.loop, revision: 0 } },
    })).toThrow(/revision must be a positive/)
  })
})
