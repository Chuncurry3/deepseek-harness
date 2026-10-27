---
description: "记录一次持久化类型迁移及其兼容性确认。"
kind: persistence-change
---

# 2026-10-12-loop-events

[English](2026-10-12-loop-events.md) | 中文

## 概述

新增四个持久 loop 事件——loop/change、loop/node-started、loop/attempt 与 loop/node——保存单个中继 loop 的快照变更与只增节点台账，结算报告约束为无损 JSON 值。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-12-loop-events
baseline: false
changes:
  - root: "event:loop/attempt"
    previous: null
    after: "a1e630029ff4ee18a6ce394c6b2f5ea8e6b8f2c888cad523ccf46e35d430dcec"
    decision: same-version
  - root: "event:loop/change"
    previous: null
    after: "54efc414d58e7d53681fc43a7a40b7b253701f1f02b8bb06d730da0b23facf26"
    decision: same-version
  - root: "event:loop/node"
    previous: null
    after: "983b6ca452ef9a45444ca7f34a5143636906feb053bcaf02219a315cc53882b8"
    decision: same-version
  - root: "event:loop/node-started"
    previous: null
    after: "36e6ba24f5674c210e7a513ae39849889e977d2d626b7b474c3ddd06b827842c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同一 Session 格式版本内的新根。既有日志不含这些事件，仍然有效；早于它们的读取方拒绝携带此类事件的日志，这是每个 required-on-read 事件的默认行为。每个载荷携带 version: 1，后续结构性变更在这些根内递增载荷版本。结算报告为无损 JSON 值；持久解码拒绝任何非无损 JSON 的报告。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/loop：261 个测试通过。严格折叠、投影与不变量伴生从会话日志回放新事件；loop/attempt 记录携带失败尝试的 childSessionId，折叠在持久解码处将结算报告钉为无损 JSON 值。gen-persistence-catalog 以此处确认的四个根再生成 schema、known-event-types 与持久化目录。

<a id="dev-note"></a>
## 开发备注

暂无。
