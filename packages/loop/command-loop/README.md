---
description: "The human-facing /loop slash command for users and maintainers starting, steering, or inspecting one cross-session relay loop from a UI command plane."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-loop

English | [中文](README.zh.md)

## Summary

`dsh-command-loop` gives users the `/loop` command to start, steer, and inspect one cross-session relay loop directly in an interactive UI. A start resolves its frozen chain and scope grants through the loop domain and normalizes every granted path; the lifecycle verbs pause, resume, and clear one durable run; a bare `/loop` renders the current status, ledger progress, and valid next commands. Commands and their direct output stay in the UI and do not enter model requests. Use this package in interactive deployments with a command adapter; headless and automation apps without one do not need it.

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

Use `dsh-command-loop` in interactive deployments that mount a command adapter — the shipped Web client is the reference. It gives users direct control over the relay lifecycle without a model turn: commands execute in the UI command plane and the adapter renders their results directly.

### Command reference

Every sub-command runs against the current loop of the invoking agent; a bare `/loop` shows the usage when no loop exists.

| Input | Result |
|---|---|
| `/loop` | Shows the objective, durable phase, round count and cap, settled node progress, process-local activation, the newest settled report digest (JSON text capped at 120 characters with a trailing ellipsis), and valid next commands; a blocked loop also shows its policy code and explanation |
| `/loop status` | Shows the current status exactly like a bare `/loop`; recognized only as the complete input |
| `/loop [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node]` | Starts and arms a loop, or replaces a completed loop with a fresh identity; the `start` verb is optional |
| `/loop pause` | Pauses the current loop and disarms continuation |
| `/loop resume [--from <node|role>]` | Resumes a stopped loop subject to its remaining round cap; `--from` parses and validates only, the replay continuation is not implemented |
| `/loop clear` | Clears the current loop while retaining its durable history |

### Input grammar

The verbs `pause`, `resume`, and `clear` are recognized only when they fit the whole input; `status` fits the same rule and shows the status. The optional `start` verb prefixes the objective — a bare `/loop start` is a direct error, and `/loop start iterate` and `/loop iterate` start the same run. Any other non-empty input is a start objective, so `/loop pause now` starts that literal objective; the objective is required and may not be empty or blank. Values may be double-quoted to carry spaces, semicolons, or a leading `--`; a quote opens a quoted run only at a token start, and quoting strips the quotes and keeps the content verbatim, with no escape sequences. `--read` and `--write` are repeatable and each grants one path; `--chain`, `--max-rounds`, and `--checkpoint` may appear once; a flag without a value, an unknown flag, or input after the flags fails loud as a direct command error.

### Scopes and the chain

A start resolves its chain from a `--chain` document (relative paths resolve against the controlling session's workspace), then from a `loop.yaml` in that workspace, and otherwise from the default single-worker chain. Relative `--read`/`--write` grants and declared chain node workspaces resolve against the same controlling workspace: every path-typed input shares one base, and nothing resolves against the process's own working directory. Absolute paths stay untouched. Every granted and declared path must exist and is realpath-normalized at start; a granted scope must name a directory, so granting a file fails loud with a direct error. `writeScopes` is the controlling workspace plus the `--write` grants, `readScopes` adds every declared chain node workspace and the `--read` grants, and membership is exact-path — nesting inside a granted directory grants nothing. A chain node whose workspace falls outside the write scopes is refused at start with a direct error.

### Compose it

The command injects the commands registry, the loop service, and the session projection registry; a custom app mounts their owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: loops
  name: '@deepseek-ai/dsh-loop'
- id: projections
  name: '@deepseek-ai/dsh-session-projection'
- id: command-loop
  name: '@deepseek-ai/dsh-command-loop'
```

The command reads the current loop through the `loop` session projection — the same read path the continuation driver uses — and mutates through `ctx.loops`. Mounting the driver plugin itself is a separate composition choice.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command parses input and renders output; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **Grammar, not free text.** A whitespace tokenizer with double-quoted runs feeds a closed command union: show, start, pause, resume with an optional `--from` target, clear, and the bare `start` rejection. Verb tokens are matched case-insensitively and only when the remaining input fits the verb, mirroring the `/goal` control words.
- **Start resolution is loud.** The chain document, every granted scope, and every declared node workspace are read and realpath-normalized before the domain start; a missing file, an invalid document, a nonexistent path, or a grant that is not a directory becomes a direct command error without a domain mutation.
- **Domain rejections become stable errors.** `LoopError` outcomes convert into direct command errors — scope violations keep the domain's explanatory message, every other outcome uses one fixed message. Unexpected failures rethrow so adapters report a command failure rather than a domain result. Rendered output exposes no branded ids or revisions.
- **Status is reconstructable from the log.** The render reads only the durable loop snapshot, the folded ledger, and the process-local activation; the settled-node count and newest report digest derive from the ledger the session log already holds.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command grammar, scope and chain resolution, status rendering, dispatch |
| — | No runtime invariant companion is published; this command adapter owns no event stream or state projection; accepted mutations are checked by the loop domain and command dispatch behavior is covered by package tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The command is a thin adapter over the loop domain; read these pages for the state it mutates and the registry it plugs into.

- [Loop service](../loop/README.md) — the durable state and lifecycle the command mutates.
- [Loop chain driver](../loop-chain-driver/README.md) — the continuation plugin that executes a started run.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/loop` control

#### What the model sees

The slash input, mutation, and direct status or error output are absent from model requests. The loop domain records the mutation as `loop/change`; a mounted continuation driver reads the resulting state when it schedules rounds. Presentation text is never logged.

#### Token effect

Reading status, mutating a loop, or receiving a direct command error adds no model tokens. A mounted driver's later continuation prompts account for their own cost.

#### KV Cache effect

Command discovery, mutations, and direct output do not affect the cache. Continuation prompts follow the driver's ordinary request history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the command is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **No attachments** — the loop grammar has no attachment slot; relay inputs come from the chain's declared sessions, not from composer cards.
- **Activation is process-local** — the status line's armed or disarmed value reflects this process only; a restarted process renders the activation as disarmed until `/loop resume` re-arms it.
- **Plain-text interaction only** — the generic command registry has no modal edit form; the start grammar and explicit clear keep destructive intent deterministic across adapters.
- **`resume --from` parses without a continuation lane** — the parser validates the target against the frozen chain's roles, indexes, and evaluator, and a valid target settles as a direct error naming the current resume behavior.
- **Web command adapter only in the shipped apps** — headless, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided: whether a replay-from-node continuation lands behind `resume --from` and which report digest fields deserve richer rendering.

</details>
