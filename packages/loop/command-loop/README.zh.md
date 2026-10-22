---
description: "面向在 UI 命令平面中启动、操控或查看跨会话接力 loop 的用户与维护者的 /loop 斜杠命令说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-loop

[English](README.md) | 中文

## 概述

`dsh-command-loop` 为用户提供 `/loop` 命令，以便直接在交互式 UI 中启动、操控并查看一条跨会话接力 loop。start 通过 loop 领域解析冻结链与作用域授权，并把每条授权路径 realpath 归一化；生命周期动词 pause、resume 与 clear 操作一条持久运行；裸 `/loop` 渲染当前状态、ledger 进度与有效的下一步命令。命令及其直接输出留在 UI 中，不进入模型请求。此包适用于带命令适配器的交互式部署；没有适配器的无头与自动化应用不需要它。

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

在挂载了命令适配器的交互式部署中使用 `dsh-command-loop`——随附的 Web 客户端是参考实现。它让用户无需模型轮次即可直接控制接力生命周期：命令在 UI 命令平面执行，适配器直接渲染其结果。

### 命令参考

每个子命令都针对调用 agent（智能体）的当前 loop 执行；没有 loop 时，裸 `/loop` 显示用法。

| 输入 | 结果 |
|---|---|
| `/loop` | 显示目标、持久 phase、Round 数量与上限、已结算节点进度、进程本地续行启用状态、最新已结算报告摘要（JSON 文本，超过 120 字符截断并以省略号结尾）与有效的下一步命令；被阻塞的 loop 还会显示其策略代码与说明 |
| `/loop status` | 与裸 `/loop` 完全相同地显示当前状态；仅在恰好构成完整输入时被识别 |
| `/loop [start] <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node]` | 启动并启用一条 loop，或用全新身份替换已完成的 loop；`start` 动词可省略 |
| `/loop pause` | 暂停当前 loop 并停用续行 |
| `/loop resume [--from <node|role>]` | 恢复已停止的 loop；仍受剩余 Round 上限约束；`--from` 仅解析与校验，重放续行尚未实现 |
| `/loop clear` | 清除当前 loop，同时保留其持久历史 |

### 输入语法

动词 `pause`、`resume` 与 `clear` 只有在恰好匹配完整输入时才被识别；`status` 遵循同一规则并显示状态。可选的 `start` 动词前置于目标——裸 `/loop start` 是直接错误，`/loop start iterate` 与 `/loop iterate` 启动同一条运行。其他任何非空输入都是 start 目标，因此 `/loop pause now` 会启动该字面目标；目标必填，不得为空或纯空白。值可以用双引号包裹以携带空格、分号或前导 `--`；引号仅在 token 起始处开启原样段，剥离引号后内容原样保留，没有转义序列。`--read` 与 `--write` 可重复出现，各自授权一条路径；`--chain`、`--max-rounds` 与 `--checkpoint` 至多出现一次；缺值的 flag、未知 flag 或 flag 之后的游离输入都会以直接命令错误响亮失败。

### 作用域与链

start 依次从 `--chain` 文档（相对路径以控制会话的 workspace 为基准）、该 workspace 下的 `loop.yaml` 解析链，否则使用默认单 worker 链。相对的 `--read`/`--write` 授权与声明的链节点 workspace 同样以控制会话的 workspace 为基准：所有路径型输入共享同一基准，不会解析到进程自身的工作目录；绝对路径原样保留。每条授权与声明的路径都必须存在，并在启动时做 realpath 归一化；授权作用域必须是一个目录，授权一个文件会以直接错误响亮失败。`writeScopes` 是控制 workspace 加 `--write` 授权，`readScopes` 额外并入每条声明链节点的 workspace 与 `--read` 授权，成员判定按精确路径——嵌套在被授权目录之内不构成授权。workspace 落在写作用域之外的链节点会在启动时以直接错误拒绝。

### 组合方式

命令注入命令注册表、loop 服务与会话投影注册表；自定义应用挂载它们的所有者与此插件：

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

命令通过 `loop` 会话投影读取当前 loop——与续行 driver 相同的读取路径——并通过 `ctx.loops` 变更。是否挂载 driver 插件本身是另一个独立的组合选择。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何解析输入并渲染输出；可观察契约见[使用本包](#use-this-package)。

### 设计

- **语法而非自由文本。** 带双引号原样段的空白分词器喂给一个封闭的命令联合：show、start、pause、带可选 `--from` 目标的 resume、clear，以及裸 `start` 拒绝。动词 token 按小写匹配且仅当剩余输入契合该动词，镜像 `/goal` 的控制词。
- **start 解析响亮失败。** 链文档、每条授权作用域与每个声明节点 workspace 都在领域 start 之前读取并做 realpath 归一化；文件缺失、文档非法、路径不存在或授权不是目录都会成为直接命令错误，且不触发领域变更。
- **领域拒绝转为稳定错误。** `LoopError` 结果转为直接命令错误——作用域违规保留领域的解释性消息，其余结果使用一条固定消息。意外失败重新抛出，使适配器将其报告为命令失败而非领域结果。渲染输出不暴露带品牌类型的 id 或 revision。
- **状态可从日志重建。** 渲染只读取持久 loop 快照、折叠后的 ledger 与进程本地续行启用状态；已结算节点数与最新报告摘要都派生自会话日志已经持有的 ledger。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令语法、作用域与链解析、状态渲染、分发 |
| — | 未发布运行时不变量 companion；此命令适配器不拥有事件流或状态投影；接受的变更由 loop 领域校验，命令分发行为由包测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

命令是 loop 领域之上的薄适配层；阅读这些页面了解它变更的状态与接入的注册表。

- [Loop 服务](../loop/README.zh.md)——命令变更的持久状态与生命周期。
- [Loop 链 driver](../loop-chain-driver/README.zh.md)——执行已启动运行的续行插件。
- [Commands 服务](../../interaction/commands/README.zh.md)——命令注册表契约与分发。

-----

<a id="model-experience"></a>
## 模型体验

### 人类 `/loop` 控制

#### 模型看到什么

斜杠输入、变更与直接状态或错误输出都不进入模型请求。loop 领域把变更记录为 `loop/change`；挂载的续行 driver 在调度 Round 时读取结果状态。呈现文本从不入日志。

#### Token 影响

读取状态、变更 loop 或接收直接命令错误不会增加模型 token。挂载 driver 之后的续行提示按自身成本计。

#### KV Cache 影响

命令发现、变更与直接输出不影响缓存。续行提示遵循 driver 的普通请求历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了命令何时不合适或需要特别对待。它们是当前包约束，不是任务积压。

- **无附件**——loop 语法没有附件槽位；接力输入来自链声明的会话，而非 composer 附件卡。
- **续行启用状态是进程本地的**——状态行的 armed 或 disarmed 取值只反映本进程；重启后的进程在 `/loop resume` 重新启用之前将其渲染为 disarmed。
- **仅纯文本交互**——通用命令注册表没有模态编辑表单；start 语法与显式 clear 让破坏性意图在各适配器间保持确定性。
- **`resume --from` 只解析、无续行通道**——解析器对照冻结链的角色、索引与 evaluator 校验目标，有效目标会以指明当前 resume 行为的直接错误结束。
- **随附应用只有 Web 命令适配器**——无头、ACP 自动化与 JSON-RPC 适配器不消费 `ctx.commands`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是面向维护者的工作上下文；明确不具权威性。开放未决：replay-from-node 续行是否落在 `resume --from` 之后，以及哪些报告摘要字段值得更丰富的渲染。

</details>
