---
description: "The loop group map: the durable cross-session relay run domain recorded by one controlling session, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/loop

English | [中文](README.zh.md)

## Summary

The loop group records one cross-session relay run per controlling session. A frozen chain of role nodes relays a single objective across rounds: each node works in its own workspace, reads the sessions the chain declares, and hands a validated report to the next node. The durable domain stores the run, its rounds, and its node ledger as session events; spawning child sessions, assembling prompts, and scheduling rounds stay with consumer packages. One session owns at most one current loop, and the authority to advance a round never persists across a process boundary.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`loop`](loop/README.md) | One durable relay loop per controlling session: versioned events, strict replay fold, lifecycle mutations, node ledger | `ctx.loops` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Loop subsystem](../../docs/subsystems/loop.md) — loop types, durable `loop/*` events, and the generated service API.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-loop) — every accepted config field of the loop service.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
