/**
 * Shared stub harness for the subagent service specs: a fake delegating
 * parent, a minimal one-shot start request, a call-counting provider stub,
 * and a freshly booted SubagentRuntime.
 */

import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

const ALL_CAPS: SubagentCapabilities = {
  agentOptions: true,
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
  cwdOverride: true,
}

/** A delegating-parent stand-in carrying only its durable session id. */
export function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

/** A minimal one-shot start request; overrides win by spread. */
export function baseRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'do a thing' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A registry stub that counts starts and records the last resolved request. */
export class StubProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  startCount = 0
  lastRequest: ResolvedSubagentStartRequest | undefined

  constructor(
    readonly name: string,
    readonly capabilities: SubagentCapabilities = ALL_CAPS,
    private readonly outcome: SubagentResult = {
      output: [{ type: 'text', text: 'ok' }],
      stopReason: 'completed',
    },
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.startCount += 1
    this.lastRequest = request
    return {
      id: SessionId(`child:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      result: Promise.resolve(this.outcome),
      async dispose() {},
    }
  }
}

/** Boot a fresh Context with only SubagentRuntime mounted. */
export async function service(): Promise<{ ctx: Context; subagents: SubagentRuntime }> {
  const ctx = new Context()
  // The registry is a required injection of SubagentRuntime (its projection
  // units register in the constructor).
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  return { ctx, subagents: ctx.subagents }
}
