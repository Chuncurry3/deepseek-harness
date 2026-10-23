---
description: "面向选择、配置或排查跨会话中继 loop 领域的用户与维护者：每个控制会话一个持久的中继运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-loop

[English](README.md) | 中文

## 概述

`dsh-loop` 为每个控制会话记录一个跨会话中继 loop：一条冻结的角色链、多轮节点 attempt，以及一份只追加的节点台账，全部以带版本的会话事件写入，并由严格的回放折叠重建。`ctx.loops` 提供比较并设置的生命周期变更与不走 CAS 的台账追加；激活——本进程是否可以推进该运行——保持进程本地。本包存储 loop 状态，但不派生节点、不组装提示词、也不调度 Round；这些策略属于独立的消费方包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个会话需要在多轮、重启与 fork 之间持有一份中继运行的持久记录时，挂载 `dsh-loop`。本包是服务：呈现一次运行的命令、查询工具与续行驱动器都是独立的消费方包，因此只挂载本包只会存储并提供 loop，不会执行其中任何环节。

### 何时使用

loop 适合由一条冻结的角色节点链跨 Round 中继的单一目标——每个节点在自己的工作区内工作，读取声明的来源会话，并把通过校验的报告交给下一个节点。常规单轮工作不应创建 loop。服务每会话至多保留一个当前 loop：未完成的 loop 必须先 pause、resume、complete、block 或 clear，才能被另一个替代；已完成的 loop 可以直接被替换。

### 配置服务

通过组合配置项加载本包；部署选项约束 Round 数量、节点重试、报告大小与评估器输入，服务会把它们物化为供消费方包读取的已校验 `resolved` 对象。

```yaml
- name: '@deepseek-ai/dsh-loop'
  config:
    defaultMaxRounds: 20
    maxNodeRetries: 2
    maxHandoffChars: 16384
    maxEvaluatorInputChars: 65536
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultMaxRounds` | `20` | start 请求省略自身上限时应用的 Round 上限 |
| `maxNodeRetries` | `2` | 一个 resume 纪元内每个节点的重试预算 |
| `maxHandoffChars` | `16384` | 单份交接报告的字符上限 |
| `maxEvaluatorInputChars` | `65536` | 评估器聚合单轮输入的字符上限 |

每个字段都必须是正的安全整数；非法值会在加载时抛出普通错误。指定了自身 Round 上限的 start 请求会覆盖 `defaultMaxRounds`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-loop)是每个受支持字段的穷尽式真源。

### 会话投影

`LoopService` 要求组合提供 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.zh.md)），并在启动时注册 `loop` 投影单元；未组合投影注册表的组合无法激活 `ctx.loops`。该单元版本为 2，其宿主状态保留最新的有效当前 loop、所有曾使用的 loop id、第一次严格回放失败，以及 fork 种子偏移。客户端视图提供当前投影；首次 create 前与 clear tombstone 后为 `null`。该键同时合并到 `SessionProjectionStateMap` 与 `SessionProjectionMap`；载体通过历史尾页和 `session/projection` 推送帧提供客户端值。

### 驱动生命周期

loop 经历五种持久 phase——`active`、`awaiting-human`、`paused`、`blocked`、`complete`——外加一个表示本进程是否可以推进当前 Round 的进程本地激活标志。动词如下：

| 操作 | 作用 |
|---|---|
| `create` | 以目标、冻结链、作用域与上限启动并启用一个 active loop |
| `pause` | 停止推进并保留状态 |
| `resume` | 在 Round 容量仍有余量时重新启用并继续；resume 的 revision 是重试纪元的下限 |
| `await-human` | 将 active loop 停靠在人工检查点等待回答 |
| `continue` | 人工回答后将 awaiting loop 送回 active |
| `advance` | 记录一次已应用的评估器裁决，消耗一轮预算 |
| `complete` | 标记 loop 已达成并停用 |
| `block` | 记录稳定的 reason 代码与说明，随后停用 |
| `clear` | 移除当前 loop；其历史保留在会话日志中 |

变更必须携带精确的 `LoopRef { id, revision }` 并拒绝陈旧引用；每个被接受的变更都会追加一条 `loop/change` 事件并递增 revision。台账追加——`appendNodeStarted`、`appendAttempt`、`appendSettlement`——以折叠级校验针对当前 loop 校验后追加，不递增 revision；每条记录都以其所取的 loop revision 记录一次节点 attempt 的派生、失败或结算。

### 什么会保留，什么不会

每个被接受的变更与台账追加都会持久记录到会话日志——loop 状态的唯一存储——因此 loop 状态绝不依赖临时消息投递。会话恢复后，loop、其 phase、其 revision、其台账与已开始的 Round 数量都仍然存在。激活是例外：它保存在每会话的进程本地缓存中，任何新进程或 agent 边界都会将其停用，且绝不持久化——重新打开的会话不会自行开始任何工作，直到消费方显式 resume。

fork 是第二个例外：投影只从 fork 的种子偏移开始折叠 loop 事件，因此父会话的运行留在父会话，fork 不驱动任何运行。

### 观察 loop

消费方通过 `loop` 会话投影读取当前 loop，通过 `ctx.loops` 进行变更。投影值携带完整快照、折叠后的台账，以及供比较并设置使用的最新 ref：

```text
const view = projection.current      // LoopProjection | null — null before the first create and after a clear
view.loop                             // LoopSnapshot — objective, phase, chain, scopes, roundsStarted
view.ledger                           // append-only entries keyed {loopId, round, nodeIndex, attempt}
view.lastRef                          // { id, revision } the next mutation must carry
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计

- **四种带版本的事件类型。** `loop/change`（版本 1）携带变更后的完整快照或带 revision 的 clear tombstone；`loop/node-started`、`loop/attempt` 与 `loop/node`（各版本 1）追加节点台账。会话日志是唯一的持久权威。
- **比较并设置的变更。** `ctx.loops` 只接受以对应 id 注册的完全相同的活跃 `Agent`，要求会话在会话存储中保持活跃，并以 `LOOP_STALE_REVISION` 拒绝陈旧引用。flush 失败会停用运行并重新抛出，而已提交的事件保留在日志中——即持久化屏障。
- **严格回放。** 折叠对 `loop/change` 取最后写入者生效，并把台账事件折叠进以 `{loopId, round, nodeIndex, attempt}` 为键的映射。它拒绝格式错误的记录、不连续的 revision、非法 phase 转换、非单调时间戳、重复的台账键、没有对应 `node-started` 的结算，以及复用的 loop id。第一次失败会被保留，loop 访问从该记录起失败；同一会话的其他投影不受影响。
- **激活是进程本地的。** `armed` 与 `disarmed` 保存在每会话缓存中，绝不持久化。新缓存与每次 `agent/created` 边界都会停用运行，即使回放发现持久 phase 为 active；`arm()` 与 `disarm()` 在不写 revision 的情况下改变权限，变更期间同步设置的待定激活会随其事件跨越追加边界。
- **投影单元。** 本包要求提供投影注册表，并注册一个严格的 `loop` 单元（状态版本 3）。其宿主状态保留回放校验数据与 fork 种子偏移；客户端视图提供最新有效的投影或 `null`。
- **不变式配套模块。** `./invariant` 出口为每个已挂接会话安装独立的增量折叠：候选事件在副本上校验，失败会指明确切的会话事件 seq。loop 折叠失败绝不会使同一会话中其他包的投影失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`LoopService`、配置 schema、start 校验、投影单元、激活缓存 |
| [`src/domain.ts`](src/domain.ts) | 持久变更与台账载荷、作用域限定的 `loop/changed` 事件、错误代码 |
| [`src/types.ts`](src/types.ts) | 纯客户端安全类型：`LoopView`、`LoopSnapshot`、链与台账类型、投影键声明 |
| [`src/fold.ts`](src/fold.ts) | 持久 loop 事件的严格回放折叠与手写解码器 |
| [`src/paths.ts`](src/paths.ts) | 作用域路径归一化：realpath 解析、正斜杠分隔符、win32 大小写折叠 |
| [`src/runtime.ts`](src/runtime.ts) | `LoopId` 品牌、`LoopError`、变更与台账版本常量 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套模块：对每个已挂接会话的独立增量折叠 |
| [`src/client.ts`](src/client.ts) | 客户端命名空间对类型出口的再导出 |

### 事件与归属

`loop/changed` 在持久 `loop/change` 提交后触发，监听器失败会被隔离；载荷携带操作与最新的 ref，并按作用域过滤到所属 agent。台账事件是以 `{loopId, round, nodeIndex, attempt}` 键与其所取 loop revision 归属的只追加记录；不变式配套模块把校验失败归属到确切的会话事件 seq。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要了解周边领域与设计理由时阅读以下页面。

- [loop 子系统](../../../docs/subsystems/loop.zh.md)——loop 类型、持久事件载荷与生成的服务 API。
- [loop 组地图](../README.zh.md)——loop 各包及其组合方式。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-loop)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### loop 状态变更

#### 模型看到什么

loop 变更不会注入模型上下文。本包不注册任何工具、命令或提示词贡献；呈现运行状态是消费方包对 `loop/change` 状态的渲染职责。

#### Token 影响

loop 变更与台账事件本身不增加模型 token。消费方渲染进工具结果或提示词的内容各自计入 token 用量。

#### KV Cache 影响

在其他组件把 loop 状态暴露为模型可见输入之前，不会影响 KV Cache。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 loop 服务何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **只负责状态，不负责执行**——本包不派生子会话、不组装提示词、不重试失败、不决定调度；这些策略属于消费方包。
- **只有一个当前 loop**——系统有意不支持并行 loop、DAG 节点形态与逐节点扇出；已完成的 loop 可以直接被替换，替换或清除后历史仍可在会话日志中读取。
- **没有跨进程自动恢复**——重启后持久状态会回放，但激活绝不持久化，没有任何东西会自行重启工作；显式 resume 才会重新启用运行。
- **只有 Round、重试与大小上限**——`maxRounds`、`maxNodeRetries`、`maxHandoffChars` 与 `maxEvaluatorInputChars` 约束投入；token、成本与挂钟时间预算暂缓。
- **fork 不继承运行**——折叠只从 fork 的种子偏移开始应用 loop 事件，因此控制会话的 fork 不驱动任何运行，必须创建全新的 loop。
- **信任进程内生产方**——能直接访问 `Session` 的插件可以追加伪造的 loop 事件。严格回放会检测格式错误或不一致的记录，并使 loop 访问从该记录起失败，直到日志修复；这是完整性检测，不是插件隔离。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。`src/fold.ts` 中的严格解码器为手写实现，镜像 goal 领域的折叠：每个字段检查都会抛出指明记录与字段的 `Error`，折叠将其归属到失败的会话事件。因此本包不声明任何 schema 库依赖；解析不可信链定义的消费方自行负责其 schema 校验。

</details>
