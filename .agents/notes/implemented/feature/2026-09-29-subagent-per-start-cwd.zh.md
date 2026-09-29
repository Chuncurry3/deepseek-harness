# Agent Note: 为 subagent 指定逐启动的子工作区

Status: implemented

[English](2026-09-29-subagent-per-start-cwd.md) | 中文

## 问题

subagent 子 agent 的工作区派生自委派它的父会话：`childSessionMeta()` 把父会话 header 的 cwd 复制到子会话 header 上，因此每个子 agent 都运行在派生其父级的项目中。必须在另一个项目的工作区中执行的委派无法表达——父会话的工作区早在任何委派发生之前就已固定，而启动请求中没有任何字段可以指明另一个工作区。

驱动该字段的消费方是[跨会话接力循环计划](../../../plans/2026-09-24-cross-session-relay-loop.md)：其链节点在获授的逐节点工作区中执行，因此每次节点启动都必须指明运行授予该节点的工作区，而不是继承控制会话的工作区。

提供方的诚实性是问题的一部分。进程内提供方自行组装子会话，可以直接兑现所请求的工作区；进程外后端通过自己的辅助逻辑解析子工作目录（配置的覆盖值，否则为父会话 cwd），因此在那里兑现逐启动 cwd 是逐后端的工作，而非整个 seam 的事实。一个被进程外提供方静默忽略的字段会错述契约。

## 决策

`SubagentStartRequest` 携带可选的 `cwd`——指明子工作区的绝对路径——`SubagentCapabilities` 携带对应的 `cwdOverride` flag，沿用既有的「每个选项一个 flag」模式（`depthLimit` 对 `maxDepth`、`toolFilter`、`persona`，见[组合控制 note](2026-07-12-subagent-persona-tool-filter-and-depth.zh.md)）。

### 能力契约

一次性启动服务在任何提供方工作之前检查该 flag：在能力表缺少 `cwdOverride` 的提供方上，携带 `cwd` 的 `start()` 以 `UNSUPPORTED_CAPABILITY` 拒绝，发生在描述符解析之前、提供方被调用之前，因此请求绝不会静默降级为父工作区。`spawn-in-process` 与 `fork-in-process` 声明 `true`，因为它们控制子 agent 的创建窗口；进程外后端——ACP、Codex、Claude Code 与 SDK 后端——声明 `cwdOverride: false`（后三者通过 `NO_START_CAPABILITIES`），在实现逐启动工作目录解析之前拒绝携带 `cwd` 的启动。`startContinuable()` 以相同方式校验同一字段；可继续子 agent 由继续执行管理器自行组装，且只有进程内提供方实现 `prepareContinuable`，因此该路径不受提供方 flag 把关。

### 校验纪律

两条启动路径都通过共享的 `assertUsableCwd` 辅助函数校验出现的 `cwd`：必须是绝对路径（相对路径会被重新锚定到 harness 启动目录）、已存在的目录、且可进入——`X_OK`，因为该值在进程外路径上同时充当子进程 cwd，也是子 agent 的工作区标识。一次性路径在能力检查之后、提供方调用之前校验；`startContinuable()` 在预留子标识之前校验，因此被拒绝的启动不留下任何持久痕迹，也不留下任何 agent。

### 子会话携带该授权

`childSessionMeta()` 按请求 `cwd` → 父会话 cwd → 无的顺序解析子会话 header 的 cwd，因此子 agent 在获授的工作区中运行、持久化并冷恢复。恢复经由持久化的子会话 header、通过 `agents.resume()` 流转：恢复后的子 agent 保持其获授的工作区，即使执行恢复的父级运行在别处——没有任何描述符读取方参与恢复。

可继续描述符在 `persona` 和 `toolFilter` 之外记录获授的 `cwd`。它是显式字段，因此加入它是一次刻意修订的 `SUBAGENT_DESCRIPTOR_VERSION` 变更（当前版本为 4），而非隐式附加字段。该记录为枚举与审计持久地指明授权；恢复路径是会话 header，不是描述符。

## 备选方案

**在缺少能力的提供方上静默忽略 `cwd`。** 被拒绝：被接受却被忽略的启动会报告成功，而子 agent 运行在父级的工作区中；一个在 spawn 时重新断言工作区范围的消费方——计划中的接力循环正是如此——将误判子 agent 究竟在哪里执行。seam 的既有模式是在创建子 agent 之前明确拒绝，`cwd` 沿用该模式。

**只从父会话派生子工作区。** 被拒绝：请求省略 `cwd` 时父会话派生仍是回退路径，但作为唯一规则它无法表达跨项目执行——父会话的工作区在创建时即固定，而接力节点的获授工作区由运行的范围授权逐节点选定。

**等第二个消费方出现再加能力。** 被拒绝：接力循环家族是具有固定落地顺序的具体消费方（按计划，Phase B 的 loop 家族包导入 `SubagentStartRequest.cwd`，没有它就无法构建），而能力 flag 让 seam 先行落地的成本对声明 `false` 的提供方为零——它们拒绝而非实现。

## 测试

`packages/subagent/subagent/tests/start-cwd.spec.ts` 覆盖服务级契约：在缺少 `cwdOverride` 的提供方上，携带 `cwd` 的启动在提供方分派之前被拒绝（stub 的 `startCount` 保持为零）；相对路径以 `must be an absolute path` 拒绝，不存在的路径以 `not an accessible directory` 拒绝；绝对且可进入的 cwd 解析出 run 并逐字到达提供方。

`packages/subagent/subagent/tests/child-cwd.spec.ts` 覆盖真实的进程内路径：请求 cwd 优先于父会话工作区，请求省略时适用父级 cwd，`startContinuable` 在任何子 agent 存在之前拒绝相对与不存在的 cwd，可继续描述符与子会话 header 都记录获授的工作区，且在全新上下文中的冷恢复在执行恢复的父级运行于别处时仍恢复获授的工作区。

## 后果

一次委派可以把一个子 agent 指向另一个获授的工作区，而无需新的提供方：字段、flag、校验与持久记录都是 seam 的一部分，计划中的 loop 家族直接在其上构建。

代价在于提供方的诚实性与一次格式版本提升。提供方作者必须准确声明 `cwdOverride`；进程外后端在实现逐启动解析之前拒绝携带 `cwd` 的启动。描述符 payload 严格按当前版本校验，其他版本的 payload 本运行时无法分类——预发布立场——因此这样的子 agent 读取为没有描述符，而不是只有部分描述符。
