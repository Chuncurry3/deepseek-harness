# Cross-session relay loops

English | [中文](loop.zh.md)

Types shared by the event-sourced loop service and its consumers. This page records the exact fields and variants from [`packages/loop/loop/src/types.ts`](../../packages/loop/loop/src/types.ts) and [`src/domain.ts`](../../packages/loop/loop/src/domain.ts); the group [map](../../packages/loop/README.md) lists the packages, and the package [README](../../packages/loop/loop/README.md) owns the callable API and the model-visible contract.

## Identity and lifecycle

`LoopId` is a [branded id](core.md#branded-ids). A `LoopRef` pins one exact revision for compare-and-set mutations; `loop/change` events are the only revision source, and every other loop event records the revision it was taken at.

```ts type-equiv
/** Compare-and-set identity for one exact loop revision. */
interface LoopRef {
  readonly id: LoopId
  /** Positive revision; increments on every `loop/change` event only. */
  readonly revision: number
}
```

The durable phase moves through `active`, `awaiting-human`, `paused`, `blocked`, and `complete`. Activation — whether this live process may advance the round — is process-local state, never a phase value, and never persists.

```ts type-equiv
/** Durable lifecycle phase. Activation is process-local and separate. */
type LoopPhase = 'active' | 'awaiting-human' | 'paused' | 'blocked' | 'complete'
```

`blocked` is the one phase that carries a machine-routable reason code, so failed nodes, the round limit, rejected verdicts, missing checkpoint providers, failed durability, and oversized reports share a single durable state instead of multiplying phases.

```ts type-equiv
/** Machine-routable and human-readable explanation for a blocked loop. */
interface LoopBlockReason {
  readonly code: 'node-failed' | 'round-limit' | 'evaluator-blocked' | 'checkpoint-provider-missing' | 'durability-failed' | 'report-budget'
  readonly message: string
}
```

The chain is frozen at start: every later round replays the same role nodes in the same order. A node names a role, its absolute workspace, and its prompt; it may replace the default handoff schema wholesale, declare source sessions to read, and name roles whose prior-round reports carry over.

```ts type-equiv
/** One declared source conversation a node continues by reading. */
interface LoopInputRef { readonly session: SessionId }
```

```ts type-equiv
/** One role node of the frozen chain. */
interface LoopChainNodeDef {
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
```

```ts type-equiv
/** The frozen, validated chain. */
interface LoopChainDef {
  readonly objective: string
  readonly exit?: string
  readonly checkpoint: 'none' | 'node'
  readonly nodes: readonly LoopChainNodeDef[]
  readonly evaluatorPrompt?: string
}
```

The snapshot is the full durable state. Scope values are compared as exact strings: the caller passes realpath-normalized absolute workspaces, and `writeScopes` must contain every node workspace or start fails.

```ts type-equiv
/** Full durable state written by every non-clear `loop/change` event. */
interface LoopSnapshot extends LoopRef {
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
```

The view adds the create and latest-mutation timestamps plus the process-local activation flag to the snapshot.

```ts type-equiv
/** Current loop view: the durable snapshot plus process-local activation. */
interface LoopView {
  readonly loop: LoopSnapshot
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: LoopActivation
}
```

## Durable ledger

Every lifecycle mutation is a durable `loop/change` session event whose payload is either a complete post-mutation snapshot or a clear tombstone. The strict fold and the projection derive loop state only from these events.

```ts type-equiv
/** Full-snapshot loop mutation committed by a durable `loop/change` event. */
interface LoopSnapshotChangeMeta {
  readonly kind: 'loop/change'
  readonly version: 1
  readonly operation: Exclude<LoopOperation, 'clear'>
  readonly loop: LoopSnapshot
  readonly createdAt: number
  readonly updatedAt: number
}
```

```ts type-equiv
/** Tombstone retained when the current loop is cleared. */
interface LoopClearChangeMeta {
  readonly kind: 'loop/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: LoopRef
  readonly clearedAt: number
}
```

Node execution appends three further event types, each carrying one ledger record. They append without a revision bump and fold into the ledger map keyed `{loopId, round, nodeIndex, attempt}`: a settlement must close an open spawn, attempt numbers are positive and 1-based within a node's retry epoch, and duplicate keys are rejected.

```ts type-equiv
/** Append-only spawn record committed by a `loop/node-started` event. */
interface LoopNodeStartedMeta {
  readonly kind: 'node-started'
  readonly version: 1
  readonly loopId: LoopId
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  /** Positive 1-based attempt number within the node's retry epoch. */
  readonly attempt: number
  readonly childSessionId: SessionId
  readonly cwd: string
  readonly atRevision: number
}
```

```ts type-equiv
/** Append-only failure record committed by a `loop/attempt` event. */
interface LoopAttemptMeta {
  readonly kind: 'attempt'
  readonly version: 1
  readonly loopId: LoopId
  readonly round: number
  readonly nodeIndex: number
  /** Positive 1-based attempt number the failure ends. */
  readonly attempt: number
  readonly childSessionId: SessionId
  readonly failure: { readonly code: string; readonly message: string }
  readonly atRevision: number
}
```

```ts type-equiv
/** Append-only settlement committed by a `loop/node` event. */
interface LoopNodeSettledMeta {
  readonly kind: 'settlement'
  readonly version: 1
  readonly loopId: LoopId
  readonly round: number
  readonly nodeIndex: number
  readonly role: string
  /** Positive 1-based attempt number the settlement closes. */
  readonly attempt: number
  readonly childSessionId: SessionId
  readonly cwd: string
  readonly report: unknown
  readonly atRevision: number
}
```

A settled report stays `unknown` in the ledger: the strict fold checks the envelope, not the payload schema. An evaluator node settles with the fixed-schema verdict that names the next round transition.

```ts type-equiv
/** One evaluator verdict, fixed schema, settled through `loop/node`. */
interface LoopVerdict {
  readonly decision: 'continue' | 'complete' | 'blocked'
  readonly feedback?: string
  readonly reason?: string
}
```

## Requests and notifications

A start request separates caller omission from the deployment choice, which the service resolves from its configuration. Every mutation notification carries the accepted operation and the exact fresh ref.

```ts type-equiv
/**
 * Caller input for {@link LoopService.start}. Scope and cwd values are
 * compared as exact strings (the caller passes realpath-normalized values).
 */
interface StartLoopRequest {
  readonly objective: string
  readonly chain: LoopChainDef
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly maxRounds?: number
  readonly checkpoint?: 'none' | 'node'
}
```

```ts type-equiv
/** Live notification after one durable loop mutation commits. */
interface LoopChanged {
  readonly operation: LoopOperation
  readonly ref: LoopRef
}
```

## Service behavior

[`LoopService`](../../packages/loop/loop/src/index.ts) resolves start defaults, reads strict replay from the `loop` projection, enforces exact-live-agent identity and compare-and-set mutations, validates ledger appends against the current loop, and emits contained `loop/changed` notifications. Its first dependent access fails if the projection registry or key is absent. The package [README](../../packages/loop/loop/README.md) defines the callable API and model-visible contract.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloops--loopservice"></a>

### `ctx.loops` — `LoopService`

Loop service (`ctx.loops`): compare-and-set lifecycle mutations and non-CAS node-ledger appends over the owning agent's session log. Every mutation requires the agent to be live in this context and its session to be live in the session store (the durability barrier); a failed flush disarms the run and rethrows while the committed event stays in the log.

```ts cordis-catalog
/**
 * Create and arm one relay loop. A completed loop may be replaced with a
 * fresh one; every other current phase must be cleared first.
 * @param agent - owning live agent.
 * @param request - objective, frozen chain, scopes, and optional caps.
 * @returns the created live view.
 * @throws LoopError LOOP_AGENT_NOT_LIVE, LOOP_ALREADY_EXISTS,
 *   LOOP_INVALID_CHAIN, or LOOP_SCOPE_VIOLATION.
 */
async start(agent: Agent, request: StartLoopRequest): Promise<LoopView>

/**
 * Pause the current loop and disarm it.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the paused view.
 */
async pause(agent: Agent, ref: LoopRef): Promise<LoopView>

/**
 * Resume and arm the loop while its round budget still has capacity; the
 * resume revision is the retry epoch floor.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the resumed view.
 */
async resume(agent: Agent, ref: LoopRef): Promise<LoopView>

/**
 * Park the active loop at a human checkpoint awaiting an answer.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the awaiting view.
 */
async awaitHuman(agent: Agent, ref: LoopRef): Promise<LoopView>

/**
 * Continue the awaiting loop after its human answer.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the active view.
 */
async continueFromHuman(agent: Agent, ref: LoopRef): Promise<LoopView>

/**
 * Record one applied verdict by consuming a round of the budget.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the active view with the advanced round count.
 */
async advance(agent: Agent, ref: LoopRef): Promise<LoopView>

/**
 * Mark the active loop complete and disarm it.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @returns the completed view.
 */
async complete(agent: Agent, ref: LoopRef): Promise<LoopView>

/**
 * Mark the loop blocked with a durable reason and disarm it.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 * @param reason - policy-owned stable code and human-readable explanation.
 * @returns the blocked view.
 */
async block(agent: Agent, ref: LoopRef, reason: LoopBlockReason): Promise<LoopView>

/**
 * Clear the current loop from any phase while retaining the tombstone.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 */
async clear(agent: Agent, ref: LoopRef): Promise<void>

/**
 * Append one node-spawn record to the current loop's ledger.
 * @param agent - owning live agent.
 * @param meta - spawn record without its version and revision stamp.
 * @param atRevision - current loop revision the record was taken at.
 */
async appendNodeStarted(agent: Agent, meta: Omit<LoopNodeStartedMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void>

/**
 * Append one attempt-failure record to the current loop's ledger.
 * @param agent - owning live agent.
 * @param meta - failure record without its version and revision stamp.
 * @param atRevision - current loop revision the record was taken at.
 */
async appendAttempt(agent: Agent, meta: Omit<LoopAttemptMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void>

/**
 * Append one node settlement to the current loop's ledger.
 * @param agent - owning live agent.
 * @param meta - settlement record without its version and revision stamp.
 * @param atRevision - current loop revision the record was taken at.
 */
async appendSettlement(agent: Agent, meta: Omit<LoopNodeSettledMeta, 'version' | 'atRevision'>, atRevision: number): Promise<void>

/**
 * Read the process-local activation for one exact live agent.
 * @param agent - owning live agent.
 * @returns the current activation.
 */
activation(agent: Agent): LoopActivation

/**
 * Arm the current loop at one exact revision without writing a durable event.
 * @param agent - owning live agent.
 * @param ref - expected current revision.
 */
arm(agent: Agent, ref: LoopRef): void

/**
 * Drop process-local continuation authority without a durable revision.
 * @param agent - owning live agent.
 */
disarm(agent: Agent): void
```

Types: [Agent](core.md)

Source: [`packages/loop/loop/src/index.ts`](../../packages/loop/loop/src/index.ts)

<a id="loop-events"></a>

### `loop/*` events

<a id="loopchanged--emit"></a>

#### `loop/changed` — emit

Loop mutation accepted by one live agent. The matching `loop/change` session event has already committed. Listener failures are contained. The emitted snapshot may already be superseded by a later concurrent mutation when a listener runs, so listeners needing current state must re-read it instead of trusting the payload. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Loop mutation accepted by one live agent. The matching `loop/change`
 * session event has already committed. Listener failures are contained.
 * The emitted snapshot may already be superseded by a later concurrent
 * mutation when a listener runs, so listeners needing current state must
 * re-read it instead of trusting the payload.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param payload.agent - agent whose session owns the loop.
 * @param payload.change - operation plus the fresh snapshot ref.
 * @mode emit
 */
'loop/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: LoopChanged }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/loop/loop/src/domain.ts`](../../packages/loop/loop/src/domain.ts)
<!-- END GENERATED cordis-surface -->
