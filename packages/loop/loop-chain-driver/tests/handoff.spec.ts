import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { foldLoop, LOOP_CHANGE_VERSION, LOOP_LEDGER_VERSION, LoopId } from '@deepseek-ai/dsh-loop'
import type { LoopChainDef, LoopChainNodeDef, LoopSnapshot } from '@deepseek-ai/dsh-loop'
import {
  assembleNodeCarry,
  assembleNodePrompt,
  DEFAULT_EVALUATOR_INSTRUCTION,
  DEFAULT_HANDOFF_SCHEMA,
  evaluatorInputBudget,
  handoffSchemaFor,
  validateReport,
} from '../src/handoff.ts'
import type { LoopHandoffView } from '../src/handoff.ts'

/** One default-schema-shaped report with a recognizable summary marker. */
function defaultReport(summary: string): Record<string, unknown> {
  return { status: 'ok', summary, evidence: [], nextSteps: [] }
}

/** Build one session event at a sequence position. */
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq, type, data } as never
}

/** Project folded events into the handoff view the driver reads. */
function handoffView(events: readonly SessionEvent[]): LoopHandoffView {
  const projection = foldLoop(events)
  if (projection.loop === undefined || projection.createdAt === undefined || projection.updatedAt === undefined) {
    throw new Error('fixture must fold a current loop')
  }
  return {
    loop: projection.loop,
    ledger: projection.ledger,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    activation: 'armed',
  }
}

const chain: LoopChainDef = {
  objective: '迭代优化仿真工具',
  exit: 'max-error ≤ 0.05',
  checkpoint: 'none',
  nodes: [
    { role: 'direct', prompt: '规划下一轮试验条件', inputs: [{ session: SessionId('input-session-1') }] },
    { role: 'experiment', prompt: '按给定条件跑试验并汇报' },
    { role: 'configure', prompt: '把结论落进配置', carryOver: ['experiment'] },
  ],
  evaluatorPrompt: '对照退出条件裁决本轮报告。',
}

const round2Snapshot: LoopSnapshot = {
  id: LoopId('loop-main'),
  revision: 2,
  objective: chain.objective,
  phase: 'active',
  maxRounds: 20,
  checkpoint: 'none',
  readScopes: ['W:/sim'],
  writeScopes: ['W:/sim'],
  chain,
  roundsStarted: 1,
}

/** Build one node-started ledger event. */
function started(seq: number, round: number, nodeIndex: number, role: string, attempt: number, childSessionId: string, atRevision: number, loopId = 'loop-main'): SessionEvent {
  return event(seq, 'loop/node-started', {
    kind: 'node-started',
    version: LOOP_LEDGER_VERSION,
    loopId,
    round,
    nodeIndex,
    role,
    attempt,
    childSessionId,
    cwd: 'W:/sim',
    atRevision,
  })
}

/** Build one settlement ledger event. */
function settled(seq: number, round: number, nodeIndex: number, role: string, attempt: number, childSessionId: string, report: unknown, atRevision: number, loopId = 'loop-main'): SessionEvent {
  return event(seq, 'loop/node', {
    kind: 'settlement',
    version: LOOP_LEDGER_VERSION,
    loopId,
    round,
    nodeIndex,
    role,
    attempt,
    childSessionId,
    cwd: 'W:/sim',
    report,
    atRevision,
  })
}

const feedbackText = 'round-1-feedback-marker'
const round2DirectReport = defaultReport('round-2-direct-marker')
const round2ExperimentReport = defaultReport('round-2-experiment-marker')
const round2ConfigureReport = defaultReport(`round-2-configure-marker${'x'.repeat(120)}`)

const createMain = event(1, 'loop/change', {
  kind: 'loop/change',
  version: LOOP_CHANGE_VERSION,
  operation: 'create',
  loop: { ...round2Snapshot, revision: 1, roundsStarted: 0 },
  createdAt: 0,
  updatedAt: 0,
})

const round1Events: readonly SessionEvent[] = [
  started(2, 1, 0, 'direct', 1, 'r1-direct', 1),
  settled(3, 1, 0, 'direct', 1, 'r1-direct', defaultReport('round-1-direct-marker'), 1),
  started(4, 1, 1, 'experiment', 1, 'r1-experiment', 1),
  settled(5, 1, 1, 'experiment', 1, 'r1-experiment', defaultReport('round-1-experiment-marker'), 1),
  started(6, 1, 2, 'configure', 1, 'r1-configure', 1),
  settled(7, 1, 2, 'configure', 1, 'r1-configure', defaultReport('round-1-configure-marker'), 1),
  started(8, 1, 3, 'evaluator', 1, 'r1-evaluator', 1),
  settled(9, 1, 3, 'evaluator', 1, 'r1-evaluator', { decision: 'continue', feedback: feedbackText }, 1),
  event(10, 'loop/change', {
    kind: 'loop/change',
    version: LOOP_CHANGE_VERSION,
    operation: 'advance',
    loop: round2Snapshot,
    createdAt: 0,
    updatedAt: 10,
  }),
]

const round2MidEvents: readonly SessionEvent[] = [
  started(11, 2, 0, 'direct', 1, 'r2-direct', 2),
  settled(12, 2, 0, 'direct', 1, 'r2-direct', round2DirectReport, 2),
  started(13, 2, 1, 'experiment', 1, 'r2-experiment', 2),
  settled(14, 2, 1, 'experiment', 1, 'r2-experiment', round2ExperimentReport, 2),
]

const round2CompleteEvents: readonly SessionEvent[] = [
  ...round2MidEvents,
  started(15, 2, 2, 'configure', 1, 'r2-configure', 2),
  settled(16, 2, 2, 'configure', 1, 'r2-configure', round2ConfigureReport, 2),
]

const viewMidRound = handoffView([createMain, ...round1Events, ...round2MidEvents])
const viewRoundComplete = handoffView([createMain, ...round1Events, ...round2CompleteEvents])

/** A create-only run: round 1 has not started, no scopes are frozen, no evaluator override. */
const bareChain: LoopChainDef = {
  objective: '优化工具',
  checkpoint: 'none',
  nodes: [{ role: 'iterate', prompt: '推进目标并汇报。' }],
}
const viewBare = handoffView([event(1, 'loop/change', {
  kind: 'loop/change',
  version: LOOP_CHANGE_VERSION,
  operation: 'create',
  loop: {
    id: LoopId('loop-bare'),
    revision: 1,
    objective: '优化工具',
    phase: 'active',
    maxRounds: 20,
    checkpoint: 'none',
    readScopes: [],
    writeScopes: [],
    chain: bareChain,
    roundsStarted: 0,
  } satisfies LoopSnapshot,
  createdAt: 0,
  updatedAt: 0,
})])

describe('assembleNodePrompt', () => {
  it('the first node receives the objective, round, role instruction, forced feedback, declared inputs, and scopes — never un-named reports', () => {
    const prompt = assembleNodePrompt(viewMidRound, 2, 0)
    expect(prompt).toContain('Relay loop round 2, node 1 of 4: "direct".')
    expect(prompt).toContain('Objective: 迭代优化仿真工具')
    expect(prompt).toContain('Role instruction (frozen at loop start):\n规划下一轮试验条件')
    expect(prompt).toContain('Carried reports: none.')
    expect(prompt).toContain(`Evaluator feedback from the round 1 verdict:\n${feedbackText}`)
    expect(prompt).toContain('Declared input sessions (continue each by reading it on demand through loop_session_search / loop_session_read):\n- input-session-1')
    expect(prompt).toContain('Your settled report must carry an "inherited" array with one entry per declared input session, each naming what you adopted from that session.')
    expect(prompt).toContain('Prior child sessions (recover any carried detail on demand through loop_session_search / loop_session_read):\n- r1-evaluator')
    expect(prompt).toContain('Read scopes (loop_session_search / loop_session_read serve reads only inside these workspaces and your own):\n- W:/sim')
    expect(prompt).not.toContain('round-1-direct-marker')
    expect(prompt).not.toContain('round-1-experiment-marker')
    expect(prompt).not.toContain('round-2-direct-marker')
  })

  it('a plain middle node receives same-round predecessor reports only — no feedback, no carry-over, no inputs', () => {
    const prompt = assembleNodePrompt(viewMidRound, 2, 1)
    expect(prompt).toContain('node 2 of 4: "experiment"')
    expect(prompt).toContain('round-2-direct-marker')
    expect(prompt).toContain('(child session r2-direct):')
    expect(prompt).toContain('Prior child sessions (recover any carried detail on demand through loop_session_search / loop_session_read):\n- r2-direct')
    expect(prompt).not.toContain('round-2-experiment-marker')
    expect(prompt).not.toContain('round-1-feedback-marker')
    expect(prompt).not.toContain('round-1-direct-marker')
    expect(prompt).not.toContain('round-1-experiment-marker')
    expect(prompt).not.toContain('Declared input sessions')
    expect(prompt).not.toContain('Evaluator feedback')
  })

  it('a carryOver node receives predecessors plus the named prior-round report and the carried feedback', () => {
    const prompt = assembleNodePrompt(viewRoundComplete, 2, 2)
    expect(prompt).toContain('node 3 of 4: "configure"')
    expect(prompt).toContain('round-2-direct-marker')
    expect(prompt).toContain('round-2-experiment-marker')
    expect(prompt).toContain('round-1-experiment-marker')
    expect(prompt).toContain(feedbackText)
    expect(prompt).not.toContain('round-1-direct-marker')
    expect(prompt).not.toContain('round-1-configure-marker')
    expect(prompt).not.toContain('round-2-configure-marker')
    expect(prompt).toContain('- r2-direct')
    expect(prompt).toContain('- r2-experiment')
    expect(prompt).toContain('- r1-experiment')
    expect(prompt).toContain('- r1-evaluator')
  })

  it('the evaluator receives every round report, the opening feedback, and the frozen exit criteria', () => {
    const prompt = assembleNodePrompt(viewRoundComplete, 2, 3)
    expect(prompt).toContain('node 4 of 4: "evaluator".')
    expect(prompt).toContain('Role instruction (frozen at loop start):\n对照退出条件裁决本轮报告。')
    expect(prompt).toContain('Exit criteria (frozen at loop start):\nmax-error ≤ 0.05')
    expect(prompt).toContain('round-2-direct-marker')
    expect(prompt).toContain('round-2-experiment-marker')
    expect(prompt).toContain('round-2-configure-marker')
    expect(prompt).toContain(feedbackText)
    expect(prompt).not.toContain('round-1-experiment-marker')
    expect(prompt).not.toContain('Declared input sessions')
    expect(prompt).toContain('- r2-direct')
    expect(prompt).toContain('- r2-experiment')
    expect(prompt).toContain('- r2-configure')
    expect(prompt).toContain('- r1-evaluator')
  })

  it('the evaluator prompt falls back to the default evaluator instruction when the chain omits the override', () => {
    const prompt = assembleNodePrompt(viewBare, 1, 1)
    expect(prompt).toContain(`Role instruction (frozen at loop start):\n${DEFAULT_EVALUATOR_INSTRUCTION}`)
    expect(prompt).not.toContain('Exit criteria')
  })

  it('a round-one node with nothing settled renders the empty lean sections', () => {
    const prompt = assembleNodePrompt(viewBare, 1, 0)
    expect(prompt).toContain('Relay loop round 1, node 1 of 2: "iterate".')
    expect(prompt).toContain('Carried reports: none.')
    expect(prompt).not.toContain('Evaluator feedback')
    expect(prompt).not.toContain('Prior child sessions')
    expect(prompt).toContain('Read scopes: none frozen beyond your own workspace.')
  })

  it('carryOver reads exactly the prior round: an older report never reaches a later round', () => {
    const prompt = assembleNodePrompt(viewRoundComplete, 3, 2)
    expect(prompt).toContain('Relay loop round 3, node 3 of 4: "configure".')
    expect(prompt).toContain('round-2-experiment-marker')
    expect(prompt).not.toContain('round-1-experiment-marker')
    expect(prompt).not.toContain('round-2-direct-marker')
    expect(prompt).not.toContain('round-1-feedback-marker')
  })

  it('the latest settlement attempt wins regardless of ledger order, and a blocked verdict carries no feedback', () => {
    const blockedChain: LoopChainDef = {
      objective: 'o',
      checkpoint: 'none',
      nodes: [
        { role: 'first', prompt: 'p1' },
        { role: 'second', prompt: 'p2', carryOver: ['first'] },
      ],
    }
    const events: readonly SessionEvent[] = [
      event(1, 'loop/change', {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'create',
        loop: {
          id: LoopId('loop-blocked'),
          revision: 1,
          objective: 'o',
          phase: 'active',
          maxRounds: 20,
          checkpoint: 'none',
          readScopes: ['W:/w'],
          writeScopes: ['W:/w'],
          chain: blockedChain,
          roundsStarted: 0,
        } satisfies LoopSnapshot,
        createdAt: 0,
        updatedAt: 0,
      }),
      // attempt 2 settles before attempt 1 in ledger order: the collection must still pick the latest attempt.
      started(2, 1, 0, 'first', 2, 'b-first-2', 1, 'loop-blocked'),
      settled(3, 1, 0, 'first', 2, 'b-first-2', defaultReport('attempt-two-marker'), 1, 'loop-blocked'),
      started(4, 1, 0, 'first', 1, 'b-first', 1, 'loop-blocked'),
      settled(5, 1, 0, 'first', 1, 'b-first', defaultReport('attempt-one-marker'), 1, 'loop-blocked'),
      started(6, 1, 1, 'second', 1, 'b-second', 1, 'loop-blocked'),
      settled(7, 1, 1, 'second', 1, 'b-second', defaultReport('second-marker'), 1, 'loop-blocked'),
      started(8, 1, 2, 'evaluator', 1, 'b-evaluator', 1, 'loop-blocked'),
      settled(9, 1, 2, 'evaluator', 1, 'b-evaluator', { decision: 'blocked', reason: '不收敛' }, 1, 'loop-blocked'),
    ]
    const view = handoffView(events)
    const prompt = assembleNodePrompt(view, 2, 1)
    expect(prompt).toContain('attempt-two-marker')
    expect(prompt).not.toContain('attempt-one-marker')
    expect(prompt).not.toContain('Evaluator feedback')
    expect(assembleNodePrompt(view, 2, 0)).not.toContain('Evaluator feedback')
  })

  it('a continue verdict without feedback carries nothing, and carryOver reads only settled rounds', () => {
    const leanChain: LoopChainDef = {
      objective: 'o',
      checkpoint: 'none',
      nodes: [{ role: 'worker', prompt: 'p', carryOver: ['worker'] }],
    }
    const leanSnapshot: LoopSnapshot = {
      id: LoopId('loop-lean'),
      revision: 2,
      objective: 'o',
      phase: 'active',
      maxRounds: 20,
      checkpoint: 'none',
      readScopes: ['W:/w'],
      writeScopes: ['W:/w'],
      chain: leanChain,
      roundsStarted: 1,
    }
    const events: readonly SessionEvent[] = [
      event(1, 'loop/change', {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'create',
        loop: { ...leanSnapshot, revision: 1, roundsStarted: 0 },
        createdAt: 0,
        updatedAt: 0,
      }),
      started(2, 1, 0, 'worker', 1, 'f-worker', 1, 'loop-lean'),
      settled(3, 1, 0, 'worker', 1, 'f-worker', defaultReport('f-round-1-marker'), 1, 'loop-lean'),
      started(4, 1, 1, 'evaluator', 1, 'f-evaluator', 1, 'loop-lean'),
      settled(5, 1, 1, 'evaluator', 1, 'f-evaluator', { decision: 'continue' }, 1, 'loop-lean'),
      event(6, 'loop/change', {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'advance',
        loop: leanSnapshot,
        createdAt: 0,
        updatedAt: 6,
      }),
      started(7, 2, 0, 'worker', 1, 'f-worker-2', 2, 'loop-lean'),
      settled(8, 2, 0, 'worker', 1, 'f-worker-2', defaultReport(`f-round-2-marker${'y'.repeat(140)}`), 2, 'loop-lean'),
    ]
    const view = handoffView(events)
    const round1 = assembleNodePrompt(view, 1, 0)
    expect(round1).toContain('Carried reports: none.')
    expect(round1).not.toContain('Prior child sessions')
    const round2 = assembleNodePrompt(view, 2, 0)
    expect(round2).toContain('f-round-1-marker')
    expect(round2).not.toContain('Evaluator feedback')
    const budget = evaluatorInputBudget(view, 2, 100)
    expect(budget.overflow?.role).toBe('worker')
    expect(budget.overflow?.reportRound).toBe(2)
  })

  it('a report that is not a JSON value carries only its schema violations', () => {
    const plainNode: LoopChainNodeDef = { role: 'worker', prompt: 'p' }
    const violations = validateReport(plainNode, () => 'not json', 1000)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some(violation => violation.includes('cap of'))).toBe(false)
  })

  it('rejects rounds and node indexes outside the frozen chain', () => {
    expect(() => assembleNodePrompt(viewMidRound, 2, 4)).toThrow(/outside the frozen chain's declared node set/)
    expect(() => assembleNodePrompt(viewMidRound, 2, -1)).toThrow(/outside the frozen chain's declared node set/)
    expect(() => assembleNodePrompt(viewMidRound, 0, 0)).toThrow(/round/)
    expect(() => assembleNodePrompt(viewMidRound, 2.5, 0)).toThrow(/round/)
  })

  it('a settlement whose report is not a lossless JSON value fails the carry validation', () => {
    const events: readonly SessionEvent[] = [
      event(1, 'loop/change', {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'create',
        loop: {
          id: LoopId('loop-bad'),
          revision: 1,
          objective: 'o',
          phase: 'active',
          maxRounds: 20,
          checkpoint: 'none',
          readScopes: ['W:/w'],
          writeScopes: ['W:/w'],
          chain: { objective: 'o', checkpoint: 'none', nodes: [{ role: 'a', prompt: 'p' }, { role: 'b', prompt: 'q' }] },
          roundsStarted: 0,
        } satisfies LoopSnapshot,
        createdAt: 0,
        updatedAt: 0,
      }),
      started(2, 1, 0, 'a', 1, 'bad-a', 1, 'loop-bad'),
      settled(3, 1, 0, 'a', 1, 'bad-a', () => 'not json', 1, 'loop-bad'),
    ]
    expect(() => assembleNodePrompt(handoffView(events), 1, 1)).toThrow(/reports\.0\.report/)
  })
})

describe('assembleNodeCarry', () => {
  it('the typed carry mirrors the visibility rule: reports, feedback, inputs, prior sessions, scopes', () => {
    const carry = assembleNodeCarry(viewMidRound, 2, 2)
    expect(carry.objective).toBe('迭代优化仿真工具')
    expect(carry.round).toBe(2)
    expect(carry.nodeIndex).toBe(2)
    expect(carry.nodeCount).toBe(4)
    expect(carry.role).toBe('configure')
    expect(carry.roleInstruction).toBe('把结论落进配置')
    expect(carry.exit).toBeUndefined()
    expect(carry.reports.map(report => `${report.round}:${report.role}:${report.childSessionId}`)).toEqual([
      '2:direct:r2-direct',
      '2:experiment:r2-experiment',
      '1:experiment:r1-experiment',
    ])
    expect(carry.reports.map(report => report.report)).toEqual([round2DirectReport, round2ExperimentReport, defaultReport('round-1-experiment-marker')])
    expect(carry.feedback).toBe(feedbackText)
    expect(carry.inputSessionIds).toEqual([])
    expect(carry.priorChildSessionIds).toEqual(['r2-direct', 'r2-experiment', 'r1-experiment', 'r1-evaluator'])
    expect(carry.readScopes).toEqual(['W:/sim'])
  })

  it('the first node carry names its declared inputs and the feedback source session only', () => {
    const carry = assembleNodeCarry(viewMidRound, 2, 0)
    expect(carry.reports).toEqual([])
    expect(carry.feedback).toBe(feedbackText)
    expect(carry.inputSessionIds).toEqual(['input-session-1'])
    expect(carry.priorChildSessionIds).toEqual(['r1-evaluator'])
  })

  it('the evaluator carry carries the exit criteria and never declared inputs', () => {
    const carry = assembleNodeCarry(viewRoundComplete, 2, 3)
    expect(carry.role).toBe('evaluator')
    expect(carry.exit).toBe('max-error ≤ 0.05')
    expect(carry.inputSessionIds).toEqual([])
    expect(carry.reports.map(report => report.role)).toEqual(['direct', 'experiment', 'configure'])
  })
})

describe('validateReport', () => {
  const plainNode: LoopChainNodeDef = { role: 'w', prompt: 'p' }
  const inputsNode: LoopChainNodeDef = {
    role: 'w',
    prompt: 'p',
    inputs: [{ session: SessionId('s-1') }, { session: SessionId('s-2') }],
  }

  it('accepts a default-schema report', () => {
    expect(validateReport(plainNode, { status: 'ok', summary: 's', evidence: ['e'], nextSteps: ['n'] }, 16384)).toEqual([])
  })

  it('rejects reports that miss required fields, carry wrong types, or are not objects', () => {
    const violations = validateReport(plainNode, { status: 'ok', evidence: [], nextSteps: [] }, 16384)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join('\n')).toMatch(/summary/)
    expect(validateReport(plainNode, 'nope', 16384).length).toBeGreaterThan(0)
  })

  it('an inputs-free node has no inherited requirement — an empty or absent inherited is legal', () => {
    expect(validateReport(plainNode, { status: 'ok', summary: 's', evidence: [], nextSteps: [], inherited: [] }, 16384)).toEqual([])
  })

  it('a node with declared inputs must report one inherited entry per input', () => {
    const report = { status: 'ok', summary: 's', evidence: [], nextSteps: [] }
    expect(validateReport(inputsNode, { ...report, inherited: ['a', 'b'] }, 16384)).toEqual([])
    expect(validateReport(inputsNode, report, 16384).join('\n')).toMatch(/inherited/)
    const wrongCount = validateReport(inputsNode, { ...report, inherited: ['only-one'] }, 16384)
    expect(wrongCount.join('\n')).toMatch(/exactly 2 entries/)
    expect(wrongCount.join('\n')).toMatch(/found 1/)
  })

  it('counts maxHandoffChars in UTF-16 code units on the serialized report — surrogate pairs count 2', () => {
    const noteNode: LoopChainNodeDef = {
      role: 'w',
      prompt: 'p',
      output: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
    }
    expect(validateReport(noteNode, { note: '😀' }, 13)).toEqual([])
    const violations = validateReport(noteNode, { note: '😀' }, 12)
    expect(violations.join('\n')).toMatch(/13 characters \(UTF-16 code units\)/)
    expect(violations.join('\n')).toMatch(/cap of 12/)
  })

  it('an out-of-subset output override fails the schema assertion loudly', () => {
    const badNode: LoopChainNodeDef = {
      role: 'w',
      prompt: 'p',
      output: { type: 'object', properties: { x: { type: 'string' } }, bogus: 1 } as never,
    }
    expect(() => validateReport(badNode, {}, 100)).toThrow(/bogus/)
  })
})

describe('handoffSchemaFor', () => {
  const plainNode: LoopChainNodeDef = { role: 'w', prompt: 'p' }
  const inputsNode: LoopChainNodeDef = { role: 'w', prompt: 'p', inputs: [{ session: SessionId('s-1') }] }

  it('returns the default schema unchanged for a node without declared inputs', () => {
    expect(handoffSchemaFor(plainNode)).toBe(DEFAULT_HANDOFF_SCHEMA)
  })

  it('injects the driver-owned required inherited property when inputs are declared', () => {
    const injected = handoffSchemaFor(inputsNode)
    expect(injected.properties?.['inherited']).toEqual({ type: 'array', items: { type: 'string' } })
    expect(injected.required).toContain('inherited')
    expect(validateReport(inputsNode, { status: 'ok', summary: 's', evidence: [], nextSteps: [], inherited: ['one'] }, 16384)).toEqual([])
  })

  it('the injected inherited property replaces any author-declared one in an override', () => {
    const overrideNode: LoopChainNodeDef = {
      role: 'w',
      prompt: 'p',
      output: {
        type: 'object',
        properties: { note: { type: 'string' }, inherited: { type: 'array', items: { type: 'object' } } },
        required: ['note'],
        additionalProperties: false,
      },
    }
    expect(validateReport(overrideNode, { note: 'n', inherited: [{ what: 'x' }] }, 100)).toEqual([])
    const violations = validateReport({ ...overrideNode, inputs: [{ session: SessionId('s-1') }] }, { note: 'n', inherited: [{ what: 'x' }] }, 100)
    expect(violations.join('\n')).toMatch(/inherited/)
    expect(validateReport({ ...overrideNode, inputs: [{ session: SessionId('s-1') }] }, { note: 'n', inherited: ['adopted'] }, 100)).toEqual([])
  })

  it('injects inherited into required when the override declares no required list', () => {
    const noRequiredNode: LoopChainNodeDef = {
      role: 'w',
      prompt: 'p',
      output: { type: 'object', properties: { note: { type: 'string' } } },
      inputs: [{ session: SessionId('s-1') }],
    }
    expect(validateReport(noRequiredNode, { note: 'n', inherited: ['one'] }, 100)).toEqual([])
    expect(validateReport(noRequiredNode, { note: 'n' }, 100).join('\n')).toMatch(/inherited/)
  })
})

describe('evaluatorInputBudget', () => {
  it('sums the round reports plus the opening feedback in UTF-16 code units', () => {
    const expectedReports = [round2DirectReport, round2ExperimentReport, round2ConfigureReport]
      .map(report => JSON.stringify(report).length)
      .reduce((sum, chars) => sum + chars, 0)
    const expectedTotal = expectedReports + feedbackText.length
    const budget = evaluatorInputBudget(viewRoundComplete, 2, 65536)
    expect(budget.totalChars).toBe(expectedTotal)
    expect(budget.overflow).toBeUndefined()
    expect(evaluatorInputBudget(viewRoundComplete, 2, expectedTotal).overflow).toBeUndefined()
  })

  it('a round with nothing settled and no verdict measures zero', () => {
    const budget = evaluatorInputBudget(viewRoundComplete, 3, 1000)
    expect(budget.totalChars).toBe(0)
    expect(budget.overflow).toBeUndefined()
  })

  it('an over-cap aggregate names the round, the offending report, and the exceeded characters', () => {
    const expectedTotal = [round2DirectReport, round2ExperimentReport, round2ConfigureReport]
      .map(report => JSON.stringify(report).length)
      .reduce((sum, chars) => sum + chars, 0) + feedbackText.length
    const budget = evaluatorInputBudget(viewRoundComplete, 2, expectedTotal - 10)
    expect(budget.totalChars).toBe(expectedTotal)
    expect(budget.overflow?.round).toBe(2)
    expect(budget.overflow?.reportRound).toBe(2)
    expect(budget.overflow?.nodeIndex).toBe(2)
    expect(budget.overflow?.role).toBe('configure')
    expect(budget.overflow?.reportChars).toBe(JSON.stringify(round2ConfigureReport).length)
    expect(budget.overflow?.exceededChars).toBe(10)
    expect(budget.overflow?.reason.code).toBe('report-budget')
    expect(budget.overflow?.reason.message).toContain('round 2')
    expect(budget.overflow?.reason.message).toContain('"configure"')
    expect(budget.overflow?.reason.message).toContain('by 10')
  })

  it('the opening feedback itself can be the offending report', () => {
    const bigFeedback = '全局约束必须在后续轮次持续遵守。'.repeat(20)
    const heavyChain: LoopChainDef = { objective: 'o', checkpoint: 'none', nodes: [{ role: 'worker', prompt: 'p' }] }
    const heavySnapshot: LoopSnapshot = {
      id: LoopId('loop-heavy'),
      revision: 2,
      objective: 'o',
      phase: 'active',
      maxRounds: 20,
      checkpoint: 'none',
      readScopes: ['W:/w'],
      writeScopes: ['W:/w'],
      chain: heavyChain,
      roundsStarted: 1,
    }
    const events: readonly SessionEvent[] = [
      event(1, 'loop/change', {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'create',
        loop: { ...heavySnapshot, revision: 1, roundsStarted: 0 },
        createdAt: 0,
        updatedAt: 0,
      }),
      event(2, 'loop/node-started', { kind: 'node-started', version: LOOP_LEDGER_VERSION, loopId: 'loop-heavy', round: 1, nodeIndex: 0, role: 'worker', attempt: 1, childSessionId: 'h-worker', cwd: 'W:/w', atRevision: 1 }),
      event(3, 'loop/node', { kind: 'settlement', version: LOOP_LEDGER_VERSION, loopId: 'loop-heavy', round: 1, nodeIndex: 0, role: 'worker', attempt: 1, childSessionId: 'h-worker', cwd: 'W:/w', report: defaultReport('heavy-round-1-marker'), atRevision: 1 }),
      event(4, 'loop/node-started', { kind: 'node-started', version: LOOP_LEDGER_VERSION, loopId: 'loop-heavy', round: 1, nodeIndex: 1, role: 'evaluator', attempt: 1, childSessionId: 'h-evaluator', cwd: 'W:/w', atRevision: 1 }),
      event(5, 'loop/node', { kind: 'settlement', version: LOOP_LEDGER_VERSION, loopId: 'loop-heavy', round: 1, nodeIndex: 1, role: 'evaluator', attempt: 1, childSessionId: 'h-evaluator', cwd: 'W:/w', report: { decision: 'continue', feedback: bigFeedback }, atRevision: 1 }),
      event(6, 'loop/change', {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'advance',
        loop: heavySnapshot,
        createdAt: 0,
        updatedAt: 6,
      }),
      event(7, 'loop/node-started', { kind: 'node-started', version: LOOP_LEDGER_VERSION, loopId: 'loop-heavy', round: 2, nodeIndex: 0, role: 'worker', attempt: 1, childSessionId: 'h-worker-2', cwd: 'W:/w', atRevision: 2 }),
      event(8, 'loop/node', { kind: 'settlement', version: LOOP_LEDGER_VERSION, loopId: 'loop-heavy', round: 2, nodeIndex: 0, role: 'worker', attempt: 1, childSessionId: 'h-worker-2', cwd: 'W:/w', report: defaultReport('heavy-round-2-marker'), atRevision: 2 }),
    ]
    const view = handoffView(events)
    const budget = evaluatorInputBudget(view, 2, 100)
    expect(budget.totalChars).toBe(JSON.stringify(defaultReport('heavy-round-2-marker')).length + bigFeedback.length)
    expect(budget.overflow?.nodeIndex).toBe(1)
    expect(budget.overflow?.role).toBe('evaluator')
    expect(budget.overflow?.reportRound).toBe(1)
    expect(budget.overflow?.reportChars).toBe(bigFeedback.length)
    expect(budget.overflow?.reason.message).toContain('"evaluator"')
  })
})
