# Agent Note: Per-start child workspace for subagent starts

Status: implemented

English | [中文](2026-09-29-subagent-per-start-cwd.zh.md)

## Problem

A subagent child derives its workspace from the delegating parent session: `childSessionMeta()` copies the parent session's header cwd onto the child's session header, so every child runs in the project that spawned its parent. A delegation that must act in another project's workspace cannot be expressed — the parent session's workspace is fixed long before any delegation happens, and no start request field names a different one.

The consumer that motivates the field is the [cross-session relay loop plan](../../../plans/2026-09-24-cross-session-relay-loop.md): its chain nodes execute in granted per-node workspaces, so every node start must name the workspace the run granted that node rather than inherit the controlling session's.

Provider honesty is part of the problem. The in-process providers compose the child session themselves and can honor a requested workspace directly; the out-of-process backends resolve the child working directory through their own helpers (configured override, else the parent session cwd), so honoring a per-start cwd there is per-backend work rather than a seam-wide fact. A field that out-of-process providers silently ignore would misstate the contract.

## Decision

`SubagentStartRequest` carries an optional `cwd` — an absolute path naming the child's workspace — and `SubagentCapabilities` carries the matching `cwdOverride` flag, following the existing flag-per-option pattern (`depthLimit` to `maxDepth`, `toolFilter`, `persona` — see [the composition-controls note](2026-07-12-subagent-persona-tool-filter-and-depth.md)).

### The capability contract

The one-shot service checks the flag before any provider work: a `cwd`-carrying `start()` on a provider whose capabilities lack `cwdOverride` rejects with `UNSUPPORTED_CAPABILITY`, before descriptor resolution and before the provider is called, so a request never degrades silently to the parent workspace. `spawn-in-process` and `fork-in-process` advertise `true` because they control the child's creation window; the out-of-process backends — ACP, Codex, Claude Code, and the SDK backend — advertise `cwdOverride: false` (the latter three through `NO_START_CAPABILITIES`) and reject a `cwd`-carrying start until they implement per-start working-directory resolution. `startContinuable()` validates the same field the same way; the continuation manager composes continuable children itself, and only the in-process providers implement `prepareContinuable`, so no provider flag gates that path.

### The validation discipline

Both start paths validate a present `cwd` through the shared `assertUsableCwd` helper: absolute (a relative path would be re-anchored to the harness launch directory), an existing directory, and enterable — `X_OK`, because the value doubles as a subprocess cwd on out-of-process paths and as the child's workspace identity. The one-shot path validates after the capability check and before the provider is called; `startContinuable()` validates before reserving the child identity, so a rejected start leaves no durable trace and no agent behind.

### The child session carries the grant

`childSessionMeta()` resolves the child session's header cwd as request `cwd` → parent session cwd → absent, so the child runs, persists, and cold-resumes in the granted workspace. Restoration flows from the persisted child session header through `agents.resume()`: a resumed child keeps its granted workspace even when the resuming parent runs elsewhere — no descriptor reader participates in restore.

The continuable descriptor records the granted `cwd` beside `persona` and `toolFilter`. It is an explicit field, so adding it is a deliberate `SUBAGENT_DESCRIPTOR_VERSION` change (the current version is 4) rather than an implicit extra field. The record names the grant durably for enumeration and audit; the session header, not the descriptor, is the restore path.

## Alternatives considered

**Silently ignore `cwd` on providers without the capability.** Rejected: an accepted-then-ignored start would report success while the child runs in the parent's workspace, and a consumer that re-asserts workspace scopes at spawn — as the planned relay does — would misjudge exactly where the child acted. The seam's established pattern is loud rejection before child creation, and `cwd` follows it.

**Derive the child workspace from the parent session only.** Rejected: parent derivation remains the fallback when the request omits `cwd`, but as the only rule it cannot express cross-project execution — the parent session's workspace is fixed at creation, while a relay node's granted workspace is chosen per node from the run's scope grants.

**Wait for a second consumer before adding the capability.** Rejected: the relay family is a concrete consumer with a fixed landing order (per the plan, Phase B's loop packages import `SubagentStartRequest.cwd` and cannot build without it), and the capability flag keeps the cost of shipping the seam first at zero for providers that advertise `false` — they reject rather than implement.

## Testing

`packages/subagent/subagent/tests/start-cwd.spec.ts` covers the service-level contract: a `cwd`-carrying start on a provider without `cwdOverride` rejects before provider dispatch (the stub's `startCount` stays zero); a relative path rejects with `must be an absolute path` and a nonexistent path with `not an accessible directory`; an absolute enterable cwd resolves the run and reaches the provider verbatim.

`packages/subagent/subagent/tests/child-cwd.spec.ts` covers the real in-process path: the request cwd wins over the parent session's workspace, the parent cwd applies when the request omits it, `startContinuable` rejects relative and nonexistent cwds before any child agent exists, the continuable descriptor and the child session header both record the granted workspace, and a cold resume in a fresh context restores the granted workspace while the resuming parent runs elsewhere.

## Consequences

A delegation can direct one child into another granted workspace without a new provider: the field, the flag, the validation, and the durable record are all part of the seam, and the planned loop family builds on them directly.

The cost is provider truthfulness and one format bump. Provider authors must advertise `cwdOverride` accurately; the out-of-process backends reject `cwd`-carrying starts until they implement per-start resolution. Descriptor payloads are validated strictly against the current version, and a payload at any other version is unclassifiable by this runtime — the pre-release stance — so such a child reads as having no descriptor rather than a partial one.
