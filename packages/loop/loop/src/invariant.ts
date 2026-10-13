/** Package-owned durable loop-stream invariants. @module @deepseek-ai/dsh-loop/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { installFoldInvariant } from '@deepseek-ai/dsh-session'
import { applyLoopEvent, emptyLoopFoldState } from './fold.ts'
import type { LoopFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-loop'

/** Cordis companion plugin name. */
export const name = 'loop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  installFoldInvariant<LoopFoldState>(ctx, fail, {
    stream: 'loop',
    emptyState: emptyLoopFoldState,
    cloneState,
    applyEvent: applyLoopEvent,
    // A fork folds loop events only from its seed boundary: the inherited
    // prefix is the parent session's run, so the fold starts from own events.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    seedEvents: session => session.ownEvents(),
  })
}, { inject: ['sessions'] })

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: LoopFoldState): LoopFoldState {
  return {
    loop: state.loop,
    ledger: new Map(state.ledger),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRef: state.lastRef,
    currentLoopId: state.currentLoopId,
    seenLoopIds: new Set(state.seenLoopIds),
  }
}

/**
 * Register the loop-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
