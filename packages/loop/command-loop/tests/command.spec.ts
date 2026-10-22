/** Grammar and Loader-booted execution of the /loop command. */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LoopService, { LOOP_CHANGE_VERSION } from '@deepseek-ai/dsh-loop'
import type { LoopBlockReason, LoopProjection, LoopRef } from '@deepseek-ai/dsh-loop'
import { normalizeScopePath } from '@deepseek-ai/dsh-loop/paths'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as commandLoop from '@deepseek-ai/dsh-command-loop'
import { parseLoopCommand } from '@deepseek-ai/dsh-command-loop'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly root: string
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent around one concrete session. */
function stubAgentForSession(session: Session, ctx: Context): Agent {
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return agent
}

/** Mount the real command registry, loop domain, and the /loop command over one temp workspace. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-command-loop-'))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LoopService)
  const plugin = await ctx.plugin(commandLoop)
  const session = ctx.sessions.create(SessionId(`command-loop-${Math.random()}`), { meta: { cwd: root } })
  const agent = stubAgentForSession(session, ctx)
  await ctx.agents.register(agent)
  return { ctx, agent, session, root, plugin }
}

const harnesses: Harness[] = []

afterEach(async () => {
  for (const mounted of harnesses) {
    await mounted.ctx.fiber.dispose()
    rmSync(mounted.root, { recursive: true, force: true })
  }
  harnesses.length = 0
})

/** One fresh mounted harness per case. */
async function test(): Promise<Harness> {
  const mounted = await harness()
  harnesses.push(mounted)
  return mounted
}

/** Execute `/loop` through the same registry boundary as a UI adapter. */
async function run(
  mounted: Harness,
  suffix = '',
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await mounted.ctx.commands.execute(
    mounted.agent,
    `/loop${suffix}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('loop command was not registered')
  return execution.result
}

/** The log with executor-owned command lifecycle bookkeeping stripped (loop assertions target domain events). */
function domainEvents(session: Session): readonly SessionEvent[] {
  const events = session.snapshotEvents()
  const lifecycle = new Set<number>()
  for (const event of events) {
    if (event.type !== 'command/run' && event.type !== 'command/done') continue
    lifecycle.add(event.seq)
    // The zero-step wrap around a lifecycle event is bookkeeping too.
    const before = events[event.seq - 1]
    const after = events[event.seq + 1]
    if (before?.type === 'turn/start') lifecycle.add(before.seq)
    if (after?.type === 'turn/end') lifecycle.add(after.seq)
  }
  return events.filter(event => !lifecycle.has(event.seq))
}

/** The controlling session's current loop projection. */
function projection(mounted: Harness): LoopProjection {
  const state = mounted.ctx.sessionProjections.stateOf(mounted.session, 'loop')
  if (state === undefined || state.current === null) throw new Error('no loop projection')
  return state.current
}

/** Current exact compare-and-set ref of the mounted loop. */
function currentRef(mounted: Harness): LoopRef {
  const loop = projection(mounted).loop
  if (loop === undefined) throw new Error('no current loop')
  return { id: loop.id, revision: loop.revision }
}

/** The realpath-normalized scope form of one path. */
function normalized(path: string): string {
  return normalizeScopePath(path)
}

/** One chain document naming worker roles without workspaces. */
function chainDocument(roles: readonly string[]): string {
  return [
    'objective: relay the monthly report',
    'checkpoint: none',
    'nodes:',
    ...roles.flatMap(role => [
      `  - role: ${role}`,
      `    prompt: Do the ${role} work.`,
    ]),
  ].join('\n')
}

describe('parseLoopCommand grammar', () => {
  it('renders status for bare input', () => {
    expect(parseLoopCommand('')).toEqual({ kind: 'show' })
    expect(parseLoopCommand('   ')).toEqual({ kind: 'show' })
  })

  it('starts with repeatable quoted --read/--write flags and zero escaping', () => {
    const input = 'iterate the tool --read "E:\\a b" --read E:\\c --write "E:\\d;e" --max-rounds 5 --checkpoint node'
    expect(parseLoopCommand(input)).toEqual({
      kind: 'start',
      objective: 'iterate the tool',
      reads: ['E:\\a b', 'E:\\c'],
      writes: ['E:\\d;e'],
      maxRounds: 5,
      checkpoint: 'node',
    })
  })

  it('strips double quotes with content verbatim and rejects unterminated runs', () => {
    const command = parseLoopCommand('iterate --read "E:\\a b;c" --write "x;y"')
    expect(command.kind).toBe('start')
    if (command.kind !== 'start') throw new Error('unreachable')
    expect(command.reads).toEqual(['E:\\a b;c'])
    expect(command.writes).toEqual(['x;y'])
    expect(() => parseLoopCommand('obj --read "E:\\a')).toThrow(/unterminated/)
    // A quote opens a quoted run only at a token start; embedded quotes stay literal.
    expect(parseLoopCommand('obj"ective"')).toEqual({ kind: 'start', objective: 'obj"ective"', reads: [], writes: [] })
    // A quoted value may look like a flag; quoting makes it data.
    expect(parseLoopCommand('obj --read "--weird"').kind === 'start').toBe(true)
    // A quoted flag-looking token after a verb is objective data, not a flag.
    expect(parseLoopCommand('resume "--from" direct')).toEqual({
      kind: 'start',
      objective: 'resume --from direct',
      reads: [],
      writes: [],
    })
  })

  it('recognizes the exact lifecycle verbs, case-insensitively, and nothing more', () => {
    expect(parseLoopCommand('pause')).toEqual({ kind: 'pause' })
    expect(parseLoopCommand('PAUSE')).toEqual({ kind: 'pause' })
    expect(parseLoopCommand('Resume')).toEqual({ kind: 'resume' })
    expect(parseLoopCommand('clear')).toEqual({ kind: 'clear' })
    expect(parseLoopCommand('optimize the tool')).toEqual({
      kind: 'start',
      objective: 'optimize the tool',
      reads: [],
      writes: [],
    })
    // Like /goal, only the exact verb is a control word; trailing words make an objective.
    expect(parseLoopCommand('pause now')).toEqual({ kind: 'start', objective: 'pause now', reads: [], writes: [] })
    expect(parseLoopCommand('clear the workspace')).toEqual({
      kind: 'start',
      objective: 'clear the workspace',
      reads: [],
      writes: [],
    })
    expect(parseLoopCommand('resumed')).toEqual({ kind: 'start', objective: 'resumed', reads: [], writes: [] })
  })

  it('rejects an empty or blank objective and trims padded quotes', () => {
    expect(() => parseLoopCommand('""')).toThrow(/objective/)
    expect(() => parseLoopCommand('"  "')).toThrow(/objective/)
    expect(parseLoopCommand('" hi "')).toEqual({ kind: 'start', objective: 'hi', reads: [], writes: [] })
    expect(parseLoopCommand('" a" padded ')).toEqual({ kind: 'start', objective: 'a padded', reads: [], writes: [] })
  })

  it('treats status and start as control words, not objectives', () => {
    expect(parseLoopCommand('status')).toEqual({ kind: 'show' })
    expect(parseLoopCommand('STATUS')).toEqual({ kind: 'show' })
    // status is a control word only as the complete input; trailing words make an objective.
    expect(parseLoopCommand('status of the run')).toEqual({
      kind: 'start',
      objective: 'status of the run',
      reads: [],
      writes: [],
    })
    // The note spells /loop start <objective>; the verb is optional prefix data.
    expect(parseLoopCommand('start iterate the tool')).toEqual({
      kind: 'start',
      objective: 'iterate the tool',
      reads: [],
      writes: [],
    })
    expect(parseLoopCommand('START iterate')).toEqual({ kind: 'start', objective: 'iterate', reads: [], writes: [] })
    expect(() => parseLoopCommand('start --read "E:\\x"')).toThrow(/objective/)
    expect(parseLoopCommand('start')).toEqual({ kind: 'invalid-start' })
  })

  it('parses an optional --from target on resume only', () => {
    expect(parseLoopCommand('resume --from direct')).toEqual({ kind: 'resume', from: 'direct' })
    expect(parseLoopCommand('resume --from "role with spaces"')).toEqual({ kind: 'resume', from: 'role with spaces' })
    // Any non-empty token parses; the frozen chain validates it at execution.
    expect(parseLoopCommand('resume --from 2')).toEqual({ kind: 'resume', from: '2' })
    expect(parseLoopCommand('resume extra')).toEqual({ kind: 'start', objective: 'resume extra', reads: [], writes: [] })
    expect(() => parseLoopCommand('resume --from')).toThrow(/--from/)
    expect(() => parseLoopCommand('resume --from ""')).toThrow(/non-empty/)
    // Extra input after the --from value is a resume-grammar violation, not a start.
    expect(() => parseLoopCommand('resume --from direct extra')).toThrow(/at most one --from value/)
  })

  it('fails loud when a flag lacks its value', () => {
    expect(() => parseLoopCommand('obj --read')).toThrow(/--read/)
    expect(() => parseLoopCommand('obj --chain')).toThrow(/--chain/)
    expect(() => parseLoopCommand('obj --max-rounds')).toThrow(/--max-rounds/)
    expect(() => parseLoopCommand('obj --checkpoint')).toThrow(/--checkpoint/)
    expect(() => parseLoopCommand('obj --read --write x')).toThrow(/--read/)
  })

  it('fails loud on unknown, repeated, or misplaced flags and values', () => {
    expect(() => parseLoopCommand('obj --bogus x')).toThrow(/unknown/)
    expect(() => parseLoopCommand('obj --chain a.yaml --chain b.yaml')).toThrow(/--chain/)
    expect(() => parseLoopCommand('obj --max-rounds 3 --max-rounds 4')).toThrow(/--max-rounds/)
    expect(() => parseLoopCommand('obj --checkpoint none --checkpoint node')).toThrow(/--checkpoint/)
    expect(() => parseLoopCommand('--read path')).toThrow(/objective/)
    expect(() => parseLoopCommand('obj --read a stray')).toThrow(/unexpected/)
    expect(() => parseLoopCommand('obj --read ""')).toThrow(/non-empty/)
  })

  it('validates --max-rounds as a positive integer and --checkpoint as none or node', () => {
    const bounded = parseLoopCommand('obj --max-rounds 1')
    if (bounded.kind !== 'start') throw new Error('unreachable')
    expect(bounded.maxRounds).toBe(1)
    expect(() => parseLoopCommand('obj --max-rounds 0')).toThrow(/positive integer/)
    expect(() => parseLoopCommand('obj --max-rounds -1')).toThrow(/positive integer/)
    expect(() => parseLoopCommand('obj --max-rounds 2.5')).toThrow(/positive integer/)
    expect(() => parseLoopCommand('obj --max-rounds five')).toThrow(/positive integer/)
    expect(() => parseLoopCommand('obj --checkpoint always')).toThrow(/none or node/)
  })
})

describe('@deepseek-ai/dsh-command-loop registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const mounted = await test()
    expect(commandLoop.name).toBe('command-loop')
    expect(commandLoop.inject).toEqual(['commands', 'loops', 'sessionProjections'])
    expect('default' in commandLoop).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandLoop)).toBe(commandLoop)

    expect(mounted.ctx.commands.list(mounted.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-loop',
      name: 'loop',
      description: 'Start or view a cross-session relay loop',
      input: { hint: '[<objective>|pause|resume|clear]' },
    })
    expect(mounted.ctx.commands.find(mounted.agent, 'loop')).toBeDefined()

    await mounted.plugin.dispose()
    expect(mounted.ctx.commands.find(mounted.agent, 'loop')).toBeUndefined()
  })
})

describe('/loop human command', () => {
  it('shows an empty status without mutating the session', async () => {
    const mounted = await test()
    await expect(run(mounted)).resolves.toEqual({
      kind: 'success',
      text: 'No loop is currently set.\nUsage: /loop [status] | [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node] | pause | resume [--from <node|role>] | clear',
    })
    expect(domainEvents(mounted.session)).toEqual([])
  })

  it('refuses a bare start and a blank quoted objective as direct errors', async () => {
    const mounted = await test()
    const bare = await run(mounted, ' start')
    expect(bare).toEqual({
      kind: 'error',
      text: 'Starting a loop requires an objective.\nUsage: /loop [status] | [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node] | pause | resume [--from <node|role>] | clear',
    })
    const blank = await run(mounted, ' ""')
    expect(blank.kind).toBe('error')
    expect(blank.text).toContain('the /loop start objective is required')
    expect(blank.text).toContain('Usage: /loop')
    expect(domainEvents(mounted.session)).toEqual([])
  })

  it('starts through the start verb with flags', async () => {
    const mounted = await test()
    const created = await run(mounted, ' start iterate the tool --max-rounds 3')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('Objective: iterate the tool')
    expect(created.text).toContain('Rounds: 0/3')
  })

  it('shows status for the status control word instead of starting an objective', async () => {
    const mounted = await test()
    const empty = await run(mounted, ' status')
    expect(empty).toEqual({
      kind: 'success',
      text: 'No loop is currently set.\nUsage: /loop [status] | [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node] | pause | resume [--from <node|role>] | clear',
    })
    await run(mounted, ' iterate the tool')
    const count = domainEvents(mounted.session).length
    const shown = await run(mounted, ' STATUS')
    expect(shown.kind).toBe('success')
    expect(shown.text).toContain('Status: active')
    expect(domainEvents(mounted.session)).toHaveLength(count)
  })

  it('starts the default chain armed with the objective and implicit home scope', async () => {
    const mounted = await test()
    const created = await run(mounted, ' iterate the tool ')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('Loop started\nStatus: active')
    expect(created.text).toContain('Objective: iterate the tool')
    expect(created.text).toContain('Rounds: 0/20')
    expect(created.text).toContain('Nodes: 0/2 (round 1)')
    expect(created.text).toContain('Activation: armed')
    expect(created.text).toContain('Commands: /loop pause, /loop clear')
    const loop = projection(mounted).loop
    expect(loop?.chain.nodes.map(node => node.role)).toEqual(['iterate'])
    expect(loop?.readScopes).toEqual([normalized(mounted.root)])
    expect(loop?.writeScopes).toEqual([normalized(mounted.root)])
    expect(domainEvents(mounted.session).map(event => event.type)).toEqual(['loop/change'])
  })

  it('normalizes repeatable --read and --write grants and folds duplicates', async () => {
    const mounted = await test()
    const other = mkdtempSync(join(tmpdir(), 'dsh-command-loop-grant-'))
    try {
      const grant = JSON.stringify(other)
      const created = await run(mounted, ` iterate --write ${grant} --read ${grant} --write ${grant} --max-rounds 3`)
      expect(created.kind).toBe('success')
      const loop = projection(mounted).loop
      expect(loop?.writeScopes).toEqual([normalized(mounted.root), normalized(other)])
      expect(loop?.readScopes).toEqual([normalized(mounted.root), normalized(other)])
      expect(loop?.maxRounds).toBe(3)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('resolves relative grants and declared node workspaces against the controlling workspace', async () => {
    const mounted = await test()
    mkdirSync(join(mounted.root, 'sub-workspace'))
    // A relative grant resolves against the session workspace, never the process's
    // own working directory; no sub-workspace exists next to the process cwd.
    const created = await run(mounted, ' iterate --read sub-workspace --write sub-workspace')
    expect(created.kind).toBe('success')
    const scope = normalized(join(mounted.root, 'sub-workspace'))
    const loop = projection(mounted).loop
    expect(loop?.readScopes).toContain(scope)
    expect(loop?.writeScopes).toContain(scope)

    const relativeMounted = await test()
    mkdirSync(join(relativeMounted.root, 'node-workspace'))
    writeFileSync(
      join(relativeMounted.root, 'loop.yaml'),
      'objective: relay it\ncheckpoint: none\nnodes:\n  - role: worker\n    prompt: Work.\n    cwd: node-workspace\n',
    )
    const withCwd = await run(relativeMounted, ' iterate --write node-workspace')
    expect(withCwd.kind).toBe('success')
    const relativeLoop = projection(relativeMounted).loop
    expect(relativeLoop?.chain.nodes[0]?.cwd).toBe(normalized(join(relativeMounted.root, 'node-workspace')))
    expect(relativeLoop?.writeScopes).toEqual([
      normalized(relativeMounted.root),
      normalized(join(relativeMounted.root, 'node-workspace')),
    ])
  })

  it('resolves a symlinked grant to its real target', async () => {
    const mounted = await test()
    const target = mkdtempSync(join(tmpdir(), 'dsh-command-loop-target-'))
    try {
      const alias = join(mounted.root, 'alias')
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const created = await run(mounted, ` iterate --read ${JSON.stringify(alias)}`)
      expect(created.kind).toBe('success')
      expect(projection(mounted).loop?.readScopes).toContain(normalized(target))
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('refuses a non-existent granted scope with a direct command error', async () => {
    const mounted = await test()
    const missing = join(mounted.root, 'missing-scope')
    const result = await run(mounted, ` iterate --read ${JSON.stringify(missing)}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('ENOENT')
    expect(result.text).toContain(missing)
    expect(domainEvents(mounted.session)).toEqual([])
  })

  it('refuses a file granted as a scope with a direct command error', async () => {
    const mounted = await test()
    const file = join(mounted.root, 'notes.txt')
    writeFileSync(file, 'data')
    // A quoted flag value keeps its content verbatim, like a real typed path.
    const read = await run(mounted, ` iterate --read "${file}"`)
    expect(read.kind).toBe('error')
    expect(read.text).toContain('--read requires a directory scope')
    expect(read.text).toContain(file)
    const write = await run(mounted, ` iterate --write "${file}"`)
    expect(write.kind).toBe('error')
    expect(write.text).toContain('--write requires a directory scope')
    expect(domainEvents(mounted.session)).toEqual([])
  })

  it('starts from the workspace loop.yaml, an explicit --chain document, or the default', async () => {
    const workspaceMounted = await test()
    writeFileSync(join(workspaceMounted.root, 'loop.yaml'), chainDocument(['writer', 'reviewer']))
    const fromWorkspace = await run(workspaceMounted, ' relay it ')
    expect(fromWorkspace.kind).toBe('success')
    expect(fromWorkspace.text).toContain('Nodes: 0/3 (round 1)')
    expect(projection(workspaceMounted).loop?.chain.nodes.map(node => node.role)).toEqual(['writer', 'reviewer'])

    const chainMounted = await test()
    writeFileSync(join(chainMounted.root, 'custom.yaml'), chainDocument(['solo']))
    const relative = await run(chainMounted, ' relay it --chain custom.yaml')
    expect(relative.kind).toBe('success')
    expect(projection(chainMounted).loop?.chain.nodes.map(node => node.role)).toEqual(['solo'])

    const absoluteMounted = await test()
    const absoluteDocument = join(absoluteMounted.root, 'custom.yaml')
    writeFileSync(absoluteDocument, chainDocument(['solo']))
    const absolute = await run(absoluteMounted, ` relay it --chain ${JSON.stringify(absoluteDocument)}`)
    expect(absolute.kind).toBe('success')
    expect(projection(absoluteMounted).loop?.chain.nodes.map(node => node.role)).toEqual(['solo'])

    const defaultMounted = await test()
    const defaulted = await run(defaultMounted, ' relay it ')
    expect(defaulted.kind).toBe('success')
    expect(projection(defaultMounted).loop?.chain.nodes.map(node => node.role)).toEqual(['iterate'])
  })

  it('reports a missing or invalid --chain document as a direct error', async () => {
    const mounted = await test()
    const missing = await run(mounted, ' obj --chain missing.yaml')
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('missing.yaml')
    expect(missing.text).toContain('ENOENT')

    writeFileSync(join(mounted.root, 'broken.yaml'), 'objective: ""\nnodes: []\n')
    const broken = await run(mounted, ' obj --chain broken.yaml')
    expect(broken.kind).toBe('error')
    expect(broken.text).toContain('loop chain document is invalid')
    expect(domainEvents(mounted.session)).toEqual([])
  })

  it('normalizes declared chain workspaces and rejects one outside the write grants', async () => {
    const mounted = await test()
    const nodeWorkspace = join(mounted.root, 'node-workspace')
    mkdirSync(nodeWorkspace)
    writeFileSync(
      join(mounted.root, 'loop.yaml'),
      `objective: relay it\ncheckpoint: none\nnodes:\n  - role: worker\n    prompt: Work.\n    cwd: ${JSON.stringify(nodeWorkspace)}\n`,
    )
    // The write grant is exact-string: the node workspace must be granted,
    // not merely nested inside the controlling workspace.
    const created = await run(mounted, ` relay it --write ${JSON.stringify(nodeWorkspace)}`)
    expect(created.kind).toBe('success')
    const loop = projection(mounted).loop
    expect(loop?.chain.nodes[0]?.cwd).toBe(normalized(nodeWorkspace))
    expect(loop?.writeScopes).toEqual([normalized(mounted.root), normalized(nodeWorkspace)])
    expect(loop?.readScopes).toEqual([normalized(mounted.root), normalized(nodeWorkspace)])

    const refused = await test()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-command-loop-outside-'))
    try {
      writeFileSync(
        join(refused.root, 'loop.yaml'),
        `objective: relay it\ncheckpoint: none\nnodes:\n  - role: worker\n    prompt: Work.\n    cwd: ${JSON.stringify(outside)}\n`,
      )
      const result = await run(refused, ' relay it ')
      expect(result.kind).toBe('error')
      expect(result.text).toContain("falls outside the run's write scopes")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a non-existent declared chain workspace at start', async () => {
    const mounted = await test()
    const missing = join(mounted.root, 'missing-node-workspace')
    writeFileSync(
      join(mounted.root, 'loop.yaml'),
      `objective: relay it\ncheckpoint: none\nnodes:\n  - role: worker\n    prompt: Work.\n    cwd: ${JSON.stringify(missing)}\n`,
    )
    const result = await run(mounted, ' relay it ')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('ENOENT')
  })

  it('refuses silent replacement of an unfinished loop and replaces a completed one', async () => {
    const mounted = await test()
    await run(mounted, ' first objective')
    const count = domainEvents(mounted.session).length
    const refusal = await run(mounted, ' replacement objective')
    expect(refusal).toEqual({
      kind: 'error',
      text: 'A loop is already active. Use /loop clear before starting another.',
    })
    expect(domainEvents(mounted.session)).toHaveLength(count)

    await mounted.ctx.loops.complete(mounted.agent, currentRef(mounted))
    const replacement = await run(mounted, ' second objective')
    expect(replacement.kind).toBe('success')
    expect(replacement.text).toContain('Objective: second objective')
  })

  it('carries --checkpoint into the durable snapshot', async () => {
    const mounted = await test()
    const created = await run(mounted, ' obj --checkpoint node')
    expect(created.kind).toBe('success')
    expect(projection(mounted).loop?.checkpoint).toBe('node')
  })

  it('refuses a start when the controlling session declares no workspace', async () => {
    const mounted = await test()
    const session = mounted.ctx.sessions.create(SessionId(`command-loop-cwdless-${Math.random()}`), {})
    const agent = stubAgentForSession(session, mounted.ctx)
    await mounted.ctx.agents.register(agent)
    const execution = await mounted.ctx.commands.execute(agent, '/loop obj', [], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'The controlling session declares no workspace; /loop start requires one.\nUsage: /loop [status] | [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node] | pause | resume [--from <node|role>] | clear',
    })
    expect(domainEvents(session)).toEqual([])
  })

  it('returns direct missing-state results for pause, resume, and clear', async () => {
    const mounted = await test()
    const missingPause = await run(mounted, ' pause')
    expect(missingPause.kind).toBe('error')
    expect(missingPause.text).toContain('/loop pause requires one')
    const missingResume = await run(mounted, ' resume')
    expect(missingResume.kind).toBe('error')
    expect(missingResume.text).toContain('/loop resume requires one')
    await expect(run(mounted, ' clear')).resolves.toEqual({ kind: 'success', text: 'No loop to clear.' })
  })

  it('pauses, resumes, clears, and converts expected domain rejections to command errors', async () => {
    const mounted = await test()
    await run(mounted, ' work')
    const redundantResume = await run(mounted, ' RESUME')
    expect(redundantResume).toEqual({
      kind: 'error',
      text: 'The loop command is not valid for the current state. Run /loop to view available commands.',
    })
    const paused = await run(mounted, ' PAUSE')
    expect(paused.kind).toBe('success')
    expect(paused.text).toContain('Loop paused\nStatus: paused')
    expect(paused.text).toContain('Activation: disarmed')
    expect(paused.text).toContain('Commands: /loop resume, /loop clear')
    const resumed = await run(mounted, ' resume')
    expect(resumed.kind).toBe('success')
    expect(resumed.text).toContain('Loop resumed\nStatus: active')
    expect(resumed.text).toContain('Activation: armed')
    await expect(run(mounted, ' clear')).resolves.toEqual({ kind: 'success', text: 'Loop cleared.' })
    const cleared = await run(mounted)
    expect(cleared.kind).toBe('success')
    expect(cleared.text).toContain('No loop is currently set')
  })

  it('renders every durable phase with its blocked reason and disarmed hints', async () => {
    const mounted = await test()
    await run(mounted, ' render the phases')

    // active + disarmed: a restarted process renders its resume hint.
    mounted.ctx.loops.disarm(mounted.agent)
    const disarmed = await run(mounted)
    expect(disarmed.text).toContain('Activation: disarmed')
    expect(disarmed.text).toContain('Commands: /loop resume, /loop pause, /loop clear')

    await mounted.ctx.loops.pause(mounted.agent, currentRef(mounted))
    const paused = await run(mounted)
    expect(paused.text).toContain('Status: paused')

    await mounted.ctx.loops.resume(mounted.agent, currentRef(mounted))
    await mounted.ctx.loops.awaitHuman(mounted.agent, currentRef(mounted))
    const awaiting = await run(mounted)
    expect(awaiting.text).toContain('Status: awaiting human')
    expect(awaiting.text).toContain('Commands: /loop resume, /loop clear')

    await mounted.ctx.loops.continueFromHuman(mounted.agent, currentRef(mounted))
    const reason: LoopBlockReason = { code: 'node-failed', message: 'worker exhausted its retries' }
    await mounted.ctx.loops.block(mounted.agent, currentRef(mounted), reason)
    const blocked = await run(mounted)
    expect(blocked.text).toContain('Status: blocked')
    expect(blocked.text).toContain('Blocker: node-failed: worker exhausted its retries')

    await mounted.ctx.loops.resume(mounted.agent, currentRef(mounted))
    await mounted.ctx.loops.complete(mounted.agent, currentRef(mounted))
    const complete = await run(mounted)
    expect(complete.text).toContain('Status: complete')
    expect(complete.text).toContain('Commands: /loop <objective>, /loop clear')
  })

  it('renders the newest settled report digest from the ledger', async () => {
    const mounted = await test()
    await run(mounted, ' digest the reports')
    const loop = projection(mounted).loop
    if (loop === undefined) throw new Error('no current loop')
    const key = {
      loopId: loop.id,
      round: 1,
      nodeIndex: 0,
      role: 'iterate',
      childSessionId: SessionId('loop-child-1'),
      cwd: mounted.root,
    }
    await mounted.ctx.loops.appendNodeStarted(mounted.agent, { ...key, kind: 'node-started', attempt: 1 }, loop.revision)
    await mounted.ctx.loops.appendSettlement(
      mounted.agent,
      { ...key, kind: 'settlement', attempt: 1, report: { status: 'ok', summary: 'round complete' } },
      loop.revision,
    )
    const shown = await run(mounted)
    expect(shown.kind).toBe('success')
    expect(shown.text).toContain('Nodes: 1/2 (round 1)')
    expect(shown.text).toContain('Report: iterate (round 1, node 0): {"status":"ok","summary":"round complete"}')

    // A report longer than the digest cap truncates deterministically.
    await mounted.ctx.loops.appendNodeStarted(mounted.agent, { ...key, kind: 'node-started', attempt: 2 }, loop.revision)
    await mounted.ctx.loops.appendSettlement(
      mounted.agent,
      { ...key, kind: 'settlement', attempt: 2, report: { status: 'ok', summary: 'x'.repeat(200) } },
      loop.revision,
    )
    const truncated = await run(mounted)
    const line = truncated.text?.split('\n').find(part => part.startsWith('Report:'))
    expect(line?.length).toBeLessThanOrEqual('Report: iterate (round 1, node 0): '.length + 120)
    expect(line?.endsWith('...')).toBe(true)

    // An unsettled started entry stays in the ledger without a report line.
    await mounted.ctx.loops.appendNodeStarted(mounted.agent, { ...key, kind: 'node-started', attempt: 3 }, loop.revision)
    const unsettled = await run(mounted)
    expect(unsettled.kind).toBe('success')
    expect(unsettled.text).toContain('Report: iterate (round 1, node 0):')
  })

  it('routes --from through chain validation and the pending replay lane', async () => {
    const mounted = await test()
    const missing = await run(mounted, ' resume --from iterate')
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('/loop resume requires one')

    await run(mounted, ' route the replay')
    const unknown = await run(mounted, ' resume --from nonexistent-role')
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('names no node of the frozen chain')
    expect(unknown.text).toContain('iterate, evaluator, 0, 1')

    const known = await run(mounted, ' resume --from iterate')
    expect(known.kind).toBe('error')
    expect(known.text).toContain('no replay-from-node continuation accepts it yet')
    const byIndex = await run(mounted, ' resume --from 1')
    expect(byIndex.kind).toBe('error')
    expect(byIndex.text).toContain('no replay-from-node continuation accepts it yet')
    // A parsed but unwired --from performs no mutation.
    expect(domainEvents(mounted.session).filter(event => event.type === 'loop/change')).toHaveLength(1)
  })

  it('surfaces a failed loop projection as a dispatch failure', async () => {
    const ctx = new Context()
    const root = mkdtempSync(join(tmpdir(), 'dsh-command-loop-corrupt-'))
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LoopService)
    await ctx.plugin(commandLoop)
    try {
      const create = {
        kind: 'loop/change',
        version: LOOP_CHANGE_VERSION,
        operation: 'create',
        loop: {
          id: 'loop-corrupt-1',
          revision: 1,
          objective: 'corrupt',
          phase: 'active',
          maxRounds: 20,
          checkpoint: 'none',
          readScopes: [root],
          writeScopes: [root],
          chain: { objective: 'corrupt', checkpoint: 'none', nodes: [{ role: 'iterate', prompt: 'Work.' }] },
          roundsStarted: 0,
        },
        createdAt: 0,
        updatedAt: 0,
      }
      const event = (seq: number, data: unknown): SessionEvent => ({ type: 'loop/change', seq, time: seq, data }) as SessionEvent
      const session = ctx.sessions.create(SessionId('loop-corrupt'), { seed: [event(0, create), event(1, create)] })
      const agent = stubAgentForSession(session, ctx)
      await ctx.agents.register(agent)
      await expect(ctx.commands.execute(agent, '/loop', [], new AbortController().signal)).rejects.toThrow(/loop replay failed/)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('converts grammar failures into direct command errors with the usage line', async () => {
    const mounted = await test()
    const result = await run(mounted, ' obj --read')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('flag --read requires a value')
    expect(result.text).toContain('Usage: /loop')
    expect(domainEvents(mounted.session)).toEqual([])
  })
})
