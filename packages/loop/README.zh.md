---
description: "loop 组地图：由一个控制会话记录的跨会话中继运行领域，面向浏览本组的用户与维护者。"
kind: "package-group"
---

# packages/loop

[English](README.md) | 中文

## 概述

loop 组为每个控制会话记录一次跨会话中继运行。一条冻结的角色节点链跨 Round 中继单一目标：每个节点在自己的工作区内工作，读取链声明的会话，并把通过校验的报告交给下一个节点。持久领域把运行、各轮与节点台账存储为会话事件；派生子会话、组装提示词与调度 Round 属于消费方包。一个会话至多持有一个当前 loop，推进 Round 的权限绝不跨进程边界持久化。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`loop`](loop/README.zh.md) | 每个控制会话一个持久中继 loop：带版本的事件、严格回放折叠、生命周期变更、节点台账 | `ctx.loops` |
| [`loop-chain-driver`](loop-chain-driver/README.zh.md) | 运行链的续行驱动器插件：派生节点子会话、结算报告、检查点、重启后恢复 | —（函数插件） |

-----

<a id="related-documentation"></a>
## 相关文档

- [loop 子系统](../../docs/subsystems/loop.zh.md)——loop 类型、持久的 `loop/*` 事件与生成的服务 API。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-loop)——loop 服务的每个受支持配置字段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

暂无。

</details>
