---
description: "面向编写链文档、组合或排查续行驱动器的用户与维护者：跨会话中继链包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-loop-chain-driver

[English](README.md) | 中文

## 概述

`dsh-loop-chain-driver` 端到端运行一个中继 loop。解析器把人工编写的链文档——为每个节点写明工作区、提示词、inputs、carryOver 与输出 schema 的 YAML 文件——转换为 `@deepseek-ai/dsh-loop` 持久化的冻结 `LoopChainDef`，`defaultChain` 提供回退。交接引擎渲染每个节点子会话的 lean-push 提示词，并按 schema 与预算上限校验结算报告。续行驱动器插件经配置的 provider 为每个节点派生一个全新 subagent，结算报告，在 `node` 检查点重新询问人类，应用评估器裁决，并在重启后恢复在途子会话——没有显式 resume，任何 Round 都不推进。

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

### 组合驱动器

把插件挂在 loop、subagent 与 user-questions 服务旁；`provider` 具名为每个节点子会话派生的 subagent provider，空白名称会在加载时失败：

```yaml
- name: '@deepseek-ai/dsh-loop'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-user-questions'
- name: '@deepseek-ai/dsh-loop-chain-driver'
  config:
    provider: 'subagent-local'
```

loop 旋钮（`defaultMaxRounds`、`maxNodeRetries`、`maxHandoffChars`、`maxEvaluatorInputChars`）属于 `dsh-loop`；驱动器读取其解析值而不是复制它们。`@deepseek-ai/dsh-session-query` peer 是可选的：缺少它时，重启恢复退化为带 attempt 记录的重新派生，且跳过未入账子会话的枚举。

### 每个 Round 做什么

只要存在确切的存活控制 agent、active 且 armed 的 loop 与剩余 Round，驱动器就按链序驱动下一轮未结算的节点：先以冻结的写作用域复核节点声明的工作区（越界工作区以不可重试的 `node-failed` 阻断），再在节点工作区内用组装好的提示词与输出 schema 派生全新子会话，记录打开的 attempt，等待结果，并结算通过校验的报告——否则追加 attempt 失败并带着失败原因重试，直到 epoch 预算以 `node-failed` 阻断。评估器是最终节点索引；其裁决 `complete`/`blocked` 结束 loop，`continue` 推进 Round。`node` 检查点在每次结算后把 loop 停入 `awaiting-human`，直到人类回答 continue、pause 或 terminate。每轮之前驱动器 flush 控制会话；flush 失败以 `durability-failed` 阻断并解除武装。

### 重启、暂停或卸载之后

新加载的驱动器解除所有 loop 的武装且不做任何工作：推进权限不跨进程边界持久化。显式 `resume` 重新武装 loop，并恰好一次地应用待定的评估器裁决。`node-started` 记录在崩溃中幸存的在途子会话从持久日志重读其最后 assistant 表面来恢复；未留可恢复报告者记录一条 `interrupted-by-shutdown` attempt 并重新派生。台账未覆盖的子会话仅通过 subagent 目录枚举并告警——从不恢复、结算或记录。低于 resume 修订号的重启前 attempt 不消耗新的重试预算。`pause` 立即中止在途子会话，并为其打开的 attempt 记录代码 `paused`，之后的 resume 从下一个 attempt 继续；卸载插件会中止、不记录并解除武装。

### 解析链文档

直接导入解析函数：

```ts
import { parseChainDocument, defaultChain } from '@deepseek-ai/dsh-loop-chain-driver/chain'

const chain = parseChainDocument(documentText)   // one aggregate Error on any invalid document
const fallback = defaultChain('Ship the migration')
```

顶层字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `objective` | 是 | loop 要推进的目标；非空且无首尾空白 |
| `exit` | 否 | 供评估器使用的自由文本退出条件；缺省时评估器对照 objective 裁决 |
| `checkpoint` | 否 | `none`（默认）不中断运行；`node` 在每个节点结算后询问人类 |
| `nodes` | 是 | 非空的角色节点列表；角色必须唯一 |
| `evaluator.prompt` | 否 | 覆盖驱动器的默认评估器指令 |

每个节点：

| 字段 | 必填 | 含义 |
|---|---|---|
| `role` | 是 | 唯一角色名；其他节点的 `carryOver` 条目引用它 |
| `prompt` | 是 | 该节点全新子会话收到的角色指令 |
| `cwd` | 否 | 节点的工作区；默认为 loop 的主工作区 |
| `output` | 否 | 以对象为根的 JSON Schema，整体替换默认交接 schema（`status`、`summary`、`evidence`、`nextSteps`） |
| `inputs` | 否 | 声明的来源会话，每个条目恰好是 `{ session: <sessionId> }` |
| `carryOver` | 否 | 其上一轮报告会传入本节点的角色名 |

未知键在所有层级都会被拒绝。失败抛出一个 `Error`，其消息把每个问题列为一行 `- <path>: <message>`；YAML 语法失败会写明 YAML 解析器拒绝的行。

### 节点交接

`assembleNodePrompt(view, round, nodeIndex)` 返回一个节点的提示词：objective、轮次编号、冻结的角色指令、可见性规则具名的报告、开场评估器反馈、声明的输入会话 id、先前子会话 id 与读作用域声明。原始转录永不进入提示词；接收节点按需从具名会话拉取细节。可见性：默认看到同轮前驱报告，加上 `carryOver` 具名角色的上一轮报告；上一轮 `continue` 裁决的反馈强制进入首个节点与每个声明 `carryOver` 的节点；评估器看到本轮全部报告、开场反馈与退出条件。`validateReport(node, report, maxHandoffChars)` 返回违规列表——schema 一致性、`inherited` 条目数精确匹配、序列化 UTF-16 尺寸——`evaluatorInputBudget(view, round, maxEvaluatorInputChars)` 对超限的评估器聚合以 `report-budget` 阻断而非截断。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释驱动器如何实现上面的行为；受支持的字段在[使用本包](#use-this-package)中说明。

### 设计

- **每个 agent 一条串行 pass。** 触发合并到 agent 本地的单条驱动 pass；loop 变更事件只请求下一条 pass。pass 在每个 await 之后重读栅栏视图（确切存活 agent、fiber active、loop active 且 armed、同一 loop id），镜像 goal-round-driver 的栅栏。
- **替换台账语义。** loop 折叠用同一 {round、nodeIndex、attempt} 键把打开的 `node-started` 记录替换为其收尾的 `attempt` 或 `settlement`，因此 attempt 编号扫描全部账目类别，剩余的 `node-started` 条目依构造为打开状态。
- **epoch 下限。** epoch 是最近一次 create 或 resume 变更的修订号；低于它的 attempt 是重启前历史，从不计入新的 `maxNodeRetries` 预算。
- **故障关闭收容。** `LoopError` 变更失败警告后安静停止 pass；`InvariantError` 以 `node-failed` 阻断；其余失败以 `durability-failed` 阻断。teardown 中止在途子会话、不记录、解除武装，并在 initiator 排空前等待 pass 静默。
- **严格解析、解析时品牌化。** `z.strictObject` 在每个层级拒绝未知键，一个聚合错误具名所有问题，每个 `inputs[].session` 字符串在解析时成为 `SessionId`。
- **Lean push、lossless pull。** `assembleNodeCarry` 构造 zod 严格镜像之后的类型化携带对象，因此报告不是无损 JSON 值的结算会在任何提示词渲染前高声失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 续行驱动器插件：Round 循环、重试、检查点、重启恢复、teardown |
| [`src/chain.ts`](src/chain.ts) | 链文档解析、校验与默认链 |
| [`src/handoff.ts`](src/handoff.ts) | 节点交接组装、报告校验与评估器输入预算 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生模块：结算一致性与受裁决门控的推进 |
| [`tests/driver.spec.ts`](tests/driver.spec.ts) | Round 驱动、重试、检查点、失败分类、重启恢复 |
| [`tests/invariant.spec.ts`](tests/invariant.spec.ts) | 伴生模块的接受与拒绝行为 |
| [`tests/chain.spec.ts`](tests/chain.spec.ts) | 解析、拒绝与默认链行为 |
| [`tests/handoff.spec.ts`](tests/handoff.spec.ts) | 可见性规则、预算与校验行为 |

### 不变量归属

伴生模块折叠每个挂载会话的 `loop/change` 与 `loop/node` 事件，拒绝报告违反冻结节点交接 schema 或角色错配的结算、超出评估器索引的结算，以及没有已结算 `continue` 裁决却推进的变更。fork 只从自身事件折叠。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [loop 组地图](../README.zh.md)——loop 各包及其组合方式。
- [`@deepseek-ai/dsh-loop`](../loop/README.zh.md)——驱动器所驱动的持久 loop 服务、事件折叠与生命周期变更。
- [loop 子系统](../../../docs/subsystems/loop.zh.md)——loop 类型、持久事件负载与生成的服务 API。
- [`@deepseek-ai/dsh-subagent`](../../subagent/subagent/README.zh.md)——驱动器以 `provider` 配置的派生接缝。

-----

<a id="model-experience"></a>
## 模型体验

### 节点子会话

#### 模型看到什么

每个节点子会话是全新会话，首轮即组装好的指令：中继轮次与节点位置、objective、冻结的角色指令、以单行 JSON 呈现的携带报告及其轮次、角色与子会话 id、开场反馈、声明的输入会话 id、先前子会话 id 与读作用域声明。原始转录永不被推送。重试的指令会附上前几次 attempt 的失败原因。

#### Token 影响

提示词长度随携带报告的数量伸缩——每个在结算时受 `maxHandoffChars` 约束——从不随会话的转录尺寸伸缩。评估器的聚合受 `maxEvaluatorInputChars` 约束，超限以 `report-budget` 阻断而非截断。

#### KV Cache 影响

节点提示词发给全新子会话，轮内与跨轮都没有 KV Cache 复用；确定性的段落顺序让重驱动轮次的提示词保持稳定。

### 检查点询问

#### 模型看到什么

没有：`node` 检查点询问的是控制人类而非模型。问题具名轮次与已结算节点数；选项是 continue、pause 与 terminate。

#### Token 影响

没有直接影响；`continue` 回答允许下一个节点派生，`terminate` 回答完成 loop。

#### KV Cache 影响

检查点询问从不进入模型可见输入，因此没有任何 KV Cache 前缀改变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明什么时候不该找本包。它们是当前包约束，不是任务积压。

- **装入随发行版的基础组合**——循环组件族（`@deepseek-ai/dsh-loop`、`@deepseek-ai/dsh-loop-chain-driver`、`@deepseek-ai/dsh-command-loop`、`@deepseek-ai/dsh-tool-loop-query`）装入 `dsh-base` 组合，驱动器的 `provider` 设为该组合进程内 spawn 提供方。
- **所有节点共用一个 provider**——`provider` 具名单个 subagent provider；按节点指定 provider 需要先在 loop 服务落地链语言扩展。
- **工作区存在性是派生的栅栏，作用域会被复核**——服务在 loop 启动时检查声明 `cwd` 是否属于写作用域，驱动器在派生时以同样的精确字符串比较复核该成员关系（恢复后声明工作区越出冻结作用域的链以不可重试的 `node-failed` 阻断）。目录存在性仍是 subagent 派生的栅栏：不存在的目录在派生时失败，以 `node-failed` 阻断且不记录 attempt。
- **文档语言是子集**——解析器接受的恰好是 `@deepseek-ai/dsh-loop` 中持久折叠能回放的内容；链语言扩展必须先落在 loop 服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。驱动器插件是函数插件：不注册 `ctx` 服务，命令包应针对 loop 服务组合并自行注册本插件的生命周期。台账追加从不抬高 loop 修订号，因此派生前视图的修订号总是合法的 `atRevision`。台账的替换语义让打开的 `node-started` 条目的 attempt 编号成为下一个 attempt 的下限；跨全部条目类别的全局扫描让编号在替换之间保持单调。派生时的作用域复核对冻结的 `writeScopes` 做精确字符串比较——折叠在读取路径上从不交叉检查链工作区，该栅栏由驱动器持有。重启恢复经 session-query 服务重读崩溃子会话的最后 assistant 表面，并像存活结算一样校验；不可解析或违反 schema 的恢复报告记录 `invalid-recovered-report` 并重试。

</details>
