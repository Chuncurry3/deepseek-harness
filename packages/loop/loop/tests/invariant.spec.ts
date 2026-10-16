/** Loop-stream invariant companion: candidate validation, fork boundary, isolation. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LoopId, loopProjectionDefinition } from '@deepseek-ai/dsh-loop'
import * as LoopInvariantCompanion from '@deepseek-ai/dsh-loop/invariant'
import type { LoopNodeSettledMeta, LoopNodeStartedMeta, LoopSnapshotChangeMeta } from '@deepseek-ai/dsh-loop'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/loop-invariant-count': number
  }
}

const LOOP_ID = LoopId('loop-invariant')

const change: LoopSnapshotChangeMeta = {
  kind: 'loop/change',
  version: 1,
  operation: 'create',
  loop: {
    id: LOOP_ID,
    revision: 1,
    objective: 'check the stream',
    phase: 'active',
    maxRounds: 2,
    checkpoint: 'none',
    readScopes: ['/w'],
    writeScopes: ['/w'],
    chain: { objective: 'check the stream', checkpoint: 'none', nodes: [{ role: 'worker', prompt: 'run the round' }] },
    roundsStarted: 0,
  },
  createdAt: 1,
  updatedAt: 1,
}

const started: LoopNodeStartedMeta = {
  kind: 'node-started',
  version: 1,
  loopId: LOOP_ID,
  round: 1,
  nodeIndex: 0,
  role: 'worker',
  attempt: 1,
  childSessionId: SessionId('loop-invariant-child'),
  cwd: '/w',
  atRevision: 1,
}

const settlement: LoopNodeSettledMeta = {
  kind: 'settlement',
  version: 1,
  loopId: LOOP_ID,
  round: 1,
  nodeIndex: 0,
  role: 'worker',
  attempt: 1,
  childSessionId: SessionId('loop-invariant-child'),
  cwd: '/w',
  report: { summary: 'done' },
  atRevision: 1,
}

/** Build one session event at a sequence position. */
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

type CountSchema = ProjectionDefinition<'test/loop-invariant-count', number>['stateSchema']

/** Foreign unit counting every event of its session. */
const countUnit = {
  key: 'test/loop-invariant-count',
  stateSchema: { parse: (value: unknown): number => {
    if (typeof value !== 'number') throw new Error('test count state must be a number')
    return value
  } } as CountSchema,
  init: () => 0,
  apply: (state: number) => state + 1,
  stateVersion: 1,
} satisfies ProjectionDefinition<'test/loop-invariant-count', number>

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(LoopInvariantCompanion)
  return ctx
}

describe('loop stream invariants', () => {
  it('accepts canonical loop changes, ledger records, and unrelated events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('loop-invariant-valid'))
    session.append('loop/change', change)
    session.append('loop/node-started', started)
    session.append('turn/start', { turn: 1 })
    session.append('loop/node', settlement)
    expect(session.seq).toBe(4)
  })

  it('rejects a duplicate ledger key before committing it and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('loop-invariant-invalid'))
    session.append('loop/change', change)
    session.append('loop/node-started', started)
    expect(() => session.append('loop/node-started', started)).toThrow(
      expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: '@deepseek-ai/dsh-loop',
      }),
    )
    expect(() => session.append('loop/node-started', started))
      .toThrow(/session event 2 violates the durable loop stream: loop ledger duplicate key/)
    expect(session.seq).toBe(2)
    expect(() => session.append('loop/node', settlement)).not.toThrow()
    expect(session.seq).toBe(3)
  })

  it('reconstructs an existing durable loop before checking later candidates', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('loop-invariant-late-load'))
    session.append('loop/change', change)
    session.append('loop/node-started', started)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(LoopInvariantCompanion)
    session.append('loop/node', settlement)
    expect(session.seq).toBe(3)
  })

  it('folds loop events only from the fork seed boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const parent = ctx.sessions.create(SessionId('loop-invariant-parent'))
    parent.append('loop/change', change)
    parent.append('loop/node-started', started)
    await ctx.plugin(LoopInvariantCompanion)

    const child = ctx.sessions.create(SessionId('loop-invariant-fork'), {
      seed: parent.snapshotEvents(),
      inheritedEventCount: SessionLogOffset(2),
      meta: { parentSession: parent.id, isSeeded: true },
    })
    const childChange: LoopSnapshotChangeMeta = {
      ...change,
      loop: { ...change.loop, id: LoopId('loop-invariant-fork') },
    }
    expect(() => child.append('loop/change', childChange)).not.toThrow()
    expect(child.seq).toBe(4)
  })

  it('isolates a corrupt loop stream from the session and other projections', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(loopProjectionDefinition)
    ctx.sessionProjections.register(countUnit)
    const id = SessionId('loop-invariant-isolated')
    const session = ctx.sessions.create(id, {
      seed: [
        event(0, 'loop/change', change),
        event(1, 'loop/node-started', started),
        event(2, 'loop/node-started', started),
        event(3, 'turn/start', { turn: 1 }),
      ],
    })
    expect(ctx.sessionProjections.stateOf(session, 'loop')?.failure)
      .toMatch(/loop replay failed at session event 2: .*duplicate key/)
    // the seed's trailing `session/end-seed` marker counts as the fifth event
    expect(ctx.sessionProjections.stateOf(session, 'test/loop-invariant-count')).toBe(5)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(LoopInvariantCompanion).then(() => undefined))
      .rejects.toThrow(/session event 2 violates the durable loop stream: loop ledger duplicate key/)
    expect(ctx.sessions.get(id)).toBeDefined()
    expect(ctx.sessionProjections.stateOf(session, 'test/loop-invariant-count')).toBe(5)
  })
})
