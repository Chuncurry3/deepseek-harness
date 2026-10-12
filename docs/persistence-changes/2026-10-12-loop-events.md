---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-12-loop-events

English | [中文](2026-10-12-loop-events.zh.md)

## Summary

Adds the four durable loop events — `loop/change`, `loop/node-started`, `loop/attempt`, and `loop/node` — that store one relay loop's snapshot mutations and append-only node ledger.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-12-loop-events
baseline: false
changes:
  - root: "event:loop/change"
    previous: null
    after: "54efc414d58e7d53681fc43a7a40b7b253701f1f02b8bb06d730da0b23facf26"
    decision: same-version
  - root: "event:loop/node-started"
    previous: null
    after: "36e6ba24f5674c210e7a513ae39849889e977d2d626b7b474c3ddd06b827842c"
    decision: same-version
  - root: "event:loop/attempt"
    previous: null
    after: "6671e24b5694b8f2684b8df740584ade4ce8d01b4a3df63ca75063091374027a"
    decision: same-version
  - root: "event:loop/node"
    previous: null
    after: "6a2990f833cdeb559346de4f71627f6aec9a096b0b4ef9f4d89f7eda41585047"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New roots in the same Session format version. Existing logs contain no such events and stay valid; readers that predate them refuse a log carrying one, as every required-on-read event does by default. Each payload carries `version: 1`, so a later structural change bumps the payload version inside these roots.

<a id="verification"></a>
## Verification

pnpm vitest run packages/loop/loop: 96 tests passed. The strict fold, projection, and invariant companions replay the new events from the session log; gen-persistence-catalog regenerated the schema, known-event-types, and persistence catalog with the four roots acknowledged here.

<a id="dev-note"></a>
## Dev Note

None.
