/**
 * Coverage for the per-start child workspace on the REAL in-process path: the
 * request cwd overriding the parent session's workspace, the parent-derived
 * fallback when the request omits it, the assertUsableCwd discipline on the
 * continuable path, the durable descriptor record that names the granted
 * workspace, and cold resume restoring that workspace from the persisted
 * child session header.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** One temp directory registered for suite teardown. */
function tempWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

const testSignal = new AbortController().signal

/** Boot the real in-process one-shot stack; the parent session carries `cwd` when given. */
async function setup(script: Script, parentCwd?: string) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    parentCwd === undefined ? {} : { cwd: parentCwd },
  )
  return { ctx, parent }
}

/** Boot the continuable stack with JSONL persistence rooted at a temp directory. */
async function setupPersistent(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = tempWorkspace('dsh-subagent-child-cwd-')
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  // The session-query service backs cold resume and label lookups.
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, root }
}

describe('in-process per-start child cwd', () => {
  it('in-process start sets the child session cwd from the request', async () => {
    const parentCwd = tempWorkspace('dsh-parent-cwd-')
    const childCwd = tempWorkspace('dsh-child-cwd-')
    const { ctx, parent } = await setup([textResponse('child answer')], parentCwd)
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'do X' }],
      parent,
      signal: testSignal,
      cwd: childCwd,
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    // The request cwd wins over the parent session's workspace.
    expect(run.localAgent?.session.header.cwd).toBe(childCwd)
    await run.dispose()
  })

  it('in-process start derives the parent cwd when request.cwd is absent', async () => {
    const parentCwd = tempWorkspace('dsh-parent-cwd-')
    const { ctx, parent } = await setup([textResponse('child answer')], parentCwd)
    const run = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'do X' }],
      parent,
      signal: testSignal,
    })
    await run.result
    expect(run.localAgent?.session.header.cwd).toBe(parentCwd)
    await run.dispose()
  })

  it('startContinuable rejects a relative request cwd', async () => {
    const { ctx, parent } = await setupPersistent([])
    await expect(ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'bad workspace',
      request: { prompt: [{ type: 'text', text: 'nope' }], parent, cwd: 'relative/path' },
      signal: testSignal,
    })).rejects.toThrow('subagent: request cwd must be an absolute path')
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('startContinuable rejects a nonexistent request cwd', async () => {
    const { ctx, parent } = await setupPersistent([])
    const missing = join(tmpdir(), 'dsh-child-cwd-does-not-exist')
    await expect(ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'missing workspace',
      request: { prompt: [{ type: 'text', text: 'nope' }], parent, cwd: missing },
      signal: testSignal,
    })).rejects.toThrow('subagent: request cwd is not an accessible directory')
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('persists the declared cwd in the continuable descriptor and restores the workspace on cold resume', async () => {
    const childCwd = tempWorkspace('dsh-child-cwd-')
    const { ctx, parent, root } = await setupPersistent([textResponse('first')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'workspace task',
      request: { prompt: [{ type: 'text', text: 'workspace task' }], parent, cwd: childCwd },
      signal: testSignal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    const stored = await ctx.sessionPersistence.open(started.childId, 'read')
    // The child session's own header carries the granted workspace...
    expect(stored.header.cwd).toBe(childCwd)
    // ...and the durable descriptor names it for the resumed child.
    const descriptor = (await stored.read()).events.find(event => event.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ cwd: childCwd })
    await stored.close()

    // Cold resume in a fresh process-like context: the child keeps its granted
    // workspace even though the resuming parent runs elsewhere.
    const otherCwd = tempWorkspace('dsh-other-cwd-')
    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root })
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(TestSessionQuery)
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
    fresh.llm.registerAdapter(['mock'], new MockAdapter([textResponse('resumed')]))
    const freshParent = await fresh.agentLoop.create(
      SessionId('parent'),
      { provider: 'mock', model: 'mock' },
      { cwd: otherCwd },
    )
    await fresh.subagents.sendMessage(freshParent, started.childId, [{ type: 'text', text: 'resume it' }], {
      signal: testSignal,
    })
    const resumed = await vi.waitFor(() => {
      const found = fresh.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    expect(resumed.session.header.cwd).toBe(childCwd)
  })
})
