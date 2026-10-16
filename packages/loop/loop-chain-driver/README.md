---
description: "The cross-session relay chain package for users and maintainers authoring chains, composing, or debugging the continuation driver that runs them."
kind: "package-reference"
---

# @deepseek-ai/dsh-loop-chain-driver

English | [中文](README.zh.md)

## Summary

`dsh-loop-chain-driver` runs a relay loop end to end. The parser turns the human-authored chain document — the YAML naming each node's workspace, prompt, inputs, carryOver, and output schema — into the frozen `LoopChainDef` `@deepseek-ai/dsh-loop` persists, with `defaultChain` as the fallback. The handoff engine renders each node child's lean-push prompt and validates settled reports against the schema and budget caps. The continuation driver plugin spawns one fresh subagent per node through a configured provider, settles reports, re-asks the human at `node` checkpoints, applies the evaluator verdict, and recovers in-flight children after a restart — no round advances without an explicit resume.

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

### Compose the driver

Mount the plugin beside the loop, subagent, and user-questions services; `provider` names the subagent provider that spawns every node child, and a blank name fails at load:

```yaml
- name: '@deepseek-ai/dsh-loop'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-user-questions'
- name: '@deepseek-ai/dsh-loop-chain-driver'
  config:
    provider: 'subagent-local'
```

The loop knobs (`defaultMaxRounds`, `maxNodeRetries`, `maxHandoffChars`, `maxEvaluatorInputChars`) belong to `dsh-loop`; the driver reads their resolved values instead of duplicating them. The `@deepseek-ai/dsh-session-query` peer is optional: without it, restart recovery degrades to respawn-with-attempt and unledgered-child enumeration is skipped.

### What each round does

With an exact live controlling agent, an active armed loop, and remaining rounds, the driver drives the next round's unsettled nodes in chain order: it re-asserts the node's declared workspace against the frozen write scopes before spawning (an out-of-scope workspace blocks `node-failed` non-retryably), spawns each node's fresh child in the node's workspace with the assembled prompt and output schema, records the open attempt, awaits the result, and settles a validated report — or appends the attempt failure and retries with the failure reason in the prompt until the epoch budget blocks `node-failed`. The evaluator is the final node index; its verdict `complete`/`blocked` ends the loop and `continue` advances the round. A `node` checkpoint parks the loop `awaiting-human` after each settlement until the human answers continue, pause, or terminate. Before every round the driver flushes the controlling session; a flush failure blocks `durability-failed` and disarms.

### After restart, pause, or unload

A freshly loaded driver disarms every loop and does no work: resuming authority crosses no process boundary. An explicit `resume` re-arms the loop and applies a pending evaluator verdict exactly once. An in-flight child whose `node-started` record survived the crash is recovered by re-reading its final assistant surface from the durable log; one that left no recoverable report records an `interrupted-by-shutdown` attempt and respawns. Children the ledger does not cover are enumerated through the subagent catalog and warned about only — never recovered, settled, or recorded. Pre-restart attempts below the resume revision do not consume the fresh retry budget. A `pause` aborts the in-flight child immediately and records its open attempt with code `paused`, so a later resume continues with the next attempt; unloading the plugin aborts, records nothing, and disarms.

### Parse chain documents

Import the parsing functions directly:

```ts
import { parseChainDocument, defaultChain } from '@deepseek-ai/dsh-loop-chain-driver/chain'

const chain = parseChainDocument(documentText)   // one aggregate Error on any invalid document
const fallback = defaultChain('Ship the migration')
```

Top-level fields:

| Field | Required | Meaning |
|---|---|---|
| `objective` | yes | What the loop works toward; non-empty, no surrounding whitespace |
| `exit` | no | Free-text exit criterion for the evaluator; without it the evaluator judges against the objective |
| `checkpoint` | no | `none` (default) runs without interruption; `node` asks the human after every node settlement |
| `nodes` | yes | Non-empty list of role nodes; roles must be unique |
| `evaluator.prompt` | no | Overrides the driver's default evaluator instruction |

Each node:

| Field | Required | Meaning |
|---|---|---|
| `role` | yes | Unique role name; other nodes' `carryOver` entries reference it |
| `prompt` | yes | The role instruction the node's fresh child receives |
| `cwd` | no | Workspace for the node; defaults to the loop's home workspace |
| `output` | no | Object-rooted JSON Schema replacing the default handoff schema (`status`, `summary`, `evidence`, `nextSteps`) wholesale |
| `inputs` | no | Declared source sessions, each entry exactly `{ session: <sessionId> }` |
| `carryOver` | no | Role names whose prior-round reports carry into this node |

Unknown keys are rejected at every level. A failure throws one `Error` whose message lists every issue as a `- <path>: <message>` line; a YAML syntax failure names the line the YAML parser rejected.

### The node handoff

`assembleNodePrompt(view, round, nodeIndex)` returns one node's prompt: the objective, the round number, the frozen role instruction, the reports the chain's visibility rule names, the opening evaluator feedback, the declared input session ids, the prior child session ids, and the read-scope statement. Raw transcripts never enter the prompt; the receiving node pulls detail on demand from the named sessions. Visibility: same-round predecessors by default, plus the `carryOver` roles' prior-round reports; prior `continue`-verdict feedback is forced into the first node and every `carryOver`-declaring node; the evaluator sees every round report, the opening feedback, and the exit criteria. `validateReport(node, report, maxHandoffChars)` returns the violations — schema conformance, the exact `inherited` entry count, and the serialized UTF-16 size — and `evaluatorInputBudget(view, round, maxEvaluatorInputChars)` blocks `report-budget` instead of truncating an over-cap evaluator aggregate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the driver realizes the behavior above; the accepted fields are covered in [Use this package](#use-this-package).

### Design

- **One serialized pass per agent.** Triggers coalesce onto one agent-local driver pass; a loop mutation event only requests the next pass. The pass re-reads the fenced view (exact live agent, fiber active, loop active and armed, same loop id) after every await, mirroring the goal-round-driver fences.
- **Replacement ledger semantics.** The loop fold replaces an open `node-started` record with its closing `attempt` or `settlement` under the same {round, nodeIndex, attempt} key, so attempt numbering scans all ledger kinds and the remaining `node-started` entry is open by construction.
- **Epoch floor.** The epoch is the revision of the latest create-or-resume change; attempts recorded below it are pre-restart history that never counts against the fresh `maxNodeRetries` budget.
- **Fail-closed containment.** A `LoopError` mutation failure warns and stops the pass quietly; an `InvariantError` blocks `node-failed`; any other failure blocks `durability-failed`. Teardown aborts the in-flight child, records nothing, disarms, and awaits pass quiescence before the initiator drain.
- **Strict parse, brand at parse.** `z.strictObject` rejects unrecognized keys at every level, one aggregate error names every issue, and each `inputs[].session` string becomes a `SessionId` during parsing.
- **Lean push, lossless pull.** `assembleNodeCarry` builds the typed carry behind a zod strict mirror, so a settlement whose report is not lossless JSON fails loud before any prompt renders.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The continuation driver plugin: round loop, retries, checkpoints, restart recovery, teardown |
| [`src/chain.ts`](src/chain.ts) | Chain-document parsing, validation, and the default chain |
| [`src/handoff.ts`](src/handoff.ts) | Node handoff assembly, report validation, and the evaluator input budget |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: settlement conformance and verdict-gated advancement |
| [`tests/driver.spec.ts`](tests/driver.spec.ts) | Round driving, retries, checkpoints, failure classification, restart recovery |
| [`tests/invariant.spec.ts`](tests/invariant.spec.ts) | Companion acceptance and rejection behavior |
| [`tests/chain.spec.ts`](tests/chain.spec.ts) | Parsing, rejection, and default-chain behavior |
| [`tests/handoff.spec.ts`](tests/handoff.spec.ts) | Visibility-rule, budget, and validation behavior |

### Invariant ownership

The companion folds every attached session's `loop/change` and `loop/node` events and rejects a settlement whose report violates the frozen node's handoff schema or role, a settlement beyond the evaluator, and an advance that applies no settled `continue` verdict. A fork folds from its own events only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Loop group map](../README.md) — the loop packages and how they compose.
- [`@deepseek-ai/dsh-loop`](../loop/README.md) — the durable loop service, event fold, and lifecycle mutations this driver drives.
- [Loop subsystem](../../../docs/subsystems/loop.md) — the loop types, durable event payloads, and generated service API.
- [`@deepseek-ai/dsh-subagent`](../../subagent/subagent/README.md) — the spawn seam the driver configures with `provider`.

-----

<a id="model-experience"></a>
## Model Experience

### Node child sessions

#### What the model sees

Each node child is a fresh session whose first turn is the assembled instruction: the relay round and node position, the objective, the frozen role instruction, the carried reports as one-line JSON with their rounds, roles, and child session ids, the opening feedback, the declared input session ids, the prior child session ids, and the read-scope statement. Raw transcripts are never pushed. A retry's instruction adds the prior attempts' failure reasons.

#### Token effect

A prompt's length scales with the number of carried reports — each bounded by `maxHandoffChars` at settlement — never with the sessions' transcript sizes. The evaluator's aggregate is bounded by `maxEvaluatorInputChars`, which blocks `report-budget` instead of truncating.

#### KV Cache effect

Node prompts go to fresh child sessions, so there is no KV-cache reuse within or across rounds; the deterministic section order keeps a re-driven round's prompts stable.

### Checkpoint asks

#### What the model sees

Nothing: `node` checkpoints ask the controlling human, not the model. The question names the round and settled-node count; the options are continue, pause, and terminate.

#### Token effect

None directly; a `continue` answer admits the next node's spawn, and a `terminate` answer completes the loop.

#### KV Cache effect

The checkpoint ask never enters model-visible input, so no KV-cache prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is the wrong place to look. They are current package constraints, not a task backlog.

- **Mounted in the shipped base** — the loop family (`@deepseek-ai/dsh-loop`, `@deepseek-ai/dsh-loop-chain-driver`, `@deepseek-ai/dsh-command-loop`, `@deepseek-ai/dsh-tool-loop-query`) mounts in the `dsh-base` composition with the driver's `provider` set to the base's in-process spawn provider.
- **One provider for every node** — `provider` names a single subagent provider; per-node providers would need a chain-language extension in the loop service first.
- **Workspace existence is the spawn's fence; scope is re-asserted** — the service checks a declared `cwd` against the write scopes at loop start, and the driver re-asserts that membership at spawn with the same exact-string comparison (a resumed chain whose declared workspace falls outside the frozen scopes blocks `node-failed` non-retryably). Directory existence stays the subagent spawn's fence: a nonexistent directory fails at spawn, blocking `node-failed` without recording an attempt.
- **The document language is a subset** — the parser accepts exactly what the durable fold in `@deepseek-ai/dsh-loop` replays; a chain-language extension must land in the loop service first.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. The driver plugin is a function plugin: it registers no `ctx` service, so command packages compose against the loop service plus their own registration of this plugin's lifecycle. Ledger appends never bump the loop revision, so the pre-spawn view's revision is always a valid `atRevision`. The ledger's replacement semantics make the open `node-started` entry's attempt number the floor for the next attempt; a global scan across all entry kinds keeps numbering monotone through replacements. The spawn-time scope re-assert compares exact strings against the frozen `writeScopes` — the fold never cross-checks chain workspaces on the read path, so the driver owns that fence. Restart recovery reads the crashed child's final assistant surface through the session-query service and validates it exactly like a live settlement; an unparseable or schema-violating recovered report records `invalid-recovered-report` and retries.

</details>
