---
description: "面向运行跨会话接力 loop 的 agent 开发者与维护者的、按谱系与作用域授权的模型侧会话查询工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-loop-query

[English](README.md) | 中文

## 概述

`dsh-tool-loop-query` 为模型提供两个只在一条接力运行谱系之内生效的只读工具。`loop_session_search` 在该运行可读取的会话中查找字面文本；`loop_session_read` 返回该会话当前的模型可见面，或一条事件及其相邻事件。授权来自调用方：运行是投影在调用会话或其某个祖先会话上的当前 loop，成员身份由该祖先所拥有的 subagent 目录证明，可读集合是运行冻结的 `readScopes` 加调用方自身 workspace，并按 realpath 比较。运行之外的调用方与落在这些作用域之外的目标，都会以指明原因的稳定错误码拒绝。

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

当接力运行的 worker 需要读取该运行被授权读取的会话时，挂载本包。常见路径是显式的：控制会话通过 `@deepseek-ai/dsh-loop` 以 `readScopes` 启动一条 loop，续行 driver 把运行交给 worker 会话，这些 worker 再调用这两个工具。

### 何时选择它

当接力运行需要模型驱动的、对该运行自身输入的读取时选择它——例如 worker 在写报告前读取上一节点的会话。部署从不启动 loop 时不要选它：这两个工具只能拒绝，而它们的 schema 仍留在每个请求上。程序化调用方也不需要它；`ctx.sessionQuery` 直接服务代码。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSearchResults` | `100` | 单次搜索返回的最大匹配事件数 |
| `searchTimeoutMs` | `30000` | 附加在搜索工具上的协作式截止时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-loop-query)是每个可接受字段及其 JSDoc 的完整来源。

### 组合方式

两个工具注入工具注册表、会话查询引擎与 subagent 运行时；自定义应用挂载它们的所有者与此插件：

```yaml
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: session-query
  name: '@deepseek-ai/dsh-session-query'
- id: subagents
  name: '@deepseek-ai/dsh-subagent'
- id: loop
  name: '@deepseek-ai/dsh-loop'
- id: tool-loop-query
  name: '@deepseek-ai/dsh-tool-loop-query'
```

loop 领域拥有运行及其作用域授权；subagent 运行时拥有证明谱系的目录；本包只读取这两者。

### 模型能做什么

| 工具 | 模型得到什么 |
|---|---|
| `loop_session_search` | 每个可读会话中的匹配事件，按会话分组，并给出序列号、类型、可见面、时间与单行摘录；可选的名字列表用于收窄扫描范围 |
| `loop_session_read` | 某个可读会话当前的模型可见面，或一条精确事件的 JSON 与可选相邻事件摘要 |

### 授权

授权来自调用方 agent，绝不来自参数。运行通过沿调用方的 parent 链查找当前 `loop` 投影来确定；被清除的 loop 不会留下任何可供上溯找到的运行，因此运行已被清除的调用方会被拒绝而不是被服务。上溯读取的是投影对外发布的客户端取值（该取值在发布前已通过 loop 视图 schema 校验），而不是 `/loop` 渲染的原始宿主状态，因此从未产生过合法快照的记录无法成为一个运行。控制会话自身的 agent 以身份方式处于其运行之内；其他每个调用方都必须出现在该会话的 subagent 目录中，因此只在自身 header 里声称父会话的会话会被拒绝。

当目标会话是调用方自身，或其 workspace 属于运行冻结的 `readScopes`、或等于调用方自身 workspace 时，该目标可读。两侧路径都做 realpath 归一化，因此被授权作用域内等价的符号链接目标会被服务。落在该集合之外的具名目标会拒绝整次调用，并且未知 id 的消息与不可读 id 的消息完全相同，调用方无法探测哪些会话存在。在请求的序列号处找不到内容的读取同样以该拒绝消息结束，因此引擎自身的 not-found 错误码不会到达模型。无法再解析的 workspace 不授予任何权限。

### 失败与恢复

本地参数与授权错误保留各自精确的工具自有消息与错误码：无 agent 绑定的调用为 `LOOP_QUERY_AGENT_REQUIRED`，运行谱系之外的调用方为 `LOOP_QUERY_LINEAGE_REFUSED`，未知或不可读目标为 `LOOP_QUERY_SCOPE_REFUSED`，被拒输入为 `LOOP_QUERY_INVALID_QUERY` 或 `LOOP_QUERY_INVALID_ARGS`。取消会转发给每一次接受信号的引擎与目录读取；逐会话的事件扫描不接受信号，会完整执行到底。除固定的摘录宽度外，本包不做任何截断，也不引入溢出后端。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释这两个工具背后的设计决策，并指出实现它们的代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计

- **一套授权推导，两条通道。** 两个执行器都在接触数据之前解析运行与可读集合，因此搜索与读取不可能对调用方能看到什么产生分歧。
- **谱系是持久数据，不是声明。** 运行来自 `loop` 会话投影，成员身份来自控制会话所拥有的 `subagent/catalog` 事件；调用方自身的 header 只是上溯的起点。
- **读取使用与 provider 无关的通道。** 搜索通道用空过滤器列出全部语料，在本地比较归一化后的 workspace，再对每个可读会话的事件做字面文本扫描。全文检索会比较原始 workspace 字符串并按 provider 打分排序，既破坏 realpath 规则也破坏确定性的分组。
- **拒绝是确定性的。** 每条拒绝都指明原因与错误码，并且不可读目标的消息刻意不区分未知 id 与禁止访问的 id。


### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、谱系与作用域授权、两条操作通道、渲染 |
| — | 未发布运行时不变量 companion；此模型适配器不拥有事件流或状态投影；它强制的谱系与作用域关系是读取 loop 领域、subagent 运行时与会话查询引擎所拥有的投影与目录，包测试覆盖两条通道、拒绝路径与注册销毁。 |

### 操作流程

每个执行器从 `ToolExecution.exec.agent` 读取调用会话，解析运行与可读集合，然后校验输入。搜索列出可读会话（可选地收窄到模型具名的 id），通过历史过滤器扫描每个会话的事件，并在达到 `maxSearchResults` 时带提示停止；读取先观察目标，再在渲染前复查观察到的 header。两者都只从持久会话数据渲染纯文本：任何进入模型请求的内容都能由会话日志重建。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从工具表面走向拥有该运行的领域以及这些工具所读取的服务。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-loop-query)——模型看到的两份工具 schema。
- [Loop 服务](../loop/README.zh.md)——运行、它的 Round 与冻结的作用域授权。
- [Loop 链 driver](../loop-chain-driver/README.zh.md)——把运行交给 worker 会话的续行插件。
- [dsh-session-query](../../session-query/session-query/README.zh.md)——两条通道背后的读取引擎。
- [dsh-subagent](../../subagent/subagent/README.zh.md)——证明调用方处于运行之内的目录。
- [Loop 子系统](../../../docs/subsystems/loop.zh.md)——loop 类型、持久 `loop/*` 事件与生成的服务 API。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`loop_session_search` 与 `loop_session_read` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-loop-query)。两段描述都以"仅在活跃运行的谱系之内可用、其他任何调用都会被拒绝"开头；描述其余部分说明工具返回什么，以及哪些 schema 字段被刻意省略（没有 cursor、没有分页大小、没有模型可控的上限、也没有 workspace 路径）。

#### Token 影响

只要挂载了本插件，每个请求都会发送两份固定的只读 schema，无论是否有活跃运行。本包不注册系统提示段：每段描述中的拒绝语句本身就承载契约，而额外的提示段会给进程内每个会话增加 token。

#### KV Cache 影响

在工具可见性与定义不变时前缀稳定。由于注册是静态且全局的，运行的开始或结束不会改变请求前缀。

### 工具结果

#### 模型看到什么

每次成功调用产出一个纯文本块。搜索按会话分组命中，并把每条摘录上限设为 200 字符（超出以省略号结尾）；被截断的结果以"收窄查询或减少具名会话"的提示结尾。读取以带编号的事件行返回可见面，或以 JSON 返回精确事件及相邻事件摘要。

#### Token 影响

结果依赖数据，并保留在已记录的工具历史中直到压缩；`maxSearchResults` 限制搜索命中数，摘录宽度限制单条命中的长度。

#### KV Cache 影响

追加式的结果文本位于可复用的请求前缀之后，不会使先前的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了本包何时不合适或需要特别对待。它们是当前包约束，不是任务积压。

- **全局注册成本**——工具是静态注册的，因此从不启动运行的组合会话同样携带两份 schema。
- **字面扫描而非全文排序**——搜索在可读会话中匹配字面事件文本并按会话顺序返回，因此可读语料很大时成本是一次完整扫描，且命中不带相关性分数。
- **搜索有上限且无续行**——搜索至多返回部署上限数量的命中，并在还有更多匹配时提示模型收窄查询；没有续行 token。
- **作用域成员判定为精确路径**——嵌套在被授权作用域目录之内的目标不构成授权；只有被授权路径本身与调用方自身 workspace 可读。
- **无写入与生命周期访问**——这些工具只读；这里不会启动、推进或清除任何运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是面向维护者的工作上下文：开放的设计问题与尚未决定的方向。它明确不具权威性——已发布行为、限制与已接受的依据都在上面各节、包代码与所链接的 Agent Note 中。

#### 未来：相关性与作用域语义

搜索是否应按匹配质量而非会话顺序排序命中，以及运行的读取权限是否应跟随其节点可修改的写作用域，两者都尚未决定。

</details>
