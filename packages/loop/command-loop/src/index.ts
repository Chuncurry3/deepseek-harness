/**
 * Human-facing `/loop` command over the event-sourced cross-session relay
 * loop: the start grammar with repeatable scope grants, the exact lifecycle
 * verbs, start-time chain and scope resolution, and status rendering of the
 * durable loop state. @module @deepseek-ai/dsh-command-loop
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { LoopError } from '@deepseek-ai/dsh-loop'
import type {
  LoopActivation,
  LoopChainDef,
  LoopChainNodeDef,
  LoopLedgerEntry,
  LoopPhase,
  LoopRef,
  LoopSnapshot,
  StartLoopRequest,
} from '@deepseek-ai/dsh-loop'
import { normalizeScopePath } from '@deepseek-ai/dsh-loop/paths'
import { defaultChain, parseChainDocument } from '@deepseek-ai/dsh-loop-chain-driver/chain'
import type {} from '@deepseek-ai/dsh-session-projection'

export const name = 'command-loop'
export const inject = ['commands', 'loops', 'sessionProjections']

const USAGE = 'Usage: /loop [status] | [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node] | pause | resume [--from <node|role>] | clear'

/** Stable text for expected loop state rejections, mirroring the /goal command. */
const LOOP_COMMAND_INVALID = 'The loop command is not valid for the current state. Run /loop to view available commands.'

/** One parsed `/loop` invocation: the show view, one start, or one lifecycle verb. */
export type LoopCommand =
  | { readonly kind: 'show' }
  | {
    readonly kind: 'start'
    readonly objective: string
    /** Granted read scopes, verbatim as typed; normalized at execution. */
    readonly reads: readonly string[]
    /** Granted write scopes, verbatim as typed; normalized at execution. */
    readonly writes: readonly string[]
    /** Chain document path, resolved against the controlling workspace when relative. */
    readonly chain?: string
    readonly maxRounds?: number
    readonly checkpoint?: 'none' | 'node'
  }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume'; readonly from?: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'invalid-start' }

/** One whitespace-split token: the token text and the value of its `quoted` field. */
interface Token {
  readonly text: string
  readonly quoted: boolean
}

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/** Human-readable text of a thrown value. */
function renderThrown(value: unknown): string {
  /* v8 ignore next -- every throw site reachable here constructs an Error; the lane keeps a future non-Error throw readable. */
  return value instanceof Error ? value.message : String(value)
}

/**
 * Split one command line into tokens: whitespace-separated runs, with a
 * double-quoted run becoming one token whose content is verbatim (zero
 * escaping). A quote opens a quoted run only at a token start.
 * @param input - trimmed command text after the `/loop` name.
 * @returns the tokens, each with its text and `quoted` field value.
 * @throws When a double-quoted run is unterminated.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    if (/\s/u.test(input.charAt(index))) {
      index++
      continue
    }
    if (input.charAt(index) === '"') {
      const close = input.indexOf('"', index + 1)
      if (close < 0) throw new Error('unterminated double-quoted value')
      tokens.push({ text: input.slice(index + 1, close), quoted: true })
      index = close + 1
      continue
    }
    let end = index
    while (end < input.length && !/\s/u.test(input.charAt(end))) end++
    tokens.push({ text: input.slice(index, end), quoted: false })
    index = end
  }
  return tokens
}

/** Whether one token acts as a flag (an unquoted `--` prefix). */
function isFlag(token: Token): boolean {
  return !token.quoted && token.text.startsWith('--')
}

/** Whether one token acts as the exact verb named by its lowercased text. */
function isVerb(token: Token, verb: string): boolean {
  return !isFlag(token) && token.text.toLowerCase() === verb
}

/** Consume the value of one flag from the remaining tokens.
 * @param flag - the flag being read, for error text.
 * @param tokens - the tokens after the flag.
 * @returns the value text and the tokens after the value.
 * @throws When no value follows, the value is another flag, or the value is empty.
 */
function flagValue(flag: string, tokens: readonly Token[]): { value: string; rest: readonly Token[] } {
  const [token] = tokens
  if (token === undefined || isFlag(token)) throw new Error(`flag ${flag} requires a value`)
  if (token.text.length === 0) throw new Error(`flag ${flag} requires a non-empty value`)
  return { value: token.text, rest: tokens.slice(1) }
}

/** Try to parse the tail of the `resume` verb: empty, or one `--from` value.
 * @param tokens - the tokens after the verb.
 * @returns the resume command, or undefined when the tail is not resume-shaped.
 * @throws When `--from` appears without a value, with an empty value, or with input after its value.
 */
function tryParseResumeTail(tokens: readonly Token[]): LoopCommand | undefined {
  const [flag, value, ...after] = tokens
  if (flag === undefined) return { kind: 'resume' }
  if (flag.text !== '--from' || !isFlag(flag)) return undefined
  if (value === undefined) throw new Error('flag --from requires a value')
  if (value.text.length === 0) throw new Error('flag --from requires a non-empty value')
  if (after.length > 0) throw new Error('resume accepts at most one --from value')
  return { kind: 'resume', from: value.text }
}

/** Split the leading flag tokens off the token stream.
 * @param tokens - the remaining tokens.
 * @returns the leading flag and the tokens after it, or undefined when none remain.
 */
function nextFlag(tokens: readonly Token[]): { flag: Token; rest: readonly Token[] } | undefined {
  const [flag, ...rest] = tokens
  return flag === undefined ? undefined : { flag, rest }
}

/** Parse the start form: the objective token run, then flags.
 * @param tokens - the whole token stream.
 * @returns the parsed start.
 * @throws When the objective is missing or blank, a flag is repeated, unknown, or valueless, or input follows the flags.
 */
function parseStart(tokens: readonly Token[]): LoopCommand {
  const objective: string[] = []
  const tail: Token[] = []
  let flags = false
  for (const token of tokens) {
    if (!flags && !isFlag(token)) {
      objective.push(token.text)
      continue
    }
    flags = true
    tail.push(token)
  }
  const objectiveText = objective.join(' ').trim()
  if (objectiveText.length === 0) throw new Error('the /loop start objective is required before any flag')
  const reads: string[] = []
  const writes: string[] = []
  let chain: string | undefined
  let maxRounds: number | undefined
  let checkpoint: 'none' | 'node' | undefined
  let remaining: readonly Token[] = tail
  for (let head = nextFlag(remaining); head !== undefined; head = nextFlag(remaining)) {
    const { flag, rest } = head
    if (!isFlag(flag)) throw new Error(`unexpected input after the start flags: ${JSON.stringify(flag.text)}`)
    switch (flag.text) {
      case '--chain': {
        if (chain !== undefined) throw new Error('flag --chain may appear at most once')
        const parsed = flagValue('--chain', rest)
        chain = parsed.value
        remaining = parsed.rest
        break
      }
      case '--read': {
        const parsed = flagValue('--read', rest)
        reads.push(parsed.value)
        remaining = parsed.rest
        break
      }
      case '--write': {
        const parsed = flagValue('--write', rest)
        writes.push(parsed.value)
        remaining = parsed.rest
        break
      }
      case '--max-rounds': {
        if (maxRounds !== undefined) throw new Error('flag --max-rounds may appear at most once')
        const parsed = flagValue('--max-rounds', rest)
        if (!/^\d+$/u.test(parsed.value) || !Number.isSafeInteger(Number(parsed.value)) || Number(parsed.value) < 1) {
          throw new Error(`flag --max-rounds requires a positive integer, got ${JSON.stringify(parsed.value)}`)
        }
        maxRounds = Number(parsed.value)
        remaining = parsed.rest
        break
      }
      case '--checkpoint': {
        if (checkpoint !== undefined) throw new Error('flag --checkpoint may appear at most once')
        const parsed = flagValue('--checkpoint', rest)
        if (parsed.value !== 'none' && parsed.value !== 'node') {
          throw new Error(`flag --checkpoint accepts none or node, got ${JSON.stringify(parsed.value)}`)
        }
        checkpoint = parsed.value
        remaining = parsed.rest
        break
      }
      default:
        throw new Error(`unknown /loop flag: ${flag.text}`)
    }
  }
  return {
    kind: 'start',
    objective: objectiveText,
    reads,
    writes,
    ...(chain === undefined ? {} : { chain }),
    ...(maxRounds === undefined ? {} : { maxRounds }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  }
}

/**
 * Parse the grammar owned by `/loop`: a bare invocation shows status, the
 * exact lifecycle verbs control it, and any other non-empty input is a start.
 * `start` optionally prefixes the start objective — a bare `start` parses as
 * an incomplete start — and `status` shows status when it is the complete
 * input.
 *
 * Double-quoted values lose their quotes and keep their content verbatim;
 * a verb is recognized only when the remaining input fits that verb (nothing
 * after `pause`/`clear`/`status`, at most one `--from` value after `resume`),
 * so `/loop pause now` starts an objective like the `/goal` command's control
 * words.
 * @param rawInput - exact text after the command name, including separator whitespace.
 * @returns the parsed command.
 * @throws When the grammar is violated: a valueless, repeated, or unknown flag, a bad value, or an unterminated quote.
 */
export function parseLoopCommand(rawInput: string): LoopCommand {
  const [first, ...rest] = tokenize(rawInput.trim())
  if (first === undefined) return { kind: 'show' }
  if (isVerb(first, 'pause') || isVerb(first, 'clear')) {
    if (rest.length === 0) return first.text.toLowerCase() === 'pause' ? { kind: 'pause' } : { kind: 'clear' }
  }
  if (isVerb(first, 'resume')) {
    const resume = tryParseResumeTail(rest)
    if (resume !== undefined) return resume
  }
  if (isVerb(first, 'start')) {
    return rest.length === 0 ? { kind: 'invalid-start' } : parseStart(rest)
  }
  if (isVerb(first, 'status') && rest.length === 0) return { kind: 'show' }
  return parseStart([first, ...rest])
}

/** Human label for one durable loop phase. */
function phaseLabel(phase: LoopPhase): string {
  switch (phase) {
    case 'active': return 'active'
    case 'awaiting-human': return 'awaiting human'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    case 'complete': return 'complete'
    /* v8 ignore next 2 -- LoopPhase is closed and every member is handled above */
    default: return assertNever(phase, 'loop phase')
  }
}

/** The round one render describes: the in-flight round, or the final round once complete. */
function currentRound(loop: LoopSnapshot): number {
  return loop.phase === 'complete' ? loop.roundsStarted : loop.roundsStarted + 1
}

/** Distinct settled node count of one round, the evaluator included. */
function settledNodes(ledger: readonly LoopLedgerEntry[], round: number): number {
  const settled = new Set<number>()
  for (const entry of ledger) {
    if (entry.kind === 'settlement' && entry.round === round) settled.add(entry.nodeIndex)
  }
  return settled.size
}

/** The newest settled report digest line, or nothing when no settlement exists. */
function reportLine(ledger: readonly LoopLedgerEntry[]): string[] {
  let newest: Extract<LoopLedgerEntry, { kind: 'settlement' }> | undefined
  for (const entry of ledger) {
    if (entry.kind === 'settlement') newest = entry
  }
  if (newest === undefined) return []
  const serialized = JSON.stringify(newest.report)
  const digest = serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized
  return [`Report: ${newest.role} (round ${newest.round}, node ${newest.nodeIndex}): ${digest}`]
}

/** Commands that are meaningful from one exact live state. */
function commandHint(loop: LoopSnapshot, activation: LoopActivation): string {
  if (loop.phase === 'active') {
    return activation === 'armed'
      ? '/loop pause, /loop clear'
      : '/loop resume, /loop pause, /loop clear'
  }
  switch (loop.phase) {
    case 'awaiting-human':
    case 'paused':
    case 'blocked':
      return '/loop resume, /loop clear'
    case 'complete':
      return '/loop <objective>, /loop clear'
    /* v8 ignore next 2 -- the active branch and every non-active phase are handled above */
    default: return assertNever(loop.phase, 'loop phase')
  }
}

/** The loop state a render shows: the durable snapshot, the ledger, and the process-local activation. */
interface LoopView {
  readonly loop: LoopSnapshot
  readonly ledger: readonly LoopLedgerEntry[]
  readonly activation: LoopActivation
}

/** Render direct UI output from durable loop state and the ledger, nothing ambient. */
function renderLoop(title: string, view: LoopView): CommandResult {
  const loop = view.loop
  const reason = loop.phase === 'blocked' ? loop.blockedReason : undefined
  /* v8 ignore next -- durable replay guarantees every blocked loop carries its validated reason. */
  if (loop.phase === 'blocked' && reason === undefined) throw new TypeError('blocked loop is missing its reason')
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return {
    kind: 'success',
    text: [
      title,
      `Status: ${phaseLabel(loop.phase)}`,
      ...blocker,
      `Objective: ${loop.objective}`,
      `Rounds: ${loop.roundsStarted}/${loop.maxRounds}`,
      `Nodes: ${settledNodes(view.ledger, currentRound(loop))}/${loop.chain.nodes.length + 1} (round ${currentRound(loop)})`,
      `Activation: ${view.activation}`,
      ...reportLine(view.ledger),
      '',
      `Commands: ${commandHint(loop, view.activation)}`,
    ].join('\n'),
  }
}

/** The current loop of one agent, read through the loop session projection. */
function currentLoop(ctx: Context, agent: CommandInvocation['agent']): LoopView | undefined {
  const state = ctx.sessionProjections.stateOf(agent.session, 'loop')
  /* v8 ignore next -- the loop package always registers its projection. */
  if (state === undefined) throw new Error('loop projection is not registered')
  /* v8 ignore next -- the invariant companion isolates replay failures at load before any read. */
  if (state.failure !== null) throw new Error(state.failure)
  const projection = state.current
  if (projection === null || projection.loop === undefined) return undefined
  return { loop: projection.loop, ledger: projection.ledger, activation: ctx.loops.activation(agent) }
}

/** Exact current compare-and-set ref. */
function loopRef(loop: LoopSnapshot): LoopRef {
  return { id: loop.id, revision: loop.revision }
}

/** Read the `--chain` document, resolved against the controlling workspace when relative.
 * @param file - the chain document path as typed.
 * @param home - the controlling session's workspace.
 * @returns the document text.
 * @throws When the file cannot be read (a missing `--chain` document is a direct command error).
 */
function readChainDocument(file: string, home: string): string {
  const path = isAbsolute(file) ? file : join(home, file)
  return readFileSync(path, 'utf8')
}

/** The workspace `loop.yaml` text, or undefined when the workspace has none. */
function workspaceChainDocument(home: string): string | undefined {
  const path = join(home, 'loop.yaml')
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
}

/** Load the frozen chain: the `--chain` document, the workspace `loop.yaml`, or the default chain.
 * @param command - the parsed start.
 * @param home - the controlling session's workspace.
 * @returns the validated chain definition.
 * @throws When the named document is unreadable or fails strict validation.
 */
function loadChain(command: Extract<LoopCommand, { kind: 'start' }>, home: string): LoopChainDef {
  const document = command.chain === undefined ? workspaceChainDocument(home) : readChainDocument(command.chain, home)
  return document === undefined ? defaultChain(command.objective) : parseChainDocument(document)
}

/** Append one normalized scope unless it is already present. */
function pushScope(scopes: string[], scope: string): void {
  if (!scopes.includes(scope)) scopes.push(scope)
}

/** Resolve one typed path against the controlling workspace, like a relative `--chain` document.
 * @param raw - the path as typed; an absolute path stays untouched.
 * @param home - the controlling session's workspace, the base for relative paths.
 * @returns the absolute path.
 */
function resolveAgainstHome(raw: string, home: string): string {
  return isAbsolute(raw) ? raw : join(home, raw)
}

/** Normalize one granted scope and require it to name an enterable directory.
 * @param flag - the flag carrying the grant, for error text.
 * @param grant - the granted path as typed; relative paths resolve against the controlling workspace.
 * @param home - the controlling session's workspace, the base for relative grants.
 * @returns the realpath-normalized directory scope.
 * @throws When the grant does not exist or is not a directory.
 */
function normalizeGrant(flag: string, grant: string, home: string): string {
  const scope = normalizeScopePath(resolveAgainstHome(grant, home))
  if (!statSync(scope).isDirectory()) {
    throw new Error(`flag ${flag} requires a directory scope, got ${grant}`)
  }
  return scope
}

/** Normalize every declared chain node workspace in place of the raw text.
 * @param chain - the validated chain.
 * @param home - the controlling session's workspace, the base for relative node workspaces.
 * @returns the chain with realpath-normalized node workspaces.
 * @throws When a declared workspace does not exist.
 */
function normalizeChainCwds(chain: LoopChainDef, home: string): LoopChainDef {
  const nodes = chain.nodes.map((node): LoopChainNodeDef =>
    node.cwd === undefined ? node : { ...node, cwd: normalizeScopePath(resolveAgainstHome(node.cwd, home)) })
  return { ...chain, nodes }
}

/** Resolve one start into a validated request: the chain, and the normalized scope unions.
 *
 * `writeScopes` is the controlling workspace plus the `--write` grants;
 * `readScopes` is the controlling workspace, every declared chain node
 * workspace, and the `--read` grants. Relative grants and declared node
 * workspaces resolve against the controlling workspace — the same base as a
 * relative `--chain` document — so no path-typed input resolves against the
 * process's own working directory; absolute paths stay untouched. Every
 * path is realpath-normalized, so the service's exact-string membership
 * check and the driver's spawn-time re-assert compare the same form. Every
 * granted scope must name an enterable directory: a frozen scope that no
 * run workspace can match is a direct error at start.
 * @param command - the parsed start.
 * @param home - the controlling session's workspace.
 * @returns the validated start request.
 * @throws When a granted path does not exist or is not a directory, a declared path does not exist, or the chain document is invalid.
 */
function resolveStartRequest(command: Extract<LoopCommand, { kind: 'start' }>, home: string): StartLoopRequest {
  const homeScope = normalizeScopePath(home)
  const writeScopes: string[] = []
  const readScopes: string[] = []
  pushScope(writeScopes, homeScope)
  for (const grant of command.writes) pushScope(writeScopes, normalizeGrant('--write', grant, home))
  const chain = normalizeChainCwds(loadChain(command, home), home)
  pushScope(readScopes, homeScope)
  for (const node of chain.nodes) {
    if (node.cwd !== undefined) pushScope(readScopes, node.cwd)
  }
  for (const grant of command.reads) pushScope(readScopes, normalizeGrant('--read', grant, home))
  return {
    objective: command.objective,
    chain,
    readScopes,
    writeScopes,
    ...(command.maxRounds === undefined ? {} : { maxRounds: command.maxRounds }),
    ...(command.checkpoint === undefined ? {} : { checkpoint: command.checkpoint }),
  }
}

/** Valid `--from` targets of one frozen chain: every node role, the evaluator, and every node index. */
function chainTargets(chain: LoopChainDef): readonly string[] {
  return [
    ...chain.nodes.map(node => node.role),
    'evaluator',
    ...chain.nodes.map((_, index) => String(index)),
    String(chain.nodes.length),
  ]
}

/** Direct error for a verb that requires a current loop. */
function missingLoop(action: string): CommandResult {
  return { kind: 'error', text: `No loop is currently set; /loop ${action} requires one.` }
}

/** Execute one parsed `/loop` command against the loop service. */
async function executeLoopCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  let command: LoopCommand
  try {
    command = parseLoopCommand(invocation.rawInput)
  } catch (error: unknown) {
    return { kind: 'error', text: `${renderThrown(error)}\n${USAGE}` }
  }
  try {
    const current = currentLoop(ctx, invocation.agent)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: `No loop is currently set.\n${USAGE}` }
          : renderLoop('Loop', current)
      case 'start': {
        if (current !== undefined && current.loop.phase !== 'complete') {
          return { kind: 'error', text: `A loop is already ${phaseLabel(current.loop.phase)}. Use /loop clear before starting another.` }
        }
        const home = invocation.agent.session.header.cwd
        if (home === undefined) {
          return { kind: 'error', text: `The controlling session declares no workspace; /loop start requires one.\n${USAGE}` }
        }
        let request: StartLoopRequest
        try {
          request = resolveStartRequest(command, home)
        } catch (error: unknown) {
          return { kind: 'error', text: `${renderThrown(error)}\n${USAGE}` }
        }
        const created = await ctx.loops.start(invocation.agent, request)
        return renderLoop('Loop started', { loop: created.loop, ledger: [], activation: created.activation })
      }
      case 'invalid-start':
        return { kind: 'error', text: `Starting a loop requires an objective.\n${USAGE}` }
      case 'pause': {
        if (current === undefined) return missingLoop('pause')
        const paused = await ctx.loops.pause(invocation.agent, loopRef(current.loop))
        return renderLoop('Loop paused', { loop: paused.loop, ledger: current.ledger, activation: paused.activation })
      }
      case 'resume': {
        if (current === undefined) return missingLoop('resume')
        if (command.from !== undefined) {
          const targets = chainTargets(current.loop.chain)
          if (!targets.includes(command.from)) {
            return {
              kind: 'error',
              text: `--from ${JSON.stringify(command.from)} names no node of the frozen chain; valid targets: ${targets.join(', ')}.`,
            }
          }
          return {
            kind: 'error',
            text: '/loop resume --from is parsed but no replay-from-node continuation accepts it yet; /loop resume continues from the first unsettled node.',
          }
        }
        const resumed = await ctx.loops.resume(invocation.agent, loopRef(current.loop))
        return renderLoop('Loop resumed', { loop: resumed.loop, ledger: current.ledger, activation: resumed.activation })
      }
      case 'clear': {
        if (current === undefined) return { kind: 'success', text: 'No loop to clear.' }
        await ctx.loops.clear(invocation.agent, loopRef(current.loop))
        return { kind: 'success', text: 'Loop cleared.' }
      }
      /* v8 ignore next 2 -- LoopCommand is closed and every member is handled above */
      default: return assertNever(command, 'loop command')
    }
  } catch (error: unknown) {
    if (error instanceof LoopError) {
      return error.code === 'LOOP_SCOPE_VIOLATION'
        ? { kind: 'error', text: `${error.message}\n${USAGE}` }
        : { kind: 'error', text: LOOP_COMMAND_INVALID }
    }
    throw error
  }
}

/** Register the Codex-shaped `/loop` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-loop'),
    name: 'loop',
    description: 'Start or view a cross-session relay loop',
    input: { hint: '[<objective>|pause|resume|clear]' },
    handler: invocation => executeLoopCommand(ctx, invocation),
  })
}
