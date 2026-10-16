/**
 * Strict replay fold for durable loop events: fail-loud schema decoders, the
 * last-wins `loop/change` application with lifecycle legality, and the
 * append-only node ledger keyed by `{loopId, round, nodeIndex, attempt}`.
 * @module @deepseek-ai/dsh-loop/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { LOOP_CHANGE_VERSION, LOOP_LEDGER_VERSION, LoopId } from './runtime.ts'
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
  LoopBlockReason,
  LoopChainDef,
  LoopChainNodeDef,
  LoopId as LoopIdType,
  LoopInputRef,
  LoopLedgerEntry,
  LoopPhase,
  LoopProjection,
  LoopRef,
  LoopSnapshot,
} from './types.ts'

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<LoopOperation, 'clear'>> = new Set([
  'create',
  'pause',
  'resume',
  'await-human',
  'continue',
  'advance',
  'complete',
  'block',
])
const PHASES: ReadonlySet<LoopPhase> = new Set(['active', 'awaiting-human', 'paused', 'blocked', 'complete'])
const BLOCK_CODES: ReadonlySet<LoopBlockReason['code']> = new Set([
  'node-failed',
  'round-limit',
  'evaluator-blocked',
  'checkpoint-provider-missing',
  'durability-failed',
  'report-budget',
])
/** Payload kind required by each ledger event key. */
const LEDGER_KINDS = {
  'loop/node-started': 'node-started',
  'loop/attempt': 'attempt',
  'loop/node': 'settlement',
} as const satisfies Record<LoopLedgerEventKey, LoopLedgerMeta['kind']>

/** Mutable accumulator kept private to the pure fold. */
export interface LoopFoldState {
  loop: LoopSnapshot | undefined
  ledger: Map<string, LoopLedgerEntry>
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: LoopRef | undefined
  /** Identity of the loop the ledger currently records; absent with no current loop. */
  currentLoopId: LoopIdType | undefined
  /** Loop identities already created in this session, retained to reject reuse. */
  seenLoopIds: Set<LoopIdType>
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current loop or prior ref.
 */
export function emptyLoopFoldState(): LoopFoldState {
  return {
    loop: undefined,
    ledger: new Map(),
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    currentLoopId: undefined,
    seenLoopIds: new Set(),
  }
}

/* jscpd:ignore-start -- goal-template mirror: these strict decoder primitives deliberately
   mirror dsh-goal's fold decoders (only the failure-message prefix differs) until a shared
   fold-primitives home extracts them. */
/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}
/* jscpd:ignore-end */

/** Require one string with non-whitespace content. */
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

/** Require one non-empty string with no surrounding whitespace. */
function trimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be non-empty and normalized`)
  }
  return value
}

/** Require an array of non-empty strings. */
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of non-empty strings`)
  const entries: unknown[] = value
  return entries.map(entry => nonEmptyString(entry, `${field} entry`))
}

/** Require one checkpoint mode literal. */
function checkpointMode(value: unknown, field: string): 'none' | 'node' {
  if (value !== 'none' && value !== 'node') {
    throw new Error(`${field} must be "none" or "node"`)
  }
  return value
}

/** Require exactly the required fields plus any named optional fields. */
function fields(value: Record<string, unknown>, subject: string, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value)
  for (const key of required) {
    if (!actual.includes(key)) throw new Error(`${subject} must carry field ${key}`)
  }
  for (const key of actual) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${subject} cannot carry field ${key}`)
    }
  }
}

/** Decode one output override through the enforced object-schema subset. */
function decodeNodeOutput(value: unknown): ObjectJsonSchema {
  assertObjectJsonSchema(value)
  return value
}

/** Decode the declared input sessions of one chain node. */
function decodeInputs(value: unknown): LoopInputRef[] {
  if (!Array.isArray(value)) throw new Error('loop/change loop.chain node inputs must be an array')
  const entries: unknown[] = value
  return entries.map((entry) => {
    if (!isRecord(entry)) throw new Error('loop/change loop.chain node inputs entry must be a record')
    fields(entry, 'loop/change loop.chain node inputs entry', ['session'])
    return { session: SessionId(nonEmptyString(entry['session'], 'loop/change loop.chain node inputs entry session')) }
  })
}

/** Decode one frozen chain node entry. */
function decodeChainNode(value: unknown): LoopChainNodeDef {
  if (!isRecord(value)) throw new Error('loop/change loop.chain node must be a record')
  fields(value, 'loop/change loop.chain node', ['role', 'prompt'], ['carryOver', 'cwd', 'inputs', 'output'])
  const role = trimmedString(value['role'], 'loop/change loop.chain node role')
  const prompt = nonEmptyString(value['prompt'], 'loop/change loop.chain node prompt')
  const cwd = Object.hasOwn(value, 'cwd') ? nonEmptyString(value['cwd'], 'loop/change loop.chain node cwd') : undefined
  const output = Object.hasOwn(value, 'output') ? decodeNodeOutput(value['output']) : undefined
  const inputs = Object.hasOwn(value, 'inputs') ? decodeInputs(value['inputs']) : undefined
  const carryOver = Object.hasOwn(value, 'carryOver')
    ? stringArray(value['carryOver'], 'loop/change loop.chain node carryOver')
    : undefined
  return {
    role,
    prompt,
    ...cwd === undefined ? {} : { cwd },
    ...output === undefined ? {} : { output },
    ...inputs === undefined ? {} : { inputs },
    ...carryOver === undefined ? {} : { carryOver },
  }
}

/** Decode the frozen chain of one snapshot. */
function decodeLoopChain(value: unknown): LoopChainDef {
  if (!isRecord(value)) throw new Error('loop/change loop.chain must be a record')
  fields(value, 'loop/change loop.chain', ['checkpoint', 'nodes', 'objective'], ['evaluatorPrompt', 'exit'])
  if (!Array.isArray(value['nodes']) || value['nodes'].length === 0) {
    throw new Error('loop/change loop.chain nodes must be a non-empty array')
  }
  const entries: unknown[] = value['nodes']
  const roles = new Set<string>()
  const nodes = entries.map((node) => {
    const decoded = decodeChainNode(node)
    if (roles.has(decoded.role)) {
      throw new Error(`loop/change loop.chain node role must be unique: ${decoded.role}`)
    }
    roles.add(decoded.role)
    return decoded
  })
  for (const node of nodes) {
    for (const named of node.carryOver ?? []) {
      if (!roles.has(named)) {
        throw new Error(`loop/change loop.chain node carryOver names an unknown role: ${named}`)
      }
    }
  }
  const exit = Object.hasOwn(value, 'exit') ? nonEmptyString(value['exit'], 'loop/change loop.chain exit') : undefined
  const evaluatorPrompt = Object.hasOwn(value, 'evaluatorPrompt')
    ? nonEmptyString(value['evaluatorPrompt'], 'loop/change loop.chain evaluatorPrompt')
    : undefined
  return {
    objective: trimmedString(value['objective'], 'loop/change loop.chain objective'),
    checkpoint: checkpointMode(value['checkpoint'], 'loop/change loop.chain checkpoint'),
    nodes,
    ...exit === undefined ? {} : { exit },
    ...evaluatorPrompt === undefined ? {} : { evaluatorPrompt },
  }
}

/** Decode and validate one canonical blocker explanation. */
function decodeBlockReason(value: unknown): LoopBlockReason {
  if (!isRecord(value)) throw new Error('loop/change loop.blockedReason must be a record')
  fields(value, 'loop/change loop.blockedReason', ['code', 'message'])
  if (typeof value['code'] !== 'string' || !BLOCK_CODES.has(value['code'] as LoopBlockReason['code'])) {
    throw new Error('loop/change loop.blockedReason.code is not a known loop block code')
  }
  return {
    code: value['code'] as LoopBlockReason['code'],
    message: trimmedString(value['message'], 'loop/change loop.blockedReason.message'),
  }
}

/** Decode and validate one snapshot. */
function decodeLoopSnapshot(value: unknown): LoopSnapshot {
  if (!isRecord(value)) throw new Error('loop/change loop must be a record')
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'] as LoopPhase)) {
    throw new Error('loop/change loop.phase is invalid')
  }
  const phase = value['phase'] as LoopPhase
  fields(
    value,
    'loop/change loop',
    phase === 'blocked'
      ? ['blockedReason', 'chain', 'checkpoint', 'id', 'maxRounds', 'objective', 'phase', 'readScopes', 'revision', 'roundsStarted', 'writeScopes']
      : ['chain', 'checkpoint', 'id', 'maxRounds', 'objective', 'phase', 'readScopes', 'revision', 'roundsStarted', 'writeScopes'],
  )
  const maxRounds = positiveInteger(value['maxRounds'], 'loop/change loop.maxRounds')
  const roundsStarted = nonNegativeInteger(value['roundsStarted'], 'loop/change loop.roundsStarted')
  if (roundsStarted > maxRounds) {
    throw new Error('loop/change loop.roundsStarted cannot exceed loop.maxRounds')
  }
  return {
    id: LoopId(nonEmptyString(value['id'], 'loop/change loop.id')),
    revision: positiveInteger(value['revision'], 'loop/change loop.revision'),
    objective: trimmedString(value['objective'], 'loop/change loop.objective'),
    phase,
    ...phase === 'blocked' ? { blockedReason: decodeBlockReason(value['blockedReason']) } : {},
    maxRounds,
    checkpoint: checkpointMode(value['checkpoint'], 'loop/change loop.checkpoint'),
    readScopes: stringArray(value['readScopes'], 'loop/change loop.readScopes'),
    writeScopes: stringArray(value['writeScopes'], 'loop/change loop.writeScopes'),
    chain: decodeLoopChain(value['chain']),
    roundsStarted,
  }
}

/** Decode and validate one compare-and-set ref. */
function decodeLoopRef(value: unknown, subject: string): LoopRef {
  if (!isRecord(value)) throw new Error(`${subject} must be a record`)
  fields(value, subject, ['id', 'revision'])
  return {
    id: LoopId(nonEmptyString(value['id'], `${subject} id`)),
    revision: positiveInteger(value['revision'], `${subject} revision`),
  }
}

/**
 * Decode a value that declares itself as a loop change. Unrelated values
 * return `undefined`; malformed loop changes fail replay loudly.
 * @param value - candidate source change.
 * @returns validated loop change or `undefined` for another value kind.
 */
export function decodeLoopChange(value: unknown): LoopChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'loop/change') return undefined
  if (value['version'] !== LOOP_CHANGE_VERSION) {
    throw new Error(`unsupported loop change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    fields(value, 'loop/change clear change', ['cleared', 'clearedAt', 'kind', 'operation', 'version'])
    return {
      kind: 'loop/change',
      version: LOOP_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeLoopRef(value['cleared'], 'loop/change clear tombstone'),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'loop/change clearedAt'),
    } satisfies LoopClearChangeMeta
  }
  if (typeof value['operation'] !== 'string'
    || !SNAPSHOT_OPERATIONS.has(value['operation'] as Exclude<LoopOperation, 'clear'>)) {
    throw new Error('loop/change operation is invalid')
  }
  fields(value, 'loop/change snapshot change', ['createdAt', 'kind', 'loop', 'operation', 'updatedAt', 'version'])
  const createdAt = nonNegativeInteger(value['createdAt'], 'loop/change createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'loop/change updatedAt')
  if (updatedAt < createdAt) throw new Error('loop/change updatedAt cannot precede createdAt')
  return {
    kind: 'loop/change',
    version: LOOP_CHANGE_VERSION,
    operation: value['operation'] as Exclude<LoopOperation, 'clear'>,
    loop: decodeLoopSnapshot(value['loop']),
    createdAt,
    updatedAt,
  } satisfies LoopSnapshotChangeMeta
}

/**
 * Decode one ledger event payload against the kind its event key requires.
 * @param key - session event key that carried the payload.
 * @param value - candidate ledger payload.
 * @returns validated ledger meta.
 */
export function decodeLoopLedger(key: LoopLedgerEventKey, value: unknown): LoopLedgerMeta {
  const kind = LEDGER_KINDS[key]
  if (!isRecord(value) || value['kind'] !== kind) {
    throw new Error(`loop ${key} payload must carry kind ${kind}`)
  }
  if (value['version'] !== LOOP_LEDGER_VERSION) {
    throw new Error(`unsupported loop ledger version ${String(value['version'])}`)
  }
  switch (kind) {
    case 'node-started': {
      fields(value, 'loop/node-started payload', ['attempt', 'atRevision', 'childSessionId', 'cwd', 'kind', 'loopId', 'nodeIndex', 'round', 'role', 'version'])
      return {
        kind,
        version: LOOP_LEDGER_VERSION,
        loopId: LoopId(nonEmptyString(value['loopId'], 'loop/node-started loopId')),
        round: positiveInteger(value['round'], 'loop/node-started round'),
        nodeIndex: nonNegativeInteger(value['nodeIndex'], 'loop/node-started nodeIndex'),
        role: nonEmptyString(value['role'], 'loop/node-started role'),
        attempt: positiveInteger(value['attempt'], 'loop/node-started attempt'),
        childSessionId: SessionId(nonEmptyString(value['childSessionId'], 'loop/node-started childSessionId')),
        cwd: nonEmptyString(value['cwd'], 'loop/node-started cwd'),
        atRevision: positiveInteger(value['atRevision'], 'loop/node-started atRevision'),
      } satisfies LoopNodeStartedMeta
    }
    case 'attempt': {
      fields(value, 'loop/attempt payload', ['attempt', 'atRevision', 'failure', 'kind', 'loopId', 'nodeIndex', 'round', 'version'])
      if (!isRecord(value['failure'])) throw new Error('loop/attempt failure must be a record')
      fields(value['failure'], 'loop/attempt failure', ['code', 'message'])
      return {
        kind,
        version: LOOP_LEDGER_VERSION,
        loopId: LoopId(nonEmptyString(value['loopId'], 'loop/attempt loopId')),
        round: positiveInteger(value['round'], 'loop/attempt round'),
        nodeIndex: nonNegativeInteger(value['nodeIndex'], 'loop/attempt nodeIndex'),
        attempt: positiveInteger(value['attempt'], 'loop/attempt attempt'),
        failure: {
          code: nonEmptyString(value['failure']['code'], 'loop/attempt failure code'),
          message: nonEmptyString(value['failure']['message'], 'loop/attempt failure message'),
        },
        atRevision: positiveInteger(value['atRevision'], 'loop/attempt atRevision'),
      } satisfies LoopAttemptMeta
    }
    case 'settlement': {
      fields(value, 'loop/node payload', ['attempt', 'atRevision', 'childSessionId', 'cwd', 'kind', 'loopId', 'nodeIndex', 'report', 'round', 'role', 'version'])
      return {
        kind,
        version: LOOP_LEDGER_VERSION,
        loopId: LoopId(nonEmptyString(value['loopId'], 'loop/node loopId')),
        round: positiveInteger(value['round'], 'loop/node round'),
        nodeIndex: nonNegativeInteger(value['nodeIndex'], 'loop/node nodeIndex'),
        role: nonEmptyString(value['role'], 'loop/node role'),
        attempt: positiveInteger(value['attempt'], 'loop/node attempt'),
        childSessionId: SessionId(nonEmptyString(value['childSessionId'], 'loop/node childSessionId')),
        cwd: nonEmptyString(value['cwd'], 'loop/node cwd'),
        report: value['report'],
        atRevision: positiveInteger(value['atRevision'], 'loop/node atRevision'),
      } satisfies LoopNodeSettledMeta
    }
  }
}

/**
 * Return the revision identity carried by a snapshot or tombstone.
 * @param change - decoded loop mutation.
 * @returns stable identity used to reconcile a deferred change with its log event.
 */
export function loopChangeRef(change: LoopChangeMeta): LoopRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.loop.id, revision: change.loop.revision }
}

/** Require one exact next revision of the current loop. */
function requireNextRevision(current: LoopSnapshot, next: LoopRef, operation: LoopOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`loop ${operation} must advance the current loop by one revision`)
  }
}

/** Require one operation to retain every field only `create` may set. */
function requireSameDefinition(current: LoopSnapshot, next: LoopSnapshot, operation: Exclude<LoopOperation, 'clear'>): void {
  if (next.objective !== current.objective
    || next.maxRounds !== current.maxRounds
    || next.checkpoint !== current.checkpoint
    || JSON.stringify(next.readScopes) !== JSON.stringify(current.readScopes)
    || JSON.stringify(next.writeScopes) !== JSON.stringify(current.writeScopes)
    || JSON.stringify(next.chain) !== JSON.stringify(current.chain)) {
    throw new Error(`loop ${operation} cannot change the objective, caps, scopes, or chain`)
  }
}

/** Validate one non-create snapshot operation against the preceding projection. */
function validateSnapshotTransition(
  state: LoopFoldState,
  change: LoopSnapshotChangeMeta,
  current: LoopSnapshot,
): void {
  const next = change.loop
  const operation = change.operation
  requireNextRevision(current, next, operation)
  /* v8 ignore next -- a current loop established by this fold always has an updatedAt */
  if (state.updatedAt === undefined) throw new Error('current loop fold lacks updatedAt')
  if (change.createdAt !== state.createdAt
    || change.updatedAt < state.updatedAt
    || (operation !== 'advance' && next.roundsStarted !== current.roundsStarted)) {
    throw new Error(`loop ${operation} does not preserve the current counters and timestamps`)
  }
  requireSameDefinition(current, next, operation)
  switch (operation) {
    case 'pause':
      if ((current.phase !== 'active' && current.phase !== 'awaiting-human') || next.phase !== 'paused') {
        throw new Error('loop pause has an invalid phase transition')
      }
      break
    case 'resume': {
      const resumable: ReadonlySet<LoopPhase> = new Set(['active', 'awaiting-human', 'paused', 'blocked'])
      if (!resumable.has(current.phase)) {
        throw new Error(`loop resume cannot leave phase ${current.phase}`)
      }
      const target = current.phase === 'paused' || current.phase === 'blocked' ? 'active' : current.phase
      if (next.phase !== target || next.roundsStarted >= next.maxRounds) {
        throw new Error('loop resume has an invalid phase transition or exhausted round budget')
      }
      break
    }
    case 'await-human':
      if (current.phase !== 'active' || next.phase !== 'awaiting-human') {
        throw new Error('loop await-human has an invalid phase transition')
      }
      break
    case 'continue':
      if (current.phase !== 'awaiting-human' || next.phase !== 'active') {
        throw new Error('loop continue has an invalid phase transition')
      }
      break
    case 'advance':
      if (current.phase !== 'active' || next.phase !== 'active'
        || next.roundsStarted !== current.roundsStarted + 1) {
        throw new Error('loop advance must run one new round of the active loop')
      }
      break
    case 'complete':
      if (current.phase !== 'active' || next.phase !== 'complete') {
        throw new Error('loop complete has an invalid phase transition')
      }
      break
    case 'block': {
      const blockable: ReadonlySet<LoopPhase> = new Set(['active', 'awaiting-human', 'paused'])
      if (!blockable.has(current.phase) || next.phase !== 'blocked') {
        throw new Error('loop block has an invalid phase transition')
      }
      break
    }
    /* v8 ignore start -- the caller excludes create and the operation union is closed; these arms retain fail-loud exhaustiveness */
    case 'create':
      throw new Error('loop create cannot be validated as a current-loop transition')
    default:
      operation satisfies never
      throw new Error('unknown loop snapshot operation')
    /* v8 ignore stop */
  }
}

/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param state - preceding durable loop projection.
 * @param change - decoded full snapshot or clear tombstone.
 */
export function applyLoopChange(state: LoopFoldState, change: LoopChangeMeta): void {
  const ref = loopChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.loop
    if (current === undefined) throw new Error('loop clear requires a current loop')
    requireNextRevision(current, change.cleared, change.operation)
    /* v8 ignore next -- a current loop established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current loop fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) {
      throw new Error('loop clear timestamp cannot precede the current loop update')
    }
    state.loop = undefined
    state.currentLoopId = undefined
    state.createdAt = undefined
    state.updatedAt = undefined
    state.ledger = new Map()
    state.lastRef = ref
    return
  }
  if (change.operation === 'create') {
    if (change.loop.revision !== 1 || change.loop.phase !== 'active' || change.loop.roundsStarted !== 0
      || (state.loop !== undefined && state.loop.phase !== 'complete')
      || state.seenLoopIds.has(change.loop.id)) {
      throw new Error('loop create requires a fresh active revision-one loop with zero rounds')
    }
    state.seenLoopIds.add(change.loop.id)
    state.ledger = new Map()
  } else {
    const current = state.loop
    if (current === undefined) throw new Error(`loop ${change.operation} requires a current loop`)
    validateSnapshotTransition(state, change, current)
  }
  state.loop = change.loop
  state.currentLoopId = change.loop.id
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

/** Project one ledger meta onto the durable ledger entry shape. */
export function loopLedgerEntry(meta: LoopLedgerMeta): LoopLedgerEntry {
  switch (meta.kind) {
    case 'node-started':
      return {
        kind: meta.kind,
        round: meta.round,
        nodeIndex: meta.nodeIndex,
        role: meta.role,
        attempt: meta.attempt,
        childSessionId: meta.childSessionId,
        cwd: meta.cwd,
        atRevision: meta.atRevision,
      }
    case 'attempt':
      return {
        kind: meta.kind,
        round: meta.round,
        nodeIndex: meta.nodeIndex,
        attempt: meta.attempt,
        failure: meta.failure,
        atRevision: meta.atRevision,
      }
    case 'settlement':
      return {
        kind: meta.kind,
        round: meta.round,
        nodeIndex: meta.nodeIndex,
        role: meta.role,
        attempt: meta.attempt,
        childSessionId: meta.childSessionId,
        cwd: meta.cwd,
        report: meta.report,
        atRevision: meta.atRevision,
      }
  }
}

/**
 * Apply one session event to the strict durable loop fold.
 * @param state - mutable fold accumulator.
 * @param event - next event in sequence order.
 */
export function applyLoopEvent(state: LoopFoldState, event: SessionEvent): void {
  switch (event.type) {
    case 'loop/change': {
      const change = decodeLoopChange(event.data)
      if (change === undefined) throw new Error(`loop change at session event ${event.seq} has an invalid kind`)
      applyLoopChange(state, change)
      return
    }
    case 'loop/node-started':
    case 'loop/attempt':
    case 'loop/node': {
      const meta = decodeLoopLedger(event.type, event.data)
      if (state.currentLoopId === undefined || meta.loopId !== state.currentLoopId) return
      const current = state.loop
      /* v8 ignore next -- currentLoopId and the current snapshot move together. */
      if (current === undefined) throw new Error('current loop fold lacks a snapshot')
      if (meta.atRevision > current.revision) {
        throw new Error(`loop ledger ${meta.kind} at session event ${event.seq} exceeds the current change revision`)
      }
      const key = `${meta.loopId}:${meta.round}:${meta.nodeIndex}:${meta.attempt}`
      const prior = state.ledger.get(key)
      if (meta.kind === 'node-started') {
        if (prior !== undefined) throw new Error(`loop ledger duplicate key: ${key}`)
      } else if (prior === undefined || prior.kind !== 'node-started') {
        throw new Error(`loop ledger ${meta.kind} without matching node-started: ${key}`)
      }
      state.ledger.set(key, loopLedgerEntry(meta))
      return
    }
    default: return
  }
}

/**
 * Fold current loop state from a contiguous session event log.
 * @param events - session events in sequence order.
 * @returns a fresh durable projection; activation is deliberately absent.
 */
export function foldLoop(events: readonly SessionEvent[]): LoopProjection {
  const state = emptyLoopFoldState()
  for (const event of events) applyLoopEvent(state, event)
  return {
    ...state.loop === undefined ? {} : { loop: { ...state.loop } },
    ledger: [...state.ledger.values()],
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}
