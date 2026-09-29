---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-subagent-descriptor-cwd

English | [中文](2026-09-29-subagent-descriptor-cwd.zh.md)

## Summary

Adds an optional cwd to the persisted subagent descriptor, recording the child workspace a start request granted.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-subagent-descriptor-cwd
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "0c4deece1129b64bdcd900db10459207942262af4d2f38489dc76de148a9ad72"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Descriptors persisted before this change carry subagent descriptor version 3, and this runtime classifies a payload strictly against version 4: a version-3 descriptor is unclassifiable, so its child reads as having no descriptor rather than a partial one. The Session log still decodes, and a version-4 payload without cwd parses unchanged — the property is optional, and its absence means the child ran in the parent session's workspace. Producers write cwd only when a start declares SubagentStartRequest.cwd, and cold resume keeps restoring the granted workspace from the persisted child session header.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent/tests/child-cwd.spec.ts: 5 tests passed, including the continuable descriptor carrying the granted cwd and the cold-resumed child restoring that workspace.

<a id="dev-note"></a>
## Dev Note

None.
