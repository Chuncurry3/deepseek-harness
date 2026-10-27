# Agent Note: 跨会话接力循环

Status: proposed

[English](2026-09-24-cross-session-relay-loop.md) | 中文

## 问题

由专业角色构成的长任务——规划下一轮试验、执行试验、依据结果优化工具、配置新版本、再循环——跨越多个项目，超出单次对话与单个上下文窗口的容量。已交付的两种执行策略覆盖的是其他形态：[同会话目标](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md)把一个目标保留在一条不断增长的对话里，多角色工作会腐化它所依赖的上下文；[Ralph 运行](../../archived/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md)以工作区为记忆迭代全新子代理，但它是前台、模型调用的 workflow，没有持久的运行状态、没有跨轮的对话串联、也没有人类命令入口，且其子代理的工作区继承自父会话，无法表达「必须在另一个项目里行动」的接力。

读取其他会话的能力已经存在——[`ctx.sessionQuery`](../../../../packages/session-query/session-query/README.zh.md) 提供受信读取，[`tool-session-query`](../../../../packages/session-query/tool-session-query/README.zh.md) 提供工作区授权的模型读取——但没有机制把对话连接起来：一个对话的整理产出，无法在持久、可恢复、人类授权的生命周期内成为另一个对话的输入，也没有策略能在另一个项目的工作区里执行某个对话的工作。

此处的「接续」指在新会话中继续原会话的内容——读取它、把结论带向前、并报告继承了什么——而不是回到原对话。

以粘贴对话记录完成交接，要么让下一个对话被冗余内容撑爆，要么丢失真正重要的信息。本特性要满足的诉求是机械的而非建议性的：跨对话传递不得引入冗余、不得丢失关键信息。

不间断执行需要显式分层：宿主进程存活时自动推进、进程死亡后以持久状态存续、且没有显式人类授权绝不重启。

## 提案

以插件族 `packages/loop/` 新增第三种执行策略，由人类 `/loop` 命令启动，全部由既有缝组装。词汇表扩展[Harness 级执行层级](../../implemented/feature/2026-07-16-harness-level-loop.zh.md)：Loop Run → Round → Node → Turn → Step。一轮是对冻结角色节点链的一次完整遍历；一个节点是一次全新的子对话。

本提案部分取代该 note 中「不存在 `packages/loop/` 族、`LoopDriver`、`LoopId`」的条款——那一条否决的是没有具体消费方的投机式通用 loop 服务。如今消费方是具体的：人类命令发起的接力链，其各轮通过校验过的结构化交接把全新对话连接起来，并在显式授予的项目工作区上执行与读取。被否决的抽象保持否决——没有模型侧的 loop 创建工具、没有通用 `StopCondition`、没有时间驱动触发（[schedule 族](../../../../packages/schedule/schedule/README.zh.md)拥有会话内提醒）——同会话 goal 与 Ralph 两个策略不变。

| 包 | 角色 |
|---|---|
| `packages/loop/loop/` 的 `@deepseek-ai/dsh-loop` | 控制会话内事件溯源的运行状态；`ctx.loops`；compare-and-set `{loopId, revision}`；进程局部 activation |
| `packages/loop/loop-chain-driver/` 的 `@deepseek-ai/dsh-loop-chain-driver` | 续跑策略：推进节点、在每节点工作区派生全新子会话、校验报告、运行评估器 |
| `packages/loop/command-loop/` 的 `@deepseek-ai/dsh-command-loop` | 经 [`ctx.commands`](../../implemented/feature/2026-07-19-plugin-command-registration.zh.md) 注册的人类 `/loop` 命令 |
| `packages/loop/tool-loop-query/` 的 `@deepseek-ai/dsh-tool-loop-query` | 强制执行运行冻结读取范围的、loop 作用域的会话搜索/读取工具 |

四个包全部挂入随产品发布的 `dsh` base 组合。命令文法沿用 [`command-goal`](../../../../packages/goal/command-goal/README.zh.md)：裸 `/loop` 或整输入的 `status` 别名渲染状态；`/loop start <objective> [--chain <file>] [--read <path>]... [--write <path>]... [--max-rounds N] [--checkpoint none|node]` 创建并 arm 一个运行，`start` 是可选前缀——其余任何非空输入本身就是 objective；`/loop pause`、`/loop resume [--from <node|role>]`、`/loop clear` 拥有生命周期。控制词按大小写不敏感识别，且只在恰好构成完整输入时被识别——`resume` 还允许携带单个 `--from` flag——因此 `/loop pause now` 以该字面文本作为 objective 启动；引号在匹配前剥除为内容，因此加引号的控制词仍是动词。无法解析出 objective 的 start 是解析期拒绝（文法的 invalid-start 成员）。`--read` 与 `--write` 是可重复的单路径 flag，值可加双引号以携带空格、分号或前导 `--`；引号只在 token 起始处开启引用段，内容原样保留且零转义，加引号的 token 绝不成为 flag；不设列表分隔符，因此不存在会写错的转义规则。每个授予路径在启动时经 `realpath` 规范化，必须存在且可进入；否则命令直接报错。`readScopes` = 控制会话自身工作区 ∪ 全部链节点工作区 ∪ `--read` 授予；`writeScopes` = 控制会话自身工作区 + `--write` 授予——隐式授予仅覆盖这一个工作区，任何跨项目写入都必须显式 `--write`。链项的 `cwd` 不是 `writeScopes` 的成员则启动失败（精确成员资格，而非子树包含），驱动器在派生时再次断言。

每节点工作区需要一处 subagent 缝扩展：`SubagentStartRequest` 增加可选 `cwd`（绝对路径，沿用现有 `assertUsableCwd` 校验纪律），以 provider 能力形式声明。in-process provider 用它设置子会话头的 cwd；不带该能力的 provider 对设置了它的请求直接拒绝，行为绝不静默退回父工作区。该扩展在实现时以独立的 subagent 族 note 落地，且顺序固定：缝 note 先行（含能力校验与 in-process provider 支持），loop 四包在其之上构建——没有它无法启动。

链来自工作区 `loop.yaml`，启动时严格校验；文件缺失时使用[链定义](#chain-definition)中的默认链。轮次随节点结算推进而非时钟。中断层级固定于[恢复](#recovery)：L1 进程内自动推进、L2 跨进程手动 `/loop resume`、不做 L3 跨进程自动恢复。

外部先例锚定了机制选择：[Ralph](https://ghuntley.com/ralph/) 的全新上下文迭代与记忆外置，[snarktank/ralph](https://github.com/snarktank/ralph) 的带完成位任务表，[vercel-labs/ralph-loop-agent](https://github.com/vercel-labs/ralph-loop-agent) 的外层验证循环、失败反馈注入与用量护栏，以及 Claude Code `/goal` 的独立评估模型（其裁决进入 transcript）。

## 持久化记录

控制会话——人类敲入 `/loop` 的会话——拥有运行，镜像 [goal 域](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.zh.md)。每次变更追加一条会话事件，折叠是唯一的持久权威。共四个带版本的事件类型：

- `loop/change`——完整变更后快照，整值 last-wins 折叠：`loopId`、`revision`、objective、冻结链定义、`maxRounds`、checkpoint 模式、`readScopes`、`writeScopes`、相位 `active | awaiting-human | paused | blocked | complete`、blocked 原因、`roundsStarted`、创建/更新时间戳。clear 追加一条带 revision 的墓碑。当前 loop 是最新一条未被墓碑终结的 create；替换性 create 铸造全局全新的 `loopId`，被清除的历史与活跃运行绝不共用同一身份。
- `loop/node-started`——append-only 派生记录：`loopId`、轮次、节点索引、角色、1 起始的 attempt、`childSessionId`、`cwd`、派生时的 `atRevision`。它在 `start()` 兑现后、等待结果前追加，因此崩溃后在飞子代理总是可定位。
- `loop/attempt`——一次尝试的 append-only 失败记录：`loopId`、轮次、节点索引、attempt、`childSessionId`、`failure: { code, message }`、`atRevision`。尝试计数与失败原因因此跨重启存续；重试预算不会意外归零。
- `loop/node`——append-only 结算：`loopId`、轮次、节点索引、角色、attempt、`childSessionId`、`cwd`、已校验报告（无损 JSON 值——持久解码拒绝任何非 JSON 内容）。结算只记录成功；失败记录在 `loop/attempt`，预算耗尽是 `loop/change` 的 block。

`revision` 只在 `loop/change` 事件上递增；节点账本从不推进它。compare-and-set 使用 change revision。每条账本事件携带 `atRevision`——事件发生时生效的 change revision——作为排序与按纪元预算的逻辑时钟；墙钟时间戳只是元数据，绝不变体。账本以 `{loopId, round, nodeIndex, attempt}` 为键；重放拒绝重复键、无对应 `node-started` 的 attempt、无对应 `node-started` 的结算。其余重放校验镜像 goal 域：revision 连续性、生命周期迁移合法性、schema 合规，在首个损坏事件处响亮失败。

会话日志一次追加一条事件；没有多事件事务。协议因此把结算排在应用裁决的 `loop/change` 之前：评估器已结算而裁决未应用是合法的中间态，resume 会恰好应用一次（对已应用裁决的再次应用被账本键与 compare-and-set 当作重复拒绝）。

损坏的 loop 事件使 loop 访问停在该记录处，而会话本身与所有其他投影正常加载——loop 状态被隔离，不会拖垮会话。分叉只从 `session.header.seedLength ?? 0` 起折叠 loop 事件（[schedule](../../../../packages/schedule/schedule/README.zh.md) 先例），因此分叉不继承运行；驱动器另外只驱动控制会话 id 等于自身会话的运行——两道相互独立的栅栏，防两个会话声称拥有同一 loop。

Activation 是进程局部的且绝不持久化：创建与显式 resume 将其 arm；插件加载、会话启动、flush 失败、pause、完成、blocked、clear 将其 disarm。`./invariant` 伴随包对候选事件应用同样的校验，先于其进入持久日志。

## 状态机

`loop/change` 的相位为 `active | awaiting-human | paused | blocked | complete`，外加 clear 墓碑。允许的迁移：

| 起点 | 动作 | 终点 |
|---|---|---|
| active | `/loop pause` | paused |
| active | checkpoint 提问开启（`checkpoint: node`） | awaiting-human |
| awaiting-human | 人类选择继续 | active |
| awaiting-human | 人类选择暂停，或 `/loop pause` | paused |
| awaiting-human | 人类选择终止，或 `/loop clear` | 墓碑 |
| active | block（`node-failed`、`round-limit`、评估器 `blocked`、`checkpoint-provider-missing`、`durability-failed`、`report-budget`） | blocked |
| active | 评估器 `complete` | complete |
| paused | `/loop resume` | active（已 arm） |
| blocked | `/loop resume` | active（已 arm；见下） |
| complete | — | 终态；替换 = 全新 create |
| 任意 | `/loop clear` | 墓碑（保留历史） |

预算分硬上限与软上限。轮次预算——`roundsStarted` 对 `maxRounds`——是任何动词都不可重置的硬上限：pause、resume、重新 arm 都不改它；`roundsStarted` 无剩余容量时从 `round-limit` 的 resume 以直接错误拒绝，提高上限意味着新运行。节点重试预算——纪元内的 `maxNodeRetries`——是软上限：对 blocked 运行的 `/loop resume` 以新纪元重新 arm，resume 的 change revision 成为新的 `atRevision` 下限，重试预算只统计不低于它的尝试——显式的人类 resume 重新授权失败节点的重试，而账本保留完整尝试历史。

`/loop pause` 先记录变更，再经运行的取消通道取消在飞子代理（subagent 缝的 signal：发布前中止即回滚，发布后取消剩余回合工作）。已结算的尝试保留其结算；被打断的尝试以代码 `paused` 记录 `loop/attempt`，resume 后以下一次尝试继续。

持久化（`ctx.sessions.flush()`）失败以代码 `durability-failed` 阻塞并 disarm——这是带持久记录的错误，绝不是「active 却停滞」的运行。

推进需要三个条件：宿主进程存活、控制会话的 root agent 存活、运行已 arm。浏览器断开本身不改变任何事（agent 活在宿主进程里）；控制 agent 被销毁只 disarm、不改相位——那是 L1→L2 边界而非错误，`/loop status` 会显示已 disarm 的 activation。若销毁发生在 `awaiting-human` 相位，提问随 agent 一起消亡、相位保持，之后的 `/loop resume` 重新 arm 并重新发起提问。

<a id="chain-definition"></a>

## 链定义

链文件是工作区 `loop.yaml`（或 `--chain <file>`），在 `/loop start` 时解析并严格校验；每次失败都是直接的命令错误，校验后的链冻结进第一条 `loop/change` 快照。顶层字段：`objective`（必填）、`exit`（可选自由文本——评估器的退出条件）、`checkpoint`（`none` | `node`，默认 `none`）、`nodes`（非空）、`evaluator`（可选的 `prompt` 覆盖）。节点字段：`role`（必填、唯一）、`cwd`（可选；默认为循环主工作区）、`prompt`（必填）、`output`（可选 JSON Schema）、`inputs`（可选的 `{ session: <sessionId> }` 列表）、`carryOver`（可选的角色名列表，其前一轮报告结转进本节点）。

```yaml
objective: 迭代优化 sim-structural 仿真工具
exit: 标准算例集上 max-error ≤ 0.05 且单算例耗时 ≤ 300 s
checkpoint: none
nodes:
  - role: direct
    cwd: E:\document\project2026-7-9\sim-structural
    inputs:
      - session: 2a5b3a99-114a-4d48-993e-c97b3705077a
    carryOver: [experiment, optimize, configure]
    prompt: |
      读取继承的历史结论与上一轮报告，产出下一轮试验条件与理由。
    output:
      type: object
      properties:
        conditions: { type: object }
        rationale: { type: string }
      required: [conditions, rationale]
  - role: experiment
    cwd: E:\document\project2026-7-9\sim-structural
    prompt: |
      用当前版本工具按给定条件跑试验，产出结构化结果与异常。
    output:
      type: object
      properties:
        results: { type: object }
        anomalies: { type: array, items: { type: string } }
      required: [results, anomalies]
evaluator:
  prompt: |
    对照退出条件裁决：目标是否已达成？给出 decision 与证据。
```

默认交接 schema——节点省略 `output` 时适用——为 `status`（字符串）、`summary`（字符串）、`evidence`（字符串数组）、`nextSteps`（字符串数组）。显式 `output` schema 将其整体替换。节点声明 `inputs` 时，驱动器向生效 schema 注入必填的 `inherited` 数组属性，且结算校验其非空、每项对应一个声明的输入会话——「我从每个输入会话继承了什么」是结算要求，不是建议。注入只发生在声明了 `inputs` 的节点；未声明的节点没有此要求，空或缺失的 `inherited` 均合法。

评估器作为最终节点自动附加到每条链并占据最后一个节点索引：一轮的节点数 = 链节点数 + 1，评估器与普通节点一样结算一条 `loop/node` 事件、同样参与「首个未结算节点」判定，而 `roundsStarted` 随应用裁决的 `loop/change` 落地时递增、不在其结算时递增。顶层 `evaluator.prompt` 覆盖其默认指令，裁决 schema `{ decision: continue | complete | blocked, feedback?, reason? }` 由驱动器固定。退出条件来自 `exit`（存在时），否则评估器对照 objective 裁决。默认链——无 `loop.yaml` 且无 `--chain`——是一个使用默认交接 schema 的工作节点加默认评估器；不存在只由评估器组成的链。

`maxRounds` 默认取部署配置 `defaultMaxRounds`（默认 20，正安全整数）；`--max-rounds` 按运行覆盖。

## 节点执行

驱动器镜像 [goal round driver](../../archived/feature/2026-07-19-same-session-goal-round-driver.md) 的栅栏——fiber 活跃、精确存活 agent、每次推进前 `ctx.sessions.flush()`、每次 await 后 compare-and-set 重查、teardown 安静化——但把同会话的轮次 prompt 换成每节点一次全新子对话，经 [subagent 缝](../../implemented/feature/2026-06-21-subagent-capability-seam.zh.md) 调用 `ctx.subagents.start(provider, { parent: controllingAgent, prompt, outputSchema, cwd, label, signal })`，其中 `cwd` 是该节点的冻结工作区。节点 prompt 携带 objective、轮次号、冻结的角色指令、其链项点名的报告——默认为本轮前序节点，外加 `carryOver` 前一轮报告——开局评估器 feedback（对首节点强制；作为结转项对声明了 `carryOver` 的节点同样可见）、声明的输入会话 id、前序子会话 id、读取范围声明。

provider 在生成侧强制角色的输出 schema；驱动器在结算前二次校验结构化结果。子代理失败或结果无效则不结算：驱动器追加带失败原因的 `loop/attempt`，把失败原因注入重试 prompt 后重试该节点，至多 `maxNodeRetries`（默认 2，部署配置）次（按当前纪元计），随后以代码 `node-failed` 阻塞。轮次耗尽以代码 `round-limit` 阻塞。

每轮的最后一个节点是评估器：一个全新子会话，接收 objective、退出条件、本轮全部已校验报告与开局 feedback、子会话 id，返回固定的裁决 schema。`continue` 使 feedback 成为默认的下一轮结转项——下一轮首节点始终收到它，声明了 `carryOver` 的节点与点名的前一轮报告一起收到它，携带全局约束的 feedback 因此也能到达后续节点；`complete` 完成运行；`blocked` 以评估器给出的原因阻塞。`evaluatorModel` 可让裁判跑在比工作节点更便宜的模型上。

## 交接：精益推送、无损拉取

无冗余、不丢关键信息的诉求以机制强制。推送精益：节点只看到其链项点名的已校验报告——默认为本轮前序节点，外加 `carryOver` 前一轮报告——与评估器 feedback（首节点强制、声明 `carryOver` 者结转可见），受 `maxHandoffChars`（默认 16384；单位为字符——UTF-16 码元，代理对按 2 计、与 JS `String.length` 一致——以使 CJK 报告文本的度量可预期；超限报告按校验失败走重试路径）约束，绝不看原始对话。拉取无损：声明的输入会话 id、前序子会话 id 加 loop 作用域查询工具可按需恢复任何细节，原始材料始终留在会话日志中。必填信息类别是 schema 字段，报告不可能缺失它们还通过结算；声明了 `inputs` 的节点不逐个输入会话报告继承了什么就无法结算；空 `inherited` 仅对未声明的节点合法。交给评估器的聚合量——本轮全部报告加 feedback——受 `maxEvaluatorInputChars`（默认 65536 字符）约束；超限以代码 `report-budget` 阻塞而非截断，且阻塞记录点名轮次、节点、肇事报告与超出字符数，人类据此可修链。

## 跨会话读取

`tool-loop-query` 在 `ctx.tools` 全局注册 `loop_session_search` 与 `loop_session_read`，并在执行器中强制授权：调用会话必须是该运行的控制会话或其后代子会话，且目标会话规范化后的 cwd 必须是运行冻结 `readScopes` 集合的成员或等于调用者自身工作区（精确成员资格，而非子树包含）。范围比较使用 `realpath` 规范化后的值——符号链接已解析、分隔符已归一、大小写不敏感平台已折叠——这与 `tool-session-query` 保守的精确字符串相等是刻意不同的两条规则，各自在各自域内生效。人类在 `/loop start` 时授予 `readScopes` 与 `writeScopes`；这两项授权是对既有授权规则的唯一放宽。注册是静态全局的，不按运行变化：按运行改变模型可见工具集会扰动请求前缀与注册处置；代价是每个组合出的会话多两个 schema；当前运行谱系之外的调用者被执行器拒绝——当前指未被清除，paused、blocked、complete 的运行同样被服务，墓碑才是拒绝边界——且两个工具的描述都明说这一点——仅在当前运行的谱系之内可用，其他任何调用都会被拒绝——以降低模型误调用的概率。并行的跨对话引用提案（`2026-09-18-cross-conversation-reference-preserve-full-key-inject`）演进 `@`-提及快照路径；接力节点经查询工具拉取，后续修订可以让拉取改走其引用形式。

## 人工检查点

`checkpoint: none`（默认）不间断运行。`checkpoint: node` 在每个节点结算后经 [`ctx.userQuestions`](../../../../packages/interaction/user-questions/README.zh.md) 向人类提问，锚定在精确存活的控制 root 上，选项为继续、暂停、终止，对应状态机迁移：继续 → `active`、暂停 → `paused`、终止 → clear 墓碑。提问未决期间运行处于显式 `awaiting-human` 相位——渲染上可见为何无推进，而不是 active 却停滞。等待只暂停推进：agent 保持空闲、命令照常分发、驱动器不持有任何独占段——无人回答的问题只挡住下一个节点，别的什么都不挡。本提案不设超时；`/loop pause` 与 `/loop clear` 经其 signal 中止未决的提问，评估器裁决或子代理失败走普通阻塞路径。provider 缺失时以代码 `checkpoint-provider-missing` 阻塞运行，而不是自动放行。

<a id="recovery"></a>

## 恢复

中断层级固定：**L1**——进程内自动推进（支持；上述三条件）；**L2**——跨进程手动恢复（支持：持久状态重放、activation 绝不持久化、`/loop resume` 重新 arm）；**L3**——跨进程自动恢复（不支持且被排除）。排除 L3 的理由：打开会话重建的是状态，不是花费资源的授权；需要自动重启的自动化在宿主之外以 daemon 形态运行、调用文档化的 resume 入口，其授权在配置 daemon 时给出。

`/loop resume` 重新 arm 并从首个未结算节点继续。`resume` 可选的 `--from <node|role>` 目标会被解析并对照冻结链校验——无效目标是点名有效目标的直接错误——但尚无任何 replay-from-node 续跑接纳它：有效目标同样以点名当前 resume 行为的直接错误应答。replay-from-node 的续跑语义推迟给一份未来提案，其设计草案记录在[实现计划](../../../plans/2026-09-24-cross-session-relay-loop.md)中。在飞子代理从账本恢复：最后一条没有结算或 `loop/attempt` 的 `node-started` 即在飞子代理，其最终助手输出从会话日志重提取并重新校验；输出缺失或无效则重新派发该节点。存在但没有账目记录的子代理——派生兑现与 `node-started` 追加之间崩溃——经 subagent 账本的 `listChildren` 在控制会话上枚举，并告警为已崩溃尝试——从不恢复，也从不写入账目记录。已结算而裁决未应用的评估器是待决迁移；resume 恰好应用一次。跨崩溃的节点执行是 at-least-once；子代理完成与结算之间的重复窗口如实记录，不宣称解决。

## 范围边界

节点在 `writeScopes` 内的各节点工作区执行；跨项目参与既是读取（`readScopes`）也是执行/写入（`writeScopes`）。本提案不向已有会话注入消息：接续原会话内容发生在读取它并报告继承了什么的新子会话里；要「回到原对话」需要单独的会话恢复/注入缝提案。L3 自动恢复被排除（见[恢复](#recovery)）。并行 loop、DAG 节点形态、token 与费用预算、模型侧 loop 创建工具都不在本提案内。

## 备选方案

- **workflow 引擎上的固定链脚本**（推广 [`tool-ralph`](../../../../packages/workflow/tool-ralph/README.zh.md)）——落选：引擎运行是进程局部的、没有持久恢复；loop 状态放工作区文件会绕开会话日志这一持久权威；暂停、恢复、节点检查点要在 jobs 上重新实现。
- **goal 域之上的提示词层链式编排**（`LOOP.md` 加每轮模型自行委派）——落选：结构只存在于提示词中，schema 缺失不是强制；同会话上下文照旧腐化；没有执行器级校验，「精益无损」不可验证。
- **维持 2026-07-16 的否定决策不变**——该 note 否决的是投机的通用 loop 服务；本提案给出具体消费方并收窄范围，因此否定条款被取代而 goal 与 Ralph 策略保持不变。
- **持久化 activation、进程退出后在宿主内自动重启（L3）**——落选：打开会话记录的是状态，不是花费资源的新授权；显式人类 resume 才 arm 续跑，需要自动重启的 daemon 调用 resume 入口、授权在配置 daemon 时给出。
- **时间驱动重复**（Claude Code `/loop 5m` 的等价物）——按决策排除在范围外；会话内提醒归 schedule 族，本运行的轮次随结算推进而非时钟。
- **把 per-node cwd 推迟到第二个消费方**——被需求否决：跨项目接力就是消费方，因此缝获得能力校验的 per-start `cwd`，不再等待。
- **回到原对话（会话注入/恢复缝）**——落选：向存活会话注入与所有权和 activation 冲突；接续发生在读取原会话的全新子会话里，未来的注入缝是独立提案。
- **按运行动态注册查询工具**——落选：按运行变更模型可见工具集会扰动请求前缀与注册处置；静态全局注册加执行器强制的代价是无关会话多两个 schema。
- **长寿命 continuable 子代理之间传递持久消息**——一次性全新子会话加结构化输出以更少的常驻状态承载接力；[continuable 子代理](../../archived/feature/2026-07-21-continuable-background-subagents.md) 保留给后续节点形态。

## 验收标准

- 以 Loader 启动包含四个包的组合，命令发现暴露 `/loop`，并能从校验过的两节点 `loop.yaml`（含评估器覆盖）启动运行。
- 一轮为每个节点结算一条含已校验报告的 `loop/node` 事件，经配置的 provider 以冻结角色 prompt、每节点 cwd、点名报告派生每个子代理，把评估器结算为最后一个节点索引，并以评估器裁决收尾；`/loop` 渲染相位、轮次、节点进度、activation 与最新报告摘要。
- 四类事件的重放严格：损坏记录使 loop 访问停在首个坏事件处，而会话与其他投影正常加载；重复账本键、无对应 `node-started` 的 attempt 与结算被拒绝。
- 持续失败的节点记录 `loop/attempt` 失败、耗尽 `maxNodeRetries`（失败反馈记录在重试 prompt 中）并以 `node-failed` 阻塞；尝试计数与失败原因跨模拟重启存续；轮次耗尽以 `round-limit` 阻塞；`/loop resume` 以新重试纪元重新 arm 被阻塞的运行，而硬上限 `roundsStarted` 绝不重置。
- `checkpoint: node` 配合 stub user-questions provider 暂停等待人类作答——运行渲染为 `awaiting-human`、命令与 agent 不受阻塞、选择继续后回到 `active`；无 provider 时以 `checkpoint-provider-missing` 阻塞；`/loop pause` 与 `/loop clear` 经其 signal 中止未决提问。
- 模拟进程重启后，重开的会话自己不启动任何工作；`/loop resume` 从首个未结算节点继续、重提取在飞子代理的有效输出、恰好应用一次待决评估器裁决、并经 subagent 账本枚举无账目的子代理。
- 链项 `cwd` 不在 `writeScopes` 内则启动失败；派生时再断言拒绝未授权 cwd；`loop_session_search` 与 `loop_session_read` 强制 realpath 规范化的 `readScopes`、拒绝范围外目标、拒绝运行谱系之外的调用者。
- 声明了 `inputs` 的节点在 prompt 中收到输入会话 id，其报告的 `inherited` 字段经结算校验为非空且逐输入会话对应，而未声明 `inputs` 的节点无此要求即可结算；输入会话不在 `readScopes` 内则启动失败。
- 控制会话的分叉不驱动任何运行。
- 聚合轮报告超限以 `report-budget` 阻塞并点名轮次、节点、肇事报告与超出字符数；单份超限报告按校验失败走重试路径。
- 一份 keyless snapshot 通过真实可运行示例记录 `/loop start`、节点接力、交接、评估器完成的组装级 transcript。
- 四个包保持逐文件覆盖率、在存在可信自有关系处注册 `./invariant` 伴随包（两个拥有状态的包），否则携带受 gate 认可的书面省略说明（两个适配器），在 HMR 下证明注册处置，并在同一变更中改写 [Harness 级执行 note](../../implemented/feature/2026-07-16-harness-level-loop.zh.md) 中已过时的「不存在 `packages/loop/` 族」事实。

## 风险

- 跨崩溃的节点执行是 at-least-once：子代理完成与结算之间保留重复窗口，与 schedule 族如实记录自身窗口的方式一致。
- 评估器仍是带证据引用的模型裁决而非机械认证；`complete` 的含义是裁判子代理报告完成。
- 链的编写是人工工作：弱角色 prompt 或宽松输出 schema 能通过校验但降低交接质量，`inherited` 报告纪律依赖模型的诚实。
- 每个控制会话一个当前 loop；并行 loop、DAG 形态、节点扇出缺失。
- `readScopes` 授予读取、`writeScopes` 授予在冻结范围内其他项目工作区的执行与文件写入；两项授权都由人类显式做出，但 `writeScopes` 是更宽的权限。
- per-start `cwd` 扩展触及 subagent 缝：in-process provider 支持，ACP 与远程 provider 需要各自的工作、在此之前对设置它的请求拒绝；`realpath` 规范化存在平台边缘（网络驱动器、大小写敏感卷）。
- 查询工具的静态全局注册让每个组合出的会话付出两个 schema 的 token 成本；运行谱系之外的调用者被拒但仍然可见。
- 驱动要求控制会话的存活 root agent；已加载但非存活的会话在 `/loop resume` 之前是惰性的。
- 仅有轮次、重试、报告大小与评估器输入上限约束投入；token、费用、时钟预算被推迟。
