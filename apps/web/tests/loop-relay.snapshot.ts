// Keyless shipped-Web acceptance for the cross-session relay loop. One /loop
// start through the real command plane arms the loop; the chain driver
// relays through fresh in-process children (a worker report, then the
// evaluator verdict); the bare /loop status renders the settled state.
// Record mode calls the real API through the worktree .env; replay serves
// the recorded children positionally and compares the controlling log.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
// The command and loop event/map merges: without these modules loaded, the
// SessionEvent union lacks 'command/run' and the projection map lacks 'loop'.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-loop'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, recordFixture, recordSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/loop-relay', import.meta.url))
const CONTROLLER_FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const WORKER_FIXTURE = join(SNAPSHOT_DIR, 'session.1.v4.jsonl')
const EVALUATOR_FIXTURE = join(SNAPSHOT_DIR, 'session.2.v4.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

const OBJECTIVE = 'Relay the inventory note into the count report'
const START_LINE = `/loop start "${OBJECTIVE}" --chain loop.yaml --read sibling --max-rounds 1`
const CHAIN_DOCUMENT = `objective: ${OBJECTIVE}
exit: The worker report is settled and the objective is met
evaluator:
  prompt: Do not use any tools. The carried worker report already satisfies the exit criteria, so immediately report decision complete with a reason naming the settled worker report.
nodes:
  - role: inventory-worker
    prompt: Count the inventory named in the read-scope statement, then settle a report with status ok, a summary naming the counted inventory, evidence naming note.txt, nextSteps handing the count to the evaluator, and an empty inherited array.
`

describe('web snapshot: /loop relay chain', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []
  const childSessions: Session[] = []
  let controllerId: SessionId | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      ...(MODE === 'record' ? {} : {
        replayFixture: CONTROLLER_FIXTURE,
        replayChildFixtures: [WORKER_FIXTURE, EVALUATOR_FIXTURE],
        paceMs: 5,
      }),
    })
    scaffold.ctx.on('session/created', (session) => {
      if (session.header.origin === 'subagent') childSessions.push(session)
    })
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.header.parentSession === undefined) events.push(event)
    })
    // The gateway this scenario records against routes the underscore model
    // spelling; replay resolves unlisted ids leniently and serves the recorded
    // chunks, so one selection holds in every mode.
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek_v4_flash' })
    // The chain document and the read-grant target exist before the start
    // command resolves them: the connected workspace is the staged
    // 'workspace' subdirectory of the scaffold root.
    const workspaceDir = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'loop.yaml'), CHAIN_DOCUMENT)
    await mkdir(join(workspaceDir, 'sibling'))
    await writeFile(join(workspaceDir, 'sibling', 'note.txt'), `inventory: three crates, one pallet
`)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const sessions = scaffold.ctx.sessions.list()
    expect(sessions).toHaveLength(1)
    const controller = sessions[0]
    if (controller === undefined) throw new Error('the connect produced no controlling session')
    controllerId = controller.id
    // The controller never calls a model: without this claim the first child
    // would bind the primary (empty) script and shift every later child.
    if (MODE !== 'record') scaffold.claimReplayPrimary(controllerId)
  }, 120_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await scaffold?.close()
  })

  /** The controlling session object; the connect births exactly one root. */
  function controllerSession(): Session {
    const session = controllerId === undefined ? undefined : scaffold.ctx.sessions.get(controllerId)
    if (session === undefined) throw new Error('the controlling session is not live')
    return session
  }

  /** Poll the durable loop projection until the named phase settles. */
  function waitForLoopPhase(phase: 'active' | 'complete'): Promise<void> {
    return expect.poll(() => {
      const state = scaffold.ctx.sessionProjections.stateOf(controllerSession(), 'loop')
      if (state === undefined || state.failure !== null) return 'unavailable'
      return state.current?.loop?.phase ?? 'none'
    }, { timeout: 150_000, interval: 500 }).toBe(phase)
  }

  it('starts the relay, relays both nodes, and renders the completed status', { timeout: 300_000 }, async () => {
    onTestFailed(() => saveFailureShot(page, 'web-snapshot-loop-relay-drive'))
    const input = page.locator('[data-composer-input]').first()
    // The connect unlocks the composer before the session's history tail and
    // event subscription settle; typing into a settled hero avoids racing the
    // first command's lifecycle into the open gap. A blank session's first
    // command is a bare goal status check: its always-present session-level
    // bar is the view state that docks the transcript, so the loop's command
    // rows stay visible in the session the user watches while the controller
    // stays free of model turns.
    await expect.poll(() => page.getByText('Into the Unknown', { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    await input.fill('/go')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await menu.getByRole('option', { name: 'Goal Set or view the goal for a long-running task' })
      .waitFor({ timeout: 10_000 })
    await input.press('Tab')
    await expect.poll(() => input.textContent()).toBe('/goal ')
    await expect.poll(() => menu.count()).toBe(0)
    await input.press('Enter')
    await expect.poll(() => page.locator('[data-phase="active"]').count(), { timeout: 15_000 }).toBe(1)
    await input.fill(START_LINE)
    await input.press('Enter')
    const startedRow = page.locator('[data-variant="others"]').filter({ hasText: 'Loop started' })
    await expect.poll(() => startedRow.count(), { timeout: 30_000 }).toBe(1)
    await waitForLoopPhase('complete')
    await scaffold.ctx.sessions.flush(controllerSession())

    await input.fill('/loop')
    await input.press('Tab')
    await input.press('Enter')
    const statusRow = page.locator('[data-variant="others"]').filter({ hasText: 'Status: complete' })
    await expect.poll(() => statusRow.count(), { timeout: 15_000 }).toBe(1)
    if (MODE === 'record') {
      const state = scaffold.ctx.sessionProjections.stateOf(controllerSession(), 'loop')
      const settlements = (state?.current?.ledger ?? []).filter((entry): entry is Extract<typeof entry, { kind: 'settlement' }> => entry.kind === 'settlement')
      expect(settlements).toHaveLength(2)
      const byId = new Map(childSessions.map(session => [String(session.id), session]))
      const worker = byId.get(String(settlements[0]?.childSessionId))
      const evaluator = byId.get(String(settlements[1]?.childSessionId))
      if (worker === undefined || evaluator === undefined) throw new Error('record harvest: a settled child session is not observable')
      await recordFixture(scaffold, controllerId!, CONTROLLER_FIXTURE)
      await recordSessionFixture(scaffold, worker, WORKER_FIXTURE)
      await recordSessionFixture(scaffold, evaluator, EVALUATOR_FIXTURE)
    }
    // Record captures the fixtures only; the follow-up refresh run writes
    // this golden, and every replay compares the replayed drive against it.
    if (MODE !== 'record') {
      await compareOrRefreshGolden(
        UI_EXPECTED,
        await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
        MODE,
      )
      expect(tripwire.pageErrors).toEqual([])
    }
  })

  it.skipIf(MODE !== 'replay')('replays the lean-push children and the settled verdict', { timeout: 120_000 }, async () => {
    const runs = events.filter((event): event is Extract<SessionEvent, { type: 'command/run' }> => event.type === 'command/run')
    expect(runs.map(event => event.data.name)).toEqual(['goal', 'loop', 'loop'])
    expect(runs[0]?.data.args).toBe(' ')
    expect(runs[1]?.data.args).toBe(' start "Relay the inventory note into the count report" --chain loop.yaml --read sibling --max-rounds 1')
    expect(runs[2]?.data.args).toBe(' ')
    expect(events.filter(event => event.type === 'command/done')).toHaveLength(3)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(events.some(event => event.type === 'turn/start')).toBe(false)

    const state = scaffold.ctx.sessionProjections.stateOf(controllerSession(), 'loop')
    expect(state?.current?.loop?.phase).toBe('complete')
    // A single-round completion never advances the round counter: the start
    // state is round 1, and only an advance to another round increments it.
    expect(state?.current?.loop?.roundsStarted).toBe(0)
    const settlements = (state?.current?.ledger ?? []).filter((entry): entry is Extract<typeof entry, { kind: 'settlement' }> => entry.kind === 'settlement')
    expect(settlements.map(entry => entry.role)).toEqual(['inventory-worker', 'evaluator'])
    expect(settlements[0]?.report).toMatchObject({
      status: 'ok',
      evidence: ['note.txt'],
    })
    expect(settlements[1]?.report).toMatchObject({ decision: 'complete' })

    const workerText = await readFile(WORKER_FIXTURE, 'utf8')
    expect(workerText).toContain('inventory-worker')
    expect(workerText).toContain(OBJECTIVE)
    expect(workerText).toContain('sibling')
    const evaluatorText = await readFile(EVALUATOR_FIXTURE, 'utf8')
    expect(evaluatorText).toContain('three crates')
    expect(evaluatorText).toContain('complete')
  })

  it.skipIf(MODE !== 'replay')('keeps the recorded-session inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v4.jsonl', 'session.1.v4.jsonl', 'session.2.v4.jsonl', 'ui.expected.md',
    ])
  })
})
