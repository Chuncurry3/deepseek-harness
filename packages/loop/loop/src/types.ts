/**
 * Pure types of the loop domain: the ONE home of the `loop` projection-key
 * declaration plus the durable vocabulary it carries, free of host-side
 * imports. Mirrors dsh-goal/types.ts.
 * @module @deepseek-ai/dsh-loop/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session/types'
// Type-only: the projection map this module merges the `loop` key into.
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Identifies one relay loop across its durable revisions. */
export type LoopId = Branded<'LoopId'>

/** Compare-and-set identity for one exact loop revision. */
export interface LoopRef {
  readonly id: LoopId
  /** Positive revision; increments on every `loop/change` event only. */
  readonly revision: number
}

/** Durable lifecycle phase. Activation is process-local and separate. */
export type LoopPhase = 'active' | 'awaiting-human' | 'paused' | 'blocked' | 'complete'

/** Machine-routable and human-readable explanation for a blocked loop. */
export interface LoopBlockReason {
  readonly code: 'node-failed' | 'round-limit' | 'evaluator-blocked' | 'checkpoint-provider-missing' | 'durability-failed' | 'report-budget'
  readonly message: string
}

/** One declared source conversation a node continues by reading. */
export interface LoopInputRef { readonly session: SessionId }

/** One role node of the frozen chain. */
export interface LoopChainNodeDef {
  readonly role: string
  /** Absolute workspace; defaults to the loop's home workspace. */
  readonly cwd?: string
  readonly prompt: string
  /** Replaces the default handoff schema wholesale when present. */
  readonly output?: ObjectJsonSchema
  /** Declared source sessions; requires the `inherited` report field. */
  readonly inputs?: readonly LoopInputRef[]
  /** Role names whose prior-round reports carry into this node. */
  readonly carryOver?: readonly string[]
}

/** The frozen, validated chain. */
export interface LoopChainDef {
  readonly objective: string
  readonly exit?: string
  readonly checkpoint: 'none' | 'node'
  readonly nodes: readonly LoopChainNodeDef[]
  readonly evaluatorPrompt?: string
}

/** Full durable state written by every non-clear `loop/change` event. */
export interface LoopSnapshot extends LoopRef {
  readonly objective: string
  readonly phase: LoopPhase
  readonly blockedReason?: LoopBlockReason
  readonly maxRounds: number
  readonly checkpoint: 'none' | 'node'
  /** realpath-normalized absolute workspaces readable by this run's nodes. */
  readonly readScopes: readonly string[]
  /** realpath-normalized absolute workspaces executable by this run's nodes. */
  readonly writeScopes: readonly string[]
  readonly chain: LoopChainDef
  readonly roundsStarted: number
}

/** Whether this live process may automatically advance the current round. */
export type LoopActivation = 'armed' | 'disarmed'

/** Current loop view: the durable snapshot plus process-local activation. */
export interface LoopView {
  readonly loop: LoopSnapshot
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: LoopActivation
}

/** One evaluator verdict, fixed schema, settled through `loop/node`. */
export interface LoopVerdict {
  readonly decision: 'continue' | 'complete' | 'blocked'
  readonly feedback?: string
  readonly reason?: string
}

/** One settled node report plus its ledger coordinates. */
export interface LoopNodeReport {
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  readonly attempt: number
  readonly report: unknown
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    loop: LoopProjectionState
  }
  interface SessionProjectionMap {
    /**
     * The session's current loop (the latest `loop/change` whole value) plus
     * the append-only node ledger, or `null` before the first create and
     * after a clear tombstone. The `loop/change` fold is last-wins; ledger
     * events fold into the ledger map by `{round, nodeIndex, attempt}`.
     */
    loop: LoopProjection | null
  }
}

/** Current loop projection: the durable snapshot plus the folded ledger. */
export interface LoopProjection {
  readonly loop?: LoopSnapshot
  readonly ledger: readonly LoopLedgerEntry[]
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly lastRef?: LoopRef
}

/** Strict checkpoint state used to derive the current loop client value. */
export interface LoopProjectionState {
  /** Latest valid current loop, or null before the first create and after a clear tombstone. */
  readonly current: LoopProjection | null
  /** Loop identities already created in this Session, retained to reject reuse. */
  readonly seenLoopIds: LoopId[]
  /** First strict replay failure, or null while the durable stream is valid. */
  readonly failure: string | null
  /** Fork seed boundary; inherited prefix loop events belong to the parent run. */
  readonly inheritedEventCount: SessionLogOffset
}

/** One ledger entry: a spawn, a failure, or a settlement. */
export type LoopLedgerEntry =
  | { readonly kind: 'node-started'; readonly round: number; readonly nodeIndex: number; readonly role: string; readonly attempt: number; readonly childSessionId: SessionId; readonly cwd: string; readonly atRevision: number }
  | { readonly kind: 'attempt'; readonly round: number; readonly nodeIndex: number; readonly attempt: number; readonly failure: { readonly code: string; readonly message: string }; readonly atRevision: number }
  | { readonly kind: 'settlement'; readonly round: number; readonly nodeIndex: number; readonly role: string; readonly attempt: number; readonly childSessionId: SessionId; readonly cwd: string; readonly report: unknown; readonly atRevision: number }
