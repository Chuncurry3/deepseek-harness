# 跨会话中继 loop

[English](loop.md) | 中文

事件溯源 loop 服务与其消费方共享的类型。本页逐字段记录 [`packages/loop/loop/src/types.ts`](../../packages/loop/loop/src/types.ts) 与 [`src/domain.ts`](../../packages/loop/loop/src/domain.ts) 的确切字段与取值；组[地图](../../packages/loop/README.zh.md)列出各包，包 [README](../../packages/loop/loop/README.zh.md) 拥有可调用 API 与模型可见契约。

## 标识与生命周期

`LoopId` 是[品牌化 id](core.zh.md#branded-ids)。一个 `LoopRef` 钉住比较并设置变更所要求的精确 revision；`loop/change` 事件是 revision 的唯一来源，其余所有 loop 事件都记录其所取的 revision。

```ts type-equiv
/** Compare-and-set identity for one exact loop revision. */
interface LoopRef {
  readonly id: LoopId
  /** Positive revision; increments on every `loop/change` event only. */
  readonly revision: number
}
```

持久 phase 依次流转于 `active`、`awaiting-human`、`paused`、`blocked` 与 `complete`。激活——本活进程是否可以推进当前 Round——是进程本地状态，既不是 phase 取值，也绝不持久化。

```ts type-equiv
/** Durable lifecycle phase. Activation is process-local and separate. */
type LoopPhase = 'active' | 'awaiting-human' | 'paused' | 'blocked' | 'complete'
```

`blocked` 是唯一携带机器可路由 reason 代码的 phase：节点失败、Round 上限、被拒绝的裁决、缺失的检查点提供方、持久化失败与超限报告共享同一个持久状态，而不是成倍增加 phase。

```ts type-equiv
/** Machine-routable and human-readable explanation for a blocked loop. */
interface LoopBlockReason {
  readonly code: 'node-failed' | 'round-limit' | 'evaluator-blocked' | 'checkpoint-provider-missing' | 'durability-failed' | 'report-budget'
  readonly message: string
}
```

链在 start 时冻结：之后的每一轮都以相同顺序重放相同的角色节点。节点声明角色、绝对工作区与提示词；可以整体替换默认交接 schema、声明要读取的来源会话，并点名其前一轮报告需要带入的角色。

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

快照是完整的持久状态。作用域值按精确字符串比较：调用方传入经 realpath 规范化的绝对工作区，且 `writeScopes` 必须包含每个节点工作区，否则 start 失败。

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

视图在快照之外补充创建与最近一次变更的时间戳，以及进程本地的激活标志。

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

## 持久台账

每个生命周期变更都是一条持久的 `loop/change` 会话事件，其载荷要么是变更后的完整快照，要么是 clear tombstone。严格折叠与投影只从这些事件推导 loop 状态。

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

节点执行追加另外三种事件类型，各携带一条台账记录。它们不递增 revision 地追加，并折叠进以 `{loopId, round, nodeIndex, attempt}` 为键的台账映射：结算必须关闭一个打开的派生，attempt 序号在节点的重试纪元内为正且从 1 起，重复键会被拒绝。

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

结算后的报告在台账中保持 `unknown`：严格折叠只检查信封，不检查载荷 schema。评估器节点以固定 schema 的裁决结算，该裁决指名下一轮的流转。

```ts type-equiv
/** One evaluator verdict, fixed schema, settled through `loop/node`. */
interface LoopVerdict {
  readonly decision: 'continue' | 'complete' | 'blocked'
  readonly feedback?: string
  readonly reason?: string
}
```

## 请求与通知

start 请求把调用方省略与部署选择区分开，服务再从其配置解析默认值。每次变更通知都携带被接受的操作与精确的最新 ref。

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

## 服务行为

[`LoopService`](../../packages/loop/loop/src/index.ts) 解析 start 默认值、从 `loop` 投影读取严格回放、强制精确活跃 agent 身份与比较并设置变更、对照当前 loop 校验台账追加，并发出被隔离的 `loop/changed` 通知。其首次依赖访问在投影注册表或键缺失时失败。包 [README](../../packages/loop/loop/README.zh.md) 定义可调用 API 与模型可见契约。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/loop/loop/src/domain.ts`](../../packages/loop/loop/src/domain.ts)
<!-- END GENERATED cordis-surface -->
