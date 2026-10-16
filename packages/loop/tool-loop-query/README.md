---
description: "Lineage- and scope-authorized model-facing session query tools for agent developers and maintainers running one cross-session relay loop."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-loop-query

English | [中文](README.zh.md)

## Summary

`dsh-tool-loop-query` gives the model two read-only tools that work only inside a relay run's lineage. `loop_session_search` finds literal text across the sessions that run may read; `loop_session_read` returns that session's current model surface, or one event with neighbors. Authority comes from the caller: the run is the current loop projected on the calling session or an ancestor, membership is proven through that ancestor's subagent catalog, and the readable set is the run's frozen `readScopes` plus the caller's own workspace, compared by realpath. Callers outside a run and targets outside those scopes are refused with a stable code naming the reason.

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

Mount this package when a relay run's worker must read the sessions the run is authorized to read. The common path is explicit: the controlling session starts a loop with `readScopes` through `@deepseek-ai/dsh-loop`, a continuation driver hands the run to worker sessions, and those workers call the two tools.

### When to choose it

Choose it when a relay run needs model-driven reads of its own inputs — a worker reading the previous node's session before writing its report. Avoid it when a deployment never runs a loop: the two tools can only refuse, while their schemas stay on every request. Programmatic callers do not need it either; `ctx.sessionQuery` serves code directly.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxSearchResults` | `100` | Maximum matching events returned by one search call |
| `searchTimeoutMs` | `30000` | Cooperative deadline attached to the search tool |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-loop-query) is the exhaustive source for every accepted field and its JSDoc.

### Compose it

The tools inject the tool registry, the session query engine, and the subagent runtime; a custom app mounts their owners plus this plugin:

```yaml
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: session-query
  name: '@deepseek-ai/dsh-session-query'
- id: subagents
  name: '@deepseek-ai/dsh-subagent'
- id: loop
  name: '@deepseek-ai/dsh-loop'
- id: tool-loop-query
  name: '@deepseek-ai/dsh-tool-loop-query'
```

The loop domain owns the run and its scope grants; the subagent runtime owns the catalog that proves lineage; this package only reads both.

### What the model can do

| Tool | What the model gets |
|---|---|
| `loop_session_search` | Matching events from every readable session, grouped by session with sequence number, type, surface, time, and a one-line excerpt; an optional name list narrows the scan |
| `loop_session_read` | One readable session's current model surface, or one exact event as JSON with optional neighboring event summaries |

### Authorization

Authority comes from the calling agent, never from the arguments. The run is found by walking the caller's parent chain for a current `loop` projection; a cleared loop leaves a tombstone and stops the walk, so a caller whose run ended is refused rather than served. The controlling session's own agent is inside its run by identity; every other caller must appear in that session's subagent catalog, so a session that only claims the parent in its own header is refused.

A target session is readable when it is the caller's own session, or when its workspace is in the run's frozen `readScopes` or equals the caller's own workspace. Paths are realpath-normalized on both sides, so a symlink-equivalent target inside a granted scope is served. A named target outside that set refuses the whole call, and the message for an unknown id is identical to the message for an unreadable one, so a caller cannot probe which sessions exist. A workspace that no longer resolves grants nothing.

### Failures and recovery

Local argument and authorization errors keep their precise tool-owned messages and codes: `LOOP_QUERY_AGENT_REQUIRED` for a call without an agent binding, `LOOP_QUERY_LINEAGE_REFUSED` for a caller outside a run's lineage, `LOOP_QUERY_SCOPE_REFUSED` for an unknown or unreadable target, and `LOOP_QUERY_INVALID_QUERY` or `LOOP_QUERY_INVALID_ARGS` for rejected input. Cancellation is forwarded to every engine and catalog read. The package performs no truncation beyond the fixed excerpt width and does not import a spill backend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the two tools and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

- **One authorization derivation, two lanes.** Both executors resolve the run and the readable set before touching data, so a search and a read cannot disagree about what the caller may see.
- **Lineage is durable data, not a claim.** The run comes from the `loop` session projection and membership from the `subagent/catalog` events the controlling session owns; the caller's own header is only a starting point for the walk.
- **Reads use the provider-independent lanes.** The search lane lists the corpus with empty filters, compares normalized workspaces locally, and scans each readable session's events for the literal text. Full-text search would compare raw workspace strings and rank by provider score, which would break both the realpath rule and the deterministic grouping.
- **Refusals are deterministic.** Each refusal names its reason and its code, and the unreadable-target message deliberately does not distinguish an unknown id from a forbidden one.


### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, lineage and scope authorization, both operation lanes, rendering |
| — | No runtime invariant companion is published; this model adapter owns no event stream or state projection; the lineage and scope relationships it enforces are reads of projections and catalogs owned by the loop domain, the subagent runtime, and the session query engine, and package tests cover both lanes, the refusals, and registration disposal. |

### Operation flow

Each executor reads the calling session from `ToolExecution.exec.agent`, resolves the run and readable set, and then validates input. Search lists readable sessions, optionally restricted to the ids the model named, scans each one's events through the history filters, and stops at `maxSearchResults` with a notice; read observes its target and re-checks the observed header before rendering. Both render plain text from durable session data only: nothing reaches a model request that the session log cannot reconstruct.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tool surface to the domain that owns the run and the services the tools read.

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-loop-query) — both tool schemas as the model sees them.
- [Loop service](../loop/README.md) — the run, its rounds, and its frozen scope grants.
- [Loop chain driver](../loop-chain-driver/README.md) — the continuation plugin that hands a run to worker sessions.
- [dsh-session-query](../../session-query/session-query/README.md) — the read engine behind both lanes.
- [dsh-subagent](../../subagent/subagent/README.md) — the catalog that proves a caller is inside the run.
- [Loop subsystem](../../../docs/subsystems/loop.md) — loop types, durable `loop/*` events, and the generated service API.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`loop_session_search` and `loop_session_read` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-loop-query). Each description opens by stating that the tool is usable only inside an active run's lineage and that every other call is refused; the rest of each description names what the tool returns and which schema fields are deliberately absent (no cursor, no page size, no model-controlled limit, and no workspace path).

#### Token effect

Two fixed read-only schemas are sent on each request while the plugin is mounted, whether or not a run is active. The package registers no system prompt section: the refusal sentence in each description carries the contract, and a section would add tokens to every session in the process.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged. Because registration is static and global, a run starting or ending does not change the request prefix.

### Tool results

#### What the model sees

Each successful call emits one plain-text block. Search groups hits by session and caps each excerpt at 200 characters with a trailing ellipsis; a capped result ends with a notice to narrow the query or name fewer sessions. Read returns the surface as numbered event lines, or the exact event as JSON with neighboring event summaries.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; `maxSearchResults` bounds search-hit count and the excerpt width bounds each hit.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Global registration cost** — the tools are registered statically, so a composed session that never starts a run still carries both schemas.
- **Literal scans, not full-text ranking** — search matches literal event text in readable sessions and returns them in session order, so a large readable corpus costs a full scan and the hits carry no relevance score.
- **Search caps without continuation** — search returns at most the deployment cap and asks the model to narrow its query when more matches exist; there is no continuation token.
- **Exact-path scope membership** — a target nested inside a granted scope directory is not granted; only the granted path itself and the caller's own workspace are readable.
- **No write or lifecycle access** — the tools read only; nothing here starts, advances, or clears a run.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: relevance and scope semantics

Whether search should rank hits by match quality rather than session order, and whether a run's read authority should follow the write scopes its nodes may modify, are both undecided.

</details>
