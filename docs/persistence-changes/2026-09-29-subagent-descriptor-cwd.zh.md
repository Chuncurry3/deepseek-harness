---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-subagent-descriptor-cwd

[English](2026-09-29-subagent-descriptor-cwd.md) | 中文

## 概述

为持久化的 subagent descriptor 增加可选的 cwd，记录启动请求授予子 agent 的工作目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

本次变更之前持久化的 descriptor 携带 subagent descriptor 版本 3，而本运行时按版本 4 严格校验 payload：版本 3 的 descriptor 不可归类，其子 agent 会被读作没有 descriptor，而不是部分 descriptor。会话日志仍可解码，不含 cwd 的版本 4 payload 可原样解析——该属性为可选，字段缺失表示子 agent 运行在父会话的工作目录中。仅当启动请求声明 SubagentStartRequest.cwd 时生产方才会写入 cwd；冷恢复仍然从持久化的子会话 header 还原被授予的工作目录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent/tests/child-cwd.spec.ts：5 个测试通过，其中包含可续期 descriptor 记录被授予的 cwd，以及冷恢复的子 agent 还原该工作目录。

<a id="dev-note"></a>
## 开发备注

无。
