/** Package-owned durable goal-stream invariants. @module @deepseek-ai/dsh-goal/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { installFoldInvariant } from '@deepseek-ai/dsh-session'
import { applyGoalEvent, emptyGoalFoldState } from './fold.ts'
import type { GoalFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-goal'

/** Cordis companion plugin name. */
export const name = 'goal-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  installFoldInvariant<GoalFoldState>(ctx, fail, {
    stream: 'goal',
    emptyState: emptyGoalFoldState,
    cloneState,
    applyEvent: applyGoalEvent,
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    seedEvents: session => session.snapshotEvents(),
  })
}, { inject: ['sessions'] })

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: GoalFoldState): GoalFoldState {
  return {
    goal: state.goal,
    roundsStarted: state.roundsStarted,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRef: state.lastRef,
    seenGoalIds: new Set(state.seenGoalIds),
  }
}

/**
 * Register the goal-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
