---
description: "The relay chain document parser for users and maintainers authoring, validating, or debugging cross-session relay loop chains."
kind: "package-reference"
---

# @deepseek-ai/dsh-loop-chain-driver

English | [中文](README.zh.md)

## Summary

`dsh-loop-chain-driver` parses the human-authored relay chain document — the YAML file that names each node's workspace, prompt, inputs, carryOver, and output schema — into the frozen `LoopChainDef` that `@deepseek-ai/dsh-loop` persists; validation is strict and loud, one aggregate error naming every offending path, and `defaultChain` supplies the one-worker fallback. The package also owns the node handoff: `assembleNodePrompt` renders the lean-push carry of named reports, opening feedback, and pull surfaces into each node child's prompt, `validateReport` checks settled reports against the schema and the `maxHandoffChars` budget, and `evaluatorInputBudget` measures the evaluator's aggregate.

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

Import the parsing functions directly; this package registers no service:

```ts
import { parseChainDocument, defaultChain } from '@deepseek-ai/dsh-loop-chain-driver/chain'

const chain = parseChainDocument(documentText)   // one aggregate Error on any invalid document
const fallback = defaultChain('Ship the migration')
```

### When to use it

The consumer that starts a relay loop parses the workspace chain document — `loop.yaml` by convention, or a `--chain <file>` choice — at start; a missing file falls back to `defaultChain(objective)`, and the validated chain freezes into the first `loop/change` snapshot. Every other consumer reads the frozen chain from the loop snapshot instead of re-parsing. The handoff engine serves every node spawn: it takes the folded loop view, the round being driven, and the resolved budget caps as plain parameters.

### The chain document

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

The handoff functions live in `src/handoff.ts`; the driver plugin and the package tests are the callers. `assembleNodePrompt(view, round, nodeIndex)` returns the prompt string for one node — the objective, the round number, the frozen role instruction, the reports the chain's visibility rule names, the opening evaluator feedback, the declared input session ids, the prior child session ids, and the read-scope statement. Raw transcripts never enter the prompt: the receiving node pulls detail on demand from the named sessions through `loop_session_search` / `loop_session_read`.

Visibility rule: a node sees the same-round predecessor reports by default, plus the prior-round reports of the roles its `carryOver` names; the prior round's `continue`-verdict feedback is forced into the first node and carried into every `carryOver`-declaring node. The final node index is the evaluator, which sees every round report, the opening feedback, and the exit criteria.

A node that declares `inputs` settles against its schema plus a driver-injected required `inherited` array — one string entry per declared input session; the injection replaces any author-declared `inherited` property. `validateReport(node, report, maxHandoffChars)` returns the violations, empty when the report may settle: schema conformance through the same object-rooted JSON Schema subset the durable fold enforces, the exact `inherited` entry count, and the serialized report's UTF-16 code-unit size against the budget. `evaluatorInputBudget(view, round, maxEvaluatorInputChars)` sums the round's serialized reports plus the opening feedback; an over-cap aggregate returns the `report-budget` block ingredients naming the round, the offending report, and the exceeded character count. Both budgets are plain parameters — the module has no Config dependency.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how parsing realizes the behavior above; the accepted fields are covered in [Use this package](#use-this-package).

### Design

- **A subset of the durable language.** Every rule mirrors the strict decoders that `@deepseek-ai/dsh-loop` applies when it replays `loop/change` events: the normalized objective, non-empty prompt/cwd/session strings, unique roles, exactly-`{ session }` input entries, carryOver names within the chain's roles, and output overrides through `assertObjectJsonSchema`. A parsed chain therefore always survives durable replay validation.
- **Strict objects everywhere.** `z.strictObject` rejects unrecognized keys at the document, node, input-entry, and evaluator levels; `checkpoint` defaults to `none` and a document `evaluator.prompt` maps to the flat `evaluatorPrompt` field during parsing.
- **One loud aggregate error.** `safeParse` collects every issue, and the failure message renders them as path-prefixed lines instead of stopping at the first.
- **Branding at parse.** Each `inputs[].session` string becomes a `SessionId` during parsing, so the frozen definition carries branded ids end to end.
- **The default chain.** `defaultChain(objective)` returns one `iterate` node with the default handoff expectations and no output override; it carries no `evaluatorPrompt` because the default evaluator instruction belongs to the continuation driver that runs the chain, and the objective is held to the same normalized-string rule as a parsed document's objective.
- **Lean push, lossless pull.** `assembleNodeCarry` builds the typed carry the prompt renders and checks it through a zod strict mirror, so a ledger settlement whose report is not a lossless JSON value fails loud before any prompt renders. The prompt carries only the named reports and names the pull surface: the declared input sessions, the prior child sessions, and the read scopes the loop session query tools serve.

### Source map

| File | Role |
|---|---|
| [`src/chain.ts`](src/chain.ts) | Chain-document parsing, validation, and the default chain |
| [`src/handoff.ts`](src/handoff.ts) | Node handoff assembly, report validation, and the evaluator input budget |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API yet |
| — | No runtime invariant companion is published; the package validates chain documents at parse and settles reports through pure functions, keeping no mutable runtime relation to re-check |
| [`tests/chain.spec.ts`](tests/chain.spec.ts) | Parsing, rejection, and default-chain behavior |
| [`tests/handoff.spec.ts`](tests/handoff.spec.ts) | Visibility-rule, budget, and validation behavior |

### Invariant ownership

No invariant companion is published because the package owns pure functions over folded loop state: its untrusted input is validated at the owning parse operation (`parseChainDocument`) and again at settlement validation (`validateReport`), and the package keeps no mutable runtime relationship of its own to re-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The accepted fields above are enough for most chain authors; read these when you need the surrounding domain.

- [Loop group map](../README.md) — the loop packages and how they compose.
- [`@deepseek-ai/dsh-loop`](../loop/README.md) — the durable loop service that persists parsed chains.
- [Loop subsystem](../../../docs/subsystems/loop.md) — the loop types, durable event payloads, and generated service API.
- [`@deepseek-ai/dsh-tools`](../../core/tools/README.md) — the object-rooted JSON Schema subset that output overrides must use.

-----

<a id="model-experience"></a>
## Model Experience

### Chain documents

#### What the model sees

This package registers no tool, command, or prompt contribution; parsing happens before any model turn. The text a chain document carries — each node's `prompt`, the optional `evaluator.prompt`, and any `output` schema — is what the continuation driver later shows the fresh child sessions it spawns.

#### Token effect

None from this package: parsing a chain document issues no model request. The parsed node prompts and evaluator override bound the tokens that the driver's assembled node instructions will consume, and a tighter `output` schema can shorten the report a child must produce.

#### KV Cache effect

There is no KV-cache effect until the continuation driver places parsed chain text into model-visible input.

### Node prompts

#### What the model sees

`assembleNodePrompt` produces the whole first-turn instruction of every node child: the relay round and node position, the objective, the frozen role instruction (the chain's `evaluator.prompt` override or the default evaluator instruction at the final node index), the carried reports as one-line JSON with their rounds, roles, and child session ids, the opening evaluator feedback, the declared input session ids, the prior child session ids, and the read-scope statement naming `loop_session_search` / `loop_session_read`. Raw transcripts are never pushed; the prompt directs the node to pull detail from the named sessions on demand.

#### Token effect

Each carried report is bounded by the resolved `maxHandoffChars` — its serialized UTF-16 size was validated at settlement — and the evaluator's aggregate is bounded by `maxEvaluatorInputChars`, which blocks with `report-budget` instead of truncating. A prompt's length scales with the number of carried reports, never with the sessions' transcript sizes.

#### KV Cache effect

Node prompts go to fresh child sessions, so there is no KV-cache reuse within or across rounds; the deterministic section order and report serialization keep a re-driven round's prompts stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is the wrong place to look. They are current package constraints, not a task backlog.

- **No driver plugin yet** — the continuation driver plugin (node advancement, fresh-child spawning, evaluator runs) and the `/loop` command surface ship later in this phase; today the package exposes chain-document parsing, the default chain, and the pure handoff functions.
- **The document language is a subset** — the parser accepts exactly what the durable fold in `@deepseek-ai/dsh-loop` replays; a chain-language extension must land in the loop service first, or parsed chains would fail replay validation.
- **No workspace existence check** — `cwd` values are validated as non-empty strings only; whether the directory exists is resolved by the driver at spawn time.
- **Session ids are branded, not resolved** — `inputs[].session` values become `SessionId` brands without a lookup; whether the session exists is scoped at loop start, not at parse.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. `src/chain.ts` validates with zod strict-object schemas against the same field rules the hand-rolled decoders in `@deepseek-ai/dsh-loop` apply on replay; the fold owns the authoritative rules, so a durable-language change must update both sides together. The duplicate-role check hangs on the nodes array and the carryOver reference check on the whole document, so a base-parse failure still reports every issue it can. `yaml` is the same library the settings file provider parses user documents with. `src/handoff.ts` reads the folded ledger directly: the latest settlement per node index, prior-round verdicts only for `continue` decisions with visible feedback, and the largest contributor as the budget overflow's offending report. The carry's zod mirror is stricter than the fold — reports must be lossless JSON — because the prompt renders them through `JSON.stringify`.

</details>
