/**
 * Lean-push, lossless-pull handoff for relay chain nodes: the typed carry
 * contract one node prompt renders, settlement validation of handed-over
 * reports, and the evaluator input aggregate budget. Pure functions over the
 * folded loop view; budget caps arrive as parameters from the resolved loop
 * config, never from a Config dependency.
 * @module @deepseek-ai/dsh-loop-chain-driver/handoff
 */

import type { LoopBlockReason, LoopChainDef, LoopChainNodeDef, LoopLedgerEntry, LoopView } from '@deepseek-ai/dsh-loop'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

/** One settlement entry of the folded node ledger. */
type Settlement = Extract<LoopLedgerEntry, { kind: 'settlement' }>

/**
 * Default evaluator role instruction applied when the chain omits
 * `evaluatorPrompt`. A document's `evaluator.prompt` override replaces it.
 */
export const DEFAULT_EVALUATOR_INSTRUCTION
  = 'Judge whether this round\'s carried reports meet the exit criteria — or the objective when no '
    + 'exit criteria are declared — and return a verdict: decision "continue" when another round is '
    + 'needed, "complete" when the objective is met, or "blocked" when the run cannot proceed. '
    + 'Include feedback for the next round when you continue, and a reason when you block.'

/** The driver-owned `inherited` property form: one string entry per declared input session. */
const inheritedSchema = { type: 'array', items: { type: 'string' } } as const

/**
 * The fixed report schema the final evaluator node settles against: a
 * `decision` of `continue`, `complete`, or `blocked`, with optional feedback
 * for the next round and a reason when blocking. Every round's verdict
 * application reads this exact shape from the settlement.
 */
export const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    feedback: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['decision'],
  additionalProperties: false,
}

/**
 * The synthetic final node every round drives: the evaluator. Its role
 * instruction is the chain's `evaluatorPrompt` or the default instruction,
 * and its report schema is the fixed verdict schema.
 * @param chain - the frozen chain definition.
 * @returns the evaluator node definition occupying `chain.nodes.length`.
 */
export function evaluatorNode(chain: LoopChainDef): LoopChainNodeDef {
  return {
    role: 'evaluator',
    prompt: chain.evaluatorPrompt ?? DEFAULT_EVALUATOR_INSTRUCTION,
    output: VERDICT_SCHEMA,
  }
}

/**
 * The default handoff schema applied when a node omits `output`: `status`
 * (string), `summary` (string), `evidence` (array of string), and
 * `nextSteps` (array of string), plus the optional `inherited` array an
 * inputs-free node may still report. An explicit `output` override replaces
 * the four default fields wholesale; the driver-injected `inherited`
 * requirement applies on top of whichever schema applies.
 */
export const DEFAULT_HANDOFF_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    inherited: inheritedSchema,
  },
  required: ['status', 'summary', 'evidence', 'nextSteps'],
  additionalProperties: false,
}

/** The driver's read of one current loop: the loop view plus the folded node ledger. */
export interface LoopHandoffView extends LoopView {
  /** Folded node ledger of the current loop; settlements carry the reports and child session ids. */
  readonly ledger: readonly LoopLedgerEntry[]
}

/** One report the visibility rule carries into a node prompt. */
export interface CarriedReport {
  /** Round the report was settled in. */
  readonly round: number
  /** Chain node index the report was settled at. */
  readonly nodeIndex: number
  /** Role that settled the report. */
  readonly role: string
  /** Child session the report came from; the pull target for its detail. */
  readonly childSessionId: SessionId
  /** The validated settlement report value. */
  readonly report: unknown
}

/**
 * The typed carry contract: exactly the content one node prompt renders. The
 * reports are the settlements the chain's visibility rule names — same-round
 * predecessors plus `carryOver` prior-round reports — and the feedback is
 * the prior round's `continue` verdict feedback. Raw transcripts never
 * enter: the receiving node pulls input and prior child sessions on demand
 * through the read scopes.
 */
export interface NodeHandoffCarry {
  readonly objective: string
  readonly round: number
  readonly nodeIndex: number
  /** Worker nodes plus the evaluator. */
  readonly nodeCount: number
  readonly role: string
  /** The frozen role instruction: the node's `prompt`, or the evaluator instruction. */
  readonly roleInstruction: string
  /** Exit criteria; the evaluator only. */
  readonly exit?: string
  readonly reports: readonly CarriedReport[]
  /** Opening evaluator feedback; the first node, `carryOver`-declaring nodes, and the evaluator. */
  readonly feedback?: string
  /** Declared input session ids, in declaration order. */
  readonly inputSessionIds: readonly SessionId[]
  /** Child sessions of every carried report plus the feedback's source settlement. */
  readonly priorChildSessionIds: readonly SessionId[]
  /** The frozen read scopes the loop session query tools serve reads inside. */
  readonly readScopes: readonly string[]
}

/** One measured contributor of the evaluator input aggregate. */
interface BudgetEntry {
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  readonly reportChars: number
}

/**
 * The evaluator input aggregate measurement for one round: the serialized
 * round reports plus the opening feedback, in UTF-16 code units.
 */
export interface EvaluatorInputBudget {
  /** Serialized UTF-16 code units of the round's reports plus the opening feedback. */
  readonly totalChars: number
  /**
   * Present when the aggregate exceeds the cap: the `report-budget` block
   * ingredients. The offending report is the largest contributor; the
   * feedback attributes to the prior round's evaluator settlement.
   */
  readonly overflow?: {
    /** The round whose evaluator input overflowed. */
    readonly round: number
    /** The offending report's own round (the prior round for feedback). */
    readonly reportRound: number
    /** The offending report's chain node index. */
    readonly nodeIndex: number
    /** The offending report's role. */
    readonly role: string
    /** Serialized UTF-16 code units of the offending report. */
    readonly reportChars: number
    /** Code units past the cap. */
    readonly exceededChars: number
    /** Ready block reason: code `report-budget`, message naming the round, node, report, and exceeded characters. */
    readonly reason: LoopBlockReason
  }
}

/** Whether a value is a JSON record rather than an array or primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The latest settlement of one node index in one round, or undefined.
 * @param ledger - folded node ledger of the current loop.
 * @param round - the relay round the settlement belongs to.
 * @param nodeIndex - the chain node index the settlement closes.
 * @returns the highest-attempt settlement record, or undefined when the node is unsettled.
 */
export function settlementFor(ledger: readonly LoopLedgerEntry[], round: number, nodeIndex: number): Settlement | undefined {
  let found: Settlement | undefined
  for (const entry of ledger) {
    if (entry.kind !== 'settlement' || entry.round !== round || entry.nodeIndex !== nodeIndex) continue
    if (found === undefined || entry.attempt > found.attempt) found = entry
  }
  return found
}

/** The prior round's `continue`-verdict feedback and the settlement it came from. */
interface VerdictFeedback {
  readonly feedback: string
  readonly settlement: Settlement
}

/** The prior round's evaluator feedback when it settled `continue` with visible feedback. */
function verdictFeedback(ledger: readonly LoopLedgerEntry[], priorRound: number, evaluatorIndex: number): VerdictFeedback | undefined {
  const settled = settlementFor(ledger, priorRound, evaluatorIndex)
  const report = settled?.report
  if (settled === undefined || !isRecord(report) || report['decision'] !== 'continue') return undefined
  const feedback = report['feedback']
  return typeof feedback === 'string' && feedback.length > 0 ? { feedback, settlement: settled } : undefined
}

/**
 * Assemble one node's typed carry from the folded loop view.
 * @param view - current loop view plus the folded node ledger.
 * @param round - the round being driven; `roundsStarted` lags it by one while the round is in flight.
 * @param nodeIndex - chain node index; the evaluator occupies `chain.nodes.length`.
 * @returns The schema-validated carry the node prompt renders.
 * @throws When the round is not a positive safe integer, the node index is out of the frozen chain, or the carry fails its schema.
 */
export function assembleNodeCarry(view: LoopHandoffView, round: number, nodeIndex: number): NodeHandoffCarry {
  const chain = view.loop.chain
  const evaluatorIndex = chain.nodes.length
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new Error(`node handoff round must be a positive safe integer, received ${round}`)
  }
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0 || nodeIndex > evaluatorIndex) {
    throw new Error(`node index ${nodeIndex} is outside the frozen chain's declared node set (0..${evaluatorIndex})`)
  }
  const isEvaluator = nodeIndex === evaluatorIndex
  const node = chain.nodes[nodeIndex]
  const role = isEvaluator ? 'evaluator' : node?.role
  const roleInstruction = isEvaluator ? (chain.evaluatorPrompt ?? DEFAULT_EVALUATOR_INSTRUCTION) : node?.prompt
  /* v8 ignore next -- nodeIndex was bounds-checked against the frozen chain above. */
  if (role === undefined || roleInstruction === undefined) throw new Error(`chain node ${nodeIndex} is missing from the frozen chain`)

  const reports: CarriedReport[] = []
  for (let predecessor = 0; predecessor < nodeIndex; predecessor++) {
    const settled = settlementFor(view.ledger, round, predecessor)
    if (settled === undefined) continue
    reports.push({
      round: settled.round,
      nodeIndex: settled.nodeIndex,
      role: settled.role,
      childSessionId: settled.childSessionId,
      report: settled.report,
    })
  }
  if (!isEvaluator) {
    for (const named of node?.carryOver ?? []) {
      const namedIndex = chain.nodes.findIndex(candidate => candidate.role === named)
      /* v8 ignore next -- the durable fold rejects carryOver roles outside the chain. */
      if (namedIndex < 0) throw new Error(`carryOver role ${named} is not in the frozen chain`)
      const settled = settlementFor(view.ledger, round - 1, namedIndex)
      if (settled === undefined) continue
      reports.push({
        round: settled.round,
        nodeIndex: settled.nodeIndex,
        role: settled.role,
        childSessionId: settled.childSessionId,
        report: settled.report,
      })
    }
  }

  const carriesFeedback = isEvaluator || nodeIndex === 0 || (node?.carryOver?.length ?? 0) > 0
  const verdict = carriesFeedback ? verdictFeedback(view.ledger, round - 1, evaluatorIndex) : undefined

  const priorChildSessionIds: SessionId[] = reports.map(report => report.childSessionId)
  if (verdict !== undefined) priorChildSessionIds.push(verdict.settlement.childSessionId)

  const carry: NodeHandoffCarry = {
    objective: view.loop.objective,
    round,
    nodeIndex,
    nodeCount: evaluatorIndex + 1,
    role,
    roleInstruction,
    reports,
    ...verdict === undefined ? {} : { feedback: verdict.feedback },
    inputSessionIds: isEvaluator ? [] : [...(node?.inputs ?? []).map(input => input.session)],
    priorChildSessionIds,
    readScopes: [...view.loop.readScopes],
    ...isEvaluator && chain.exit !== undefined ? { exit: chain.exit } : {},
  }

  const parsed = nodeCarrySchema.safeParse(carry)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`node handoff carry is invalid: ${issues}`)
  }
  return carry
}

/**
 * Assemble one node's prompt: the carry rendered as the model-facing string.
 * @param view - current loop view plus the folded node ledger.
 * @param round - the round being driven; `roundsStarted` lags it by one while the round is in flight.
 * @param nodeIndex - chain node index; the evaluator occupies `chain.nodes.length`.
 * @returns The rendered node prompt: exactly the visibility rule's named content, never raw transcripts.
 * @throws When the round is not a positive safe integer, the node index is out of the frozen chain, or the carry fails its schema.
 */
export function assembleNodePrompt(view: LoopHandoffView, round: number, nodeIndex: number): string {
  return renderNodePrompt(assembleNodeCarry(view, round, nodeIndex))
}

/** Render one carry as the node prompt string. */
function renderNodePrompt(carry: NodeHandoffCarry): string {
  const sections: string[] = []
  sections.push(`Relay loop round ${carry.round}, node ${carry.nodeIndex + 1} of ${carry.nodeCount}: "${carry.role}".`)
  sections.push(`Objective: ${carry.objective}`)
  if (carry.exit !== undefined) sections.push(`Exit criteria (frozen at loop start):\n${carry.exit}`)
  sections.push(`Role instruction (frozen at loop start):\n${carry.roleInstruction}`)
  if (carry.reports.length === 0) {
    sections.push('Carried reports: none.')
  } else {
    const lines = ['Carried reports (validated settlements only; raw transcripts are never pushed — recover detail on demand through loop_session_search / loop_session_read):']
    for (const entry of carry.reports) {
      lines.push(`- round ${entry.round}, node ${entry.nodeIndex + 1} of ${carry.nodeCount} "${entry.role}" (child session ${entry.childSessionId}): ${JSON.stringify(entry.report)}`)
    }
    sections.push(lines.join('\n'))
  }
  if (carry.feedback !== undefined) {
    sections.push(`Evaluator feedback from the round ${carry.round - 1} verdict:\n${carry.feedback}`)
  }
  if (carry.inputSessionIds.length > 0) {
    const lines = ['Declared input sessions (continue each by reading it on demand through loop_session_search / loop_session_read):']
    for (const session of carry.inputSessionIds) lines.push(`- ${session}`)
    lines.push('Your settled report must carry an "inherited" array with one entry per declared input session, each naming what you adopted from that session.')
    sections.push(lines.join('\n'))
  }
  if (carry.priorChildSessionIds.length > 0) {
    const lines = ['Prior child sessions (recover any carried detail on demand through loop_session_search / loop_session_read):']
    for (const session of carry.priorChildSessionIds) lines.push(`- ${session}`)
    sections.push(lines.join('\n'))
  }
  sections.push(carry.readScopes.length === 0
    ? 'Read scopes: none frozen beyond your own workspace.'
    : ['Read scopes (loop_session_search / loop_session_read serve reads only inside these workspaces and your own):', ...carry.readScopes.map(scope => `- ${scope}`)].join('\n'))
  return sections.join('\n\n')
}

/**
 * The schema one node's reports settle against: the node's `output`
 * override or the default handoff schema, with the driver-owned `inherited`
 * property injected — required, one string entry per declared input — when
 * the node declares `inputs`. The injected property replaces any
 * author-declared `inherited` declaration.
 * @param node - the frozen chain node.
 * @returns The effective object-rooted schema, asserted against the same subset the durable fold enforces.
 * @throws When the effective schema falls outside `assertObjectJsonSchema`'s enforced subset.
 */
export function handoffSchemaFor(node: LoopChainNodeDef): ObjectJsonSchema {
  const base = node.output ?? DEFAULT_HANDOFF_SCHEMA
  if ((node.inputs?.length ?? 0) === 0) {
    assertObjectJsonSchema(base)
    return base
  }
  const injected: ObjectJsonSchema = {
    ...base,
    properties: { ...base.properties, inherited: inheritedSchema },
    required: base.required === undefined ? ['inherited'] : [...new Set([...base.required, 'inherited'])],
  }
  assertObjectJsonSchema(injected)
  return injected
}

/**
 * Validate one candidate node report against the node's handoff contract,
 * without the deployment-configured budget: schema conformance plus the
 * `inherited` entry count. The durable invariant companion reuses this for
 * settled reports, where the handoff budget is not an invariant.
 * @param node - the frozen chain node whose report settles.
 * @param report - the settled or candidate report value.
 * @returns Violations; empty means the report conforms to the node's schema contract.
 * @throws When the effective schema falls outside `assertObjectJsonSchema`'s enforced subset.
 */
export function reportSchemaViolations(node: LoopChainNodeDef, report: unknown): readonly string[] {
  const violations: string[] = [...validateJsonSchemaValue(handoffSchemaFor(node), report)]
  const declared = node.inputs?.length ?? 0
  const inherited = isRecord(report) ? report['inherited'] : undefined
  if (declared > 0 && Array.isArray(inherited) && inherited.length !== declared) {
    violations.push(`inherited must carry exactly ${declared} entries, one per declared input session (found ${inherited.length})`)
  }
  return violations
}

/**
 * Validate one candidate node report against the node's handoff contract.
 * @param node - the frozen chain node whose report is settling.
 * @param report - the candidate structured report value.
 * @param maxHandoffChars - resolved per-character handoff cap, in UTF-16 code units on the serialized report.
 * @returns Violations — schema conformance, the `inherited` entry count, the serialized budget; empty means the report may settle.
 * @throws When the effective schema falls outside `assertObjectJsonSchema`'s enforced subset.
 */
export function validateReport(node: LoopChainNodeDef, report: unknown, maxHandoffChars: number): readonly string[] {
  const violations = [...reportSchemaViolations(node, report)]
  const serialized = JSON.stringify(report)
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JSON.stringify returns undefined for non-JSON values.
  if (serialized !== undefined && serialized.length > maxHandoffChars) {
    violations.push(
      `serialized report is ${serialized.length} characters (UTF-16 code units), exceeding the maxHandoffChars cap of ${maxHandoffChars}`,
    )
  }
  return violations
}

/**
 * Measure the evaluator input aggregate for one round: every serialized
 * round report plus the opening feedback, in UTF-16 code units.
 * @param view - current loop view plus the folded node ledger.
 * @param round - the round whose evaluator input is measured.
 * @param maxEvaluatorInputChars - resolved per-character aggregate cap.
 * @returns The total, plus the `report-budget` block ingredients when the aggregate exceeds the cap.
 * @throws When the round is not a positive safe integer or the assembled evaluator carry fails its schema.
 */
export function evaluatorInputBudget(view: LoopHandoffView, round: number, maxEvaluatorInputChars: number): EvaluatorInputBudget {
  const evaluatorIndex = view.loop.chain.nodes.length
  const carry = assembleNodeCarry(view, round, evaluatorIndex)
  const entries: readonly BudgetEntry[] = carry.reports.map(entry => ({
    round: entry.round,
    nodeIndex: entry.nodeIndex,
    role: entry.role,
    reportChars: JSON.stringify(entry.report).length,
  }))
  const feedbackChars = carry.feedback?.length ?? 0
  const totalChars = entries.reduce((sum, entry) => sum + entry.reportChars, 0) + feedbackChars
  if (totalChars <= maxEvaluatorInputChars) return { totalChars }
  const offenders: readonly BudgetEntry[] = carry.feedback === undefined
    ? entries
    : [...entries, { round: round - 1, nodeIndex: evaluatorIndex, role: 'evaluator', reportChars: feedbackChars }]
  /* v8 ignore next -- the aggregate exceeds a non-negative cap, so at least one contributor exists. */
  const offending = offenders.reduce((largest, entry) =>
    entry.reportChars > largest.reportChars || (entry.reportChars === largest.reportChars && entry.nodeIndex < largest.nodeIndex)
      ? entry
      : largest)
  const exceededChars = totalChars - maxEvaluatorInputChars
  return {
    totalChars,
    overflow: {
      round,
      reportRound: offending.round,
      nodeIndex: offending.nodeIndex,
      role: offending.role,
      reportChars: offending.reportChars,
      exceededChars,
      reason: {
        code: 'report-budget',
        message: `round ${round} evaluator input totals ${totalChars} characters (UTF-16 code units), exceeding the maxEvaluatorInputChars cap of ${maxEvaluatorInputChars} by ${exceededChars}; the largest contributor is the round ${offending.round} node ${offending.nodeIndex + 1} "${offending.role}" report at ${offending.reportChars} characters`,
      },
    },
  }
}

/** Strict mirror of {@link NodeHandoffCarry}: every field type-checked, non-empty where the render requires content. */
const carriedReportSchema = z.strictObject({
  round: z.number().int().positive(),
  nodeIndex: z.number().int().nonnegative(),
  role: z.string().min(1),
  childSessionId: z.string().min(1),
  report: z.json(),
})

/** Strict mirror of {@link NodeHandoffCarry} the assembled carry must satisfy before it renders. */
const nodeCarrySchema = z.strictObject({
  objective: z.string().min(1),
  round: z.number().int().positive(),
  nodeIndex: z.number().int().nonnegative(),
  nodeCount: z.number().int().positive(),
  role: z.string().min(1),
  roleInstruction: z.string().min(1),
  exit: z.string().min(1).optional(),
  reports: z.array(carriedReportSchema),
  feedback: z.string().min(1).optional(),
  inputSessionIds: z.array(z.string().min(1)),
  priorChildSessionIds: z.array(z.string().min(1)),
  readScopes: z.array(z.string().min(1)),
})
