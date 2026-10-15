/** Driver-owned loop-stream invariants: settlement conformance and verdict-gated advancement. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { LoopId } from '@deepseek-ai/dsh-loop'
import * as DriverInvariant from '@deepseek-ai/dsh-loop-chain-driver/invariant'
import type { LoopNodeSettledMeta, LoopSnapshotChangeMeta } from '@deepseek-ai/dsh-loop'

const LOOP_ID = LoopId('driver-invariant')

const WORKER_REPORT = { status: 'ok', summary: 'the report is ready', evidence: ['draft.txt'], nextSteps: ['review it'] }
const VERDICT_CONTINUE = { decision: 'continue', feedback: 'tighten the summary' }

const change: LoopSnapshotChangeMeta = {
  kind: 'loop/change',
  version: 1,
  operation: 'create',
  loop: {
    id: LOOP_ID,
    revision: 1,
    objective: 'relay the monthly report',
    phase: 'active',
    maxRounds: 3,
    checkpoint: 'none',
    readScopes: ['/w'],
    writeScopes: ['/w'],
    chain: {
      objective: 'relay the monthly report',
      checkpoint: 'none',
      nodes: [
        { role: 'writer', prompt: 'Draft the report.', cwd: '/w' },
        { role: 'reviewer', prompt: 'Review the draft.', carryOver: ['writer'], cwd: '/w' },
      ],
    },
    roundsStarted: 0,
  },
  createdAt: 1,
  updatedAt: 1,
}

const advanced: LoopSnapshotChangeMeta = {
  ...change,
  operation: 'advance',
  loop: { ...change.loop, revision: 2, roundsStarted: 1 },
}

function settlement(nodeIndex: number, role: string, report: unknown): LoopNodeSettledMeta {
  return {
    kind: 'settlement',
    version: 1,
    loopId: LOOP_ID,
    round: 1,
    nodeIndex,
    role,
    attempt: 1,
    childSessionId: SessionId('driver-invariant-child'),
    cwd: '/w',
    report,
    atRevision: 1,
  }
}

const writerSettlement = settlement(0, 'writer', WORKER_REPORT)
const reviewerSettlement = settlement(1, 'reviewer', WORKER_REPORT)
const evaluatorSettlement = settlement(2, 'evaluator', VERDICT_CONTINUE)

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(DriverInvariant)
  return ctx
}

describe('loop-chain-driver stream invariants', () => {
  it('accepts conforming settlements, the evaluator verdict, and the verdict-gated advance', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-valid'))
    session.append('loop/change', change)
    session.append('loop/node', writerSettlement)
    session.append('loop/node', reviewerSettlement)
    session.append('loop/node', evaluatorSettlement)
    session.append('loop/change', advanced)
    // Ledger records of other kinds and settlements of other loops fold without checks.
    session.append('loop/attempt', {
      kind: 'attempt', version: 1, loopId: LOOP_ID, round: 2, nodeIndex: 0, attempt: 1,
      failure: { code: 'error', message: 'model fault' }, atRevision: 2,
    })
    session.append('loop/node', { ...settlement(0, 'writer', WORKER_REPORT), loopId: LoopId('another-loop') })
    expect(session.seq).toBe(7)
  })

  it('rejects a worker settlement whose report violates the default handoff schema', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-bad-report'))
    session.append('loop/change', change)
    expect(() => session.append('loop/node', settlement(0, 'writer', { status: 'ok' })))
      .toThrow(/settlement report of node "writer" violates its handoff contract/)
    expect(session.seq).toBe(1)
  })

  it('rejects an evaluator settlement whose report is not a verdict', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-bad-verdict'))
    session.append('loop/change', change)
    expect(() => session.append('loop/node', settlement(2, 'evaluator', { decision: 'maybe' })))
      .toThrow(/settlement report of node "evaluator" violates its handoff contract/)
    expect(session.seq).toBe(1)
  })

  it('rejects a settlement beyond the evaluator index', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-beyond'))
    session.append('loop/change', change)
    expect(() => session.append('loop/node', settlement(3, 'reviewer', WORKER_REPORT)))
      .toThrow(/settlement at node index 3 is beyond the evaluator at 2/)
    expect(session.seq).toBe(1)
  })

  it('rejects a settlement whose role does not match the frozen chain node', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-role'))
    session.append('loop/change', change)
    expect(() => session.append('loop/node', settlement(1, 'writer', WORKER_REPORT)))
      .toThrow(/settlement role "writer" does not match the frozen chain node 1/)
    expect(session.seq).toBe(1)
  })

  it('rejects an advance that applies no settled continue verdict', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-unjustified'))
    session.append('loop/change', change)
    session.append('loop/node', writerSettlement)
    expect(() => session.append('loop/change', advanced))
      .toThrow(/advance to 1 rounds applies no settled continue verdict for round 1/)
    expect(session.seq).toBe(2)
  })

  it('rejects an advance that applies a complete verdict instead of continue', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('driver-invariant-complete'))
    session.append('loop/change', change)
    session.append('loop/node', evaluatorSettlement)
    session.append('loop/node', settlement(2, 'evaluator', { ...VERDICT_CONTINUE, decision: 'complete' }))
    expect(() => session.append('loop/change', advanced))
      .toThrow(/applies no settled continue verdict/)
    expect(session.seq).toBe(3)
  })

  it('folds a fork only from its own events, ignoring the inherited run', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const parent = ctx.sessions.create(SessionId('driver-invariant-parent'))
    parent.append('loop/change', change)
    await ctx.plugin(DriverInvariant)

    const child = ctx.sessions.create(SessionId('driver-invariant-fork'), {
      seed: parent.snapshotEvents(),
      inheritedEventCount: SessionLogOffset(1),
      meta: { parentSession: parent.id, isSeeded: true },
    })
    // The inherited create never folded, so the parent loop's contract checks nothing here.
    expect(() => child.append('loop/node', settlement(0, 'writer', { status: 'ok' }))).not.toThrow()
    // The seed's trailing end-seed marker keeps the child's own events one past the inherited prefix.
    expect(child.seq).toBe(3)
  })

  it('refuses to create a session whose seed already violates the stream', async () => {
    const ctx = await setup()
    expect(() => ctx.sessions.create(SessionId('driver-invariant-bad-seed'), {
      seed: [
        { type: 'loop/change', seq: 0, time: 0, data: change } as never,
        { type: 'loop/node', seq: 1, time: 1, data: settlement(0, 'writer', { status: 'ok' }) } as never,
      ] as never,
    })).toThrow(/violates its handoff contract/)
    expect(ctx.sessions.get(SessionId('driver-invariant-bad-seed'))).toBeUndefined()
  })
})
