/** Package-owned durable loop-stream invariants. @module @deepseek-ai/dsh-loop/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyLoopEvent, emptyLoopFoldState } from './fold.ts'
import type { LoopFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-loop'

/** Cordis companion plugin name. */
export const name = 'loop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

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

/** Apply one event through the strict loop decoders and attribute failures. */
function applyChecked(state: LoopFoldState, event: SessionEvent, fail: InvariantFailure): void {
  try {
    applyLoopEvent(state, event)
  } catch (error) {
    /* v8 ignore next -- the strict loop fold throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    fail(`session event ${event.seq} violates the durable loop stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, LoopFoldState>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: LoopFoldState }>()

  // A fork folds loop events only from its seed boundary: the inherited
  // prefix is the parent session's run, so the fold starts from own events.
  const seed = (session: Session): LoopFoldState => {
    const state = emptyLoopFoldState()
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.ownEvents()) applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): LoopFoldState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = cloneState(stateFor(session))
    applyChecked(state, event, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching loop-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the loop-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
