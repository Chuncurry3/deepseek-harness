/**
 * Driver-owned durable loop-stream invariants: settlement conformance and
 * verdict-gated advancement.
 * @module @deepseek-ai/dsh-loop-chain-driver/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { decodeLoopChange, decodeLoopLedger } from '@deepseek-ai/dsh-loop'
import type { LoopChainDef, LoopNodeSettledMeta, LoopRef } from '@deepseek-ai/dsh-loop'
import { installFoldInvariant } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { evaluatorNode, reportSchemaViolations } from './handoff.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-loop-chain-driver'

/** Cordis companion plugin name. */
export const name = 'loop-chain-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The current loop's driver-fold identity: chain plus the applied round budget. */
interface CurrentLoop {
  readonly loopId: LoopRef['id']
  readonly chain: LoopChainDef
  roundsStarted: number
}

/** Fold state of the driver-owned loop relationships. */
interface DriverFoldState {
  /** Current loop; undefined before create and after a clear tombstone. */
  current: CurrentLoop | undefined
  /** Evaluator decisions by round, recorded from evaluator settlements. */
  readonly verdicts: Map<number, 'continue' | 'complete' | 'blocked'>
}

/** Build the empty driver fold. */
function emptyDriverFoldState(): DriverFoldState {
  return { current: undefined, verdicts: new Map() }
}

/** Copy the driver fold before validating one candidate event. */
function cloneDriverFoldState(state: DriverFoldState): DriverFoldState {
  return { current: state.current, verdicts: new Map(state.verdicts) }
}

/**
 * Apply one session event to the driver fold: track the current loop and its
 * applied rounds, validate every current-loop settlement against the frozen
 * node's handoff contract, and require every advance to apply a settled
 * `continue` verdict. Events of other loops fold without checks, mirroring
 * the loop projection's own tolerance for historical streams.
 * @param state - fold accumulator to mutate.
 * @param event - the candidate session event.
 * @throws When a settlement violates the frozen node's schema or role, or an advance consumes no `continue` verdict.
 */
function applyDriverEvent(state: DriverFoldState, event: SessionEvent): void {
  if (event.type === 'loop/change') {
    const decoded = decodeLoopChange(event.data)
    /* v8 ignore next 2 -- the loop fold rejects a loop/change event whose payload is not a change record. */
    if (decoded === undefined) throw new Error('loop/change event carries a non-change payload')
    const change = decoded
    if (change.operation === 'clear') {
      state.current = undefined
      state.verdicts.clear()
      return
    }
    const loop = change.loop
    if (change.operation === 'advance' && state.current !== undefined) {
      const applied = state.verdicts.get(loop.roundsStarted)
      if (applied !== 'continue') {
        throw new Error(
          `advance to ${loop.roundsStarted} rounds applies no settled continue verdict for round ${loop.roundsStarted}`,
        )
      }
    }
    if (state.current === undefined) state.verdicts.clear()
    state.current = { loopId: loop.id, chain: loop.chain, roundsStarted: loop.roundsStarted }
    return
  }
  if (event.type !== 'loop/node') return
  // decodeLoopLedger throws unless the payload's kind matches the 'loop/node' key, so the union is the settlement meta.
  const settled = decodeLoopLedger('loop/node', event.data) as LoopNodeSettledMeta
  const current = state.current
  if (current === undefined || settled.loopId !== current.loopId) return
  const evaluatorIndex = current.chain.nodes.length
  if (settled.nodeIndex > evaluatorIndex) {
    throw new Error(`settlement at node index ${settled.nodeIndex} is beyond the evaluator at ${evaluatorIndex}`)
  }
  const node = settled.nodeIndex === evaluatorIndex
    ? evaluatorNode(current.chain)
    : current.chain.nodes[settled.nodeIndex]
  if (node === undefined || settled.role !== node.role) {
    throw new Error(`settlement role "${settled.role}" does not match the frozen chain node ${settled.nodeIndex}`)
  }
  const violations = reportSchemaViolations(node, settled.report)
  if (violations.length > 0) {
    throw new Error(`settlement report of node "${settled.role}" violates its handoff contract: ${violations.join('; ')}`)
  }
  if (settled.nodeIndex === evaluatorIndex) {
    const decision = (settled.report as Record<string, unknown>)['decision']
    state.verdicts.set(settled.round, decision as 'continue' | 'complete' | 'blocked')
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  installFoldInvariant<DriverFoldState>(ctx, fail, {
    stream: 'loop-chain-driver',
    emptyState: emptyDriverFoldState,
    cloneState: cloneDriverFoldState,
    applyEvent: applyDriverEvent,
    // A fork folds driver relationships only from its seed boundary: the
    // inherited prefix is the parent session's run, so the fold starts from
    // own events.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    seedEvents: (session: Session) => session.ownEvents(),
  })
}, { inject: ['sessions'] })

/**
 * Register the loop-chain-driver invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
