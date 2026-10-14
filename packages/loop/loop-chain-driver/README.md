---
description: "The relay chain document parser for users and maintainers authoring, validating, or debugging cross-session relay loop chains."
kind: "package-reference"
---

# @deepseek-ai/dsh-loop-chain-driver

English | [中文](README.zh.md)

## Summary

`dsh-loop-chain-driver` parses the human-authored relay chain document — the YAML file that names each role node's workspace, prompt, declared input sessions, carryOver references, and output schema — into the frozen `LoopChainDef` that `@deepseek-ai/dsh-loop` persists. Validation is strict and loud: unknown keys, duplicate roles, unknown carryOver references, blank strings, and out-of-subset output overrides fail together in one aggregate error that names every offending path. `defaultChain` supplies the one-worker chain for a start that names no document.

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

The consumer that starts a relay loop parses the workspace chain document — `loop.yaml` by convention, or a `--chain <file>` choice — at start; a missing file falls back to `defaultChain(objective)`, and the validated chain freezes into the first `loop/change` snapshot. Every other consumer reads the frozen chain from the loop snapshot instead of re-parsing.

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

### Source map

| File | Role |
|---|---|
| [`src/chain.ts`](src/chain.ts) | Chain-document parsing, validation, and the default chain |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API yet |
| — | No runtime invariant companion is published; the package parses and validates chain documents at its own input operation and keeps no mutable runtime relation to re-check |
| [`tests/chain.spec.ts`](tests/chain.spec.ts) | Parsing, rejection, and default-chain behavior |

### Invariant ownership

No invariant companion is published because the package is a chain-document parser: its untrusted input is validated at the owning parse operation (`parseChainDocument`), and the package keeps no mutable runtime relationship of its own to re-check.

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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is the wrong place to look. They are current package constraints, not a task backlog.

- **Parsing only, for now** — the continuation driver plugin (node advancement, fresh-child spawning, report validation, evaluator runs) and the `/loop` command surface ship later in this phase; today the package exposes chain-document parsing and the default chain.
- **The document language is a subset** — the parser accepts exactly what the durable fold in `@deepseek-ai/dsh-loop` replays; a chain-language extension must land in the loop service first, or parsed chains would fail replay validation.
- **No workspace existence check** — `cwd` values are validated as non-empty strings only; whether the directory exists is resolved by the driver at spawn time.
- **Session ids are branded, not resolved** — `inputs[].session` values become `SessionId` brands without a lookup; whether the session exists is scoped at loop start, not at parse.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. `src/chain.ts` validates with zod strict-object schemas against the same field rules the hand-rolled decoders in `@deepseek-ai/dsh-loop` apply on replay; the fold owns the authoritative rules, so a durable-language change must update both sides together. The duplicate-role check hangs on the nodes array and the carryOver reference check on the whole document, so a base-parse failure still reports every issue it can. `yaml` is the same library the settings file provider parses user documents with.

</details>
