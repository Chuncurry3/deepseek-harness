/**
 * Parsing for the human-authored relay chain document: strict YAML validation
 * into the frozen `LoopChainDef` that the loop service persists, plus the
 * default single-worker chain for a start that names no document.
 * @module @deepseek-ai/dsh-loop-chain-driver/chain
 */

import type { LoopChainDef, LoopChainNodeDef } from '@deepseek-ai/dsh-loop'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertObjectJsonSchema, JsonSchemaError } from '@deepseek-ai/dsh-tools'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/** Role instruction for the default chain's single worker node. */
const DEFAULT_WORKER_PROMPT = 'Advance the objective, then report status, summary, evidence, and next steps.'

/** Require visible content, mirroring the durable fold's non-empty string rule. */
const visibleString = (message: string) =>
  z.string().refine(value => value.trim().length > 0, message)

/** Require visible content without surrounding whitespace, mirroring the durable fold's normalized string rule. */
const normalizedString = (message: string) =>
  z.string().refine(value => value.trim().length > 0 && value === value.trim(), message)

/** The objective rule and its message, shared by the document schema and the default chain. */
const OBJECTIVE_MESSAGE = 'objective must be a non-empty string without surrounding whitespace'
const objectiveSchema = normalizedString(OBJECTIVE_MESSAGE)

/** One declared input session, branded at parse time exactly like the durable fold. */
const inputRefSchema = z.strictObject({
  session: visibleString('session must be a non-empty string').transform(SessionId),
})

/** One node output override, held to the same object-rooted JSON Schema subset the durable fold enforces. */
const outputOverrideSchema = z.unknown()
  .superRefine((value, ctx) => {
    try {
      assertObjectJsonSchema(value)
    } catch (error) {
      /* v8 ignore next -- assertObjectJsonSchema throws only JsonSchemaError; the rethrow keeps an unexpected failure loud. */
      if (!(error instanceof JsonSchemaError)) throw error
      ctx.addIssue({
        code: 'custom',
        message: `output must be an object-rooted JSON Schema in the supported subset: ${error.violations.join('; ')}`,
      })
    }
  })
  .transform((value) => {
    assertObjectJsonSchema(value)
    return value
  })

/** One chain node exactly as the document spells it; unrecognized keys are rejected. */
const nodeSchema = z.strictObject({
  role: normalizedString('role must be a non-empty string without surrounding whitespace'),
  prompt: visibleString('prompt must be a non-empty string'),
  cwd: visibleString('cwd must be a non-empty string').optional(),
  output: outputOverrideSchema.optional(),
  inputs: z.array(inputRefSchema).optional(),
  carryOver: z.array(visibleString('carryOver entry must be a non-empty string')).optional(),
})

/** The whole chain document; every parsed chain must also survive the durable fold's replay validation. */
const chainDocumentSchema = z.strictObject({
  objective: objectiveSchema,
  exit: visibleString('exit must be a non-empty string').optional(),
  checkpoint: z.enum(['none', 'node']).default('none'),
  nodes: z.array(nodeSchema).min(1).superRefine((nodes, ctx) => {
    const seen = new Set<string>()
    for (const node of nodes) {
      if (seen.has(node.role)) ctx.addIssue({ code: 'custom', message: `node role must be unique: ${node.role}` })
      seen.add(node.role)
    }
  }),
  evaluator: z.strictObject({
    prompt: visibleString('evaluator prompt must be a non-empty string'),
  }).optional(),
}).superRefine((document, ctx) => {
  const roles = new Set(document.nodes.map(node => node.role))
  for (const [index, node] of document.nodes.entries()) {
    for (const named of node.carryOver ?? []) {
      if (!roles.has(named)) {
        ctx.addIssue({ code: 'custom', message: `carryOver names an unknown role: ${named}`, path: ['nodes', index, 'carryOver'] })
      }
    }
  }
})

/** Parse the YAML text itself, turning a syntax failure into a direct error. */
function parseYamlDocument(source: string): unknown {
  try {
    return parseYaml(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`loop chain document is not valid YAML: ${detail}`)
  }
}

/** Rebuild one parsed node as the frozen definition, keeping absent optional keys absent. */
function toNodeDef(node: z.infer<typeof nodeSchema>): LoopChainNodeDef {
  return {
    role: node.role,
    prompt: node.prompt,
    ...node.cwd === undefined ? {} : { cwd: node.cwd },
    ...node.output === undefined ? {} : { output: node.output },
    ...node.inputs === undefined ? {} : { inputs: node.inputs },
    ...node.carryOver === undefined ? {} : { carryOver: node.carryOver },
  }
}

/** Render every validation issue as one path-prefixed line of a single aggregate error. */
function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map(issue => `- ${issue.path.length === 0 ? 'document' : issue.path.join('.')}: ${issue.message}`)
  return `loop chain document is invalid:\n${lines.join('\n')}`
}

/**
 * Parse one human-authored chain document into the frozen chain definition the
 * loop service persists. Validation is strict and loud: unknown keys, duplicate
 * roles, unknown carryOver references, blank strings, and output overrides
 * outside the object-rooted JSON Schema subset all fail with one aggregate
 * error naming every offending path.
 * @param source - the chain document text, in YAML.
 * @returns The validated chain definition; an absent `checkpoint` defaults to
 * `'none'` and a document `evaluator.prompt` maps to `evaluatorPrompt`.
 * @throws When the source is not valid YAML or fails chain validation.
 */
export function parseChainDocument(source: string): LoopChainDef {
  const parsed = chainDocumentSchema.safeParse(parseYamlDocument(source))
  if (!parsed.success) throw new Error(formatIssues(parsed.error))
  const document = parsed.data
  const evaluatorPrompt = document.evaluator?.prompt
  return {
    objective: document.objective,
    checkpoint: document.checkpoint,
    nodes: document.nodes.map(toNodeDef),
    ...document.exit === undefined ? {} : { exit: document.exit },
    ...evaluatorPrompt === undefined ? {} : { evaluatorPrompt },
  }
}

/**
 * Build the default chain for a start that names no chain document: one
 * `iterate` worker node with the default handoff expectations and no output
 * override. It carries no `evaluatorPrompt` — the default evaluator
 * instruction belongs to the continuation driver that runs the chain, exactly
 * where a document's `evaluator.prompt` override would apply.
 * @param objective - the loop objective the worker advances, held to the same
 * normalized-string rule as a parsed document's objective.
 * @returns The frozen one-node chain definition with checkpointing off.
 * @throws When the objective is blank or carries surrounding whitespace.
 */
export function defaultChain(objective: string): LoopChainDef {
  const parsed = objectiveSchema.safeParse(objective)
  if (!parsed.success) throw new Error(OBJECTIVE_MESSAGE)
  return {
    objective: parsed.data,
    checkpoint: 'none',
    nodes: [{ role: 'iterate', prompt: DEFAULT_WORKER_PROMPT }],
  }
}
