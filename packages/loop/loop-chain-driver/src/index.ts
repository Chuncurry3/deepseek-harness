/**
 * Relay chain continuation driver over public loop, subagent, session, and
 * user-questions services: drives one armed loop through sequential node
 * attempts — one fresh subagent child per attempt inside the node's frozen
 * workspace, settlement only for schema-valid handoff reports, node
 * checkpoints parked in `awaiting-human`, in-flight child recovery from the
 * ledger after a restart, and the evaluator verdict applied exactly once per
 * round.
 * @module @deepseek-ai/dsh-loop-chain-driver
 */

import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { InvariantError } from '@deepseek-ai/dsh-invariants'
import { LoopError } from '@deepseek-ai/dsh-loop'
import type {
  LoopBlockReason,
  LoopChainNodeDef,
  LoopLedgerEntry,
  LoopProjection,
  LoopRef,
  LoopVerdict,
} from '@deepseek-ai/dsh-loop'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  assembleNodePrompt,
  evaluatorInputBudget,
  evaluatorNode,
  handoffSchemaFor,
  settlementFor,
  validateReport,
} from './handoff.ts'
import type { LoopHandoffView } from './handoff.ts'

export { evaluatorNode, VERDICT_SCHEMA } from './handoff.ts'

export const name = 'loop-chain-driver'
export const inject = ['loops', 'subagents', 'sessionProjections', 'agents', 'sessions']

/**
 * Relay chain continuation driver configuration.
 */
export interface Config {
  /** Subagent provider name every loop node child spawns through. */
  provider: string
}

/** Schemastery schema of {@link Config}. */
export const Config: z<Config> = z.object({ provider: z.string() })

/** One spawned node-attempt record of the folded ledger. */
type NodeStarted = Extract<LoopLedgerEntry, { kind: 'node-started' }>

/** Whether a child's structured report survives a lossless JSON round trip. */
function isLosslessReport(value: unknown): value is JsonValue {
  return isJsonValue(value)
}

/** Terminal outcome of driving one node for one round. */
type NodeOutcome = 'settled' | 'retry' | 'stop'

/** Serialized process-local driving state for one exact controlling agent. */
interface DriverState {
  readonly agent: Agent
  /** Latest create-or-resume revision of the current loop: the retry epoch floor. */
  epoch: { readonly loopId: LoopRef['id']; readonly revision: number } | undefined
  /** Cancellation for the in-flight round pass: aborts the open child run and checkpoint ask. */
  controller: AbortController | undefined
  /** Re-drive request coalescing flag. */
  requested: boolean
  /** The in-flight drive-pass promise. */
  run: Promise<void> | undefined
  /** Teardown sentinel: stops accepting new drive passes. */
  stopping: boolean
}

/** Checkpoint answer options in the spec's continue/pause/terminate order. */
const CHECKPOINT_OPTIONS: { label: string; description: string }[] = [
  { label: 'continue', description: 'Drive the next node of this round now.' },
  { label: 'pause', description: 'Park the loop paused; /loop resume re-arms it later.' },
  { label: 'terminate', description: 'Clear the loop and stop relaying.' },
]

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Install relay chain continuation and its race fences.
 * @param ctx - Cordis context carrying the loop, subagent, session projection, and agent services.
 * @param config - driver configuration naming the subagent provider.
 * @throws When the configured provider is blank.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.provider.trim() === '') {
    throw new Error('loop-chain-driver: config provider must be a non-blank subagent provider name')
  }
  const states = new Map<Agent, DriverState>()

  /** Create state for one exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      epoch: undefined,
      controller: undefined,
      requested: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Exact compare-and-set ref of one view. */
  function refOf(view: { readonly loop: LoopRef }): LoopRef {
    return { id: view.loop.id, revision: view.loop.revision }
  }

  /**
   * Whether one projection row carries its current loop: the strict parse and
   * fold contracts guarantee the snapshot, timestamps, and lastRef travel
   * together with it.
   */
  function isCurrentProjection(projection: LoopProjection | null): projection is LoopProjection & {
    readonly loop: LoopHandoffView['loop']
    readonly createdAt: number
    readonly updatedAt: number
  } {
    return projection?.loop !== undefined
  }

  /**
   * The current loop view of one live agent: the folded projection plus the
   * process-local activation.
   * @param state - driving state of the exact agent.
   * @returns the handoff view, or undefined when no current loop exists.
   * @throws When the loop projection is unregistered, its fold failed, or the agent is not live.
   */
  function currentView(state: DriverState): LoopHandoffView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    const projectionState = ctx.sessionProjections.stateOf(state.agent.session, 'loop')
    /* v8 ignore next -- the loop package always registers its projection. */
    if (projectionState === undefined) throw new Error('loop projection is not registered')
    /* v8 ignore next -- the invariant companion isolates replay failures at load before any read. */
    if (projectionState.failure !== null) throw new Error(projectionState.failure)
    const projection = projectionState.current
    if (!isCurrentProjection(projection)) return undefined
    return {
      loop: projection.loop,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
      activation: ctx.loops.activation(state.agent),
      ledger: [...projection.ledger],
    }
  }

  /**
   * The current view while the exact run may still be driven by the open
   * pass: same loop, active phase, armed activation, live fiber and agent.
   * @param state - driving state of the exact agent.
   * @param loopId - the loop the open pass is driving.
   * @returns the fresh view, or undefined when any fence no longer holds.
   */
  function drivableView(state: DriverState, loopId: LoopRef['id']): LoopHandoffView | undefined {
    if (ctx.fiber.state !== FiberState.ACTIVE || state.stopping) return undefined
    const view = currentView(state)
    if (view === undefined || view.loop.id !== loopId) return undefined
    if (view.loop.phase !== 'active' || view.activation !== 'armed') return undefined
    return view
  }

  /** The synthetic evaluator node's index: one past the last worker node. */
  function evaluatorIndexOf(view: LoopHandoffView): number {
    return view.loop.chain.nodes.length
  }

  /** The first unsettled node index of one round: workers in order, then the
   * evaluator; one past the evaluator when the round is settled. */
  function firstUnsettledIndex(view: LoopHandoffView, round: number): number {
    const evaluatorIndex = evaluatorIndexOf(view)
    for (let nodeIndex = 0; nodeIndex <= evaluatorIndex; nodeIndex++) {
      if (settlementFor(view.ledger, round, nodeIndex) === undefined) return nodeIndex
    }
    return evaluatorIndex + 1
  }

  /** The node-started entries of one node index in one round, in ledger order. */
  function nodeStarteds(ledger: readonly LoopLedgerEntry[], round: number, nodeIndex: number): readonly NodeStarted[] {
    return ledger.filter((entry): entry is NodeStarted =>
      entry.kind === 'node-started' && entry.round === round && entry.nodeIndex === nodeIndex)
  }

  /**
   * The next attempt number for one node: one past the highest recorded
   * attempt of any ledger kind, so attempt keys never collide across retry
   * epochs.
   */
  function nextAttemptNumber(view: LoopHandoffView, round: number, nodeIndex: number): number {
    let highest = 0
    for (const entry of view.ledger) {
      if (entry.round === round && entry.nodeIndex === nodeIndex && entry.attempt > highest) highest = entry.attempt
    }
    return highest + 1
  }

  /** Attempts started below the retry epoch floor: the pre-restart history that never counts against the fresh budget. */
  function epochFloorAttempts(view: LoopHandoffView, round: number, nodeIndex: number, floor: number): number {
    let below = 0
    for (const entry of view.ledger) {
      if (entry.round === round && entry.nodeIndex === nodeIndex && entry.atRevision < floor) below += 1
    }
    return below
  }

  /**
   * The open in-flight child of one node: the last node-started entry. The
   * fold replaces a node-started record with its attempt failure or
   * settlement when the attempt closes, so a remaining node-started entry
   * is open by construction.
   */
  function openNodeStarted(view: LoopHandoffView, round: number, nodeIndex: number): NodeStarted | undefined {
    let open: NodeStarted | undefined
    for (const entry of nodeStarteds(view.ledger, round, nodeIndex)) {
      open = entry
    }
    return open
  }

  /** The latest recorded attempt failure of one node, for the retry prompt. */
  function lastAttemptFailure(
    view: LoopHandoffView,
    round: number,
    nodeIndex: number,
  ): { readonly code: string; readonly message: string } | undefined {
    let found: { code: string; message: string } | undefined
    for (const entry of view.ledger) {
      if (entry.kind !== 'attempt' || entry.round !== round || entry.nodeIndex !== nodeIndex) continue
      found = entry.failure
    }
    return found
  }

  /** The round's evaluator verdict, read from its settlement report. */
  function verdictFor(view: LoopHandoffView, round: number): LoopVerdict | undefined {
    const settled = settlementFor(view.ledger, round, evaluatorIndexOf(view))
    /* v8 ignore next -- the evaluator is the final driven node, so every verdict read follows
       its settlement. */
    if (settled === undefined) return undefined
    const report = settled.report
    /* v8 ignore next -- the invariant companion rejects non-record evaluator reports at append time. */
    if (typeof report !== 'object' || report === null) {
      throw new Error(`round ${round} evaluator settlement carries a non-record report`)
    }
    const decision = (report as Record<string, unknown>)['decision']
    /* v8 ignore next -- the invariant companion rejects invalid decisions at append time. */
    if (decision !== 'continue' && decision !== 'complete' && decision !== 'blocked') {
      throw new Error(`round ${round} evaluator settlement carries an invalid decision ${JSON.stringify(decision)}`)
    }
    const feedback = (report as Record<string, unknown>)['feedback']
    const reason = (report as Record<string, unknown>)['reason']
    return {
      decision,
      ...typeof feedback === 'string' ? { feedback } : {},
      ...typeof reason === 'string' ? { reason } : {},
    }
  }

  /** Disarm one agent's loop, tolerating an agent the registry already retired. */
  function disarmQuietly(state: DriverState): void {
    try {
      ctx.loops.disarm(state.agent)
    } catch (error: unknown) {
      /* v8 ignore next -- a retired agent is never in the state map, so disarm cannot reject. */
      ctx.logger.warn(`loop-chain-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Record one terminal block outcome, tolerating a concurrently-moved phase. */
  async function blockFailed(state: DriverState, reason: LoopBlockReason): Promise<void> {
    const view = currentView(state)
    /* v8 ignore next -- a concurrently moved phase or cleared loop owns the terminal outcome already. */
    if (view === undefined || view.loop.phase === 'blocked' || view.loop.phase === 'complete') return
    await ctx.loops.block(state.agent, refOf(view), reason)
  }

  /**
   * The note's pause rule: a pause that interrupts an in-flight child records
   * the open attempt as paused at pause time, so a later resume continues with
   * the next attempt instead of recovering the aborted child.
   * @param state - driving state of the exact agent.
   * @param view - the pre-spawn view whose node-started stays open.
   * @param round - the round being driven.
   * @param nodeIndex - chain node index of the interrupted child.
   * @param node - the frozen node definition.
   * @param attempt - the open attempt number.
   * @param childSessionId - the interrupted child's session id.
   */
  async function recordPausedAttempt(
    state: DriverState,
    view: LoopHandoffView,
    round: number,
    nodeIndex: number,
    node: LoopChainNodeDef,
    attempt: number,
    childSessionId: SessionId,
  ): Promise<void> {
    const current = currentView(state)
    if (current === undefined || current.loop.id !== view.loop.id) return
    if (current.loop.phase !== 'paused') return
    try {
      await ctx.loops.appendAttempt(state.agent, {
        kind: 'attempt',
        loopId: view.loop.id,
        round,
        nodeIndex,
        attempt,
        childSessionId,
        failure: {
          code: 'paused',
          message: `in-flight child ${childSessionId} of node "${node.role}" (round ${round}) was interrupted by a pause`,
        },
      }, current.loop.revision)
    } catch (error: unknown) {
      /* v8 ignore next -- no await separates the phase check from the append, so only a
         concurrently retired agent or cleared loop reaches here; the open node-started
         then belongs to the restart recovery lane. */
      ctx.logger.warn(`loop-chain-driver: could not record the paused attempt for agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /**
   * One drive pass: park an awaiting-human checkpoint answer, or drive one
   * whole round of the armed loop to its verdict application.
   * @param state - driving state of the exact agent.
   */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the pass fence. */
    if (ctx.fiber.state !== FiberState.ACTIVE || state.stopping) return
    if (ctx.agents.get(agent.id) !== agent) return
    const view = currentView(state)
    if (view === undefined) return
    if (view.loop.phase === 'awaiting-human') {
      await reissueCheckpoint(state, view)
      return
    }
    if (view.loop.phase !== 'active' || view.activation !== 'armed') return
    if (view.loop.roundsStarted >= view.loop.maxRounds) {
      await blockFailed(state, {
        code: 'round-limit',
        message: `loop "${view.loop.id}" reached its configured limit of ${view.loop.maxRounds} rounds`,
      })
      return
    }
    try {
      await ctx.sessions.flush(agent.session)
    } catch (error: unknown) {
      await blockFailed(state, {
        code: 'durability-failed',
        message: `session flush before driving round ${view.loop.roundsStarted + 1} failed: ${renderThrown(error)}`,
      })
      return
    }
    const fresh = drivableView(state, view.loop.id)
    if (fresh === undefined) return
    await driveRound(state, fresh)
  }

  /**
   * Drive one round from its first unsettled node to the verdict
   * application: worker nodes in order, the evaluator last.
   * @param state - driving state of the exact agent.
   * @param view - the armed active view opening the pass.
   */
  async function driveRound(state: DriverState, view: LoopHandoffView): Promise<void> {
    const loopId = view.loop.id
    const controller = new AbortController()
    state.controller = controller
    try {
      const round = view.loop.roundsStarted + 1
      /* v8 ignore next -- a cleared-then-recreated loop resets the epoch; its fresh ledger carries
         no pre-restart attempts, so the floor stays 0. */
      const floor = state.epoch?.loopId === loopId ? state.epoch.revision : 0
      await enumerateUnledgeredChildren(state, view, round, controller)
      let current = drivableView(state, loopId)
      /* v8 ignore next -- a pause or clear landing between the enumeration and the first node
         is fenced here; the driveNode fences own the in-node windows. */
      if (current === undefined) return
      const evaluatorIndex = evaluatorIndexOf(current)
      for (let nodeIndex = firstUnsettledIndex(current, round); nodeIndex <= evaluatorIndex; nodeIndex++) {
        current = drivableView(state, loopId)
        /* v8 ignore next -- a pause or clear landing between two node settlements is fenced here;
         the driveNode fences own the in-node windows. */
        if (current === undefined) return
        const outcome = await driveNode(state, current, round, nodeIndex, floor, controller)
        if (outcome === 'stop') return
        if (outcome === 'retry') nodeIndex -= 1
      }
      current = drivableView(state, loopId)
      /* v8 ignore next -- a pause or clear landing between the evaluator settlement and the
         verdict application is fenced here; the driveNode fences own the in-node windows. */
      if (current === undefined) return
      await applyVerdict(state, current, round)
    } finally {
      /* v8 ignore next -- the serialized pass fence runs the previous finally before a new
         pass can install its controller. */
      if (state.controller === controller) state.controller = undefined
    }
  }

  /**
   * Drive one node for one round: recover an in-flight child, or spawn and
   * settle a fresh attempt.
   * @param state - driving state of the exact agent.
   * @param view - the armed active view driving this node.
   * @param round - the round being driven.
   * @param nodeIndex - chain node index; the evaluator occupies `chain.nodes.length`.
   * @param floor - retry epoch floor revision.
   * @param controller - the round pass's cancellation.
   * @returns whether the node settled, needs a retried spawn, or stopped the pass.
   */
  async function driveNode(
    state: DriverState,
    view: LoopHandoffView,
    round: number,
    nodeIndex: number,
    floor: number,
    controller: AbortController,
  ): Promise<NodeOutcome> {
    const { agent } = state
    const loop = view.loop
    const evaluatorIndex = evaluatorIndexOf(view)
    const isEvaluator = nodeIndex === evaluatorIndex
    const node = isEvaluator ? evaluatorNode(loop.chain) : loop.chain.nodes[nodeIndex]
    /* v8 ignore next -- the chain fold guarantees nodeIndex stays inside the frozen node set. */
    if (node === undefined) {
      await blockFailed(state, {
        code: 'node-failed',
        message: `chain node ${nodeIndex} is missing from the frozen chain`,
      })
      return 'stop'
    }
    const maxHandoffChars = ctx.loops.resolved.maxHandoffChars

    const inflight = openNodeStarted(view, round, nodeIndex)
    if (inflight !== undefined) {
      const recovered = await recoverInFlightChild(state, view, round, nodeIndex, node, inflight)
      if (recovered === 'settled') return checkpointAfter(state, loop.id, round, nodeIndex, controller)
      const retry = drivableView(state, loop.id)
      /* v8 ignore next -- the recovered child's settlement pass already fenced the same
         mutations; this re-read only loses to the same race. */
      if (retry === undefined) return 'stop'
      view = retry
    }

    const attempt = nextAttemptNumber(view, round, nodeIndex)
    if (attempt > ctx.loops.resolved.maxNodeRetries + epochFloorAttempts(view, round, nodeIndex, floor)) {
      await blockFailed(state, {
        code: 'node-failed',
        message: `node "${node.role}" (round ${round}) exhausted ${ctx.loops.resolved.maxNodeRetries} retries in the current epoch`,
      })
      return 'stop'
    }
    if (isEvaluator) {
      const budget = evaluatorInputBudget(view, round, ctx.loops.resolved.maxEvaluatorInputChars)
      if (budget.overflow !== undefined) {
        await blockFailed(state, budget.overflow.reason)
        return 'stop'
      }
    }

    const cwd = node.cwd ?? agent.session.header.cwd
    if (cwd === undefined) {
      await blockFailed(state, {
        code: 'node-failed',
        message: `node "${node.role}" (round ${round}) has no workspace: the chain declares no cwd and the controlling session has none`,
      })
      return 'stop'
    }
    // The durable fold validates chain structure on replay but never cross-checks
    // node workspaces against the run's scopes, so a resumed corrupt or hostile
    // log reaches here with an out-of-scope declared cwd. The driver re-asserts
    // the note's spawn-time scope rule with the service's own comparison
    // semantics: exact strings against the frozen, start-time-normalized
    // writeScopes list, skipping nodes whose cwd is the implicitly granted
    // session workspace (exactly like the start-time check).
    if (node.cwd !== undefined && !view.loop.writeScopes.includes(cwd)) {
      await blockFailed(state, {
        code: 'node-failed',
        message: `node "${node.role}" (round ${round}) cwd ${JSON.stringify(cwd)} falls outside the run's write scopes (LOOP_SCOPE_VIOLATION)`,
      })
      return 'stop'
    }

    let run: SubagentRun
    try {
      run = await ctx.subagents.start(config.provider, {
        parent: agent,
        prompt: [{ type: 'text', text: nodePrompt(view, round, nodeIndex) }],
        cwd,
        outputSchema: handoffSchemaFor(node),
        label: node.role,
        signal: controller.signal,
      })
    } catch (error: unknown) {
      /* v8 ignore next -- the agent registry only drops the agent mid-spawn on its own disposal,
         which also aborts the pass through the state fence. */
      if (ctx.agents.get(agent.id) !== agent) return 'stop'
      await blockFailed(state, {
        code: 'node-failed',
        message: `node "${node.role}" (round ${round}) could not spawn through provider "${config.provider}": ${renderThrown(error)}`,
      })
      return 'stop'
    }

    try {
      await ctx.loops.appendNodeStarted(agent, {
        kind: 'node-started',
        loopId: loop.id,
        round,
        nodeIndex,
        role: node.role,
        attempt,
        childSessionId: run.id,
        cwd,
      }, view.loop.revision)
    } catch (error: unknown) {
      await settleRunQuietly(run)
      throw error
    }

    let result: SubagentResult
    try {
      result = await run.result
    } catch (error: unknown) {
      await settleRunQuietly(run)
      await blockFailed(state, {
        code: 'node-failed',
        message: `node "${node.role}" (round ${round}) run rejected on infrastructure: ${renderThrown(error)}`,
      })
      return 'stop'
    }
    await settleRunQuietly(run)
    if (drivableView(state, loop.id) === undefined) {
      // A pause that landed mid-child records its interrupted attempt now, per
      // the note; every other de-fencing leaves the open node-started to the
      // restart recovery lane.
      await recordPausedAttempt(state, view, round, nodeIndex, node, attempt, run.id)
      return 'stop'
    }

    if (result.stopReason !== 'completed' || result.structured === undefined) {
      const failure = result.stopReason !== 'completed'
        ? {
          code: result.stopReason,
          message: result.diagnostic ?? `the child ended with stop reason "${result.stopReason}"`,
        }
        : {
          code: 'missing-structured',
          message: 'the child completed without a structured report satisfying the handoff schema',
        }
      await ctx.loops.appendAttempt(agent, {
        kind: 'attempt',
        loopId: loop.id,
        round,
        nodeIndex,
        attempt,
        childSessionId: run.id,
        failure,
      }, view.loop.revision)
      return 'retry'
    }
    if (!isLosslessReport(result.structured)) {
      await ctx.loops.appendAttempt(agent, {
        kind: 'attempt',
        loopId: loop.id,
        round,
        nodeIndex,
        attempt,
        childSessionId: run.id,
        failure: {
          code: 'invalid-report',
          message: 'the structured report is not a lossless JSON value',
        },
      }, view.loop.revision)
      return 'retry'
    }
    const violations = validateReport(node, result.structured, maxHandoffChars)
    if (violations.length > 0) {
      await ctx.loops.appendAttempt(agent, {
        kind: 'attempt',
        loopId: loop.id,
        round,
        nodeIndex,
        attempt,
        childSessionId: run.id,
        failure: { code: 'invalid-report', message: violations.join('; ') },
      }, view.loop.revision)
      return 'retry'
    }
    await ctx.loops.appendSettlement(agent, {
      kind: 'settlement',
      loopId: loop.id,
      round,
      nodeIndex,
      role: node.role,
      attempt,
      childSessionId: run.id,
      cwd,
      report: result.structured,
    }, view.loop.revision)
    return checkpointAfter(state, loop.id, round, nodeIndex, controller)
  }

  /** The spawn prompt: the assembled carry plus the retry context of the latest recorded failure. */
  function nodePrompt(view: LoopHandoffView, round: number, nodeIndex: number): string {
    const prompt = assembleNodePrompt(view, round, nodeIndex)
    const failure = lastAttemptFailure(view, round, nodeIndex)
    if (failure === undefined) return prompt
    return `${prompt}\n\nPrevious attempt failed and was not accepted: ${failure.code}: ${failure.message}\nReturn a corrected report that satisfies the handoff contract exactly.`
  }

  /**
   * Apply one round's settled evaluator verdict exactly once.
   * @param state - driving state of the exact agent.
   * @param view - the armed active view after the round's last settlement.
   * @param round - the completed round.
   */
  async function applyVerdict(state: DriverState, view: LoopHandoffView, round: number): Promise<void> {
    const { agent } = state
    const verdict = verdictFor(view, round)
    /* v8 ignore next -- the evaluator is the final driven node, so a completed round always carries its settlement. */
    if (verdict === undefined) {
      await blockFailed(state, {
        code: 'evaluator-blocked',
        message: `round ${round} ended without an evaluator verdict`,
      })
      return
    }
    switch (verdict.decision) {
      case 'complete':
        await ctx.loops.complete(agent, refOf(view))
        return
      case 'blocked':
        await ctx.loops.block(agent, refOf(view), {
          code: 'evaluator-blocked',
          message: verdict.reason ?? `round ${round} evaluator verdict blocked the run`,
        })
        return
      case 'continue': {
        /* v8 ignore start -- the drive entry fence blocks an exhausted budget before a round starts, so the application never sees one. */
        if (view.loop.roundsStarted >= view.loop.maxRounds) {
          await ctx.loops.block(agent, refOf(view), {
            code: 'round-limit',
            message: `loop "${view.loop.id}" reached its configured limit of ${view.loop.maxRounds} rounds`,
          })
          return
        }
        /* v8 ignore end */
        await ctx.loops.advance(agent, refOf(view))
        return
      }
    }
  }

  /**
   * Park the checkpoint after one settled worker node, when the chain asks
   * for per-node checkpoints and the final node has not settled yet.
   */
  async function checkpointAfter(
    state: DriverState,
    loopId: LoopRef['id'],
    round: number,
    nodeIndex: number,
    controller: AbortController,
  ): Promise<NodeOutcome> {
    const view = drivableView(state, loopId)
    if (view === undefined) return 'stop'
    if (view.loop.checkpoint !== 'node' || nodeIndex >= evaluatorIndexOf(view)) return 'settled'
    const answer = await checkpoint(state, view, round, nodeIndex, controller)
    return answer === 'continue' ? 'settled' : 'stop'
  }

  /**
   * Ask the human checkpoint question on one awaiting-human loop.
   * @param state - driving state of the exact agent.
   * @param view - the awaiting view to ask about.
   * @param round - the round being driven.
   * @param nodeIndex - the chain node index that just settled, or the settled count when re-issuing.
   * @param controller - cancellation that aborts the open ask.
   * @returns whether the answer continues driving this pass.
   */
  async function checkpoint(
    state: DriverState,
    view: LoopHandoffView,
    round: number,
    nodeIndex: number,
    controller: AbortController,
  ): Promise<'continue' | 'stop'> {
    const { agent } = state
    // A re-issued ask starts on a loop already parked at awaiting-human; only
    // the fresh checkpoint after a settlement transitions there.
    const asked = view.loop.phase === 'awaiting-human' ? view : await ctx.loops.awaitHuman(agent, refOf(view))
    const asker = ctx.get('userQuestions')
    if (asker === undefined) {
      await blockFailed(state, {
        code: 'checkpoint-provider-missing',
        message: 'the user-questions service is not composed; no human answerer can receive the loop checkpoint',
      })
      return 'stop'
    }
    const nodeCount = evaluatorIndexOf(view) + 1
    let answer: AskUserQuestionAnswer
    try {
      answer = await asker.ask({
        questions: [{
          id: 'loop-checkpoint',
          question: `Relay loop round ${round}: ${nodeIndex + 1} of ${nodeCount} nodes settled. Continue the relay, pause it, or terminate it?`,
          header: 'Relay loop checkpoint',
          options: CHECKPOINT_OPTIONS,
        }],
        agent,
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (error instanceof UserQuestionError && error.code === 'ASK_ABORTED') return 'stop'
      if (error instanceof UserQuestionError && error.code === 'NO_PROVIDER') {
        await blockFailed(state, {
          code: 'checkpoint-provider-missing',
          message: `the loop checkpoint had no user-questions answerer: ${error.message}`,
        })
        return 'stop'
      }
      // A failed ask parks the run disarmed: only an explicit resume re-arms
      // and re-issues the question, instead of an automatic re-ask loop.
      ctx.logger.warn(`loop-chain-driver: checkpoint ask failed for agent "${agent.id}": ${renderThrown(error)}`)
      ctx.loops.disarm(agent)
      return 'stop'
    }
    const selected = answer.answers[0]?.selected ?? []
    if (selected.includes('continue')) {
      await ctx.loops.continueFromHuman(agent, refOf(asked))
      return 'continue'
    }
    if (selected.includes('terminate')) {
      await ctx.loops.clear(agent, refOf(asked))
      return 'stop'
    }
    await ctx.loops.pause(agent, refOf(asked))
    return 'stop'
  }

  /**
   * Re-issue the checkpoint ask on one armed awaiting-human loop after a
   * resume: the crashed ask never delivered an answer, so the run asks again.
   */
  async function reissueCheckpoint(state: DriverState, view: LoopHandoffView): Promise<void> {
    if (view.activation !== 'armed') return
    const round = view.loop.roundsStarted + 1
    const settled = view.ledger.filter(entry => entry.kind === 'settlement' && entry.round === round).length
    const asker = ctx.get('userQuestions')
    if (asker === undefined) {
      await blockFailed(state, {
        code: 'checkpoint-provider-missing',
        message: 'the user-questions service is not composed; no human answerer can receive the loop checkpoint',
      })
      return
    }
    const controller = new AbortController()
    state.controller = controller
    try {
      await checkpoint(state, view, round, settled - 1, controller)
    } finally {
      /* v8 ignore next -- the serialized pass fence runs the previous finally before a new
         pass can install its controller. */
      if (state.controller === controller) state.controller = undefined
    }
  }

  /**
   * Recover one in-flight child from the ledger: re-extract its final
   * assistant output, re-validate it, and settle it; a missing or invalid
   * output records the crash and lets the node respawn.
   * @param state - driving state of the exact agent.
   * @param view - the armed active view driving this node.
   * @param round - the round being driven.
   * @param nodeIndex - chain node index of the in-flight child.
   * @param node - the frozen node definition.
   * @param inflight - the open node-started record.
   * @returns whether the child settled, stopped the pass, or crashed and needs a respawn.
   */
  async function recoverInFlightChild(
    state: DriverState,
    view: LoopHandoffView,
    round: number,
    nodeIndex: number,
    node: LoopChainNodeDef,
    inflight: NodeStarted,
  ): Promise<NodeOutcome> {
    const { agent } = state
    const query = ctx.get('sessionQuery')
    let recovered: unknown
    let crashCode = 'interrupted-by-shutdown'
    if (query !== undefined) {
      let events: Parameters<typeof finalAssistantOutput>[0] | undefined
      // The session-query read rejects only when the crashed child's session is
      // missing or unreadable — exactly the interrupted-attempt class.
      try {
        events = (await query.readSurface(inflight.childSessionId)).events
      } catch {
        crashCode = 'interrupted-by-shutdown'
      }
      if (events !== undefined) {
        const output = finalAssistantOutput(events)
        const text = output === undefined
          ? undefined
          : output.map(block => block.type === 'text' ? block.text : '').join('')
        if (text !== undefined && text.trim() !== '') {
          // A JSON syntax failure in the extracted text names an invalid recovered report.
          try {
            recovered = JSON.parse(text)
          } catch {
            crashCode = 'invalid-recovered-report'
          }
        }
      }
    }
    if (recovered !== undefined && isLosslessReport(recovered)) {
      const violations = reportViolations(node, recovered)
      if (violations.length === 0) {
        await ctx.loops.appendSettlement(agent, {
          kind: 'settlement',
          loopId: view.loop.id,
          round,
          nodeIndex,
          role: node.role,
          attempt: inflight.attempt,
          childSessionId: inflight.childSessionId,
          cwd: inflight.cwd,
          report: recovered,
        }, view.loop.revision)
        return 'settled'
      }
      await ctx.loops.appendAttempt(agent, {
        kind: 'attempt',
        loopId: view.loop.id,
        round,
        nodeIndex,
        attempt: inflight.attempt,
        childSessionId: inflight.childSessionId,
        failure: { code: 'invalid-recovered-report', message: violations.join('; ') },
      }, view.loop.revision)
      return 'retry'
    }
    await ctx.loops.appendAttempt(agent, {
      kind: 'attempt',
      loopId: view.loop.id,
      round,
      nodeIndex,
      attempt: inflight.attempt,
      childSessionId: inflight.childSessionId,
      failure: {
        code: crashCode,
        message: `in-flight child ${inflight.childSessionId} of node "${node.role}" (round ${round}) crashed before settlement and left no valid report`,
      },
    }, view.loop.revision)
    return 'retry'
  }

  /**
   * Enumerate the controlling session's catalog children and log the ones
   * absent from the loop ledger as crashed attempts: never recovered, never
   * settled — the crash landed between publication and the node-started append.
   */
  async function enumerateUnledgeredChildren(
    state: DriverState,
    view: LoopHandoffView,
    round: number,
    controller: AbortController,
  ): Promise<void> {
    if (ctx.get('sessionQuery') === undefined) return
    let children: readonly { readonly id: SessionId }[]
    try {
      children = await ctx.subagents.listChildren(state.agent.session.id, controller.signal)
    } catch (error: unknown) {
      ctx.logger.warn(`loop-chain-driver: unledgered-child enumeration failed for agent "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    // The match set spans every ledger entry: the fold closes each ledger key
    // under {round, nodeIndex, attempt} by replacing the open node-started with
    // its attempt failure or settlement, and all three records carry the
    // childSessionId, so a spawned child stays covered through whichever record
    // closed it. Only a crash between publication and the node-started append
    // leaves a child unledgered.
    const ledgerChildren = new Set(view.ledger.map(entry => entry.childSessionId))
    const unledgered = children.filter(child => !ledgerChildren.has(child.id))
    if (unledgered.length > 0) {
      ctx.logger.warn(
        `loop-chain-driver: round ${round} found ${unledgered.length} child session(s) without loop ledger entries (crashed attempts, not recovered): ${unledgered.map(child => child.id).join(', ')}`,
      )
    }
  }

  /** Schema violations of one recovered report, mirroring the driver's settlement validation. */
  function reportViolations(node: LoopChainNodeDef, report: unknown): readonly string[] {
    return validateReport(node, report, ctx.loops.resolved.maxHandoffChars)
  }

  /** Dispose one settled subagent run without letting disposal mask the flow's own outcome. */
  async function settleRunQuietly(run: SubagentRun): Promise<void> {
    try {
      await run.dispose()
    } catch (error: unknown) {
      ctx.logger.warn(`loop-chain-driver: subagent run disposal failed: ${renderThrown(error)}`)
    }
  }

  /**
   * Classify one drive-pass failure: a loop CAS race stops quietly while the
   * durable state already moved; an invariant or checkpoint-provider failure
   * blocks the run node-level; anything else failed to commit durably.
   */
  async function settleDriveFailure(state: DriverState, error: unknown): Promise<void> {
    ctx.logger.warn(`loop-chain-driver: round drive failed for agent "${state.agent.id}": ${renderThrown(error)}`)
    if (error instanceof LoopError) return
    let reason: LoopBlockReason
    if (error instanceof InvariantError) {
      reason = {
        code: 'node-failed',
        message: `the invariant companion rejected a driver append: ${error.message}`,
      }
    } else {
      reason = {
        code: 'durability-failed',
        message: `a loop mutation did not commit durably: ${renderThrown(error)}`,
      }
    }
    await blockFailed(state, reason)
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* jscpd:ignore-start -- deliberate mirror of goal-round-driver's coalescer: the plan mandates
       fencing parity, and the disarm semantics diverge per driver. */
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the pass fence. */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            await settleDriveFailure(state, error)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`loop-chain-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarmQuietly(state)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`loop-chain-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarmQuietly(state)
      retire()
    })
    /* jscpd:ignore-end */
  }

  // One composite effect keeps the drive installed until this plugin's own
  // scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/disposed', ({ agent }) => {
      // Abort the open pass so its initiator boundary settles before the
      // registry's disposal drain; the retired agent records nothing more.
      const state = states.get(agent)
      if (state !== undefined) state.controller?.abort()
      states.delete(agent)
    })
    ctx.on('agent/error', ({ agent }) => {
      const state = stateFor(agent)
      state.controller?.abort()
      requestDrive(state)
    })
    ctx.on('loop/changed', ({ agent, change }) => {
      const state = stateFor(agent)
      if (change.operation === 'create' || change.operation === 'resume') {
        state.epoch = { loopId: change.ref.id, revision: change.ref.revision }
      }
      if (change.operation === 'pause' || change.operation === 'clear') state.controller?.abort()
      requestDrive(state)
    })

    // Loading a continuation driver over existing agents never inherits
    // hidden automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      stateFor(agent)
      ctx.loops.disarm(agent)
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      const waits: Promise<unknown>[] = []
      for (const state of states.values()) {
        state.stopping = true
        state.controller?.abort()
        disarmQuietly(state)
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'loop-chain-driver lifecycle')
}
