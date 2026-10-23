# Agent Note: Cross-session relay loop

Status: proposed

English | [中文](2026-09-24-cross-session-relay-loop.zh.md)

## Problem

A long task composed of specialized roles — direct the next experiment, run it, optimize the tool from its results, configure the new version, repeat — spans multiple projects and outlives one conversation and one context window. The two shipped execution policies cover other shapes. A [same-session goal](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) keeps one objective in one growing conversation, so multi-role work rots the context it depends on. A [Ralph run](../../archived/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) iterates fresh children with workspace memory but is a foreground, model-invoked workflow with no durable run state, no cross-round conversation chaining, and no human command surface; its children also derive the parent session's workspace, so a relay that must act in another project cannot be expressed.

Reading other sessions exists — [`ctx.sessionQuery`](../../../../packages/session-query/session-query/README.md) serves trusted reads and [`tool-session-query`](../../../../packages/session-query/tool-session-query/README.md) serves workspace-authorized model reads — but nothing connects conversations: one conversation's curated output never becomes another conversation's input, and no policy executes a conversation's work in another project's workspace under a durable, resumable, human-authorized lifecycle.

Continuity here means continuing an original conversation's content in a new session — reading it, carrying its conclusions forward, and reporting what was inherited — not returning to the original conversation.

Handoffs done by pasting transcripts either bloat the next conversation with redundant material or drop the information that mattered. The requirement this feature exists to satisfy is mechanical, not advisory: cross-conversation transfer must admit no redundancy and lose no key information.

Uninterrupted execution needs explicit levels: work advances automatically while the host process lives, survives process death as durable state, and never restarts without explicit human authority.

## Proposal

Add a third execution policy as the plugin family `packages/loop/`, started by a human `/loop` command and assembled from existing seams. The vocabulary extends the [harness-level execution hierarchy](../../implemented/feature/2026-07-16-harness-level-loop.md): Loop Run → Round → Node → Turn → Step. One round is one traversal of a frozen chain of role nodes; one node is one fresh child conversation.

This proposal partially supersedes that note's clause "there is no `packages/loop/` family, `LoopDriver`, `LoopId`", which rejected a speculative universal loop service with no concrete consumer. The consumer is now concrete: human-command relay chains whose rounds connect fresh conversations through validated structured handoffs, executing and reading across explicitly granted project workspaces. The rejected abstraction stays rejected — no model-facing loop-creation tool, no generic `StopCondition`, no time-driven trigger (the [schedule family](../../../../packages/schedule/schedule/README.md) owns session-local reminders) — and the same-session goal and Ralph policies stand unchanged.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-loop` in `packages/loop/loop/` | Event-sourced run state in the controlling session; `ctx.loops`; compare-and-set `{loopId, revision}`; process-local activation |
| `@deepseek-ai/dsh-loop-chain-driver` in `packages/loop/loop-chain-driver/` | Continuation policy: advances nodes, spawns fresh children in per-node workspaces, validates reports, runs the evaluator |
| `@deepseek-ai/dsh-command-loop` in `packages/loop/command-loop/` | Human `/loop` command registered through [`ctx.commands`](../../implemented/feature/2026-07-19-plugin-command-registration.md) |
| `@deepseek-ai/dsh-tool-loop-query` in `packages/loop/tool-loop-query/` | Loop-scoped session search and read tools enforcing the run's frozen read scopes |

All four packages mount in the shipped `dsh` base composition. The command grammar follows [`command-goal`](../../../../packages/goal/command-goal/README.md): bare `/loop` or its whole-input `status` alias renders status; `/loop start <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node]` creates and arms a run, `start` being an optional prefix — any other non-empty input is itself the objective; `/loop pause`, `/loop resume [--from <node|role>]`, and `/loop clear` own the lifecycle. A control word is recognized case-insensitively only where it fits the whole input — `resume` also fits with the single `--from` flag — so `/loop pause now` starts that literal objective; quotes strip to their content before the match, so a quoted control word still acts as a verb. A start with no parsable objective is a parse-time rejection (the grammar's invalid-start member). `--read` and `--write` are repeatable single-path flags whose values may be double-quoted to carry spaces, semicolons, or a leading `--`; a quote opens a quoted run only at a token start and keeps its content verbatim with zero escapes, and a quoted token never becomes a flag; there is no list separator, so no escaping rules exist to get wrong. Every granted path is `realpath`-normalized at start and must exist and be enterable; anything else is a direct command error. `readScopes` is the union of the controlling session's own workspace, every chain node's workspace, and the `--read` grants; `writeScopes` is the controlling session's own workspace plus the `--write` grants — the implicit grant covers that one workspace, and every cross-project write is an explicit `--write`. A chain entry whose `cwd` falls outside `writeScopes` fails at start, and the driver re-asserts the scope at spawn.

Per-node workspaces require one subagent-seam extension: `SubagentStartRequest` gains an optional `cwd` (absolute, validated by the existing `assertUsableCwd` discipline), advertised as a provider capability. In-process providers set the child session's header cwd from it; providers without the capability reject a request that sets it, so behavior never silently degrades to the parent workspace. The extension lands as its own subagent-family note at implementation time, and the order is fixed: that note lands first, with capability validation and in-process provider support, and the loop packages build on it — they cannot start without it.

The chain comes from a workspace `loop.yaml`, strictly validated at start; a missing file yields the default chain defined in [Chain definition](#chain-definition). Rounds advance on node settlement, not wall-clock. Interruption levels are fixed in [Recovery](#recovery): L1 in-process automatic advancement, L2 cross-process manual `/loop resume`, and no L3 cross-process automatic resume.

External prior art anchors the mechanism choices: [Ralph](https://ghuntley.com/ralph/) for fresh-context iterations with externalized memory, [snarktank/ralph](https://github.com/snarktank/ralph) for task tables with completion bits, [vercel-labs/ralph-loop-agent](https://github.com/vercel-labs/ralph-loop-agent) for an outer verification loop with failure-feedback injection and usage guardrails, and Claude Code's `/goal` for an independent evaluator model whose verdict enters the transcript.

## Durable record

The controlling session — where the human typed `/loop` — owns the run, mirroring the [goal domain](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.md). Every mutation appends a session event and the fold is the only durable authority. Four versioned event types exist:

- `loop/change` — a complete post-mutation snapshot as a last-wins whole value: `loopId`, `revision`, objective, frozen chain definition, `maxRounds`, checkpoint mode, `readScopes`, `writeScopes`, phase `active | awaiting-human | paused | blocked | complete`, blocked reason, `roundsStarted`, and create/update timestamps. A clear appends a revisioned tombstone. The current loop is the latest create not followed by a tombstone; a replacement create mints a globally fresh `loopId`, so cleared history and a live run never share an identity.
- `loop/node-started` — an append-only spawn record: `loopId`, round, node index, role, 1-based attempt, `childSessionId`, `cwd`, and the `atRevision` at which the spawn happened. It is appended as soon as `start()` fulfills, before the result is awaited, so an in-flight child is always findable after a crash.
- `loop/attempt` — an append-only failure record for one attempt: `loopId`, round, node index, attempt, `failure: { code, message }`, `atRevision`. Attempt counts and failure reasons therefore survive restarts; the retry budget never resets by accident.
- `loop/node` — an append-only settlement: `loopId`, round, node index, role, attempt, `childSessionId`, `cwd`, and the validated report. Settlements record success; failures live in `loop/attempt`, and a budget exhaustion is a `loop/change` block.

`revision` increments only on `loop/change` events; the node ledger never bumps it. Compare-and-set uses the change revision. Every ledger event carries `atRevision`, the change revision in force when it happened — the logical clock for ordering and epoch-scoped budgets; wall-clock timestamps are metadata, never an invariant. The ledger is keyed by `{loopId, round, nodeIndex, attempt}`; replay rejects duplicate keys, attempts without a matching `node-started`, and settlements without a matching `node-started`. Replay validation otherwise mirrors the goal domain: revision continuity, lifecycle transition legality, and schema conformance, failing loud at the first corrupt record.

The session log appends events one at a time; there are no multi-event transactions. The protocol therefore orders settlement before the verdict-applying `loop/change`: an evaluator settlement whose verdict is not yet applied is a legal intermediate state, and resume applies it exactly once (applying an applied verdict rejects as a duplicate by ledger key and compare-and-set).

A corrupt loop event leaves loop access failed at that record while the session itself and every other projection load normally — loop state is isolated, not session-fatal. A fork folds loop events only from `session.header.seedLength ?? 0` (the [schedule](../../../../packages/schedule/schedule/README.md) precedent), so a fork inherits no run, and the driver additionally drives only the run whose controlling session id equals its own session — two independent fences against two sessions claiming one loop.

Activation is process-local and never persisted: creation and explicit resume arm it; plugin load, session start, flush failure, pause, completion, blocking, and clear disarm it. `./invariant` companions apply the same validation to candidate events before they enter the durable log.

## State machine

`loop/change` phases are `active | awaiting-human | paused | blocked | complete`, plus the clear tombstone. Allowed transitions:

| From | Verb | To |
|---|---|---|
| active | `/loop pause` | paused |
| active | checkpoint ask opens (`checkpoint: node`) | awaiting-human |
| awaiting-human | human answers continue | active |
| awaiting-human | human answers pause, or `/loop pause` | paused |
| awaiting-human | human answers terminate, or `/loop clear` | tombstone |
| active | block (`node-failed`, `round-limit`, evaluator `blocked`, `checkpoint-provider-missing`, `durability-failed`, `report-budget`) | blocked |
| active | evaluator `complete` | complete |
| paused | `/loop resume` | active (armed) |
| blocked | `/loop resume` | active (armed; see below) |
| complete | — | terminal; replacement is a fresh create |
| any | `/loop clear` | tombstone (history retained) |

Budgets split into hard and soft caps. The round budget — `roundsStarted` against `maxRounds` — is a hard cap no verb resets: pause, resume, and re-arm never change it; resume from `round-limit` rejects with a direct error while no capacity remains, and raising the cap is a new run. The node retry budget — `maxNodeRetries` within an epoch — is a soft cap: `/loop resume` on a blocked run re-arms with a fresh epoch, the resume change's revision becoming the new `atRevision` floor, so retry budgets count attempts at or above it and an explicit human resume re-authorizes the failing node's retries while the ledger keeps the full attempt history.

`/loop pause` records the mutation, then cancels the in-flight child through the run's cancellation path (the subagent seam's signal: pre-publication aborts roll back, post-publication cancels remaining turn work). An attempt already settled keeps its settlement; the interrupted attempt records `loop/attempt` with code `paused`, and resume continues with the next attempt.

A durability (`ctx.sessions.flush()`) failure blocks with code `durability-failed` and disarms — it is an error with a durable record, never an active-but-stalled run.

Advancement requires three conditions: the host process lives, the controlling session's root agent is live, and the run is armed. A browser disconnect alone changes nothing (agents live in the host process); disposal of the controlling agent disarms without a phase change — that is the L1→L2 boundary, not an error, and `/loop status` reports the disarmed activation. If the agent is disposed while `awaiting-human`, the ask dies with it, the phase stands, and a later `/loop resume` re-arms and re-issues the ask.

## Chain definition

The chain file is a workspace `loop.yaml` (or `--chain <file>`), parsed and strictly validated at `/loop start`; every failure is a direct command error, and the validated chain is frozen into the first `loop/change` snapshot. Top-level fields: `objective` (required), `exit` (optional free text — the evaluator's exit criterion), `checkpoint` (`none` | `node`, default `none`), `nodes` (non-empty), and `evaluator` (optional `prompt` override). Node fields: `role` (required, unique), `cwd` (optional; defaults to the loop's home workspace), `prompt` (required), `output` (optional JSON Schema), `inputs` (optional list of `{ session: <sessionId> }`), `carryOver` (optional list of role names whose prior-round reports carry into this node).

```yaml
objective: 迭代优化 sim-structural 仿真工具
exit: 标准算例集上 max-error ≤ 0.05 且单算例耗时 ≤ 300 s
checkpoint: none
nodes:
  - role: direct
    cwd: E:\document\project2026-7-9\sim-structural
    inputs:
      - session: 2a5b3a99-114a-4d48-993e-c97b3705077a
    carryOver: [experiment, optimize, configure]
    prompt: |
      读取继承的历史结论与上一轮报告，产出下一轮试验条件与理由。
    output:
      type: object
      properties:
        conditions: { type: object }
        rationale: { type: string }
      required: [conditions, rationale]
  - role: experiment
    cwd: E:\document\project2026-7-9\sim-structural
    prompt: |
      用当前版本工具按给定条件跑试验，产出结构化结果与异常。
    output:
      type: object
      properties:
        results: { type: object }
        anomalies: { type: array, items: { type: string } }
      required: [results, anomalies]
evaluator:
  prompt: |
    对照退出条件裁决：目标是否已达成？给出 decision 与证据。
```

The default handoff schema — applied when a node omits `output` — is `status` (string), `summary` (string), `evidence` (array of string), and `nextSteps` (array of string). An explicit `output` schema replaces it wholesale. When a node declares `inputs`, the driver injects a required `inherited` array property into whatever schema applies, and settlement validates it as non-empty with one entry per declared input session — "what I adopted from each input session" is a settlement requirement, not a suggestion. The injection applies only to nodes that declare `inputs`; a node without them has no requirement, and an empty or absent `inherited` is legal.

The evaluator is auto-appended as the final node of every chain and occupies the last node index: one round's node count is the chain's nodes plus one, the evaluator settles through one `loop/node` event like any node and joins the first-unsettled-node recovery judgment, and `roundsStarted` increments when the verdict-applying `loop/change` lands, not at its settlement. A top-level `evaluator.prompt` overrides its default instruction, and the verdict schema `{ decision: continue | complete | blocked, feedback?, reason? }` is fixed by the driver. Exit criteria come from `exit` when present, otherwise the evaluator judges against the objective. The default chain — no `loop.yaml` and no `--chain` — is one worker node with the default handoff schema plus the default evaluator; there is no chain consisting only of an evaluator.

`maxRounds` defaults to the deployment config `defaultMaxRounds` (default 20, positive safe integer); `--max-rounds` overrides it per run.

## Node execution

The driver mirrors the [goal round driver](../../archived/feature/2026-07-19-same-session-goal-round-driver.md) fences — fiber active, exact live agent, `ctx.sessions.flush()` before every advance, compare-and-set recheck after every await, teardown quiescence — but replaces the same-session round prompt with one fresh child conversation per node through `ctx.subagents.start(provider, { parent: controllingAgent, prompt, outputSchema, cwd, label, signal })` on the [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md), where `cwd` is the node's frozen workspace. A node prompt carries the objective, the round number, the frozen role instruction, the reports its chain entry names — same-round predecessors by default plus `carryOver` prior-round reports — the opening evaluator feedback (forced into the first node; as a carry-over, visible to every node that declares `carryOver`), the declared input session ids, the prior child session ids, and the read-scope statement.

The provider enforces the role's output schema at generation; the driver re-validates the structured result before settlement. A failed or invalid child settles nothing: the driver appends `loop/attempt` with the failure, retries the node with the failure reason injected into the retry prompt, up to `maxNodeRetries` (default 2, deployment config) attempts within the current epoch, then blocks with code `node-failed`. Round exhaustion blocks with code `round-limit`.

The final node of every round is the evaluator: a fresh child receiving the objective, the exit criteria, the round's validated reports and opening feedback, and the child session ids, returning the fixed verdict schema. `continue` makes the feedback a default next-round carry-over — the next round's first node always receives it, and any node declaring `carryOver` receives it alongside the named prior-round reports, so feedback carrying global constraints reaches later nodes too; `complete` completes the run; `blocked` blocks it with the evaluator's reason. `evaluatorModel` may run the judge on a cheaper model than worker nodes.

## Handoff: lean push, lossless pull

The no-redundancy and no-loss requirement is enforced mechanically. Push is lean: a node sees only the validated reports its chain entry names — same-round predecessors by default plus `carryOver` prior-round reports — and the evaluator feedback (forced for the first node, carried for nodes declaring `carryOver`), capped by `maxHandoffChars` (default 16384; characters — UTF-16 code units, surrogate pairs counting as 2 to match `String.length`; chosen so CJK report text is measured predictably; an over-cap report fails validation and takes the retry path), never raw transcripts. Pull is lossless: declared input session ids, prior child session ids, and the loop-scoped query tools recover any detail on demand, and raw material always remains in the session logs. Required information categories are schema fields, so a report cannot omit them and settle; a node with declared `inputs` cannot settle without reporting what it inherited from each input session; an empty `inherited` is legal only for a node that declares none. The aggregate handed to the evaluator — all of the round's reports plus feedback — is capped by `maxEvaluatorInputChars` (default 65536 characters); overflow blocks with code `report-budget` rather than truncating, and the blocked record names the round, node, offending report, and exceeded character count so a human can fix the chain.

## Cross-session reads

`tool-loop-query` registers `loop_session_search` and `loop_session_read` globally on `ctx.tools` and enforces authorization in the executor: the calling session must be the run's controlling session or a descendant child of it, and the target session's normalized cwd must be a member of the run's frozen `readScopes` set or equal the caller's own workspace (exact membership, not subtree containment). Scope comparison uses `realpath`-normalized values — symlinks resolved, separators normalized, case-folded on case-insensitive platforms — which is deliberately different from `tool-session-query`'s conservative exact-string equality; both rules hold in their own domains. The human grants `readScopes` and `writeScopes` at `/loop start`; these grants are the only widening of the existing authorization rules. Registration is static and global, not per-run: mutating the model-visible tool set per run would churn request prefixes and registry disposal; the cost is two schemas on every composed session; callers outside a current run's lineage are refused by the executor — current means not cleared, so paused, blocked, and complete runs are served alike and the tombstone is the refusal boundary — and both tool descriptions state exactly that — usable only inside a current run's lineage, every other call refused — to keep models from attempting them. The concurrent cross-conversation reference proposal (`2026-09-18-cross-conversation-reference-preserve-full-key-inject`) evolves the `@`-mention snapshot path; relay nodes pull through the query tools, and a later revision may route pulls through its reference forms.

## Human checkpoint

`checkpoint: none` (the default) runs without interruption. `checkpoint: node` asks the human after every node settlement through [`ctx.userQuestions`](../../../../packages/interaction/user-questions/README.md) anchored to the exact live controlling root, with continue, pause, and terminate options mapping to the state machine: continue → `active`, pause → `paused`, terminate → the clear tombstone. While the ask is open the run sits in the explicit `awaiting-human` phase, so the render shows why no work advances instead of a stalled `active`. Waiting suspends advancement only: the agent stays idle, commands still dispatch, and the driver holds no exclusive section — an unanswered question blocks nothing but the next node. There is no timeout in this proposal; `/loop pause` and `/loop clear` abort an open ask through its signal, and an evaluator verdict or child failure blocks through the ordinary path. A missing provider blocks the run with code `checkpoint-provider-missing` rather than auto-advancing.

## Recovery

Interruption levels are fixed: **L1** — in-process automatic advancement (supported; the three conditions above); **L2** — cross-process manual recovery (supported: durable state replays, activation is never persisted, `/loop resume` re-arms); **L3** — cross-process automatic resume (unsupported and excluded). L3 is excluded because opening a session reconstructs state, it does not authorize spending resources; automation that must restart work runs outside the host as a daemon invoking the documented resume verb, authorized when that daemon is configured.

`/loop resume` re-arms and continues from the first node without a settlement. `resume`'s optional `--from <node|role>` target is parsed and validated against the frozen chain — an invalid target is a direct error naming the valid targets — but no replay-from-node continuation accepts it yet: a valid target is likewise answered with a direct error naming the current resume behavior. The replay-from-node continuation semantics are deferred to a future proposal whose design sketch is recorded in the [implementation plan](../../../plans/2026-09-24-cross-session-relay-loop.md). In-flight children are recovered from the ledger: the last `loop/node-started` without a settlement or `loop/attempt` names the in-flight child, whose final assistant output is re-extracted from its session log and re-validated; a missing or invalid output re-spawns the node. A child that exists without any ledger entry — a crash between publication and the `node-started` append — is enumerated through the subagent ledger's `listChildren` on the controlling session and treated as a crashed attempt. A settled evaluator whose verdict is not yet applied is a pending transition; resume applies it exactly once. Node execution is at-least-once across crashes; the duplicate window between child completion and settlement is documented, not solved.

## Scope boundary

Nodes execute in per-node workspaces inside `writeScopes`; cross-project participation is both read (`readScopes`) and execute/write (`writeScopes`). This proposal injects no messages into existing sessions: continuing an original conversation's content happens in new child sessions that read it and report what they inherited; returning to the original conversation would require a separate session-recovery or injection seam proposal. L3 automatic resume is excluded (see [Recovery](#recovery)). Parallel loops, DAG node shapes, token and cost budgets, and a model-facing loop-creation tool are absent from this proposal.

## Alternatives considered

- **A fixed chain script on the workflow engine** (generalizing [`tool-ralph`](../../../../packages/workflow/tool-ralph/README.md)) — lost because engine runs are process-local with no durable resume; loop state in workspace files would bypass the session log as durable authority; pause, resume, and node checkpoints would need re-implementation over jobs.
- **Prompt-level chaining over the goal domain** (`LOOP.md` plus model-driven delegation each round) — lost because structure would exist only in prompts and schema omission is not enforcement; same-session context still rots; the lean-lossless handoff requirement is unverifiable without executor-level validation.
- **Keep the 2026-07-16 negative decision unchanged** — that note rejected a speculative universal loop service; this proposal supplies the concrete consumer and narrows the scope, so the negative clause is superseded while the goal and Ralph policies stand.
- **Persist activation and auto-restart work inside the host after process exit (L3)** — rejected because opening a session records status, not fresh authority to spend resources; explicit human resume arms continuation, and a daemon that needs automatic restart invokes the resume verb with authorization given at daemon-configuration time.
- **Time-driven repetition** (a Claude Code `/loop 5m` equivalent) — out of scope by decision; the session-local schedule family owns reminders, and this run's rounds advance on settlement, not wall-clock.
- **Defer per-node cwd to a second consumer** — rejected by requirement: cross-project relay is the consumer, so the seam gains a capability-checked per-start `cwd` rather than waiting.
- **Return to the original conversation (a session-injection or resume seam)** — rejected: injecting into live sessions collides with session ownership and activation; continuity happens in fresh child sessions that read the originals, and a future injection seam is a separate proposal.
- **Per-run dynamic registration of the query tools** — rejected: mutating the model-visible tool set per run churns request prefixes and registry disposal; static global registration with executor enforcement costs two schemas on unrelated sessions.
- **Long-lived continuable children passing durable messages** — one-shot fresh children with structured outputs carry the relay with less standing state; [continuable children](../../archived/feature/2026-07-21-continuable-background-subagents.md) remain available for later node shapes.

## Acceptance criteria

- A Loader-booted composition with the four packages mounted in the shipped base exposes `/loop` through command discovery and starts a run from a validated two-node `loop.yaml` with an evaluator override.
- One round settles one `loop/node` event per node with validated reports, spawns each child through the configured provider with the frozen role prompt, per-node cwd, and named reports, settles the evaluator as the final node index, and ends with an evaluator verdict; `/loop` renders phase, round, node progress, activation, and the newest report digest.
- Replay of the four event types is strict: corrupt records leave loop access failed at the first bad event while the session and other projections load; duplicate ledger keys, attempts, and settlements without a matching `node-started` reject.
- A node whose children keep failing records `loop/attempt` failures, exhausts `maxNodeRetries` with failure feedback in the retry prompts, and blocks `node-failed`; the attempt count and failure reasons survive a simulated restart; round exhaustion blocks `round-limit`; `/loop resume` re-arms a blocked run with a fresh retry epoch while `roundsStarted` — the hard cap — never resets.
- `checkpoint: node` with a stub user-questions provider pauses for a human answer — the run renders `awaiting-human`, commands and the agent stay live, and a continue answer returns it to `active`; without a provider the run blocks `checkpoint-provider-missing`; `/loop pause` and `/loop clear` abort an open ask through its signal.
- After a simulated process restart, the reopened session starts no work by itself; `/loop resume` continues from the first unsettled node, re-extracts a valid in-flight output, applies a pending evaluator verdict exactly once, and enumerates unledgered children through the subagent ledger.
- A chain entry with `cwd` outside `writeScopes` fails at start; a spawn-time re-assert rejects an unauthorized cwd; `loop_session_search` and `loop_session_read` enforce realpath-normalized `readScopes`, refuse out-of-scope targets, and refuse callers outside the run's lineage.
- A node with declared `inputs` receives the input session ids in its prompt and its report's `inherited` field is settlement-validated as non-empty with one entry per declared input session while an `inputs`-free node settles without the requirement; an input session outside `readScopes` fails at start.
- A fork of the controlling session drives no run.
- An aggregate round-report overflow blocks `report-budget` with the round, node, offending report, and exceeded character count; a single over-cap report fails validation into the retry path.
- A keyless snapshot records an assembled transcript of `/loop start`, node relay, handoff, and evaluator completion through a real runnable example.
- The four packages hold per-file coverage, register `./invariant` companions where a plausible owned relationship exists (the two state-owning packages) and carry a gate-recognized documented omission otherwise (the two adapters), prove registry disposal under HMR, and the [harness-level execution note](../../implemented/feature/2026-07-16-harness-level-loop.md) has its stale "no `packages/loop/` family" fact rewritten in the same change.

## Risks

- Node execution is at-least-once across crashes: a duplicate window remains between child completion and settlement, exactly as the schedule family documents its own.
- The evaluator remains a model verdict with cited evidence, not mechanical certification; `complete` means the judge child reported completion.
- Chain authoring is human work: weak role prompts or loose output schemas pass validation while degrading handoff quality, and the `inherited` report discipline depends on the model's honesty.
- One loop is current per controlling session; parallel loops, DAG shapes, and per-node fan-out are absent.
- `readScopes` grants read access and `writeScopes` grants execution and file writes in other projects' workspaces inside the frozen scopes; both grants are human-made and explicit, but `writeScopes` is the broader authority.
- The per-start `cwd` extension touches the subagent seam: in-process providers honor it, while ACP and remote providers need per-provider work and reject requests that set it until then; `realpath` normalization has platform edges (network drives, case-sensitive volumes).
- Static global registration of the query tools costs every composed session two schemas; callers outside a run's lineage are refused but still see them.
- Driving requires the controlling session's live root agent; a loaded-but-not-live session is inert until `/loop resume`.
- Only round, retry, report-size, and evaluator-input caps bound effort; token, cost, and wall-clock budgets are deferred.
