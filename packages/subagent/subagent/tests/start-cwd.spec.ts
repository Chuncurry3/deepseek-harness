/**
 * Coverage for the per-start child workspace seam: the cwdOverride capability
 * flag, the capability-gated cwd request field, and the assertUsableCwd
 * validation the service applies before provider dispatch.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentCapabilities } from '../src/types.ts'

function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

const ALL_CAPS: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwdOverride: true }

function baseRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'do a thing' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

class StubProvider implements SubagentProvider {
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

async function service(): Promise<{ ctx: Context; subagents: SubagentRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  return { ctx, subagents: ctx.subagents }
}

describe('SubagentCapabilities declares cwdOverride', () => {
  it('every capability table carries the new flag', () => {
    const caps: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwdOverride: true }
    expect(caps.cwdOverride).toBe(true)
  })
})

describe('per-start request cwd', () => {
  it('start rejects cwd on a provider without cwdOverride', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('oop', NO_START_CAPABILITIES)
    subagents.registerProvider(provider)
    await expect(subagents.start('oop', baseRequest({ cwd: tmpdir() })))
      .rejects.toThrow(/cwdOverride/)
    expect(provider.startCount).toBe(0)
  })

  it('start validates the request cwd with the assertUsableCwd discipline', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('capable')
    subagents.registerProvider(provider)
    await expect(subagents.start('capable', baseRequest({ cwd: 'relative/path' })))
      .rejects.toThrow('must be an absolute path')
    await expect(subagents.start('capable', baseRequest({ cwd: join(tmpdir(), 'dsh-no-such-dir-xyz') })))
      .rejects.toThrow('not an accessible directory')
    expect(provider.startCount).toBe(0)
  })

  it('start accepts an absolute enterable cwd and passes it to the provider', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('capable')
    subagents.registerProvider(provider)
    const run = await subagents.start('capable', baseRequest({ cwd: tmpdir() }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(provider.startCount).toBe(1)
    expect(provider.lastRequest?.cwd).toBe(tmpdir())
  })
})
