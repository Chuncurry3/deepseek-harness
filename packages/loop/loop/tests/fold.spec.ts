import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyLoopEvent,
  decodeLoopChange,
  decodeLoopLedger,
  emptyLoopFoldState,
  foldLoop,
  loopChangeRef,
} from '../src/fold.ts'
import { LOOP_CHANGE_VERSION, LOOP_LEDGER_VERSION, LoopError, LoopId } from '../src/runtime.ts'

const baseSnapshot = {
  id: 'L1' as never,
  revision: 1,
  objective: 'o',
  phase: 'active',
  maxRounds: 20,
  checkpoint: 'none',
  readScopes: [],
  writeScopes: [],
  chain: { objective: 'o', checkpoint: 'none', nodes: [{ role: 'worker', prompt: 'p' }] },
  roundsStarted: 0,
}

const started = {
  kind: 'node-started',
  version: LOOP_LEDGER_VERSION,
  loopId: 'L1',
  round: 1,
  nodeIndex: 0,
  role: 'r',
  attempt: 1,
  childSessionId: 's1',
  cwd: '/w',
  atRevision: 1,
}

const attemptFailure = {
  kind: 'attempt',
  version: LOOP_LEDGER_VERSION,
  loopId: 'L1',
  round: 1,
  nodeIndex: 0,
  attempt: 1,
  childSessionId: 's1',
  failure: { code: 'node-failed', message: 'child failed' },
  atRevision: 1,
}

const settlement = {
  kind: 'settlement',
  version: LOOP_LEDGER_VERSION,
  loopId: 'L1',
  round: 1,
  nodeIndex: 0,
  role: 'r',
  attempt: 1,
  childSessionId: 's1',
  cwd: '/w',
  report: { summary: 'ok' },
  atRevision: 1,
}

/** Build one session event at a sequence position. */
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq, type, data } as never
}

/** Build one loop/change snapshot payload. */
function snapshotChange(operation: string, loop: Record<string, unknown>, createdAt = 0, updatedAt = 1): Record<string, unknown> {
  return { kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation, loop, createdAt, updatedAt }
}

/** Build one loop/change clear tombstone payload. */
function clearChange(cleared: { id: unknown; revision: number }, clearedAt = 1): Record<string, unknown> {
  return { kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared, clearedAt }
}

/** Fold change payloads into a fresh state. */
function changeState(...changes: Record<string, unknown>[]) {
  const state = emptyLoopFoldState()
  let seq = 0
  for (const data of changes) applyLoopEvent(state, event(++seq, 'loop/change', data))
  return state
}

const create = snapshotChange('create', baseSnapshot, 0, 0)
const pause = (revision = 2) => snapshotChange('pause', { ...baseSnapshot, revision, phase: 'paused' })
const resume = (revision = 2, phase = 'active') => snapshotChange('resume', { ...baseSnapshot, revision, phase })
const ask = (revision = 2) => snapshotChange('await-human', { ...baseSnapshot, revision, phase: 'awaiting-human' })
const block = (revision = 2) => snapshotChange('block', {
  ...baseSnapshot,
  revision,
  phase: 'blocked',
  blockedReason: { code: 'node-failed', message: 'm' },
})

describe('loop durable fold', () => {
  it('last-wins change fold and transition legality', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    expect(state.loop?.revision).toBe(1)
    applyLoopEvent(state, event(2, 'loop/change', pause()))
    expect(state.loop?.phase).toBe('paused')
  })

  it('rejects illegal phase transitions fail-loud', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    expect(() => { applyLoopEvent(state, event(2, 'loop/change', snapshotChange('await-human', { ...baseSnapshot, revision: 2 }))) }).toThrow(/transition/)
  })

  it('ledger keys are unique and attempts require their node-started', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    applyLoopEvent(state, event(2, 'loop/node-started', started))
    expect(() => { applyLoopEvent(state, event(3, 'loop/node-started', started)) }).toThrow(/duplicate/)
    expect(() => { applyLoopEvent(state, event(4, 'loop/attempt', { ...attemptFailure, nodeIndex: 9 })) }).toThrow(/node-started/)
  })

  it('a clear tombstone ends the run; later ledger events for the old loopId are history', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    applyLoopEvent(state, event(2, 'loop/change', clearChange({ id: 'L1', revision: 2 })))
    expect(state.loop).toBeUndefined()
    applyLoopEvent(state, event(3, 'loop/node', settlement))
    expect(state.ledger.size).toBe(0)
    expect(state.lastRef).toEqual({ id: 'L1', revision: 2 })
  })

  it('fails loud on a malformed loop change payload', () => {
    const state = emptyLoopFoldState()
    expect(() => { applyLoopEvent(state, event(1, 'loop/change', { ...create, version: 2 })) }).toThrow('unsupported loop change version 2')
    expect(() => { applyLoopEvent(state, event(2, 'loop/change', { kind: 'other' })) }).toThrow('has an invalid kind')
  })
})

describe('loop ledger fold', () => {
  it('rejects settlements and attempts without their node-started', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    expect(() => { applyLoopEvent(state, event(2, 'loop/node', settlement)) }).toThrow(/node-started/)
    expect(() => { applyLoopEvent(state, event(3, 'loop/attempt', attemptFailure)) }).toThrow(/node-started/)
  })

  it('rejects a second settlement or a failure after a settlement for one attempt', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    applyLoopEvent(state, event(2, 'loop/node-started', started))
    applyLoopEvent(state, event(3, 'loop/node', settlement))
    expect(() => { applyLoopEvent(state, event(4, 'loop/node', settlement)) }).toThrow(/node-started/)
    expect(() => { applyLoopEvent(state, event(5, 'loop/attempt', attemptFailure)) }).toThrow(/node-started/)
  })

  it('records retries as separate ledger keys', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    applyLoopEvent(state, event(2, 'loop/node-started', started))
    applyLoopEvent(state, event(3, 'loop/attempt', attemptFailure))
    applyLoopEvent(state, event(4, 'loop/node-started', { ...started, attempt: 2, childSessionId: 's2' }))
    applyLoopEvent(state, event(5, 'loop/node', { ...settlement, attempt: 2, childSessionId: 's2' }))
    // The replacing attempt entry keeps the failed child's session id, so both
    // the failed and the retried child stay matchable from the folded ledger.
    expect([...state.ledger.values()]).toEqual([
      { kind: 'attempt', round: 1, nodeIndex: 0, attempt: 1, childSessionId: 's1', failure: { code: 'node-failed', message: 'child failed' }, atRevision: 1 },
      { kind: 'settlement', round: 1, nodeIndex: 0, role: 'r', attempt: 2, childSessionId: 's2', cwd: '/w', report: { summary: 'ok' }, atRevision: 1 },
    ])
  })

  it('ignores ledger events that belong to another loop or precede the first create', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    applyLoopEvent(state, event(2, 'loop/node-started', { ...started, loopId: 'L2' }))
    expect(state.ledger.size).toBe(0)
    const unseeded = emptyLoopFoldState()
    applyLoopEvent(unseeded, event(1, 'loop/node-started', started))
    expect(unseeded.ledger.size).toBe(0)
  })

  it('rejects a ledger event stamped with a revision the loop has not reached', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    expect(() => { applyLoopEvent(state, event(2, 'loop/node-started', { ...started, atRevision: 2 })) }).toThrow('exceeds the current change revision')
  })
})

describe('loop change transitions', () => {
  it('rejects creates that are not fresh active revision-one loops', () => {
    expect(() => changeState(snapshotChange('create', { ...baseSnapshot, revision: 2 }, 0, 0))).toThrow('fresh active revision-one')
    expect(() => changeState(snapshotChange('create', { ...baseSnapshot, phase: 'paused' }, 0, 0))).toThrow('fresh active revision-one')
    expect(() => changeState(snapshotChange('create', { ...baseSnapshot, roundsStarted: 1 }, 0, 0))).toThrow('fresh active revision-one')
    expect(() => changeState(create, snapshotChange('create', { ...baseSnapshot, id: 'L2' }, 0, 1))).toThrow('fresh active revision-one')
  })

  it('rejects a replacement create that reuses a cleared identity', () => {
    expect(() => changeState(create, clearChange({ id: 'L1', revision: 2 }), create)).toThrow('fresh active revision-one')
  })

  it('replaces a completed run with a fresh identity and an empty ledger', () => {
    const state = emptyLoopFoldState()
    applyLoopEvent(state, event(1, 'loop/change', create))
    applyLoopEvent(state, event(2, 'loop/node-started', started))
    applyLoopEvent(state, event(3, 'loop/change', snapshotChange('complete', { ...baseSnapshot, revision: 2, phase: 'complete' })))
    applyLoopEvent(state, event(4, 'loop/change', snapshotChange('create', { ...baseSnapshot, id: 'L2' }, 5, 5)))
    expect(state.loop?.id).toBe('L2')
    expect(state.loop?.revision).toBe(1)
    expect(state.ledger.size).toBe(0)
    expect([...state.seenLoopIds]).toEqual(['L1', 'L2'])
  })

  it('pauses from active and awaiting-human', () => {
    expect(changeState(create, pause()).loop?.phase).toBe('paused')
    expect(changeState(create, ask(), pause(3)).loop?.phase).toBe('paused')
  })

  it('rejects pausing a paused loop', () => {
    expect(() => changeState(create, pause(), pause(3))).toThrow('loop pause has an invalid phase transition')
  })

  it('resumes paused, blocked, re-armed, and still-asking loops', () => {
    expect(changeState(create, pause(), resume(3)).loop?.phase).toBe('active')
    expect(changeState(create, block(), resume(3)).loop?.phase).toBe('active')
    expect(changeState(create, resume(2)).loop?.revision).toBe(2)
    expect(changeState(create, ask(), resume(3, 'awaiting-human')).loop?.phase).toBe('awaiting-human')
  })

  it('rejects resuming a completed loop', () => {
    expect(() => changeState(
      create,
      snapshotChange('complete', { ...baseSnapshot, revision: 2, phase: 'complete' }),
      resume(3),
    )).toThrow('loop resume cannot leave phase complete')
  })

  it('rejects resuming a run with no round capacity left', () => {
    const single = { ...baseSnapshot, maxRounds: 1 }
    expect(() => changeState(
      snapshotChange('create', single, 0, 0),
      snapshotChange('advance', { ...single, revision: 2, roundsStarted: 1 }),
      snapshotChange('resume', { ...single, revision: 3, phase: 'active', roundsStarted: 1 }),
    )).toThrow('exhausted round budget')
  })

  it('opens and answers human checkpoints', () => {
    const answer = snapshotChange('continue', { ...baseSnapshot, revision: 3, phase: 'active' })
    expect(changeState(create, ask(), answer).loop?.phase).toBe('active')
  })

  it('rejects opening a checkpoint outside active and answering outside awaiting-human', () => {
    expect(() => changeState(create, pause(), ask(3))).toThrow('loop await-human has an invalid phase transition')
    expect(() => changeState(create, snapshotChange('continue', { ...baseSnapshot, revision: 2, phase: 'active' }))).toThrow('loop continue has an invalid phase transition')
  })

  it('advances exactly one round of the active loop', () => {
    expect(changeState(create, snapshotChange('advance', { ...baseSnapshot, revision: 2, roundsStarted: 1 })).loop?.roundsStarted).toBe(1)
  })

  it('rejects advances that skip, stall, or leave the active phase', () => {
    expect(() => changeState(create, snapshotChange('advance', { ...baseSnapshot, revision: 2 }))).toThrow('must run one new round')
    expect(() => changeState(create, snapshotChange('advance', { ...baseSnapshot, revision: 2, roundsStarted: 2 }))).toThrow('must run one new round')
    expect(() => changeState(create, snapshotChange('advance', { ...baseSnapshot, revision: 2, roundsStarted: 1, phase: 'paused' }))).toThrow('must run one new round')
    expect(() => changeState(create, pause(), snapshotChange('advance', { ...baseSnapshot, revision: 3, roundsStarted: 1 }))).toThrow('must run one new round')
  })

  it('completes from active only', () => {
    expect(changeState(create, snapshotChange('complete', { ...baseSnapshot, revision: 2, phase: 'complete' })).loop?.phase).toBe('complete')
    expect(() => changeState(create, pause(), snapshotChange('complete', { ...baseSnapshot, revision: 3, phase: 'complete' }))).toThrow('loop complete has an invalid phase transition')
    expect(() => changeState(create, snapshotChange('complete', { ...baseSnapshot, revision: 2, phase: 'paused' }))).toThrow('loop complete has an invalid phase transition')
  })

  it('blocks live loops and rejects re-blocking', () => {
    expect(changeState(create, block()).loop?.phase).toBe('blocked')
    expect(changeState(create, ask(), block(3)).loop?.phase).toBe('blocked')
    expect(changeState(create, pause(), block(3)).loop?.phase).toBe('blocked')
    expect(() => changeState(create, block(), block(3))).toThrow('loop block has an invalid phase transition')
    expect(() => changeState(create, snapshotChange('block', { ...baseSnapshot, revision: 2, phase: 'paused' }))).toThrow('loop block has an invalid phase transition')
  })

  it('rejects mutations without a current loop', () => {
    expect(() => changeState(pause())).toThrow('loop pause requires a current loop')
    expect(() => changeState(clearChange({ id: 'L1', revision: 1 }))).toThrow('loop clear requires a current loop')
  })

  it('rejects revision discontinuity', () => {
    expect(() => changeState(create, pause(3))).toThrow('must advance the current loop by one revision')
    expect(() => changeState(create, snapshotChange('pause', { ...baseSnapshot, revision: 2, phase: 'paused', id: 'L2' }))).toThrow('must advance the current loop by one revision')
    expect(() => changeState(create, clearChange({ id: 'L1', revision: 1 }))).toThrow('must advance the current loop by one revision')
  })

  it('rejects counter and timestamp drift', () => {
    expect(() => changeState(create, snapshotChange('pause', { ...baseSnapshot, revision: 2, phase: 'paused', roundsStarted: 1 }))).toThrow('does not preserve the current counters and timestamps')
    expect(() => changeState(create, snapshotChange('pause', { ...baseSnapshot, revision: 2, phase: 'paused' }, 1, 1))).toThrow('does not preserve the current counters and timestamps')
    expect(() => changeState(snapshotChange('create', baseSnapshot, 0, 5), pause(2))).toThrow('does not preserve the current counters and timestamps')
    expect(() => changeState(snapshotChange('create', baseSnapshot, 0, 5), clearChange({ id: 'L1', revision: 2 }, 3))).toThrow('timestamp cannot precede')
  })

  it('rejects definition drift after create', () => {
    for (const override of [
      { objective: 'x' },
      { maxRounds: 21 },
      { checkpoint: 'node' },
      { readScopes: ['/w'] },
      { writeScopes: ['/w'] },
      { chain: { objective: 'o', checkpoint: 'none', nodes: [{ role: 'worker', prompt: 'q' }] } },
    ]) {
      expect(() => changeState(create, snapshotChange('pause', { ...baseSnapshot, revision: 2, phase: 'paused', ...override }))).toThrow('cannot change the objective, caps, scopes, or chain')
    }
  })
})

describe('loop change decoder', () => {
  it('returns undefined for values that are not loop changes', () => {
    expect(decodeLoopChange(undefined)).toBeUndefined()
    expect(decodeLoopChange('loop/change')).toBeUndefined()
    expect(decodeLoopChange({ kind: 'other' })).toBeUndefined()
  })

  it('rejects unsupported versions and operations', () => {
    expect(() => decodeLoopChange({ ...create, version: 2 })).toThrow('unsupported loop change version 2')
    expect(() => decodeLoopChange({ ...create, operation: 'explode' })).toThrow('operation is invalid')
  })

  it('rejects malformed clear changes', () => {
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared: { id: 'L1', revision: 2 } })).toThrow('must carry field clearedAt')
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared: { id: 'L1', revision: 2 }, clearedAt: 1, extra: true })).toThrow('cannot carry field extra')
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared: 'L1', clearedAt: 1 })).toThrow('tombstone must be a record')
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared: { id: '', revision: 2 }, clearedAt: 1 })).toThrow('tombstone id must be a non-empty string')
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared: { id: 'L1', revision: 0 }, clearedAt: 1 })).toThrow('tombstone revision must be a positive safe integer')
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'clear', cleared: { id: 'L1', revision: 2 }, clearedAt: -1 })).toThrow('clearedAt must be a non-negative safe integer')
    expect(decodeLoopChange(clearChange({ id: 'L1', revision: 2 }))).toMatchObject({ operation: 'clear', cleared: { id: 'L1', revision: 2 }, clearedAt: 1 })
  })

  it('rejects malformed snapshot changes', () => {
    expect(() => decodeLoopChange({ kind: 'loop/change', version: LOOP_CHANGE_VERSION, operation: 'create', createdAt: 0, updatedAt: 0 })).toThrow('must carry field loop')
    expect(() => decodeLoopChange({ ...create, extra: true })).toThrow('cannot carry field extra')
    expect(() => decodeLoopChange({ ...create, createdAt: -1 })).toThrow('createdAt must be a non-negative safe integer')
    expect(() => decodeLoopChange({ ...create, updatedAt: 'x' })).toThrow('updatedAt must be a non-negative safe integer')
    expect(() => decodeLoopChange({ ...create, updatedAt: 0, createdAt: 1 })).toThrow('cannot precede createdAt')
  })

  it('rejects malformed snapshots', () => {
    for (const [override, message] of [
      [{ phase: 'running' }, 'loop.phase is invalid'],
      [{ phase: 5 }, 'loop.phase is invalid'],
      [{ maxRounds: 0 }, 'loop.maxRounds must be a positive safe integer'],
      [{ maxRounds: 'x' }, 'loop.maxRounds must be a positive safe integer'],
      [{ maxRounds: 1, roundsStarted: 2 }, 'roundsStarted cannot exceed loop.maxRounds'],
      [{ roundsStarted: -1 }, 'roundsStarted must be a non-negative safe integer'],
      [{ id: '' }, 'loop.id must be a non-empty string'],
      [{ id: 5 }, 'loop.id must be a non-empty string'],
      [{ revision: 0 }, 'loop.revision must be a positive safe integer'],
      [{ revision: 1.5 }, 'loop.revision must be a positive safe integer'],
      [{ objective: 5 }, 'loop.objective must be non-empty and normalized'],
      [{ objective: ' ' }, 'loop.objective must be non-empty and normalized'],
      [{ objective: ' o ' }, 'loop.objective must be non-empty and normalized'],
      [{ checkpoint: 'both' }, 'loop.checkpoint must be "none" or "node"'],
      [{ readScopes: '/w' }, 'loop.readScopes must be an array'],
      [{ readScopes: [''] }, 'loop.readScopes entry must be a non-empty string'],
      [{ writeScopes: [''] }, 'loop.writeScopes entry must be a non-empty string'],
      [{ blockedReason: { code: 'node-failed', message: 'm' } }, 'cannot carry field blockedReason'],
      [{ phase: 'blocked' }, 'must carry field blockedReason'],
      [{ phase: 'blocked', blockedReason: 'x' }, 'blockedReason must be a record'],
      [{ phase: 'blocked', blockedReason: { code: 'nope', message: 'm' } }, 'not a known loop block code'],
      [{ phase: 'blocked', blockedReason: { code: 'node-failed', message: '' } }, 'blockedReason.message must be non-empty and normalized'],
      [{ chain: 5 }, 'loop.chain must be a record'],
      [5, 'loop must be a record'],
    ] as [Record<string, unknown> | number, string][]) {
      const loop = typeof override === 'number' ? override : { ...baseSnapshot, ...override }
      expect(() => decodeLoopChange(snapshotChange('create', loop as Record<string, unknown>, 0, 0)), JSON.stringify(override)).toThrow(message)
    }
  })

  it('rejects malformed frozen chains', () => {
    const chainOf = (chain: Record<string, unknown>) => snapshotChange('create', { ...baseSnapshot, chain }, 0, 0) as never
    for (const [chain, message] of [
      [{ checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p' }] }, 'must carry field objective'],
      [{ objective: '', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p' }] }, 'chain objective must be non-empty and normalized'],
      [{ objective: 'o', checkpoint: 'both', nodes: [{ role: 'w', prompt: 'p' }] }, 'chain checkpoint must be "none" or "node"'],
      [{ objective: 'o', checkpoint: 'none', nodes: [] }, 'nodes must be a non-empty array'],
      [{ objective: 'o', checkpoint: 'none', nodes: 5 }, 'nodes must be a non-empty array'],
      [{ objective: 'o', checkpoint: 'none', nodes: [5] }, 'node must be a record'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ prompt: 'p' }] }, 'must carry field role'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w' }] }, 'must carry field prompt'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', extra: 1 }] }, 'cannot carry field extra'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: ' w', prompt: 'p' }] }, 'node role must be non-empty and normalized'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: ' ' }] }, 'node prompt must be a non-empty string'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', cwd: '' }] }, 'node cwd must be a non-empty string'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', output: 5 }] }, 'unsupported JSON schema'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', inputs: 5 }] }, 'inputs must be an array'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', inputs: [5] }] }, 'inputs entry must be a record'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', inputs: [{ session: '' }] }] }, 'session must be a non-empty string'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', inputs: [{ session: 's', x: 1 }] }] }, 'cannot carry field x'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', carryOver: 5 }] }, 'carryOver must be an array'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', carryOver: [''] }] }, 'carryOver entry must be a non-empty string'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p', carryOver: ['ghost'] }] }, 'unknown role: ghost'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p' }, { role: 'w', prompt: 'q' }] }, 'role must be unique'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p' }], exit: '' }, 'chain exit must be a non-empty string'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p' }], evaluatorPrompt: '' }, 'evaluatorPrompt must be a non-empty string'],
      [{ objective: 'o', checkpoint: 'none', nodes: [{ role: 'w', prompt: 'p' }], extra: 1 }, 'cannot carry field extra'],
    ] as [Record<string, unknown>, string][]) {
      expect(() => decodeLoopChange(chainOf(chain)), JSON.stringify(chain)).toThrow(message)
    }
  })

  it('decodes a fully populated chain change', () => {
    const change = decodeLoopChange(snapshotChange('create', {
      ...baseSnapshot,
      readScopes: ['/r'],
      writeScopes: ['/w'],
      chain: {
        objective: 'o',
        exit: 'done',
        checkpoint: 'node',
        evaluatorPrompt: 'e',
        nodes: [{
          role: 'w',
          prompt: 'p',
          cwd: '/w',
          output: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          inputs: [{ session: 's1' }],
          carryOver: ['w'],
        }],
      },
    }, 0, 0))
    expect(change).toMatchObject({
      kind: 'loop/change',
      operation: 'create',
      createdAt: 0,
      updatedAt: 0,
      loop: {
        id: 'L1',
        readScopes: ['/r'],
        writeScopes: ['/w'],
        chain: {
          objective: 'o',
          exit: 'done',
          checkpoint: 'node',
          evaluatorPrompt: 'e',
          nodes: [{ role: 'w', cwd: '/w', inputs: [{ session: 's1' }], carryOver: ['w'] }],
        },
      },
    })
  })
})

describe('loop ledger decoder', () => {
  it('requires the payload kind that matches the event key', () => {
    expect(() => decodeLoopLedger('loop/attempt', { ...settlement, version: LOOP_LEDGER_VERSION })).toThrow('loop loop/attempt payload must carry kind attempt')
    expect(() => decodeLoopLedger('loop/node', 5)).toThrow('loop loop/node payload must carry kind settlement')
    expect(() => decodeLoopLedger('loop/node-started', { ...started, version: 2 })).toThrow('unsupported loop ledger version 2')
  })

  it('validates the shared ledger fields', () => {
    for (const [override, message] of [
      [{ loopId: '' }, 'loopId must be a non-empty string'],
      [{ round: 0 }, 'round must be a positive safe integer'],
      [{ round: 1.5 }, 'round must be a positive safe integer'],
      [{ nodeIndex: -1 }, 'nodeIndex must be a non-negative safe integer'],
      [{ nodeIndex: 1.5 }, 'nodeIndex must be a non-negative safe integer'],
      [{ attempt: 0 }, 'attempt must be a positive safe integer'],
      [{ atRevision: 0 }, 'atRevision must be a positive safe integer'],
      [{ role: '' }, 'role must be a non-empty string'],
      [{ role: 5 }, 'role must be a non-empty string'],
      [{ childSessionId: '' }, 'childSessionId must be a non-empty string'],
      [{ childSessionId: 5 }, 'childSessionId must be a non-empty string'],
      [{ cwd: '' }, 'cwd must be a non-empty string'],
      [{ cwd: 5 }, 'cwd must be a non-empty string'],
      [{ extra: 1 }, 'cannot carry field extra'],
    ] as [Record<string, unknown>, string][]) {
      expect(() => decodeLoopLedger('loop/node-started', { ...started, ...override }), JSON.stringify(override)).toThrow(message)
    }
  })

  it('validates attempt failure records', () => {
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, failure: 5 })).toThrow('failure must be a record')
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, failure: { code: 'x' } })).toThrow('must carry field message')
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, failure: { code: '', message: 'm' } })).toThrow('code must be a non-empty string')
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, failure: { code: 'x', message: '' } })).toThrow('message must be a non-empty string')
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, role: 'r' })).toThrow('cannot carry field role')
  })

  it('requires the failed attempt\'s child session id', () => {
    const { childSessionId: _childSessionId, ...withoutChild } = attemptFailure
    expect(() => decodeLoopLedger('loop/attempt', withoutChild)).toThrow('must carry field childSessionId')
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, childSessionId: '' })).toThrow('childSessionId must be a non-empty string')
    expect(() => decodeLoopLedger('loop/attempt', { ...attemptFailure, childSessionId: 5 })).toThrow('childSessionId must be a non-empty string')
  })

  it('validates settlement payloads', () => {
    const { report: _report, ...withoutReport } = settlement
    expect(() => decodeLoopLedger('loop/node', withoutReport)).toThrow('must carry field report')
    expect(decodeLoopLedger('loop/node', settlement)).toMatchObject({ kind: 'settlement', report: { summary: 'ok' } })
    expect(decodeLoopLedger('loop/node-started', started)).toMatchObject({ kind: 'node-started', loopId: 'L1', childSessionId: 's1' })
    expect(decodeLoopLedger('loop/attempt', attemptFailure)).toMatchObject({ kind: 'attempt', childSessionId: 's1', failure: { code: 'node-failed' } })
  })
})

describe('loop folded projection', () => {
  it('folds a full round lifecycle with the current-loop projection', () => {
    const projection = foldLoop([
      event(1, 'loop/change', create),
      event(2, 'loop/node-started', started),
      event(3, 'loop/node', settlement),
      event(4, 'loop/change', snapshotChange('advance', { ...baseSnapshot, revision: 2, roundsStarted: 1 })),
      event(5, 'turn/start', { turn: 1 }),
    ])
    expect(projection).toEqual({
      loop: { ...baseSnapshot, revision: 2, roundsStarted: 1 },
      ledger: [{ kind: 'settlement', round: 1, nodeIndex: 0, role: 'r', attempt: 1, childSessionId: 's1', cwd: '/w', report: { summary: 'ok' }, atRevision: 1 }],
      createdAt: 0,
      updatedAt: 1,
      lastRef: { id: 'L1', revision: 2 },
    })
  })

  it('folds an empty log to an empty ledger', () => {
    expect(foldLoop([])).toEqual({ ledger: [] })
  })

  it('folds a cleared run to the tombstone ref with an empty ledger', () => {
    const projection = foldLoop([
      event(1, 'loop/change', create),
      event(2, 'loop/node-started', started),
      event(3, 'loop/change', clearChange({ id: 'L1', revision: 2 })),
    ])
    expect(projection).toEqual({ ledger: [], lastRef: { id: 'L1', revision: 2 } })
  })
})

describe('loop change refs', () => {
  it('returns the tombstone ref of a clear and the snapshot ref otherwise', () => {
    const clear = decodeLoopChange(clearChange({ id: 'L1', revision: 2 }))
    if (clear === undefined) throw new Error('clear change failed to decode')
    expect(loopChangeRef(clear)).toEqual({ id: 'L1', revision: 2 })
    const created = decodeLoopChange(create)
    if (created === undefined) throw new Error('create change failed to decode')
    expect(loopChangeRef(created)).toEqual({ id: 'L1', revision: 1 })
  })
})

describe('loop runtime constructors', () => {
  it('brands loop ids without changing the value', () => {
    expect(LoopId('L1')).toBe('L1')
  })

  it('narrows the harness error code at the loop boundary', () => {
    const error = new LoopError('no live agent', 'LOOP_AGENT_NOT_LIVE')
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe('LOOP_AGENT_NOT_LIVE')
    expect(error.message).toBe('no live agent')
  })
})
