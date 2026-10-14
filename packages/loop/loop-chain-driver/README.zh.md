---
description: "面向编写、校验或排查跨会话中继 loop 链的用户与维护者：中继链文档解析器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-loop-chain-driver

[English](README.md) | 中文

## 概述

`dsh-loop-chain-driver` 解析人工编写的中继链文档——那份为每个角色节点写明工作区、提示词、声明的输入会话、carryOver 引用与输出 schema 的 YAML 文件——得到 `@deepseek-ai/dsh-loop` 所持久化的冻结 `LoopChainDef`。校验严格且失败直接：未知键、重复角色、未知 carryOver 引用、空白字符串与超出子集的输出覆盖会在一个聚合错误中一并列出每条出错路径。`defaultChain` 为未指定文档的启动提供单工作节点链。

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

直接导入解析函数；本包不注册任何服务：

```ts
import { parseChainDocument, defaultChain } from '@deepseek-ai/dsh-loop-chain-driver/chain'

const chain = parseChainDocument(documentText)   // one aggregate Error on any invalid document
const fallback = defaultChain('Ship the migration')
```

### 何时使用

启动中继 loop 的消费方在启动时解析工作区链文档——约定为 `loop.yaml`，或 `--chain <file>` 指定的文件；文件缺失时退回 `defaultChain(objective)`，校验通过的链冻结进第一条 `loop/change` 快照。其他所有消费方从 loop 快照读取冻结的链，而不是重新解析。

### 链文档

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

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释解析如何实现上面的行为；受支持的字段在[使用本包](#use-this-package)中说明。

### 设计

- **持久语言的子集。** 每条规则都镜像 `@deepseek-ai/dsh-loop` 回放 `loop/change` 事件时应用的严格解码器：规范化的 objective、非空的 prompt/cwd/session 字符串、唯一角色、恰好 `{ session }` 的 inputs 条目、限定在本链角色内的 carryOver 名称，以及经 `assertObjectJsonSchema` 校验的输出覆盖。因此解析出的链总是能通过持久回放校验。
- **处处严格对象。** `z.strictObject` 在文档、节点、inputs 条目与 evaluator 各层级拒绝未知键；`checkpoint` 缺省为 `none`，文档中的 `evaluator.prompt` 在解析时映射为扁平的 `evaluatorPrompt` 字段。
- **一个高声的聚合错误。** `safeParse` 收集全部问题，失败消息把它们渲染为带路径前缀的行，而不是停在第一个问题。
- **解析时品牌化。** 每个 `inputs[].session` 字符串在解析时成为 `SessionId`，冻结的定义因此端到端携带品牌 id。
- **默认链。** `defaultChain(objective)` 返回一个 `iterate` 节点，带默认交接待遇、无输出覆盖；它不携带 `evaluatorPrompt`，因为默认评估器指令属于运行链的续行驱动器。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/chain.ts`](src/chain.ts) | 链文档解析、校验与默认链 |
| [`src/index.ts`](src/index.ts) | 包入口；尚不承载运行时 API |
| — | 不发布运行时不变量伴生模块；本包在自身的输入操作处解析并校验链文档，没有可供复查的可变运行时关系 |
| [`tests/chain.spec.ts`](tests/chain.spec.ts) | 解析、拒绝与默认链行为 |

### 不变量归属

本包不发布不变量伴生模块，因为它是链文档解析器：其不可信输入在归属的解析操作（`parseChainDocument`）处校验，本包自身没有可供复查的可变运行时关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

上面的字段说明已足够大多数链作者使用；需要了解周边领域时再读这些。

- [loop 组地图](../README.zh.md)——loop 各包及其组合方式。
- [`@deepseek-ai/dsh-loop`](../loop/README.zh.md)——持久化已解析链的 loop 服务。
- [loop 子系统](../../../docs/subsystems/loop.zh.md)——loop 类型、持久事件负载与生成的服务 API。
- [`@deepseek-ai/dsh-tools`](../../core/tools/README.zh.md)——输出覆盖必须使用的以对象为根的 JSON Schema 子集。

-----

<a id="model-experience"></a>
## 模型体验

### 链文档

#### 模型看到什么

本包不注册任何工具、命令或提示词贡献；解析发生在任何模型轮次之前。链文档承载的文本——每个节点的 `prompt`、可选的 `evaluator.prompt` 与任何 `output` schema——是续行驱动器之后展示给它派生的全新子会话的内容。

#### Token 影响

本包没有 token 影响：解析链文档不发起模型请求。解析出的节点提示词与评估器覆盖决定了驱动器组装的节点指令将消耗的 token；更严格的 `output` schema 可以缩短子会话必须产出的报告。

#### KV Cache 影响

在续行驱动器把解析出的链文本放入模型可见输入之前，不会影响 KV Cache。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明什么时候不该找本包。它们是当前包约束，不是任务积压。

- **目前只做解析**——续行驱动器插件（推进节点、派生全新子会话、校验报告、运行评估器）与 `/loop` 命令面在本阶段稍后交付；今天本包只暴露链文档解析与默认链。
- **文档语言是子集**——解析器接受的恰好是 `@deepseek-ai/dsh-loop` 中持久折叠能回放的内容；链语言扩展必须先落在 loop 服务，否则解析出的链会在回放校验中失败。
- **不检查工作区存在性**——`cwd` 只校验为非空字符串；目录是否存在由驱动器在派生时解决。
- **会话 id 只品牌化、不解析**——`inputs[].session` 成为 `SessionId` 品牌而不做查找；会话是否存在在 loop 启动时限定，不在解析时。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。`src/chain.ts` 用 zod 严格对象 schema 按 `@deepseek-ai/dsh-loop` 回放时应用的同一套字段规则做校验；折叠拥有权威规则，持久语言变更必须两侧同步。重复角色检查挂在 nodes 数组上，carryOver 引用检查挂在整个文档上，因此基础解析失败时仍会尽可能报告所有问题。`yaml` 与 settings 文件提供方解析用户文档所用的库相同。

</details>
