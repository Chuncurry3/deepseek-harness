/**
 * Host service (`ctx.loops`) for the event-sourced cross-session relay
 * loop: compare-and-set lifecycle mutations and non-CAS node-ledger appends,
 * each committed to the owning session log and flushed through the session
 * store's durability barrier before returning. @module @deepseek-ai/dsh-loop
 */

import { randomUUID } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { applyLoopEvent, decodeLoopChange, decodeLoopLedger, loopChangeRef, loopLedgerEntry } from './fold.ts'
import type { LoopFoldState } from './fold.ts'
import { normalizeScopePath } from './paths.ts'
import {
  LOOP_CHANGE_VERSION,
  LOOP_LEDGER_VERSION,
  LoopError,
  LoopId,
} from './runtime.ts'
import type {
  LoopAttemptMeta,
  LoopChangeMeta,
  LoopClearChangeMeta,
  LoopLedgerEventKey,
  LoopLedgerMeta,
  LoopNodeSettledMeta,
  LoopNodeStartedMeta,
  LoopOperation,
  LoopSnapshotChangeMeta,
} from './domain.ts'
import type {
  LoopActivation,
  LoopBlockReason,
  LoopChainDef,
  LoopLedgerEntry,
  LoopPhase,
  LoopProjection,
  LoopProjectionState,
  LoopRef,
  LoopSnapshot,
  LoopView,
} from './types.ts'
import type { LoopId as LoopIdType } from './types.ts'

export const name = 'loop'

// The pure payload outlets (./types.ts, ONE home of the `loop` projection-key
// declaration; ./domain.ts, the host-side vocabulary) re-exported onto the
// package root keep those module edges in the emitted index.d.ts, so
// aggregate programs consuming the declarations still receive the
// SessionProjectionStateMap, SessionProjectionMap, SessionEventMap, and
// Events merges.
export type * from './types.ts'
export type * from './domain.ts'
export { LOOP_CHANGE_VERSION, LOOP_LEDGER_VERSION, LoopError, LoopId } from './runtime.ts'
export { decodeLoopChange, decodeLoopLedger, foldLoop, loopChangeRef } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loop lifecycle and node-ledger service owned by the loop plugin. */
    loops: LoopService
  }
}

/**
 * Schema slot of the loop projection unit's persisted state, satisfied below
 * by a hand-rolled `parse` duck-type: the loop package keeps zod out of its
 * runtime (the B3 decoders are hand-rolled), so the persisted cache row is
 * validated through the same strict decoders rather than a zod schema.
 */
type LoopStateSchema = ProjectionDefinition<'loop', LoopProjectionState>['stateSchema']

/** View-schema slot of the loop projection unit's client wire. */
type LoopViewSchema = NonNullable<ProjectionDefinition<'loop', LoopProjectionState>['wire']>['viewSchema']

/** Whether a value is a JSON record rather than an array or primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one JSON record. */
function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${subject} must be a JSON record`)
  return value
}

/** Require exactly one field set: every required field present, no others. */
function requireFields(
  record: Record<string, unknown>,
  subject: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(record)
  for (const field of required) {
    if (!actual.includes(field)) throw new Error(`${subject} must carry field ${field}`)
  }
  for (const key of actual) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${subject} cannot carry field ${key}`)
    }
  }
}

/** Require one non-empty string. */
function requireNonEmptyString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${subject} must be a non-empty string`)
  }
  return value
}

/** Require one array of non-empty strings. */
function requireStringArray(value: unknown, subject: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${subject} must be an array`)
  return value.map(entry => requireNonEmptyString(entry, `${subject} entry`))
}

/** Require one non-negative safe integer. */
function requireNonNegativeInteger(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${subject} must be a non-negative safe integer`)
  }
  return value
}

/** Require one positive safe integer. */
function requirePositiveInteger(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${subject} must be a positive safe integer`)
  }
  return value
}

/** Validate one persisted snapshot through the strict fold decoder. */
function parseLoopSnapshot(value: unknown): LoopSnapshot {
  const change = decodeLoopChange({
    kind: 'loop/change',
    version: LOOP_CHANGE_VERSION,
    operation: 'create',
    loop: value,
    createdAt: 0,
    updatedAt: 0,
  }) as LoopSnapshotChangeMeta | undefined
  /* v8 ignore next 3 -- the carrier declares kind "loop/change", which the decoder never declines. */
  if (change === undefined) {
    throw new Error('loop projection snapshot failed fold decoding')
  }
  return change.loop
}

/** Validate one persisted compare-and-set ref. */
function parseLoopRef(value: unknown): LoopRef {
  const record = requireRecord(value, 'loop projection lastRef')
  requireFields(record, 'loop projection lastRef', ['id', 'revision'])
  return {
    id: LoopId(requireNonEmptyString(record['id'], 'loop projection lastRef id')),
    revision: requirePositiveInteger(record['revision'], 'loop projection lastRef revision'),
  }
}

/** Session event key that carries each ledger record kind. */
const LEDGER_EVENT_KEYS = {
  'node-started': 'loop/node-started',
  attempt: 'loop/attempt',
  settlement: 'loop/node',
} as const satisfies Record<LoopLedgerMeta['kind'], LoopLedgerEventKey>

/** Validate one persisted ledger entry through the strict fold decoder and project it onto the durable entry shape. */
function validateLedgerEntry(loopId: LoopIdType, value: unknown): LoopLedgerEntry {
  const record = requireRecord(value, 'loop projection ledger entry')
  const kind = requireNonEmptyString(record['kind'], 'loop projection ledger entry kind')
  if (!Object.hasOwn(LEDGER_EVENT_KEYS, kind)) throw new Error('loop projection ledger entry has an unknown kind')
  return loopLedgerEntry(decodeLoopLedger(LEDGER_EVENT_KEYS[kind as LoopLedgerMeta['kind']], { ...record, version: LOOP_LEDGER_VERSION, loopId }))
}

/** Validate the append-only ledger array of one persisted projection and return its decoded entries. */
function parseLedger(value: unknown, loopId: LoopIdType | undefined): readonly LoopLedgerEntry[] {
  if (!Array.isArray(value)) throw new Error('loop projection ledger must be an array')
  if (loopId === undefined) {
    if (value.length > 0) throw new Error('loop projection ledger entry requires a current loop')
    return []
  }
  const entries: LoopLedgerEntry[] = []
  const keys = new Set<string>()
  for (const entry of value) {
    const decoded = validateLedgerEntry(loopId, entry)
    entries.push(decoded)
    const key = `${loopId}:${String(decoded.round)}:${String(decoded.nodeIndex)}:${String(decoded.attempt)}`
    if (keys.has(key)) throw new Error(`loop projection ledger has duplicate key ${key}`)
    keys.add(key)
  }
  return entries
}

/** Validate one persisted current-loop projection (the client wire value). */
function parseLoopProjection(value: unknown): LoopProjection {
  const projection = requireRecord(value, 'loop projection')
  const hasLoop = Object.hasOwn(projection, 'loop')
  const hasCreatedAt = Object.hasOwn(projection, 'createdAt')
  const hasUpdatedAt = Object.hasOwn(projection, 'updatedAt')
  if (hasLoop !== hasCreatedAt || hasLoop !== hasUpdatedAt) {
    throw new Error('loop projection must carry loop, createdAt, and updatedAt together')
  }
  requireFields(projection, 'loop projection', hasLoop ? ['ledger', 'loop', 'createdAt', 'updatedAt'] : ['ledger'], ['lastRef'])
  const lastRef = Object.hasOwn(projection, 'lastRef') ? parseLoopRef(projection['lastRef']) : undefined
  if (hasLoop) {
    const loop = parseLoopSnapshot(projection['loop'])
    const createdAt = requireNonNegativeInteger(projection['createdAt'], 'loop projection createdAt')
    const updatedAt = requireNonNegativeInteger(projection['updatedAt'], 'loop projection updatedAt')
    if (updatedAt < createdAt) throw new Error('loop projection updatedAt cannot precede createdAt')
    return lastRef === undefined
      ? { loop, ledger: parseLedger(projection['ledger'], loop.id), createdAt, updatedAt }
      : { loop, ledger: parseLedger(projection['ledger'], loop.id), createdAt, updatedAt, lastRef }
  }
  return { ledger: parseLedger(projection['ledger'], undefined) }
}

/** Validate one persisted projection-state row and return it unchanged. */
function parseLoopProjectionState(value: unknown): LoopProjectionState {
  const state = requireRecord(value, 'loop projection state')
  requireFields(state, 'loop projection state', ['current', 'failure', 'inheritedEventCount', 'seenLoopIds'])
  const failure = state['failure'] === null ? null : requireNonEmptyString(state['failure'], 'loop projection state failure')
  const seenLoopIds = requireStringArray(state['seenLoopIds'], 'loop projection state seenLoopIds')
  if (new Set(seenLoopIds).size !== seenLoopIds.length) {
    throw new Error('loop projection state seenLoopIds must be unique')
  }
  const current = state['current'] === null ? null : parseLoopProjection(state['current'])
  if (current !== null && current.loop !== undefined && !seenLoopIds.includes(current.loop.id)) {
    throw new Error('loop projection state current loop id must be retained among seenLoopIds')
  }
  return {
    current,
    seenLoopIds: seenLoopIds.map(LoopId),
    failure,
    inheritedEventCount: SessionLogOffset(
      requireNonNegativeInteger(state['inheritedEventCount'], 'loop projection state inheritedEventCount'),
    ),
  }
}

/** Hand-rolled state validation duck-typed to the registry's schema slot. */
const loopProjectionStateSchema = {
  parse: (value: unknown): LoopProjectionState => parseLoopProjectionState(value),
} as LoopStateSchema

/** Hand-rolled wire validation sharing the projection's parser. */
const loopProjectionSchema = {
  parse: (value: unknown): LoopProjection | null => (value === null ? null : parseLoopProjection(value)),
} as LoopViewSchema

/** Ledger map key — the fold's `{loopId, round, nodeIndex, attempt}` formula. */
function ledgerKey(loopId: LoopIdType, entry: { round: number; nodeIndex: number; attempt: number }): string {
  return `${loopId}:${entry.round}:${entry.nodeIndex}:${entry.attempt}`
}

/** Build strict fold state from one projection state. */
function loopFoldState(state: LoopProjectionState): LoopFoldState {
  const current = state.current
  const loop = current?.loop
  const ledger = new Map<string, LoopLedgerEntry>()
  if (current !== null && loop !== undefined) {
    for (const entry of current.ledger) ledger.set(ledgerKey(loop.id, entry), entry)
  }
  return {
    loop,
    ledger,
    createdAt: current?.createdAt,
    updatedAt: current?.updatedAt,
    lastRef: current?.lastRef === undefined ? undefined : { ...current.lastRef },
    currentLoopId: loop?.id,
    seenLoopIds: new Set(state.seenLoopIds),
  }
}

/** Convert strict fold state into projection state at one fork boundary. */
function loopProjectionState(folded: LoopFoldState, inheritedEventCount: SessionLogOffset): LoopProjectionState {
  let current: LoopProjection | null = null
  if (folded.loop !== undefined) {
    const { createdAt, updatedAt } = folded
    /* v8 ignore next 3 -- applyLoopChange always writes both timestamps with a snapshot. */
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current loop fold lacks timestamps')
    }
    current = {
      loop: folded.loop,
      ledger: [...folded.ledger.values()],
      createdAt,
      updatedAt,
      ...folded.lastRef === undefined ? {} : { lastRef: { ...folded.lastRef } },
    }
  }
  return { current, seenLoopIds: [...folded.seenLoopIds], failure: null, inheritedEventCount }
}

/**
 * Fold durable loop events through the strict replay rules without throwing
 * from the projection registry's event drive. Loop events before the fork
 * seed boundary belong to the parent session's run and are skipped. The
 * first invalid owned event is retained in `failure`; host loop access
 * rejects that state while the client view stays at the last valid loop.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is unrelated).
 */
export function applyLoopProjection(state: LoopProjectionState, event: SessionEvent): LoopProjectionState {
  if (state.failure !== null) return state
  if (event.seq < state.inheritedEventCount) return state
  if (event.type !== 'loop/change'
    && event.type !== 'loop/node-started'
    && event.type !== 'loop/attempt'
    && event.type !== 'loop/node') return state
  const folded = loopFoldState(state)
  try {
    applyLoopEvent(folded, event)
    return loopProjectionState(folded, state.inheritedEventCount)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict loop fold throws Error instances. */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `loop replay failed at session event ${event.seq}: ${message}` }
  }
}

/**
 * Loop projection unit: last-wins fold of the durable loop record. A fork
 * folds loop events only from its seed boundary, so it inherits no run.
 */
export const loopProjectionDefinition = {
  key: 'loop',
  stateSchema: loopProjectionStateSchema,
  init: (_header, inheritedEventCount): LoopProjectionState => ({
    current: null,
    seenLoopIds: [],
    failure: null,
    inheritedEventCount,
  }),
  apply: applyLoopProjection,
  wire: { viewSchema: loopProjectionSchema, view: (state: LoopProjectionState): LoopProjection | null => state.current },
  stateVersion: 3,
} satisfies ProjectionDefinition<'loop', LoopProjectionState>
/** Deployment defaults for loop runs and node handoffs. */
export interface Config {
  /** Round cap used when a start request omits its own. */
  defaultMaxRounds?: number
  /** Retry budget per node within one resume epoch. */
  maxNodeRetries?: number
  /** Character cap for one handed-over report. */
  maxHandoffChars?: number
  /** Character cap for the evaluator's aggregate round input. */
  maxEvaluatorInputChars?: number
}

/** Resolved deployment defaults shared with the loop driver family. */
export interface ResolvedConfig {
  /** Validated positive safe-integer default round cap. */
  defaultMaxRounds: number
  /** Validated positive safe-integer per-node retry budget. */
  maxNodeRetries: number
  /** Validated positive safe-integer per-report character cap. */
  maxHandoffChars: number
  /** Validated positive safe-integer evaluator input character cap. */
  maxEvaluatorInputChars: number
}

/** Validate one positive safe-integer config value. */
function resolvePositiveConfig(value: number, field: keyof ResolvedConfig): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`loop config ${field} must be a positive safe integer`)
  }
  return value
}

/** Materialize and validate the deployment defaults. */
function resolveLoopConfig(config: Config): ResolvedConfig {
  return {
    defaultMaxRounds: resolvePositiveConfig(config.defaultMaxRounds ?? 20, 'defaultMaxRounds'),
    maxNodeRetries: resolvePositiveConfig(config.maxNodeRetries ?? 2, 'maxNodeRetries'),
    maxHandoffChars: resolvePositiveConfig(config.maxHandoffChars ?? 16384, 'maxHandoffChars'),
    maxEvaluatorInputChars: resolvePositiveConfig(config.maxEvaluatorInputChars ?? 65536, 'maxEvaluatorInputChars'),
  }
}

/** Process-local activation state crossing the synchronous append boundary. */
interface LoopRuntimeState {
  activation: LoopActivation
  pendingActivation: {
    readonly offset: SessionLogOffset
    readonly activation: LoopActivation
  } | undefined
}

/** Validated start input with every deployment default materialized. */
interface ResolvedStartLoop {
  readonly objective: string
  readonly chain: LoopChainDef
  readonly maxRounds: number
  readonly checkpoint: 'none' | 'node'
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
}

/**
 * Caller input for {@link LoopService.start}. Scope and cwd values are
 * compared as exact strings (the caller passes realpath-normalized values).
 */
export interface StartLoopRequest {
  readonly objective: string
  readonly chain: LoopChainDef
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly maxRounds?: number
  readonly checkpoint?: 'none' | 'node'
}

/** Validate a caller-visible positive safe-integer round cap. */
function resolveMaxRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LoopError('start maxRounds must be a positive safe integer', 'LOOP_INVALID_CHAIN')
  }
  return value
}

/** Validate and normalize a start objective at the domain boundary. */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LoopError('start objective must be a non-empty string', 'LOOP_INVALID_CHAIN')
  }
  return value.trim()
}

/** Materialize defaults and validate one start request. */
function resolveStartLoop(request: StartLoopRequest, defaultMaxRounds: number): ResolvedStartLoop {
  return {
    objective: resolveObjective(request.objective),
    chain: request.chain,
    maxRounds: resolveMaxRounds(request.maxRounds ?? defaultMaxRounds),
    checkpoint: request.checkpoint ?? request.chain.checkpoint,
    readScopes: [...request.readScopes],
    writeScopes: [...request.writeScopes],
  }
}

/** Reject chain node workspaces outside the run's write scopes. */
function assertChainWithinWriteScopes(spec: ResolvedStartLoop): void {
  for (const node of spec.chain.nodes) {
    if (node.cwd === undefined || spec.writeScopes.includes(node.cwd)) continue
    throw new LoopError(
      `chain node "${node.role}" cwd ${JSON.stringify(node.cwd)} falls outside the run's write scopes`,
      'LOOP_SCOPE_VIOLATION',
    )
  }
}

/**
 * Reject declared input sessions whose live workspace falls outside the run's
 * read scopes. A session the store cannot resolve — or whose header carries
 * no workspace — stays legal at start: the loop-scoped query tools own the
 * executor-level refusal for every later pull. A workspace that no longer
 * resolves fails loud through `normalizeScopePath`'s ENOENT.
 */
function assertInputSessionsWithinReadScopes(spec: ResolvedStartLoop, ctx: Context): void {
  for (const node of spec.chain.nodes) {
    if (node.inputs === undefined) continue
    for (const input of node.inputs) {
      const cwd = ctx.sessions.get(input.session)?.header.cwd
      if (cwd === undefined) continue
      if (spec.readScopes.includes(normalizeScopePath(cwd))) continue
      throw new LoopError(
        `chain node "${node.role}" input session "${input.session}" (cwd ${JSON.stringify(cwd)}) falls outside the run's read scopes`,
        'LOOP_SCOPE_VIOLATION',
      )
    }
  }
}

/** A current-loop projection with its snapshot and timestamps guaranteed present. */
interface CurrentLoop extends LoopProjection {
  readonly loop: LoopSnapshot
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Whether one projection row carries its current loop: the strict parse and
 * fold contracts guarantee the snapshot, timestamps, and lastRef travel
 * together with it.
 */
function isCurrentLoop(state: LoopProjection | null): state is CurrentLoop {
  return state?.loop !== undefined
}

/** Operations whose mutation is a pure phase swap. */
type PhaseSwapOperation = Exclude<LoopOperation, 'create' | 'resume' | 'advance' | 'block' | 'clear'>

/**
 * Loop service (`ctx.loops`): compare-and-set lifecycle mutations and
 * non-CAS node-ledger appends over the owning agent's session log. Every
 * mutation requires the agent to be live in this context and its session to
 * be live in the session store (the durability barrier); a failed flush
 * disarms the run and rethrows while the committed event stays in the log.
 */
export class LoopService extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'sessions']

  static Config: z<Config> = z.object({
    defaultMaxRounds: z.number().default(20),
    maxNodeRetries: z.number().default(2),
    maxHandoffChars: z.number().default(16384),
    maxEvaluatorInputChars: z.number().default(65536),
  })

  /** Resolved deployment defaults shared with the loop driver family. */
  readonly resolved: ResolvedConfig

  private readonly runtimeStates = new WeakMap<Session, LoopRuntimeState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'loops')
    this.resolved = resolveLoopConfig(config)
    ctx.on('agent/created', ({ agent }) => {
      this.setActivation(agent.session, 'disarmed')
    })
    ctx.sessionProjections.register(loopProjectionDefinition)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'loop/change') return
      const runtime = this.runtimeState(session)
      const activation = runtime.pendingActivation !== undefined
        && SessionSeq(runtime.pendingActivation.offset) === event.seq
        ? runtime.pendingActivation.activation
        : 'disarmed'
      this.setActivation(session, activation)
    })
  }

  /**
   * Create and arm one relay loop. A completed loop may be replaced with a
   * fresh one; every other current phase must be cleared first.
   * @param agent - owning live agent.
   * @param request - objective, frozen chain, scopes, and optional caps.
   * @returns the created live view.
   * @throws LoopError LOOP_AGENT_NOT_LIVE, LOOP_ALREADY_EXISTS,
   *   LOOP_INVALID_CHAIN, or LOOP_SCOPE_VIOLATION.
   */
  async start(agent: Agent, request: StartLoopRequest): Promise<LoopView> {
    const spec = resolveStartLoop(request, this.resolved.defaultMaxRounds)
    const [state, runtime] = this.prepareMutation(agent)
    const current = state?.loop
    if (current !== undefined && current.phase !== 'complete') {
      throw new LoopError(`loop "${current.id}" already exists with phase "${current.phase}"`, 'LOOP_ALREADY_EXISTS')
    }
    assertChainWithinWriteScopes(spec)
    assertInputSessionsWithinReadScopes(spec, this.ctx)
    const now = Date.now()
    const loop: LoopSnapshot = {
      id: LoopId(`loop-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxRounds: spec.maxRounds,
      checkpoint: spec.checkpoint,
      readScopes: spec.readScopes,
      writeScopes: spec.writeScopes,
      chain: spec.chain,
      roundsStarted: 0,
    }
    return this.commitSnapshot(agent, runtime, 'create', loop, now, now, 'armed')
  }

  /**
   * Pause the current loop and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  async pause(agent: Agent, ref: LoopRef): Promise<LoopView> {
    return this.transition(agent, ref, 'pause', ['active', 'awaiting-human'], 'paused', true)
  }

  /**
   * Resume and arm the loop while its round budget still has capacity; the
   * resume revision is the retry epoch floor.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the resumed view.
   */
  async resume(agent: Agent, ref: LoopRef): Promise<LoopView> {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.loop
    const resumable: readonly LoopPhase[] = ['active', 'awaiting-human', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && runtime.activation === 'armed') {
      throw new LoopError(`loop "${current.id}" is already active and armed`, 'LOOP_INVALID_TRANSITION')
    }
    if (current.roundsStarted >= current.maxRounds) {
      throw new LoopError(
        `loop "${current.id}" exhausted ${current.maxRounds} rounds; increase maxRounds before resuming`,
        'LOOP_INVALID_TRANSITION',
      )
    }
    const phase: LoopPhase = current.phase === 'awaiting-human' ? 'awaiting-human' : 'active'
    return this.commitCurrent(agent, currentState, runtime, 'resume', this.withPhase(current, phase), 'armed')
  }

  /**
   * Park the active loop at a human checkpoint awaiting an answer.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the awaiting view.
   */
  async awaitHuman(agent: Agent, ref: LoopRef): Promise<LoopView> {
    return this.transition(agent, ref, 'await-human', ['active'], 'awaiting-human', false)
  }

  /**
   * Continue the awaiting loop after its human answer.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view.
   */
  async continueFromHuman(agent: Agent, ref: LoopRef): Promise<LoopView> {
    return this.transition(agent, ref, 'continue', ['awaiting-human'], 'active', false)
  }
  /**
   * Record one applied verdict by consuming a round of the budget.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view with the advanced round count.
   */
  async advance(agent: Agent, ref: LoopRef): Promise<LoopView> {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.loop
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'advance', ['active'])
    }
    if (current.roundsStarted >= current.maxRounds) {
      throw new LoopError(
        `loop "${current.id}" exhausted ${current.maxRounds} rounds; the evaluator must complete or block instead`,
        'LOOP_INVALID_TRANSITION',
      )
    }
    const loop: LoopSnapshot = { ...this.withPhase(current, 'active'), roundsStarted: current.roundsStarted + 1 }
    return this.commitCurrent(agent, currentState, runtime, 'advance', loop, runtime.activation)
  }

  /**
   * Mark the active loop complete and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  async complete(agent: Agent, ref: LoopRef): Promise<LoopView> {
    return this.transition(agent, ref, 'complete', ['active'], 'complete', true)
  }

  /**
   * Mark the loop blocked with a durable reason and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param reason - policy-owned stable code and human-readable explanation.
   * @returns the blocked view.
   */
  async block(agent: Agent, ref: LoopRef, reason: LoopBlockReason): Promise<LoopView> {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.loop
    const blockable: readonly LoopPhase[] = ['active', 'awaiting-human', 'paused']
    if (!blockable.includes(current.phase)) {
      throw this.transitionError(current, 'block', blockable)
    }
    const loop: LoopSnapshot = { ...this.withPhase(current, 'blocked'), blockedReason: reason }
    return this.commitCurrent(agent, currentState, runtime, 'block', loop, 'disarmed')
  }

  /**
   * Clear the current loop from any phase while retaining the tombstone.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   */
  async clear(agent: Agent, ref: LoopRef): Promise<void> {
    const [state, runtime] = this.prepareMutation(agent)
    const current = this.expectCurrent(state, ref)
    const change: LoopClearChangeMeta = {
      kind: 'loop/change',
      version: LOOP_CHANGE_VERSION,
      operation: 'clear',
      cleared: { id: current.loop.id, revision: current.loop.revision + 1 },
      clearedAt: this.nextMutationTime(current),
    }
    await this.commit(agent, runtime, change, 'disarmed')
  }

  /**
   * Append one node-spawn record to the current loop's ledger.
   * @param agent - owning live agent.
   * @param meta - spawn record without its version and revision stamp.
   * @param atRevision - current loop revision the record was taken at.
   */
  async appendNodeStarted(agent: Agent, meta: Omit<LoopNodeStartedMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void> {
    await this.appendLedger(agent, { ...meta, version: LOOP_LEDGER_VERSION, atRevision })
  }

  /**
   * Append one attempt-failure record to the current loop's ledger.
   * @param agent - owning live agent.
   * @param meta - failure record without its version and revision stamp.
   * @param atRevision - current loop revision the record was taken at.
   */
  async appendAttempt(agent: Agent, meta: Omit<LoopAttemptMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void> {
    await this.appendLedger(agent, { ...meta, version: LOOP_LEDGER_VERSION, atRevision })
  }

  /**
   * Append one node settlement to the current loop's ledger.
   * @param agent - owning live agent.
   * @param meta - settlement record without its version and revision stamp.
   * @param atRevision - current loop revision the record was taken at.
   */
  async appendSettlement(agent: Agent, meta: Omit<LoopNodeSettledMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void> {
    await this.appendLedger(agent, { ...meta, version: LOOP_LEDGER_VERSION, atRevision })
  }

  /**
   * Read the process-local activation for one exact live agent.
   * @param agent - owning live agent.
   * @returns the current activation.
   */
  activation(agent: Agent): LoopActivation {
    this.assertLive(agent)
    return this.runtimeState(agent.session).activation
  }

  /**
   * Arm the current loop at one exact revision without writing a durable event.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   */
  arm(agent: Agent, ref: LoopRef): void {
    this.assertLive(agent)
    this.expectCurrent(this.state(agent.session), ref)
    this.setActivation(agent.session, 'armed')
  }

  /**
   * Drop process-local continuation authority without a durable revision.
   * @param agent - owning live agent.
   */
  disarm(agent: Agent): void {
    this.assertLive(agent)
    this.setActivation(agent.session, 'disarmed')
  }

  /** Resolve the durable and process-local state used by a mutation. */
  private prepareMutation(agent: Agent): readonly [LoopProjection | null, LoopRuntimeState] {
    this.assertLive(agent)
    return [this.state(agent.session), this.runtimeState(agent.session)]
  }

  /** Resolve the current-loop projection for a non-CAS ledger append. */
  private expectLoop(agent: Agent): CurrentLoop {
    const state = this.state(agent.session)
    if (!isCurrentLoop(state)) {
      throw new LoopError('no current loop', 'LOOP_NOT_FOUND')
    }
    return state
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(state: LoopProjection | null, ref: LoopRef): CurrentLoop {
    if (!isCurrentLoop(state)) {
      throw new LoopError('no current loop', 'LOOP_NOT_FOUND')
    }
    if (ref.id !== state.loop.id || ref.revision !== state.loop.revision) {
      throw new LoopError(
        `stale loop ref "${ref.id}" revision ${ref.revision}; current is "${state.loop.id}" revision ${state.loop.revision}`,
        'LOOP_STALE_REVISION',
      )
    }
    return state
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new LoopError(`agent ${agent.id} is not live in this context`, 'LOOP_AGENT_NOT_LIVE')
    }
  }

  /**
   * Shared validated phase swap.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param operation - snapshot operation recorded for the swap.
   * @param allowed - phases the operation accepts.
   * @param phase - the swap's target phase.
   * @param disarm - drop process-local activation instead of preserving it.
   * @returns the swapped view.
   */
  private async transition(
    agent: Agent,
    ref: LoopRef,
    operation: PhaseSwapOperation,
    allowed: readonly LoopPhase[],
    phase: LoopPhase,
    disarm: boolean,
  ): Promise<LoopView> {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    if (!allowed.includes(currentState.loop.phase)) {
      throw this.transitionError(currentState.loop, operation, allowed)
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      operation,
      this.withPhase(currentState.loop, phase),
      disarm ? 'disarmed' : runtime.activation,
    )
  }

  /** Build the rejection for a phase an operation does not accept. */
  private transitionError(current: LoopSnapshot, operation: string, allowed: readonly LoopPhase[]): LoopError {
    return new LoopError(
      `loop "${current.id}" cannot ${operation} from phase "${current.phase}" (allowed: ${allowed.join(', ')})`,
      'LOOP_INVALID_TRANSITION',
    )
  }

  /** Build the next revision of one snapshot with a new phase, dropping any block reason. */
  private withPhase(current: LoopSnapshot, phase: LoopPhase): LoopSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxRounds: current.maxRounds,
      checkpoint: current.checkpoint,
      readScopes: current.readScopes,
      writeScopes: current.writeScopes,
      chain: current.chain,
      roundsStarted: current.roundsStarted,
    }
  }

  /** Clamp a current loop's next timestamp across backward wall-clock movement. */
  private nextMutationTime(state: CurrentLoop): number {
    return Math.max(Date.now(), state.updatedAt)
  }

  /**
   * Commit one mutation with its full snapshot.
   * @param agent - owning live agent.
   * @param runtime - process-local state crossing the append boundary.
   * @param operation - snapshot operation recorded for the mutation.
   * @param loop - the full next snapshot.
   * @param createdAt - the loop's preserved creation timestamp.
   * @param updatedAt - the clamped mutation timestamp.
   * @param activation - activation recorded with the commit.
   * @returns the fresh live view.
   */
  private async commitSnapshot(
    agent: Agent,
    runtime: LoopRuntimeState,
    operation: Exclude<LoopOperation, 'clear'>,
    loop: LoopSnapshot,
    createdAt: number,
    updatedAt: number,
    activation: LoopActivation,
  ): Promise<LoopView> {
    const change: LoopSnapshotChangeMeta = {
      kind: 'loop/change',
      version: LOOP_CHANGE_VERSION,
      operation,
      loop,
      createdAt,
      updatedAt,
    }
    await this.commit(agent, runtime, change, activation)
    return {
      loop: { ...loop },
      createdAt,
      updatedAt,
      activation: runtime.activation,
    }
  }

  /** Commit one mutation of the current loop, preserving its creation timestamp. */
  private async commitCurrent(
    agent: Agent,
    state: CurrentLoop,
    runtime: LoopRuntimeState,
    operation: Exclude<LoopOperation, 'create' | 'clear'>,
    loop: LoopSnapshot,
    activation: LoopActivation,
  ): Promise<LoopView> {
    return this.commitSnapshot(agent, runtime, operation, loop, state.createdAt, this.nextMutationTime(state), activation)
  }

  /** Validate one composed change through the strict fold decoder before append. */
  private validateChange(change: LoopChangeMeta): void {
    /* v8 ignore next 3 -- the composed change declares kind "loop/change", which the decoder never declines. */
    if (decodeLoopChange(change) === undefined) {
      throw new LoopError(`loop ${change.operation} change is not a loop change`, 'LOOP_INVALID_CHAIN')
    }
  }
  /** Commit one mutation into the loop log, flush it, and recheck the ref. */
  private async commit(agent: Agent, runtime: LoopRuntimeState, change: LoopChangeMeta, activation: LoopActivation): Promise<void> {
    this.validateChange(change)
    const ref = loopChangeRef(change)
    runtime.pendingActivation = { offset: agent.session.seq, activation }
    try {
      const event = agent.session.append('loop/change', change)
      /* v8 ignore next -- Session.append returns the event committed at the pre-append seq. */
      if (SessionSeq(runtime.pendingActivation.offset) === event.seq) runtime.activation = activation
    } finally {
      runtime.pendingActivation = undefined
    }
    await this.flushMutation(agent)
    const current = this.state(agent.session)?.loop
    if (current !== undefined && (current.id !== ref.id || current.revision !== ref.revision)) {
      throw new LoopError(
        `stale loop ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'LOOP_STALE_REVISION',
      )
    }
    agentEvents(this.ctx, agent).emit('loop/changed', {
      change: { operation: change.operation, ref: { ...ref } },
    })
  }

  /** Flush one committed mutation; a durability failure disarms and rethrows. */
  private async flushMutation(agent: Agent): Promise<void> {
    try {
      await this.ctx.sessions.flush(agent.session)
    } catch (error: unknown) {
      // A durability failure disarms (never active-but-stalled); the mutation
      // stays in the log and the caller owns the surfaced error and any
      // durability-failed block record.
      this.setActivation(agent.session, 'disarmed')
      throw error
    }
  }

  /** Validate one ledger record against the current fold, append, and flush it. */
  private async appendLedger(agent: Agent, meta: LoopLedgerMeta): Promise<void> {
    this.assertLive(agent)
    const current = this.expectLoop(agent)
    const key = LEDGER_EVENT_KEYS[meta.kind]
    decodeLoopLedger(key, meta)
    if (meta.loopId !== current.loop.id) {
      throw new LoopError(`loop "${meta.loopId}" is not the current loop "${current.loop.id}"`, 'LOOP_NOT_FOUND')
    }
    if (meta.atRevision > current.loop.revision) {
      throw new LoopError(
        `ledger atRevision ${meta.atRevision} exceeds the current revision ${current.loop.revision}`,
        'LOOP_STALE_REVISION',
      )
    }
    const prior = current.ledger.find(entry =>
      entry.round === meta.round && entry.nodeIndex === meta.nodeIndex && entry.attempt === meta.attempt)
    if (meta.kind === 'node-started') {
      if (prior !== undefined) {
        throw new LoopError(`ledger key ${ledgerKey(meta.loopId, meta)} already exists`, 'LOOP_ALREADY_EXISTS')
      }
    } else if (prior?.kind !== 'node-started') {
      throw new LoopError(`ledger ${meta.kind} without a matching node-started at ${ledgerKey(meta.loopId, meta)}`, 'LOOP_INVALID_TRANSITION')
    }
    agent.session.append(key, meta)
    await this.flushMutation(agent)
    // Post-commit fold check: a fold failure retained by this append throws here instead of passing silently.
    this.state(agent.session)
  }

  /** Read the current loop state, rejecting fold failure and missing registration. */
  private state(session: Session): LoopProjection | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'loop')
    if (state === undefined) throw new Error('loop projection is not registered')
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** Resolve the process-local runtime state of one session. */
  private runtimeState(session: Session): LoopRuntimeState {
    let runtime = this.runtimeStates.get(session)
    if (runtime === undefined) {
      runtime = { activation: 'disarmed', pendingActivation: undefined }
      this.runtimeStates.set(session, runtime)
    }
    return runtime
  }

  /** Record one process-local activation edge. */
  private setActivation(session: Session, activation: LoopActivation): void {
    this.runtimeState(session).activation = activation
  }
}

export default LoopService
