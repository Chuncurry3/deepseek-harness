# Cross-session Relay Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/loop` cross-session relay feature per [the approved spec](../notes/proposed/feature/2026-09-24-cross-session-relay-loop.md): fresh child conversations per node, per-node workspaces, event-sourced durable state, L1/L2-only resumption, and human-checkpointed rounds.

**Architecture:** Four new packages under `packages/loop/` mirror the goal family: `dsh-loop` (event-sourced domain + `ctx.loops`), `dsh-loop-chain-driver` (continuation policy), `dsh-command-loop` (`/loop` command), `dsh-tool-loop-query` (loop-scoped session reads). Phase A first extends the subagent seam with a capability-checked per-start `cwd`, because every loop node spawns a child in a granted workspace.

**Tech Stack:** TypeScript ESM, Cordis plugins, zod + schemastery validation, vitest, vitest snapshot replay. All conventions from [repo AGENTS.md](../../AGENTS.md).

**Spec authority:** the note above is the contract. When this plan and the note disagree, the note wins; stop and reconcile.

**Branching and commits:** start from a clean checkout of master. PR order is fixed: **PR 0** registers this plan's home directory (Task 0.5), **PR 1** lands Phase A (`feature/subagent-per-start-cwd`), **PR 2** lands Phases B–E (`feature/cross-session-relay-loop`, rebased onto PR 1 after it merges). Phase B does not start until PR 1 is merged — the loop packages import `SubagentStartRequest.cwd`, which does not exist before the seam lands. Every phase ends at a human review checkpoint (a two-stage review of the phase's diff); do not start the next phase before it passes. The shared working tree may contain others' uncommitted changes — every commit step adds ONLY the exact paths that task lists; never `git add -A` or `git add .`.

**Landing addendum (2026-10-07):** the public github.com `deepseek-ai/deepseek-harness` repository is a read-only mirror — its pulls REST resource returns 404 and it reports zero pull requests and zero issues, while its git history cites pull-request numbers from an internal instance. The fork keeps `chore/register-agents-plans` (b784410ed9) and `feature/subagent-per-start-cwd` (323940c89d) as upstreamable artifacts. The PR gates are reinterpreted as local merges: PR 0 and PR 1 content is merged into this branch's baseline (commits 1-6, two-stage-reviewed), so Phase B starts from 323940c89d as the local trunk; Phases B-E land on `feature/cross-session-relay-loop` and merge locally at their review checkpoints.

---

### Task 0: Read the reference surfaces before touching anything

**Files:**
- Read: [spec](../notes/proposed/feature/2026-09-24-cross-session-relay-loop.md) (the contract)
- Read: [packages/goal/goal/src/types.ts](../../packages/goal/goal/src/types.ts), [domain.ts](../../packages/goal/goal/src/domain.ts), [fold.ts](../../packages/goal/goal/src/fold.ts), [index.ts](../../packages/goal/goal/src/index.ts), [invariant.ts](../../packages/goal/goal/src/invariant.ts)
- Read: [packages/goal/goal-round-driver/src/index.ts](../../packages/goal/goal-round-driver/src/index.ts) (fences to mirror)
- Read: [packages/goal/command-goal/src/index.ts](../../packages/goal/command-goal/src/index.ts)
- Read: [packages/subagent/subagent/src/types.ts](../../packages/subagent/subagent/src/types.ts), [child-agent.ts](../../packages/subagent/subagent/src/child-agent.ts), [index.ts](../../packages/subagent/subagent/src/index.ts), [out-of-process.ts](../../packages/subagent/subagent/src/out-of-process.ts)
- Read: [packages/session-query/session-query/README.md](../../packages/session-query/session-query/README.md), [packages/session-query/tool-session-query/README.md](../../packages/session-query/tool-session-query/README.md), [packages/interaction/user-questions/README.md](../../packages/interaction/user-questions/README.md)

- [ ] **Step 1: Read every file above end-to-end.** The goal family is the structural template for the loop family; the subagent seam is the extension target. Confirm the import location of `ObjectJsonSchema` and `assertUsableCwd` by reading the top of `packages/subagent/subagent/src/types.ts` and `out-of-process.ts` — later tasks import both.

---

### Task 0.5 (PR 0): register the plan directory in the repo layout

**Files:**
- Modify: `AGENTS.md` (the `.agents/` layout line)

- [ ] **Step 1: Edit two layout lines** (the change is already staged in this working tree; PR 0 commits exactly `AGENTS.md`)

`.agents/     Agent workflows and Agent Notes (\`notes/\`)` becomes `.agents/     Agent workflows, plans (\`plans/\`), and Agent Notes (\`notes/\`)`, and `vendor/      Vendored Cordis source — manifest + sync procedure in vendor/README.md` becomes `vendor/      Vendored Cordis source (see vendor/README.md)` — the vendor condensation frees the word budget the registration consumes (root `AGENTS.md` sat at 1899/1900 before the edit; per docs/AGENTS.md an above-target file freezes its ceiling, so condensation is the only legal move) and aligns the line with the `python/`/`native/`/`examples/` style; the manifest-and-sync detail lives in `vendor/README.md` either way.

- [ ] **Step 2: Gates** — Run: `pnpm run verify-md-wrap && pnpm run verify-doc-budgets`; expected PASS (verified on this tree: 9 budgeted docs within ceiling, no hard-wrapped prose).

- [ ] **Step 3: Commit and land alone**

```bash
git switch -c chore/register-agents-plans
git add AGENTS.md
git commit -m "chore(agents): register .agents/plans as the implementation-plan home"
```

Open PR `kind/process area/agents` from that branch, land it, then branch Phase A from the updated master.

---

## Phase A — subagent seam: per-start cwd (independently landable PR 1)

The seam change is its own decision with its own Agent Note; the loop family is its first consumer (spec § Proposal).

### Task A1: capability flag + request field + loud rejection

**Files:**
- Modify: `packages/subagent/subagent/src/types.ts` (SubagentCapabilities ~L86, SubagentStartRequest ~L100)
- Modify: `packages/subagent/subagent/src/index.ts` (capability check list ~L486)
- Modify: `packages/subagent/subagent/src/out-of-process.ts` (capability table ~L29)
- Test: `packages/subagent/subagent/tests/start-cwd.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/subagent/subagent/tests/start-cwd.spec.ts
import { describe, expect, it } from 'vitest'
import type { SubagentCapabilities } from '../src/types.ts'

describe('SubagentCapabilities declares cwdOverride', () => {
  it('every capability table carries the new flag', () => {
    const caps: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwdOverride: true }
    expect(caps.cwdOverride).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/subagent/subagent/tests/start-cwd.spec.ts`
Expected: FAIL (type error: `cwdOverride` does not exist on `SubagentCapabilities`).

- [ ] **Step 3: Add the flag and request field**

`types.ts` — extend `SubagentCapabilities` (keep JSDoc parity with siblings):

```ts
export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
  /**
   * Whether the provider honors a per-start child workspace. Requires the
   * request cwd to be absolute, existing, and enterable (the
   * `assertUsableCwd` discipline); providers without the capability reject
   * a request that sets `cwd` instead of silently deriving the parent
   * session's workspace.
   */
  readonly cwdOverride: boolean
}
```

`types.ts` — add to `SubagentStartRequest` after `persona`:

```ts
  /**
   * Optional absolute workspace for the child session's header cwd.
   * Requires {@link SubagentCapabilities.cwdOverride}; rejected at start
   * otherwise. In-process providers set the child session cwd from it;
   * validation follows the `assertUsableCwd` discipline.
   */
  readonly cwd?: string
}
```

`out-of-process.ts` capability table (~L29, where `persona: false` sits): add `cwd: false` — hmm, name it exactly like the flag: `cwdOverride: false`.

`index.ts` (~L486, the capability check list `{ when: request.persona !== undefined, cap: 'persona' }`): add

```ts
    { when: request.cwd !== undefined, cap: 'cwdOverride' },
```

and reject non-absolute or non-enterable paths next to that check with the existing `assertUsableCwd` helper imported from `./out-of-process.ts` (re-export it if it is module-private).

- [ ] **Step 4: Run the test — it must pass; add the rejection test**

Append to `start-cwd.spec.ts` (follow the existing service-level start tests in `packages/subagent/subagent/tests/` for harness setup — copy the nearest one's bootstrapping):

```ts
  it('start rejects cwd on a provider without cwdOverride', async () => {
    // Use the existing out-of-process provider stub from the sibling tests;
    // its capability table says cwdOverride: false.
    await expect(startWithCwd(providerWithoutCwd)).rejects.toThrow(/cwdOverride/)
  })
```

Run: `pnpm vitest run packages/subagent/subagent/tests/start-cwd.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/subagent/src/types.ts packages/subagent/subagent/src/index.ts packages/subagent/subagent/src/out-of-process.ts packages/subagent/subagent/tests/start-cwd.spec.ts
git commit -m "feat(subagent): capability-checked per-start child cwd"
```

### Task A2: in-process provider honors the request cwd

**Files:**
- Modify: `packages/subagent/subagent/src/child-agent.ts` (~L110, the `...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}` spread)
- Test: `packages/subagent/subagent/tests/child-cwd.spec.ts`

- [ ] **Step 1: Write the failing test** — mirror the existing in-process spawn test in `packages/subagent/subagent/tests/`; assert the created child session's header `cwd` equals a temp directory passed as `request.cwd`:

```ts
  it('in-process start sets the child session cwd from the request', async () => {
    const child = await startInProcess({ ...baseRequest, cwd: tempDir })
    expect(readSessionHeader(child).cwd).toBe(tempDir)
  })
  it('in-process start derives the parent cwd when request.cwd is absent', async () => {
    const child = await startInProcess(baseRequest)
    expect(readSessionHeader(child).cwd).toBe(parentCwd)
  })
```

- [ ] **Step 2: Run — expect FAIL** (child cwd is always the parent's).

- [ ] **Step 3: Implement** — in `child-agent.ts` where the child session creation composes the header, resolve in priority order:

```ts
const cwd = request.cwd !== undefined
  ? { cwd: request.cwd }
  : parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}
```

The in-process capability tables are the `readonly capabilities` class properties in `packages/subagent/subagent-spawn-in-process/src/index.ts` (`SpawnInProcessProvider`) and `packages/subagent/subagent-fork-in-process/src/index.ts` (`ForkInProcessProvider`); both currently declare `cwdOverride: false` (multi-line literal, A1 landed them) — flip both to `true` and extend their class JSDoc capability enumerations. `subagent-acp` stays `false` (out-of-process). Also update the A1-landed mirrors: `scripts/gen-tool-catalog.ts` `registerCatalogSubagentProvider` capabilities (`cwdOverride: true`), the spawn/fork spec `toEqual` capability shapes, and the spawn/fork README capability enumerations. Also persist `cwd` in the durable child descriptor (descriptor.ts: pattern-match the `persona` persistence at ~L245/`286`) so resume of an in-flight child restores the workspace.

- [ ] **Step 4: Run — expect PASS**; then `pnpm vitest run packages/subagent` for the whole subagent family (spawn, fork, acp, adapters, driver).

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/subagent/src/child-agent.ts packages/subagent/subagent/src/descriptor.ts packages/subagent/subagent/tests/child-cwd.spec.ts packages/subagent/subagent-spawn-in-process/src/index.ts packages/subagent/subagent-fork-in-process/src/index.ts scripts/gen-tool-catalog.ts
git commit -m "feat(subagent): in-process provider applies per-start cwd to the child session"
```

plus any spawn/fork spec `toEqual` and README enumeration files the flip touches (verify each diff is purely capability-related before staging).

### Task A3: README + implemented Agent Note triplet + gates

**Files:**
- Modify: `packages/subagent/subagent/README.md` (+ `README.zh.md`, regenerate `README.i18n.yaml` via the pairing script)
- Create: `.agents/notes/implemented/feature/<today>-subagent-per-start-cwd.md` + `.zh.md` + `.i18n.yaml`

- [ ] **Step 1: README** — add one paragraph under the start-request options: `cwd` (optional absolute path; requires the provider's `cwdOverride` capability; in-process providers set the child session workspace; ACP/remote providers reject until they implement it). Mirror the bilingual pairing workflow: edit both README files, then `pnpm run verify-translation-pairing --write packages/subagent/subagent/README.md`. Also refresh the type-equivalence pastes in `docs/subsystems/subagent.md` + `.zh.md` (verify-type-equiv gates them; dsh-translate-docs stays user-invoked), and the `dsh-sdk` README capability enumeration. `packages/extensions/tool-cordis/src/api-catalog.ts` is generated, freshness-gated, and carries another author's uncommitted edits — never hand-edit it; if its gate stays red because their in-flight work has not landed, record it as a registered exception at the phase checkpoint instead of entangling their file.

- [ ] **Step 2: Agent Note** — write the implemented note (EN + zh + sidecar). Core clauses, in the note's own words: the decision (capability-checked per-start `cwd` on `SubagentStartRequest`), why (the loop relay family executes nodes in granted workspaces; deriving from the parent session cannot express cross-project execution), what was rejected (silently ignoring the field; deriving from the parent; waiting for a second consumer), the capability contract, the validation discipline, and the acceptance tests that exist. Follow the note format gates: `pnpm run verify-agent-note-format`, pairing `--write`, `pnpm run verify-md-links`.

- [ ] **Step 3: Repo gates for the touched surface**

Run: `pnpm vitest run packages/subagent && pnpm run verify-md-links && pnpm run doc-sync`
Expected: all PASS.

- [ ] **Step 4: Commit + land PR 1**

```bash
git add packages/subagent/subagent/README.md packages/subagent/subagent/README.zh.md packages/subagent/subagent/README.i18n.yaml .agents/notes/implemented/feature/
git commit -m "docs(subagent): per-start cwd seam decision and README"
```

Open PR `kind/feature area/subagent` from `feature/subagent-per-start-cwd`, then rebase `feature/cross-session-relay-loop` onto it.

---

## Phase B — `packages/loop/loop`: the event-sourced domain (PR 2, task 1 of the loop family)

### Task B1: package scaffold

**Files:**
- Create: `packages/loop/loop/package.json`, `tsconfig.json`, `src/index.ts` (stub), `README.md` (+ zh + i18n later, with the real content in B6)
- Modify: `tsconfig.host.json` (references array, next to the goal entries ~L170)
- Modify: root `pnpm-workspace.yaml` only if it does not already glob `packages/*/*` (it does — no change)

- [ ] **Step 1: Copy the structural template** from [packages/goal/goal/package.json](../../packages/goal/goal/package.json): name `@deepseek-ai/dsh-loop`, description "Event-sourced cross-session relay loop state and lifecycle service for the DeepSeek Harness", same export surface (`./invariant`, `./types`, `./client`, `./typert`, `./remote`, `./src/*`), peer/dev deps: `dsh-agent`, `dsh-session-projection`, `dsh-brand`, `dsh-invariants`, `dsh-llm`, `dsh-scope`, `dsh-session`, `dsh-typert-protocol`, `cordis`, `dsh-subagent` (new: chain output schemas are `ObjectJsonSchema`), deps `@deepseek-ai/schemastery` + `zod`.
- [ ] **Step 2: tsconfig.json** — copy goal's verbatim, adding a reference to `../../subagent/subagent`.
- [ ] **Step 3: Register the aggregate** — add `{ "path": "./packages/loop/loop" }` to `tsconfig.host.json` references; `src/index.ts` stub:

```ts
/** Event-sourced relay-loop domain. @module @deepseek-ai/dsh-loop */
export const name = 'loop'
```

- [ ] **Step 4: Build check**

Run: `pnpm run build:lib:host`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/loop/loop/package.json packages/loop/loop/tsconfig.json packages/loop/loop/src/index.ts tsconfig.host.json
git commit -m "chore(loop): scaffold @deepseek-ai/dsh-loop package"
```

### Task B2: pure types (`src/types.ts`)

**Files:**
- Create: `packages/loop/loop/src/types.ts`
- Test: `packages/loop/loop/tests/types.spec.ts` (compile-only assertions; types carry no runtime)

- [ ] **Step 1: Write the types**

```ts
/**
 * Pure types of the loop domain: the ONE home of the `loop` projection-key
 * declaration plus the durable vocabulary it carries, free of host-side
 * imports. Mirrors dsh-goal/types.ts.
 * @module @deepseek-ai/dsh-loop/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObjectJsonSchema, SessionId } from '@deepseek-ai/dsh-subagent'

/** Identifies one relay loop across its durable revisions. */
export type LoopId = Branded<'LoopId'>

/** Compare-and-set identity for one exact loop revision. */
export interface LoopRef {
  readonly id: LoopId
  /** Positive revision; increments on every `loop/change` event only. */
  readonly revision: number
}

/** Durable lifecycle phase. Activation is process-local and separate. */
export type LoopPhase = 'active' | 'awaiting-human' | 'paused' | 'blocked' | 'complete'

/** Machine-routable and human-readable explanation for a blocked loop. */
export interface LoopBlockReason {
  readonly code: 'node-failed' | 'round-limit' | 'evaluator-blocked' | 'checkpoint-provider-missing' | 'durability-failed' | 'report-budget'
  readonly message: string
}

/** One declared source conversation a node continues by reading. */
export interface LoopInputRef { readonly session: SessionId }

/** One role node of the frozen chain. */
export interface LoopChainNodeDef {
  readonly role: string
  /** Absolute workspace; defaults to the loop's home workspace. */
  readonly cwd?: string
  readonly prompt: string
  /** Replaces the default handoff schema wholesale when present. */
  readonly output?: ObjectJsonSchema
  /** Declared source sessions; requires the `inherited` report field. */
  readonly inputs?: readonly LoopInputRef[]
  /** Role names whose prior-round reports carry into this node. */
  readonly carryOver?: readonly string[]
}

/** The frozen, validated chain. */
export interface LoopChainDef {
  readonly objective: string
  readonly exit?: string
  readonly checkpoint: 'none' | 'node'
  readonly nodes: readonly LoopChainNodeDef[]
  readonly evaluatorPrompt?: string
}

/** Full durable state written by every non-clear `loop/change` event. */
export interface LoopSnapshot extends LoopRef {
  readonly objective: string
  readonly phase: LoopPhase
  readonly blockedReason?: LoopBlockReason
  readonly maxRounds: number
  readonly checkpoint: 'none' | 'node'
  /** realpath-normalized absolute workspaces readable by this run's nodes. */
  readonly readScopes: readonly string[]
  /** realpath-normalized absolute workspaces executable by this run's nodes. */
  readonly writeScopes: readonly string[]
  readonly chain: LoopChainDef
  readonly roundsStarted: number
}

/** Whether this live process may automatically advance the current round. */
export type LoopActivation = 'armed' | 'disarmed'

/** Current loop view: the durable snapshot plus process-local activation. */
export interface LoopView {
  readonly loop: LoopSnapshot
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: LoopActivation
}

/** One evaluator verdict, fixed schema, settled through `loop/node`. */
export interface LoopVerdict {
  readonly decision: 'continue' | 'complete' | 'blocked'
  readonly feedback?: string
  readonly reason?: string
}

/** One settled node report plus its ledger coordinates. */
export interface LoopNodeReport {
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  readonly attempt: number
  readonly report: unknown
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current loop (the latest `loop/change` whole value) plus
     * the append-only node ledger, or `null` before the first create and
     * after a clear tombstone. The `loop/change` fold is last-wins; ledger
     * events fold into the ledger map by `{round, nodeIndex, attempt}`.
     */
    loop: LoopProjection | null
  }
}

/** Current loop projection: the durable snapshot plus the folded ledger. */
export interface LoopProjection {
  readonly loop?: LoopSnapshot
  readonly ledger: readonly LoopLedgerEntry[]
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly lastRef?: LoopRef
}

/** One ledger entry: a spawn, a failure, or a settlement. */
export type LoopLedgerEntry =
  | { readonly kind: 'node-started'; readonly round: number; readonly nodeIndex: number; readonly role: string; readonly attempt: number; readonly childSessionId: SessionId; readonly cwd: string; readonly atRevision: number }
  | { readonly kind: 'attempt'; readonly round: number; readonly nodeIndex: number; readonly attempt: number; readonly failure: { readonly code: string; readonly message: string }; readonly atRevision: number }
  | { readonly kind: 'settlement'; readonly round: number; readonly nodeIndex: number; readonly role: string; readonly attempt: number; readonly childSessionId: SessionId; readonly cwd: string; readonly report: unknown; readonly atRevision: number }
```

- [ ] **Step 2: Compile check** — `pnpm run build:lib:host`; expected exit 0.
- [ ] **Step 3: Commit**

```bash
git add packages/loop/loop/src/types.ts
git commit -m "feat(loop): loop domain pure types"
```

### Task B3: durable events + strict fold (`src/domain.ts`, `src/fold.ts`, `src/runtime.ts`)

**Files:**
- Create: `packages/loop/loop/src/domain.ts`, `src/fold.ts`, `src/runtime.ts`
- Test: `packages/loop/loop/tests/fold.spec.ts`

- [ ] **Step 1: Write the failing fold tests** (pure; no Cordis):

```ts
// packages/loop/loop/tests/fold.spec.ts
import { describe, expect, it } from 'vitest'
import { applyLoopEvent, emptyLoopFoldState } from '../src/fold.ts'

const baseSnapshot = { id: 'L1' as never, revision: 1, objective: 'o', phase: 'active', maxRounds: 20, checkpoint: 'none', readScopes: [], writeScopes: [], chain: { objective: 'o', checkpoint: 'none', nodes: [] }, roundsStarted: 0 }

it('last-wins change fold and transition legality', () => {
  const state = emptyLoopFoldState()
  applyLoopEvent(state, { seq: 1, at: 0, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'create', loop: baseSnapshot, createdAt: 0, updatedAt: 0 } } as never)
  expect(state.snapshot?.revision).toBe(1)
  applyLoopEvent(state, { seq: 2, at: 1, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'pause', loop: { ...baseSnapshot, revision: 2, phase: 'paused' }, createdAt: 0, updatedAt: 1 } } as never)
  expect(state.snapshot?.phase).toBe('paused')
})

it('rejects illegal phase transitions fail-loud', () => {
  const state = emptyLoopFoldState()
  applyLoopEvent(state, { seq: 1, at: 0, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'create', loop: baseSnapshot, createdAt: 0, updatedAt: 0 } } as never)
  expect(() => applyLoopEvent(state, { seq: 2, at: 1, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'complete', loop: { ...baseSnapshot, revision: 2, phase: 'complete' }, createdAt: 0, updatedAt: 1 } } as never)).toThrow(/transition/)
})

it('ledger keys are unique and attempts require their node-started', () => {
  const state = emptyLoopFoldState()
  applyLoopEvent(state, { seq: 1, at: 0, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'create', loop: baseSnapshot, createdAt: 0, updatedAt: 0 } } as never)
  const started = { kind: 'node-started', loopId: 'L1', round: 1, nodeIndex: 0, role: 'r', attempt: 1, childSessionId: 's1', cwd: '/w', atRevision: 1 }
  applyLoopEvent(state, { seq: 2, at: 1, type: 'loop/node-started', data: started } as never)
  expect(() => applyLoopEvent(state, { seq: 3, at: 2, type: 'loop/node-started', data: started } as never)).toThrow(/duplicate/)
  expect(() => applyLoopEvent(state, { seq: 4, at: 3, type: 'loop/attempt', data: { kind: 'attempt', loopId: 'L1', round: 1, nodeIndex: 9, attempt: 1, failure: { code: 'x', message: 'm' }, atRevision: 1 } } as never)).toThrow(/node-started/)
})

it('a clear tombstone ends the run; later ledger events for the old loopId are history', () => {
  const state = emptyLoopFoldState()
  applyLoopEvent(state, { seq: 1, at: 0, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'create', loop: baseSnapshot, createdAt: 0, updatedAt: 0 } } as never)
  applyLoopEvent(state, { seq: 2, at: 1, type: 'loop/change', data: { kind: 'loop/change', version: 1, operation: 'clear', cleared: { id: 'L1' as never, revision: 1 }, clearedAt: 1 } } as never)
  expect(state.snapshot).toBeUndefined()
})
```

- [ ] **Step 2: Run — expect FAIL** (fold module missing).
- [ ] **Step 3: Implement** `domain.ts` (event metas + SessionEventMap merging — copy goal's declaration pattern verbatim):

```ts
/** Host-side vocabulary of the loop domain. @module @deepseek-ai/dsh-loop */
export type LoopOperation = 'create' | 'pause' | 'resume' | 'await-human' | 'continue' | 'advance' | 'complete' | 'block' | 'clear'

export interface LoopSnapshotChangeMeta { readonly kind: 'loop/change'; readonly version: 1; readonly operation: Exclude<LoopOperation, 'clear'>; readonly loop: LoopSnapshot; readonly createdAt: number; readonly updatedAt: number }
export interface LoopClearChangeMeta { readonly kind: 'loop/change'; readonly version: 1; readonly operation: 'clear'; readonly cleared: LoopRef; readonly clearedAt: number }
export type LoopChangeMeta = LoopSnapshotChangeMeta | LoopClearChangeMeta
export interface LoopNodeStartedMeta { readonly kind: 'node-started'; readonly version: 1; readonly loopId: LoopId; readonly round: number; readonly nodeIndex: number; readonly role: string; readonly attempt: number; readonly childSessionId: SessionId; readonly cwd: string; readonly atRevision: number }
export interface LoopAttemptMeta { readonly kind: 'attempt'; readonly version: 1; readonly loopId: LoopId; readonly round: number; readonly nodeIndex: number; readonly attempt: number; readonly failure: { readonly code: string; readonly message: string }; readonly atRevision: number }
export interface LoopNodeSettledMeta { readonly kind: 'settlement'; readonly version: 1; readonly loopId: LoopId; readonly round: number; readonly nodeIndex: number; readonly role: string; readonly attempt: number; readonly childSessionId: SessionId; readonly cwd: string; readonly report: unknown; readonly atRevision: number }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'loop/change': LoopChangeMeta
    'loop/node-started': LoopNodeStartedMeta
    'loop/attempt': LoopAttemptMeta
    'loop/node': LoopNodeSettledMeta
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Loop mutation accepted by one live agent; the matching `loop/change`
     * session event has committed. Listener failures are contained.
     * @param payload.agent - agent whose session owns the loop.
     * @param payload.change - operation plus the fresh snapshot ref.
     * @mode emit
     */
    'loop/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<import('@deepseek-ai/dsh-agent').Agent>, payload: { agent: import('@deepseek-ai/dsh-agent').Agent; change: { operation: LoopOperation; ref: LoopRef } }): void
  }
}
```

`fold.ts` — the strict replay fold (mirror goal's fold structure: `emptyLoopFoldState`, `decodeLoopChange`/`decodeLoopLedger` zod decoders, `applyLoopEvent`):

```ts
export interface LoopFoldState {
  snapshot?: LoopSnapshot
  ledger: Map<string, LoopLedgerEntry>
  createdAt?: number
  updatedAt?: number
  lastRef?: LoopRef
  tombstone?: LoopRef
  currentLoopId?: LoopId
}

const LEDGER_TRANSITIONS: ReadonlyMap<string, string> = new Map([
  // from -> allowed to (spec § State machine table, verbatim)
  ['active', 'awaiting-human paused blocked complete'],
  ['awaiting-human', 'active paused blocked'],
  ['paused', 'active blocked'],
  ['blocked', 'active'],
  ['complete', ''],
])

export function applyLoopEvent(state: LoopFoldState, event: SessionEvent): void {
  switch (event.type) {
    case 'loop/change': {
      const change = decodeLoopChange(event.data)
      if (change.operation === 'clear') { /* tombstone: drop snapshot, keep ledger as history, clear currentLoopId */ }
      else {
        if (state.snapshot === undefined) {
          if (change.operation !== 'create') throw new Error('loop transition: first change must be create')
        } else {
          if (change.loop.id !== state.snapshot.id) throw new Error('loop transition: fresh create requires a globally fresh loopId')
          if (change.loop.revision !== state.snapshot.revision + 1) throw new Error('loop revision continuity violated')
          if (!LEDGER_TRANSITIONS.get(state.snapshot.phase)!.split(' ').includes(change.loop.phase)) {
            throw new Error(`loop transition illegal: ${state.snapshot.phase} -> ${change.loop.phase}`)
          }
        }
        state.snapshot = change.loop
        state.currentLoopId = change.loop.id
        state.updatedAt = change.updatedAt
      }
      state.lastRef = change.operation === 'clear' ? change.cleared : change.loop
      return
    }
    case 'loop/node-started': case 'loop/attempt': case 'loop/node': {
      const meta = decodeLoopLedger(event.type, event.data)
      if (state.currentLoopId === undefined || meta.loopId !== state.currentLoopId) return // history before a tombstone
      const key = `${meta.round}:${meta.nodeIndex}:${meta.attempt}`
      const prior = state.ledger.get(key)
      if (meta.kind === 'node-started' && prior !== undefined) throw new Error(`loop ledger duplicate key: ${key}`)
      if (meta.kind !== 'node-started') {
        const spawn = state.ledger.get(key)
        if (spawn === undefined || spawn.kind !== 'node-started') throw new Error(`loop ledger ${meta.kind} without matching node-started: ${key}`)
        if (prior !== undefined) throw new Error(`loop ledger duplicate settlement: ${key}`)
      }
      state.ledger.set(key, /* normalized LoopLedgerEntry */)
      return
    }
    default: return
  }
}
```

`runtime.ts` — `LOOP_CHANGE_VERSION = 1`, `LoopError` class and error codes `LOOP_AGENT_NOT_LIVE | LOOP_NOT_FOUND | LOOP_ALREADY_EXISTS | LOOP_STALE_REVISION | LOOP_INVALID_TRANSITION | LOOP_SCOPE_VIOLATION | LOOP_INVALID_CHAIN` (copy GoalError's shape).

- [ ] **Step 4: Run — expect PASS**; add the corrupt-isolation test (a malformed `loop/change` payload throws from the decoder; the fold is per-session and the session itself keeps loading — assert via the invariant task B5).
- [ ] **Step 5: Commit**

```bash
git add packages/loop/loop/src/domain.ts packages/loop/loop/src/fold.ts packages/loop/loop/src/runtime.ts packages/loop/loop/tests/fold.spec.ts
git commit -m "feat(loop): durable event vocabulary and strict replay fold"
```

### Task B4: `ctx.loops` service (`src/index.ts`)

**Files:**
- Modify: `packages/loop/loop/src/index.ts`
- Test: `packages/loop/loop/tests/service.spec.ts`

- [ ] **Step 1: Write the failing service tests** — boot a REAL composition through the Loader (packages/AGENTS.md: hand-built `ctx.plugin` is insufficient): copy the boot pattern from an existing goal service test (`packages/goal/goal/tests/` — reuse its cordis.yml test composition file approach, adding `@deepseek-ai/dsh-loop`). Assert: `start` appends a `loop/change` create with revision 1 and arms; a second `start` rejects `LOOP_ALREADY_EXISTS`; `pause`/`resume` write revisions 2/3; CAS mismatch rejects `LOOP_STALE_REVISION`; `clear` writes the tombstone; activation is process-local (never serialized — assert the appended events carry no activation field).

- [ ] **Step 2: Implement** — mirror [GoalService](../../packages/goal/goal/src/index.ts) exactly for the CAS skeleton (agent liveness check → read projection → validate transition → append → `ctx.sessions.flush()` → recheck). Service surface:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { loops: LoopService }
}

export interface StartLoopRequest {
  readonly objective: string
  readonly chain: LoopChainDef
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly maxRounds?: number
  readonly checkpoint?: 'none' | 'node'
}

export class LoopService {
  async start(agent: Agent, request: StartLoopRequest): Promise<LoopView>
  async pause(agent: Agent, ref: LoopRef): Promise<LoopView>
  async resume(agent: Agent, ref: LoopRef): Promise<LoopView>   // fresh epoch: retry floor = the resume revision
  async clear(agent: Agent, ref: LoopRef): Promise<void>
  async awaitHuman(agent: Agent, ref: LoopRef): Promise<LoopView>      // active -> awaiting-human
  async continueFromHuman(agent: Agent, ref: LoopRef): Promise<LoopView> // awaiting-human -> active
  async advance(agent: Agent, ref: LoopRef): Promise<LoopView>          // roundsStarted++ (verdict applied)
  async complete(agent: Agent, ref: LoopRef): Promise<LoopView>
  async block(agent: Agent, ref: LoopRef, reason: LoopBlockReason): Promise<LoopView>
  /** Non-CAS ledger appends with fold-grade validation. */
  async appendNodeStarted(agent: Agent, meta: Omit<LoopNodeStartedMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void>
  async appendAttempt(agent: Agent, meta: Omit<LoopAttemptMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void>
  async appendSettlement(agent: Agent, meta: Omit<LoopNodeSettledMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void>
  activation(agent: Agent): LoopActivation
  arm(agent: Agent, ref: LoopRef): void
  disarm(agent: Agent): void
}
```

Config (schemastery, validated): `defaultMaxRounds` (positive int, default 20), `maxNodeRetries` (positive int, default 2), `maxHandoffChars` (positive int, default 16384), `maxEvaluatorInputChars` (positive int, default 65536). Also register the light `applyLoopProjection` last-wins projection unit exactly as goal's `applyGoalProjection`.

- [ ] **Step 3: Run tests — PASS; run the Loader-booted test specifically.**
- [ ] **Step 4: Commit**

```bash
git add packages/loop/loop/src/index.ts packages/loop/loop/tests/service.spec.ts
git commit -m "feat(loop): ctx.loops service with CAS mutations and ledger appends"
```

### Task B5: `./invariant` companion

**Files:**
- Create: `packages/loop/loop/src/invariant.ts`
- Test: `packages/loop/loop/tests/invariant.spec.ts`

- [ ] **Step 1: Implement** — copy [goal's invariant.ts](../../packages/goal/goal/src/invariant.ts) structure: companion plugin name `loop-invariant`, `inject = ['invariants']`, a WeakMap of independent `LoopFoldState` per attached session, staged candidate-event validation with the strict decoders, failures attributed to the event seq. Manifest name: `@deepseek-ai/dsh-loop`.
- [ ] **Step 2: Test** — a session with a valid stream passes; splice one duplicate ledger key into the event stream and the invariant fails naming the seq. Also assert loop fold failure does NOT fail other projections of the same session (isolation, spec § Durable record).
- [ ] **Step 3: `pnpm vitest run packages/loop/loop && pnpm run verify-package-invariants` — PASS**
- [ ] **Step 4: Commit**

```bash
git add packages/loop/loop/src/invariant.ts packages/loop/loop/tests/invariant.spec.ts
git commit -m "feat(loop): durable loop-stream invariant companion"
```

### Task B6: README + note wiring

**Files:**
- Create: `packages/loop/loop/README.md` + `README.zh.md` + `README.i18n.yaml`

- [ ] **Step 1: README** in the canonical Model Experience format: what the package owns, the four event types, the fold rules, config keys with defaults, model-visible surface (none — no tools), KV-cache effects (none), and `## Known Limitations and Deferred Work` (single current loop per session; L3 excluded; no token/cost budgets).
- [ ] **Step 2: Run `pnpm run doc-sync`** — expected PASS (readme-limitations gate included).
- [ ] **Step 3: Commit**

```bash
git add packages/loop/loop/README.md packages/loop/loop/README.zh.md packages/loop/loop/README.i18n.yaml
git commit -m "docs(loop): dsh-loop README"
```

---

## Phase C — `packages/loop/loop-chain-driver`: the continuation policy (PR 2, task 2)

### Task C1: chain parsing + validation

**Files:**
- Create: `packages/loop/loop-chain-driver/src/chain.ts`
- Test: `packages/loop/loop-chain-driver/tests/chain.spec.ts`
- Scaffold: package.json (name `@deepseek-ai/dsh-loop-chain-driver`), tsconfig (references loop/loop + subagent + interaction packages), tsconfig.host.json registration, as in B1.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseChainDocument, defaultChain } from '../src/chain.ts'

it('parses a two-node chain with inputs, carryOver, and evaluator override', () => {
  const chain = parseChainDocument(`objective: 迭代工具\ncheckpoint: none\nnodes:\n  - role: direct\n    cwd: /w\n    inputs:\n      - session: s-1\n    carryOver: [experiment]\n    prompt: |\n      规划\n  - role: experiment\n    prompt: |\n      试验\nevaluator:\n  prompt: |\n    裁决\n`)
  expect(chain.nodes).toHaveLength(2)
  expect(chain.nodes[0].inputs?.[0].session).toBe('s-1')
  expect(chain.nodes[0].carryOver).toEqual(['experiment'])
  expect(chain.evaluatorPrompt).toContain('裁决')
})

it('rejects duplicate roles, empty nodes, and unknown keys — loud', () => {
  expect(() => parseChainDocument('nodes:\n  - role: a\n    prompt: p\n  - role: a\n    prompt: q')).toThrow(/role/)
  expect(() => parseChainDocument('nodes: []')).toThrow(/nodes/)
  expect(() => parseChainDocument('objective: o\nnodes:\n  - role: a\n    prompt: p\n    bogus: 1')).toThrow(/bogus/)
})

it('the default chain is one worker node plus the evaluator prompt', () => {
  const chain = defaultChain('优化工具')
  expect(chain.nodes).toHaveLength(1)
  expect(chain.nodes[0].role).toBe('iterate')
  expect(chain.nodes[0].output).toBeUndefined()
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — zod strict object schemas for `LoopChainDef` (unknown keys rejected, roles unique, nodes non-empty, output schemas validated through the subagent seam's `assertObjectJsonSchema` subset — import it from `@deepseek-ai/dsh-subagent`), YAML via the repo's existing YAML dependency if one is already used by settings/config packages (`grep -r "yaml" packages/settings packages/preset` and reuse the same library; do not add a new dependency without the dependencies-over-hand-rolling policy check). Provide `defaultChain(objective)` per the spec's default chain.
- [ ] **Step 4: PASS; commit**

```bash
git add packages/loop/loop-chain-driver/src/chain.ts packages/loop/loop-chain-driver/tests/chain.spec.ts packages/loop/loop-chain-driver/package.json packages/loop/loop-chain-driver/tsconfig.json tsconfig.host.json
git commit -m "feat(loop): chain document parsing and default chain"
```

### Task C2: node prompt assembly + handoff budget

**Files:**
- Create: `packages/loop/loop-chain-driver/src/handoff.ts`
- Test: `packages/loop/loop-chain-driver/tests/handoff.spec.ts`

- [ ] **Step 1: Failing tests** — `assembleNodePrompt(view, round, nodeIndex)` produces a prompt carrying objective, round number, frozen role instruction, the named reports (same-round predecessors + carryOver + feedback per the spec's visibility rule), declared input session ids, prior child session ids, and the read-scope statement; never raw transcripts. `validateReport(node, report)`: schema-conformant via the seam's schema enforcement mirror, `maxHandoffChars` counted in UTF-16 code units (`report.text.length`-style measurement on the serialized report — surrogate pairs count 2 by construction), `inherited` required non-empty with one entry per declared input when `inputs` is declared, absent requirement otherwise. `evaluatorInputBudget(view, round)` sums the round's serialized reports + feedback and names round/node/report/exceeded-characters on `report-budget`.
- [ ] **Step 2: FAIL → implement → PASS → commit** `git add packages/loop/loop-chain-driver/src/handoff.ts packages/loop/loop-chain-driver/tests/handoff.spec.ts` with message `feat(loop): lean-push lossless-pull handoff assembly and validation`.

### Task C3: the driver loop

**Files:**
- Create: `packages/loop/loop-chain-driver/src/index.ts` (plugin: `name = 'loop-chain-driver'`, `inject = ['loops', 'subagents', 'sessions']`, Config: `provider: Schema.string()` — the subagent provider name; misconfiguration fails loud at load)
- Test: `packages/loop/loop-chain-driver/tests/driver.spec.ts`

- [ ] **Step 1: Write the failing driver tests** with a stub subagent provider (registered through the real subagent service seam, capability `cwdOverride: true`, returning canned structured outputs) and the Loader-booted composition from B4:
  - one round settles one `loop/node` per node with validated reports, the evaluator settles as the final node index, and `advance` increments `roundsStarted` only when the verdict's change lands;
  - spawn rejection: a chain node `cwd` outside `writeScopes` fails at `/loop start` (service-level check, tested here end-to-end) and the driver re-asserts the scope at spawn;
  - failing children append `loop/attempt`, retry with the failure reason in the prompt, and block `node-failed` after `maxNodeRetries` within the epoch;
  - `checkpoint: node` with a stub user-questions provider moves the run to `awaiting-human` and a continue answer returns `active`; missing provider blocks `checkpoint-provider-missing`;
  - a simulated restart (new driver instance over the same session log) starts no work until `resume`; `resume` re-extracts the in-flight child's final assistant output from its session log via `ctx.sessionQuery.readSurface`, applies a pending evaluator verdict exactly once, and enumerates unledgered children through the subagent ledger's `listChildren`.

- [ ] **Step 2: Implement the driver** — mirror the goal-round-driver fences exactly (read [its source](../../packages/goal/goal-round-driver/src/index.ts) first: fiber-active guard, exact live agent recovery, flush before every advance, CAS recheck after every await, teardown quiescence). Core loop:

```ts
async function driveRound(agent: Agent, view: LoopView): Promise<void> {
  const nodes = [...view.loop.chain.nodes, evaluatorNode(view.loop.chain)]
  for (let nodeIndex = firstUnsettledIndex(view, view.loop.roundsStarted + 1); nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex]
    const attempt = nextAttemptNumber(view, view.loop.roundsStarted + 1, nodeIndex, epochFloor(view))
    const run = await ctx.subagents.start(config.provider, {
      parent: agent,
      prompt: assembleNodePrompt(view, node, nodeIndex),
      outputSchema: schemaFor(node),
      cwd: assertScope(node.cwd ?? homeWorkspace, view.loop.writeScopes),
      label: node.role,
      signal: controller.signal,
    })
    await ctx.loops.appendNodeStarted(agent, { round, nodeIndex, role: node.role, attempt, childSessionId: run.sessionId, cwd: node.cwd ?? homeWorkspace }, view.loop.revision)
    const result = await run.result
    const report = validateReport(node, result.structured)
    if (report === undefined) {
      await ctx.loops.appendAttempt(agent, { round, nodeIndex, attempt, failure: result.failure }, view.loop.revision)
      if (attempt >= config.maxNodeRetries + epochFloorAttempts(view)) { await ctx.loops.block(agent, ref(view), { code: 'node-failed', message: `${node.role}: ${result.failure.message}` }); return }
      nodeIndex--  // retry same node with attempt + 1
      continue
    }
    await ctx.loops.appendSettlement(agent, { round, nodeIndex, role: node.role, attempt, childSessionId: run.sessionId, cwd: node.cwd ?? homeWorkspace, report: result.structured }, view.loop.revision)
    if (view.loop.checkpoint === 'node' && nodeIndex < nodes.length - 1) await checkpoint(agent, view)
  }
  // evaluator settled: settle-then-apply (spec § Durable record)
  const verdict = lastVerdict(view)
  if (verdict.decision === 'complete') await ctx.loops.complete(agent, ref(view))
  else if (verdict.decision === 'blocked') await ctx.loops.block(agent, ref(view), { code: 'evaluator-blocked', message: verdict.reason ?? 'evaluator blocked' })
  else {
    if (view.loop.roundsStarted >= view.loop.maxRounds) await ctx.loops.block(agent, ref(view), { code: 'round-limit', message: `${view.loop.roundsStarted}/${view.loop.maxRounds}` })
    else await ctx.loops.advance(agent, ref(view))
  }
}
```

`checkpoint` uses [`ctx.userQuestions`](../../packages/interaction/user-questions/README.md) with `AskUserQuestionRequest` (`questions`, `agent`, `signal`), options continue/pause/terminate, and the answer mapping from the spec. Flush failures call `ctx.loops.block(agent, ref, { code: 'durability-failed', ... })` then disarm. Driver-local helpers used above, each defined in this task with a one-line contract: `evaluatorNode(chain)` builds the fixed evaluator node (role `evaluator`, the chain's `evaluatorPrompt`, the fixed verdict schema); `firstUnsettledIndex(view, round)` scans the ledger for the first node index without a settlement (evaluator included); `nextAttemptNumber(view, round, nodeIndex, floor)` counts `node-started` entries at `atRevision >= floor` for that node; `epochFloor(view)` is the revision of the latest create-or-resume change event; `schemaFor(node)` merges the node's `output` override with the driver-injected `inherited` requirement; `lastVerdict(view)` reads the round's evaluator settlement report; `assertScope(cwd, writeScopes)` realpath-normalizes and throws `LOOP_SCOPE_VIOLATION` outside the scopes; `ref(view)` and `controller` are the current `LoopRef` and the run's `AbortController`.

- [ ] **Step 3: PASS; run `pnpm vitest run packages/loop` — PASS; commit**

```bash
git add packages/loop/loop-chain-driver/src/index.ts packages/loop/loop-chain-driver/tests/driver.spec.ts
git commit -m "feat(loop): relay chain continuation driver"
```

---

## Phase D — command + query tools + composition (PR 2, task 3)

### Task D1: `/loop` command grammar

**Files:**
- Create: `packages/loop/command-loop/src/index.ts` (package `@deepseek-ai/dsh-command-loop`; scaffold as in B1/C1)
- Test: `packages/loop/command-loop/tests/command.spec.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseLoopCommand } from '../src/index.ts'

it('bare /loop renders status', () => {
  expect(parseLoopCommand('')).toEqual({ kind: 'show' })
})
it('start parses repeatable quoted --read/--write flags with zero escaping', () => {
  const parsed = parseLoopCommand('iterate the tool --read "E:\a b" --read E:\c --write "E:\d;e" --max-rounds 5 --checkpoint node')
  expect(parsed).toEqual({ kind: 'start', objective: 'iterate the tool', reads: ['E:\\a b', 'E:\\c'], writes: ['E:\\d;e'], maxRounds: 5, checkpoint: 'node' })
})
it('pause/resume/clear are exact verbs; anything else after start verbs is the objective', () => {
  expect(parseLoopCommand('pause')).toEqual({ kind: 'pause' })
  expect(parseLoopCommand('optimize the tool')).toEqual({ kind: 'start', objective: 'optimize the tool', reads: [], writes: [] })
})
it('a flag without a value fails loud', () => {
  expect(() => parseLoopCommand('obj --read')).toThrow(/--read/)
})
```

- [ ] **Step 2: Implement** — tokenizer: split on whitespace, respect double-quoted runs (quotes strip, content verbatim — any character legal, zero escaping per spec); `--chain <file>` once, `--read <path>`/`--write <path>` repeatable, `--max-rounds <n>` positive int, `--checkpoint none|node`; verbs `pause`/`resume`/`clear` exact (lowercased); the first non-flag token run before any flag is the objective (required non-empty for start). Command registration mirrors [command-goal](../../packages/goal/command-goal/src/index.ts): `inject = ['commands', 'loops', 'loopChainDriver']`, usage string, phase labels for all five phases, blocked reason rendering, `Activation:` line, and the newest report digest line.
- [ ] **Step 3: realpath-normalize granted scopes at start** — shared helper (place it in `packages/loop/loop/src/paths.ts` so the query tools reuse it):

```ts
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/** realpath-normalize one granted scope: resolve symlinks, separators, and case-fold on Windows. */
export function normalizeScopePath(raw: string): string {
  const absolute = isAbsolute(raw) ? raw : resolve(raw)
  const real = realpathSync(absolute) // throws ENOENT -> the command surfaces a direct error
  const unified = real.split(sep).join('/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}
```

Tests: two symlinked paths normalize equal; drive-letter case folds on win32 (skip the case assertion off-platform); a non-existent path throws.
- [ ] **Step 4: PASS; commit**

```bash
git add packages/loop/command-loop packages/loop/loop/src/paths.ts tsconfig.host.json
git commit -m "feat(loop): /loop command grammar and scope normalization"
```

### Task D2: `loop_session_search` / `loop_session_read` tools

**Files:**
- Create: `packages/loop/tool-loop-query/src/index.ts` (package `@deepseek-ai/dsh-tool-loop-query`; scaffold as above)
- Test: `packages/loop/tool-loop-query/tests/tools.spec.ts`

- [ ] **Step 1: Failing tests** — registration mirrors [tool-session-query](../../packages/session-query/tool-session-query/README.md) (tool Consumer pattern on `ctx.tools`); executor authorization is the behavior under test:
  - caller outside any run's lineage (plain session) → refused with the error naming lineage;
  - caller inside a run (the controlling agent or a child) with target cwd inside frozen `readScopes` → served through `ctx.sessionQuery` (`filterSessions`/`filterEvents` for search, `readSurface`/`readEvent` for read);
  - target cwd outside scopes and not the caller's own workspace → refused;
  - symlink-equivalent target inside a granted scope → served (realpath comparison, distinct from tool-session-query's exact-string rule — both rules hold in their own domains per spec).

- [ ] **Step 2: Implement** — two tools, schemas mirroring tool-session-query's shapes; descriptions pinned verbatim (model-facing contract): they open with "Usable only inside an active relay run's lineage; every other call is refused" per the spec. Executor: recover the calling agent's session id, check lineage via the subagent ledger (`listChildren` on the controlling session of the current loop in `ctx.loops` view, recursively) or equality with the controlling session, then compare the target session's cwd (from `ctx.sessionQuery` header data) with the frozen scopes through `normalizeScopePath`.
- [ ] **Step 3: PASS + HMR disposal proof** — dispose the fiber, assert both tools vanish from the registry (packages/AGENTS.md registry rule).
- [ ] **Step 4: Commit**

```bash
git add packages/loop/tool-loop-query tsconfig.host.json
git commit -m "feat(loop): lineage- and scope-enforced loop session query tools"
```

### Task D3: mount in the shipped base composition

**Files:**
- Modify: `packages/bundle/base/cordis.patch.yml` (next to the goal entries ~L275-282)
- Modify: the bundle's dependency manifest wherever `@deepseek-ai/dsh-goal` appears (`grep -rn "dsh-goal" packages/bundle/base/` and add the four loop packages to the same manifest file(s))

- [ ] **Step 1: Add four entries**

```yaml
    - id: loop
      name: '@deepseek-ai/dsh-loop'

    - id: loop-chain-driver
      name: '@deepseek-ai/dsh-loop-chain-driver'

    - id: command-loop
      name: '@deepseek-ai/dsh-command-loop'

    - id: tool-loop-query
      name: '@deepseek-ai/dsh-tool-loop-query'
```

`loop-chain-driver` config carries `provider: '<in-process provider name>'` — set the same provider id the shipped base uses for subagents today (`grep -n "provider" packages/subagent/subagent/README.md` and the base yml; do not invent a new name).

- [ ] **Step 2: Gates**

Run: `pnpm run verify-cordis-config && pnpm run build && pnpm run hygiene`
Expected: PASS (knip/publint surface the four packages cleanly).

- [ ] **Step 3: Commit**

```bash
git add packages/bundle/base/cordis.patch.yml packages/bundle/base
git commit -m "feat(loop): mount the loop family in the shipped base"
```

---

## Phase E — acceptance, snapshot, and spec sync (PR 2, task 4)

### Task E1: keyless snapshot of a full relay

**Files:**
- Create: `apps/cli/tests/loop-relay.snapshot.ts` (follow the harness of the nearest existing spec — `ls apps/cli/tests/*.snapshot.ts` and copy the closest scenario's structure, fixtures dir, and recording workflow)
- Create: its fixtures/expected-output directory under the same conventions

- [ ] **Step 1: Record** (`pnpm run test:snapshot:record` with `DEEPSEEK_API_KEY`): a two-node `loop.yaml` + evaluator, `--read` a sibling workspace, run to one evaluator `complete`. The transcript must show: `/loop start` echo, node relay prompts (lean push), settlement reports, evaluator verdict, completion render.
- [ ] **Step 2: Replay keyless** — `pnpm run test:snapshot`; expected PASS with the recorded fixtures.
- [ ] **Step 3: Commit**

```bash
git add apps/cli/tests/loop-relay.snapshot.ts apps/cli/tests
git commit -m "test(loop): keyless relay snapshot through a real composition"
```

### Task E2: spec sync — 2026-07-16 stale fact + note lifecycle

**Files:**
- Modify: `.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md` (+ zh + sidecar re-record)
- Move: `.agents/notes/proposed/feature/2026-09-24-cross-session-relay-loop.md` → `.agents/notes/implemented/feature/` (+ zh + sidecar), `Status: implemented`

Ordering constraint: this task runs LAST — only after Task E3's acceptance sweep is green (or green under its registered exemptions). Plan completion is not implementation completion; the note moves only when the behavior it describes is shipped.

- [ ] **Step 1:** Rewrite the 2026-07-16 note's stale clause — the family now exists with the concrete consumer; keep the note's rejected-abstraction reasoning and cross-link both directions (that note ↔ this note).
- [ ] **Step 2:** Move the spec triplet to `implemented/`, set `Status: implemented`, and re-record the sidecar: `pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-09-24-cross-session-relay-loop.md`. Fix every inbound link to the moved note (`grep -rn "2026-09-24-cross-session-relay-loop" . --include=*.md`).
- [ ] **Step 3: Supersession check** per [.agents/notes/AGENTS.md](../notes/AGENTS.md): audit the active tree for other notes claiming loop/relay territory; archive qualifying implemented triplets through the dsh-archive-agent-notes workflow; keep partial supersessions active and cross-linked.
- [ ] **Step 4: Docs gates** — `pnpm run verify-agent-note-format && pnpm run verify-translation-pairing && pnpm run verify-md-links && pnpm run doc-sync`; expected all PASS.
- [ ] **Step 5: Commit**

```bash
git add .agents/notes/implemented/feature/2026-07-16-harness-level-loop.md .agents/notes/implemented/feature/2026-07-16-harness-level-loop.zh.md .agents/notes/implemented/feature/2026-09-24-cross-session-relay-loop.md .agents/notes/implemented/feature/2026-09-24-cross-session-relay-loop.zh.md .agents/notes/proposed/feature
git commit -m "docs(loop): land the relay loop decision record and supersede the 2026-07-16 stale fact"
```

### Task E3: acceptance sweep against the spec

- [ ] **Step 1: Walk the spec's 12 acceptance criteria one by one.** For each: name the test that proves it (unit, Loader-booted, snapshot) and run that test file. Any criterion without a test gets a test added in the owning package before continuing — the list is in the spec's `## Acceptance criteria` section; do not paraphrase it, copy the bullets.
- [ ] **Step 2: Full gate set for the change**

Run: `pnpm run test:coverage && pnpm run typecheck && pnpm run lint && pnpm run duplication && pnpm run hygiene && pnpm run doc-sync && pnpm run test:snapshot`
Expected: all PASS (per-file 100% coverage on every new `packages/loop/*/*/src` file), with two registered pre-existing exemptions while they persist: (1) `scripts/project-doc-site.spec.ts > publishableImage > refuses a target whose real path escapes the repository` — a local Windows environment limitation, not a HEAD regression: the test body's `symlinkSync` fails with EPERM without Developer Mode/admin privilege; the spec and its subject are committed and clean, the same failure reproduces in a clean worktree at HEAD, and CI on Linux creates symlinks without privilege; (2) the `verify-client-catalog` staleness naming `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` — another author's uncommitted catalog work that must resolve when they land it, because their PR cannot merge without regenerating the catalog. Re-check both at execution time and drop an exemption the moment it turns green.

- [ ] **Step 3: Commit any test additions**, message `test(loop): close acceptance-criteria gaps`.

- [ ] **Step 4: Land PR 2** from `feature/cross-session-relay-loop` (labels: `kind/feature`, `area/loop`, `area/subagent` when it carries the seam rebase). Follow [dsh-pre-push-checks](../skills/dsh-pre-push-checks/SKILL.md) for the outgoing diff selection — do not reflexively run the full suite locally.
