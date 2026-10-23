---
description: "The event-sourced cross-session relay loop domain for users and maintainers choosing, configuring, or debugging one durable relay run per controlling session."
kind: "package-reference"
---

# @deepseek-ai/dsh-loop

English | [中文](README.zh.md)

## Summary

`dsh-loop` records one cross-session relay loop per controlling session: a frozen role chain, rounds of node attempts, and an append-only node ledger, all written as versioned session events and rebuilt by a strict replay fold. `ctx.loops` serves compare-and-set lifecycle mutations and non-CAS ledger appends; activation — whether this process may advance the run — stays process-local. The package stores loop state but spawns no nodes, assembles no prompts, and schedules no rounds; those policies belong to separate consumer packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-loop` whenever one session must own the durable record of a relay run across turns, restarts, and forks. The package is a service: commands, query tools, and continuation drivers that surface a run are separate consumer packages, so mounting only this package stores and serves the loop without executing any of it.

### When to use it

A loop suits one objective that a frozen chain of role nodes relays across rounds — each node working in its own workspace, reading declared source sessions, and handing a validated report to the next node. Routine single-turn work should not create a loop. The service keeps at most one current loop per session: an unfinished loop must be paused, resumed, completed, blocked, or cleared before another takes its place, while a completed loop can be replaced directly.

### Set up the service

Load the package with a composition entry; the deployment choices bound rounds, node retries, report size, and evaluator input, and the service materializes them into the validated `resolved` object consumer packages read.

```yaml
- name: '@deepseek-ai/dsh-loop'
  config:
    defaultMaxRounds: 20
    maxNodeRetries: 2
    maxHandoffChars: 16384
    maxEvaluatorInputChars: 65536
```

| Field | Default | Meaning |
|---|---|---|
| `defaultMaxRounds` | `20` | Round cap applied when a start request omits its own |
| `maxNodeRetries` | `2` | Retry budget per node within one resume epoch |
| `maxHandoffChars` | `16384` | Character cap for one handed-over report |
| `maxEvaluatorInputChars` | `65536` | Character cap for the evaluator's aggregate round input |

Every field must be a positive safe integer; invalid values raise a plain error at load. A start request that names its own round cap overrides `defaultMaxRounds`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-loop) is the exhaustive source for every accepted field.

### Session projection

`LoopService` requires `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)) and registers the `loop` projection unit at startup; a composition that omits the projection registry cannot activate `ctx.loops`. The unit's version 2 host state retains the latest valid current loop, every previously used loop id, the first strict replay failure, and the fork seed offset. Its client view exposes the current projection or `null` before the first create and after a clear tombstone. The key merges into both `SessionProjectionStateMap` and `SessionProjectionMap`; carriers serve the client value on the history tail page and the `session/projection` push frame.

### Drive the lifecycle

A loop moves through five durable phases — `active`, `awaiting-human`, `paused`, `blocked`, `complete` — plus a process-local activation that says whether this process may advance the round. The verbs:

| Operation | What it does |
|---|---|
| `create` | Starts and arms an active loop with an objective, frozen chain, scopes, and caps |
| `pause` | Stops advancement and keeps the state |
| `resume` | Rearms and continues while round capacity remains; the resume revision is the retry-epoch floor |
| `await-human` | Parks an active loop at a human checkpoint awaiting an answer |
| `continue` | Returns an awaiting loop to active after its human answer |
| `advance` | Records one applied evaluator verdict by consuming a round of the budget |
| `complete` | Marks the loop achieved and disarms it |
| `block` | Records a stable reason code and explanation, then disarms |
| `clear` | Removes the current loop; its history stays in the session log |

Mutations carry the exact `LoopRef { id, revision }` and reject stale refs; every accepted mutation appends a `loop/change` event and increments the revision. The ledger appends — `appendNodeStarted`, `appendAttempt`, `appendSettlement` — validate fold-grade against the current loop and append without a revision bump; each records the spawn, failure, or settlement of one node attempt at the loop revision it was taken at.

### What survives and what does not

Every accepted mutation and ledger append is recorded durably in the session log — the only store of loop state — so loop state never depends on transient message delivery. After session resume, the loop, its phase, its revisions, its ledger, and its started-round count are all still there. Activation is the exception: it lives in a per-session process-local cache, a fresh process or agent boundary disarms it, and it is never persisted — a reopened session starts no work by itself until a consumer explicitly resumes.

A fork is the second exception: the projection folds loop events only from the fork's seed offset, so the parent's run stays with the parent session and a fork drives no run.

### Observing a loop

Consumers read the current loop through the `loop` session projection and mutate through `ctx.loops`. The projection value carries the whole snapshot, the folded ledger, and the last ref for compare-and-set:

```text
const view = projection.current      // LoopProjection | null — null before the first create and after a clear
view.loop                             // LoopSnapshot — objective, phase, chain, scopes, roundsStarted
view.ledger                           // append-only entries keyed {loopId, round, nodeIndex, attempt}
view.lastRef                          // { id, revision } the next mutation must carry
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **Four versioned event types.** `loop/change` (version 1) carries the complete post-mutation snapshot or a revisioned clear tombstone; `loop/node-started`, `loop/attempt`, and `loop/node` (version 1 each) append the node ledger. The session log is the only durable authority.
- **Compare-and-set mutations.** `ctx.loops` accepts only the exact live `Agent` registered under its id, requires the session to be live in the session store, and rejects stale refs with `LOOP_STALE_REVISION`. A failed flush disarms the run and rethrows while the committed event stays in the log — the durability barrier.
- **Strict replay.** The fold applies `loop/change` last-wins and folds ledger events into a map keyed `{loopId, round, nodeIndex, attempt}`. It rejects malformed records, discontinuous revisions, illegal phase transitions, non-monotonic timestamps, duplicate ledger keys, settlements without a matching `node-started`, and reused loop ids. The first failure is retained and loop access fails from that record; other projections of the same session are unaffected.
- **Activation is process-local.** `armed` and `disarmed` live in a per-session cache and are never persisted. A fresh cache and every `agent/created` edge disarm the run even when replay finds an active durable phase; `arm()` and `disarm()` change authority without writing a revision, and a pending activation set synchronously during a mutation crosses the append boundary with its event.
- **Projection unit.** The package requires the projection registry and registers a strict `loop` unit (state version 3). Its host state retains replay validation data and the fork seed offset; its client view exposes the latest valid projection or `null`.
- **Invariant companion.** The `./invariant` export installs an independent incremental fold over every attached session: candidate events are validated on a copy, and failures name the exact session event seq. A loop fold failure never fails other packages' projections of the same session.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LoopService`, config schema, start validation, projection unit, activation cache |
| [`src/domain.ts`](src/domain.ts) | Durable change and ledger payloads, scoped `loop/changed` event, error codes |
| [`src/types.ts`](src/types.ts) | Pure client-safe types: `LoopView`, `LoopSnapshot`, chain and ledger types, projection-key declaration |
| [`src/fold.ts`](src/fold.ts) | Strict replay fold and hand-rolled decoders for the durable loop events |
| [`src/paths.ts`](src/paths.ts) | Scope-path normalization: realpath resolution, forward-slash separators, win32 case folding |
| [`src/runtime.ts`](src/runtime.ts) | `LoopId` brand, `LoopError`, change and ledger version constants |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: independent incremental fold over every attached session |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |

### Events and attribution

`loop/changed` fires after the durable `loop/change` commits, with listener failures contained; the payload carries the operation and the fresh ref, scope-filtered to the owning agent. Ledger events are append-only records attributed by their `{loopId, round, nodeIndex, attempt}` key and the loop revision they were taken at; the invariant companion attributes validation failures to the exact session event seq.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [Loop subsystem](../../../docs/subsystems/loop.md) — the loop types, durable event payloads, and generated service API.
- [Loop group map](../README.md) — the loop packages and how they compose.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-loop) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Loop-state mutations

#### What the model sees

Loop mutations do not inject model context. This package registers no tools, no command, and no prompt contribution; consumers that surface a run own any rendering of `loop/change` state.

#### Token effect

Loop mutation and ledger events add no model tokens by themselves. Whatever a consumer renders into tool results or prompts accounts for its own visible state.

#### KV Cache effect

There is no KV-cache effect until another component exposes loop state in model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the loop service is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **State, not execution** — this package spawns no child sessions, assembles no prompts, retries no failures, and decides no scheduling; those policies belong to consumer packages.
- **One current loop** — parallel loops, DAG node shapes, and per-node fan-out are intentionally absent; a completed loop can be replaced directly, and history remains readable in the session log.
- **No automatic cross-process resume** — durable state replays after a restart, but activation is never persisted and nothing restarts work on its own; an explicit resume re-arms the run.
- **Round, retry, and size caps only** — `maxRounds`, `maxNodeRetries`, `maxHandoffChars`, and `maxEvaluatorInputChars` bound effort; token, cost, and wall-clock budgets are deferred.
- **A fork inherits no run** — the fold applies loop events only from the fork's seed offset, so a fork of the controlling session drives no run and must create a fresh loop.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit loop events. Strict replay detects malformed or inconsistent records and leaves loop access failed at that record until the log is repaired; this is integrity detection, not plugin isolation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. The strict decoders in `src/fold.ts` are hand-rolled, mirroring the goal domain's fold: each field check throws an `Error` naming the record and field, and the fold attributes it to the failing session event. The package therefore declares no schema-library dependency; consumers that parse untrusted chain definitions own their schema validation.

</details>
