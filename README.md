# Avent

**Event-driven, sessionless agents.**

Avent 是一个基于论文 [arXiv:2611.05306v1 — *You don't need long context*](https://arxiv.org/abs/2611.05306v1)（Semantic State Space Models / EoCC / SAC / Selective Reading）构建的**无会话（Sessionless）智能体运行时**，并通过标准 **ACP（Agent Client Protocol）** 统一调度多家订阅客户端。

---

## 核心特性

- **零长会话驻留（Sessionless Pulses）**：没有持续膨胀的对话历史。每次事件唤醒一个干净的微脉冲（Pulse），执行受控步数并提交结构化 `SemanticState` 后，立即调用 `session/close` 物理销毁底层会话，KV Cache 彻底归零。
- **SSSM 演进式语义状态与防漂移账本**：严格区分“不可变目标与人类持久约束（Immutable Objective & Steering）”与“可演进状态简报（已验证事实、待验证猜想、变更与验证、死胡同清单、下一步动作）”。
- **选择性读取与 Spill 上下文防火墙**：内置 `avent` MCP Server（`avent_commit_state`、`avent_doc_read`、`avent_doc_grep`、`avent_history_grep`）与 ACP 文件/终端截断代理（单次读取 ≤ 6000 字符，超长自动落盘 `.avent/spills/`）。
- **跨订阅热切换接力**：
  - **Google AI Pro / Ultra**：原生驱动 `agy acp`（默认 `Gemini 4 Carbon` High，已实测通过）
  - **Anthropic Claude Pro / Max**：内置 `@agentclientprotocol/claude-agent-acp` 驱动
  - **OpenAI ChatGPT Plus / Pro**：内置 `@agentclientprotocol/codex-acp` 驱动

---

## 快速启动

```powershell
# 1. 安装依赖（需 Node.js >= 22.5，推荐 Node.js 24+）
npm.cmd install

# 2. 构建前端与内置 MCP 并启动本地工作台
npm.cmd start
```

浏览器打开 **`http://localhost:4320`** 即可创建任务并实时观察脉冲接力与语义状态演进。

## 运行测试

```powershell
npm.cmd run typecheck
npm.cmd test
```
