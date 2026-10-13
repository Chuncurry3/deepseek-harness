/**
 * Shared fold-invariant companion plumbing for durable session event streams.
 * A package owning a versioned event stream keeps an independent incremental
 * fold over attached sessions and validates every candidate event before
 * publication; this module owns the staging machinery so each package
 * companion supplies only its decoder, accumulator, seeding history, and
 * failure attribution.
 *
 * @module dsh-session/fold-companion
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Package-specific fold behavior and failure attribution for one durable stream. */
export interface FoldInvariantConfig<State> {
  /** Stream name embedded in failure attribution, such as `goal` or `loop`. */
  readonly stream: string
  /** Build an empty fold accumulator. */
  readonly emptyState: () => State
  /** Copy the accumulator so candidate validation cannot mutate committed state. */
  readonly cloneState: (state: State) => State
  /** Apply one event through the package's strict decoder; violations throw. */
  readonly applyEvent: (state: State, event: SessionEvent) => void
  /** Session history a fresh fold replays: the full snapshot, or a fork's own events. */
  readonly seedEvents: (session: Session) => Iterable<SessionEvent>
}

/**
 * Install one package's fold-based stream invariant into a registration's
 * child context; the companion's local `install` function delegates here.
 *
 * Keeps one independent incremental fold per attached session under a
 * two-phase staging contract: `internal/dispatch` validates every candidate
 * `session/event` on a cloned fold and stages the result keyed by the
 * dispatched event object; the `session/event` listener then commits the
 * staged fold only when publication carries the exact staged event for the
 * same session. A publication without a matching staged candidate fails the
 * invariant, so no event bypasses validation, and a candidate rejected
 * during dispatch leaves the committed fold untouched. Decoder failures are
 * attributed with `config.stream` in the failure message.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to the registering package name.
 * @param config - package-owned fold behavior and failure attribution.
 */
export function installFoldInvariant<State>(
  ctx: Context,
  fail: InvariantFailure,
  config: FoldInvariantConfig<State>,
): void {
  const states = new WeakMap<Session, State>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: State }>()

  const applyChecked = (state: State, event: SessionEvent): void => {
    try {
      config.applyEvent(state, event)
    } catch (error) {
      /* v8 ignore next -- strict stream decoders throw Error instances */
      const message = error instanceof Error ? error.message : String(error)
      fail(`session event ${event.seq} violates the durable ${config.stream} stream: ${message}`)
    }
  }

  const seed = (session: Session): State => {
    const state = config.emptyState()
    for (const event of config.seedEvents(session)) applyChecked(state, event)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): State => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = config.cloneState(stateFor(session))
    applyChecked(state, event)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail(`session/event reached publication without matching ${config.stream}-fold validation`)
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}
