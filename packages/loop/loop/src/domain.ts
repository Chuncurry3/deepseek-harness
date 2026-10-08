/**
 * Host-side vocabulary of the loop domain: durable change payloads, the
 * append-only node-ledger events, the live notification view, and the scoped
 * `loop/changed` event. Kept separate from ./types.ts (the pure client-safe
 * outlet) because these declarations pull dsh-agent, dsh-session, and cordis
 * into the program — the one-program-per-side layout forbids that on client
 * aggregates.
 * @module @deepseek-ai/dsh-loop
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoopId, LoopRef, LoopSnapshot } from './types.ts'

/** Loop state-changing verbs recorded in the durable source change. */
export type LoopOperation =
  | 'create'
  | 'pause'
  | 'resume'
  | 'await-human'
  | 'continue'
  | 'advance'
  | 'complete'
  | 'block'
  | 'clear'

/** Full-snapshot loop mutation committed by a durable `loop/change` event. */
export interface LoopSnapshotChangeMeta {
  readonly kind: 'loop/change'
  readonly version: 1
  readonly operation: Exclude<LoopOperation, 'clear'>
  readonly loop: LoopSnapshot
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the current loop is cleared. */
export interface LoopClearChangeMeta {
  readonly kind: 'loop/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: LoopRef
  readonly clearedAt: number
}

/** Durable change union carried by the loop domain's own session event. */
export type LoopChangeMeta = LoopSnapshotChangeMeta | LoopClearChangeMeta

/** Append-only spawn record committed by a `loop/node-started` event. */
export interface LoopNodeStartedMeta {
  readonly kind: 'node-started'
  readonly version: 1
  readonly loopId: LoopId
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  /** Positive 1-based attempt number within the node's retry epoch. */
  readonly attempt: number
  readonly childSessionId: SessionId
  readonly cwd: string
  readonly atRevision: number
}

/** Append-only failure record committed by a `loop/attempt` event. */
export interface LoopAttemptMeta {
  readonly kind: 'attempt'
  readonly version: 1
  readonly loopId: LoopId
  readonly round: number
  readonly nodeIndex: number
  /** Positive 1-based attempt number the failure ends. */
  readonly attempt: number
  readonly failure: { readonly code: string; readonly message: string }
  readonly atRevision: number
}

/** Append-only settlement committed by a `loop/node` event. */
export interface LoopNodeSettledMeta {
  readonly kind: 'settlement'
  readonly version: 1
  readonly loopId: LoopId
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  /** Positive 1-based attempt number the settlement closes. */
  readonly attempt: number
  readonly childSessionId: SessionId
  readonly cwd: string
  readonly report: unknown
  readonly atRevision: number
}

/** Durable ledger-event union; one entry spawns, fails, or settles one attempt. */
export type LoopLedgerMeta = LoopNodeStartedMeta | LoopAttemptMeta | LoopNodeSettledMeta

/** Session event keys whose payloads carry node-ledger records. */
export type LoopLedgerEventKey = 'loop/node-started' | 'loop/attempt' | 'loop/node'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-mutation loop snapshot or clear tombstone. */
    'loop/change': LoopChangeMeta
    /** Spawn record for one node attempt. */
    'loop/node-started': LoopNodeStartedMeta
    /** Failure record for one node attempt. */
    'loop/attempt': LoopAttemptMeta
    /** Settlement for one node attempt. */
    'loop/node': LoopNodeSettledMeta
  }
}

/** Live notification after one durable loop mutation commits. */
export interface LoopChanged {
  readonly operation: LoopOperation
  readonly ref: LoopRef
}

/** Stable error codes for rejected loop reads and mutations. */
export type LoopErrorCode =
  | 'LOOP_AGENT_NOT_LIVE'
  | 'LOOP_NOT_FOUND'
  | 'LOOP_ALREADY_EXISTS'
  | 'LOOP_STALE_REVISION'
  | 'LOOP_INVALID_TRANSITION'
  | 'LOOP_SCOPE_VIOLATION'
  | 'LOOP_INVALID_CHAIN'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Loop mutation accepted by one live agent. The matching `loop/change`
     * session event has already committed. Listener failures are contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param payload.agent - agent whose session owns the loop.
     * @param payload.change - operation plus the fresh snapshot ref.
     * @mode emit
     */
    'loop/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: LoopChanged }): void
  }
}
