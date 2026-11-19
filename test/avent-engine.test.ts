import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { AventStore } from "../src/server/db.js";
import { ProviderRegistry } from "../src/server/providers/registry.js";
import { PulseEngine } from "../src/server/pulse-engine.js";
import { describeToolCall, evaluateToolPermission } from "../src/server/permissions.js";
import {
  boundedDocRead,
  searchPulseHistory,
  spillIfOversized,
  surgicalGrep,
} from "../src/server/selective-io.js";

describe("Avent Sessionless Workbench & SSSM Runtime", () => {
  it("spills oversized reads (>6000 chars) and supports bounded selective reading & history grep", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "avent-io-"));
    const store = new AventStore(path.join(tmpDir, ".avent"), tmpDir);
    try {
      const bigContent = Array.from(
        { length: 400 },
        (_, i) => `Line ${i + 1}: token_payload_${"x".repeat(25)}`
      ).join("\n");
      const bigFile = path.join(tmpDir, "huge.txt");
      writeFileSync(bigFile, bigContent, "utf8");

      const spilled = spillIfOversized({
        spillsDir: store.spillsDir,
        taskId: "task-1",
        label: "huge.txt",
        content: bigContent,
      });
      assert.equal(spilled.truncated, true);
      assert.ok(spilled.spilledPath);
      assert.ok(spilled.text.includes("AVENT CONTEXT FIREWALL"));

      const windowRead = boundedDocRead({
        cwd: tmpDir,
        filePath: "huge.txt",
        startLine: 10,
        endLine: 15,
      });
      assert.ok(windowRead.includes("10: Line 10:"));
      assert.ok(windowRead.includes("15: Line 15:"));
      assert.ok(!windowRead.includes("16: Line 16:"));

      const grepOut = surgicalGrep({
        cwd: tmpDir,
        pattern: "Line 250:",
        targetPath: "huge.txt",
      });
      assert.ok(grepOut.includes("250"));

      store.appendPulseTrace("task-1", 1, {
        timestamp: new Date().toISOString(),
        kind: "tool",
        summary: "secret_coin_toss_17=HEADS",
      });
      const histOut = searchPulseHistory({
        archiveDir: store.archiveDir,
        taskId: "task-1",
        query: "secret_coin_toss_17",
      });
      assert.ok(histOut.includes("HEADS"));
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("registers agy, claude-agent-acp, and codex-acp with zero hardcoded fallback models when unprobed, and supports editable compatible endpoints", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "avent-ep-"));
    const store = new AventStore(path.join(tmpDir, ".avent"), tmpDir);
    try {
      const registry = new ProviderRegistry(process.cwd(), store);
      const statuses = registry.listProviderStatuses();
      assert.deepEqual(
        statuses.map((s) => s.id),
        ["agy", "claude", "codex"]
      );
      // Zero hardcoded fallback models or thought levels before live ACP probe!
      for (const st of statuses) {
        assert.deepEqual(st.models, []);
        assert.deepEqual(st.thoughtLevels, []);
      }

      // Compatible endpoint inline CRUD + per-model thinkingMode + secret isolation
      const ep = store.addCompatibleEndpoint({
        name: "My Gateway",
        protocol: "anthropic",
        baseUrl: "https://gateway.example.com",
        apiKey: "sk-secret-1234567890",
        models: [{ id: "deepseek-chat", thinkingMode: "none" }],
      });
      assert.equal(ep.apiKeySet, true);
      assert.equal(ep.apiKeyHint, "sk-s••••7890");
      assert.equal("apiKey" in ep, false);

      const updated = store.updateCompatibleEndpoint(ep.id, {
        models: [
          { id: "deepseek-chat", thinkingMode: "none" },
          { id: "deepseek-reasoner", thinkingMode: "extended" },
        ],
      })!;
      assert.equal(updated.models.length, 2);
      assert.equal(updated.models[1].thinkingMode, "extended");

      const secret = store.getCompatibleEndpointSecret(ep.id)!;
      assert.equal(secret.apiKey, "sk-secret-1234567890");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("evaluates allow/ask/deny permission rules in strict precedence order", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "avent-perm-"));
    const store = new AventStore(path.join(tmpDir, ".avent"), tmpDir);
    try {
      const ws = store.listWorkspaces()[0];
      store.addPermissionRule({
        behavior: "deny",
        rule: "Bash(rm -rf *)",
        scope: "workspace",
        workspaceId: ws.id,
      });
      store.addPermissionRule({
        behavior: "allow",
        rule: "Bash(npm.cmd run build*)",
        scope: "workspace",
        workspaceId: ws.id,
      });

      const rules = store.listPermissionRules(ws.id);

      const dangerous = describeToolCall("Bash", "rm -rf dist", { command: "rm -rf dist" });
      const resDeny = evaluateToolPermission({
        mode: "bypassPermissions",
        rules,
        descriptor: dangerous,
        rawName: "Bash",
      });
      assert.equal(resDeny.action, "deny");

      const allowedBuild = describeToolCall("Bash", "npm.cmd run build:web", {
        command: "npm.cmd run build:web",
      });
      const resAllow = evaluateToolPermission({
        mode: "default",
        rules,
        descriptor: allowedBuild,
        rawName: "Bash",
      });
      assert.equal(resAllow.action, "allow");

      const unknownCmd = describeToolCall("Bash", "python deploy.py", {
        command: "python deploy.py",
      });
      const resAsk = evaluateToolPermission({
        mode: "acceptEdits",
        rules,
        descriptor: unknownCmd,
        rawName: "Bash",
      });
      assert.equal(resAsk.action, "ask");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("relays SemanticState across rounds, supports interactive approval & @task refs, and records usage", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "avent-pulse-"));
    const store = new AventStore(path.join(tmpDir, ".avent"), tmpDir);
    try {
      const registry = new ProviderRegistry(process.cwd());
      const closedSessions: string[] = [];
      const seenPrompts: string[] = [];

      const engine = new PulseEngine({
        store,
        registry,
        projectRoot: process.cwd(),
        aventApiUrl: "http://127.0.0.1:0",
        mockAgentFactory: (_task, pulseNumber) => {
          return acp
            .agent({ name: `mock-agent-p${pulseNumber}` })
            .onRequest(acp.methods.agent.initialize, async () => ({
              protocolVersion: acp.PROTOCOL_VERSION,
              agentCapabilities: {
                sessionCapabilities: { close: {} },
              },
              agentInfo: { name: "mock-acp", version: "1.0.0" },
            }))
            .onRequest(acp.methods.agent.session.new, async () => ({
              sessionId: `ephemeral-session-${pulseNumber}`,
            }))
            .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
              const promptText =
                ctx.params.prompt[0]?.type === "text" ? ctx.params.prompt[0].text : "";
              seenPrompts.push(promptText);

              if (pulseNumber === 1) {
                // Request interactive permission for a shell command
                const permRes = await ctx.client.request(
                  acp.methods.client.session.requestPermission,
                  {
                    sessionId: ctx.params.sessionId,
                    toolCall: {
                      toolCallId: "tc-custom-1",
                      name: "Bash",
                      title: "node check-port.js",
                      rawInput: { command: "node check-port.js" },
                    },
                    options: [
                      { optionId: "allow", name: "Allow", kind: "allow_once" },
                      { optionId: "reject", name: "Reject", kind: "reject_once" },
                    ],
                  }
                );
                assert.equal(permRes.outcome.outcome, "selected");
              }

              const stateJson =
                pulseNumber === 1
                  ? {
                      status: "CONTINUE",
                      deliverableSummary: "已完成代码扫描，定位到默认端口配置。",
                      establishedFacts: [
                        {
                          fact: "端口定义在 index.ts",
                          sourcePointer: "src/server/index.ts#L45",
                        },
                      ],
                      openHypotheses: [],
                      appliedChanges: [],
                      verificationChecks: [],
                      deadEnds: [{ approach: "全局环境变量硬编码", reasonFailed: "不支持多实例" }],
                      remainingPlan: ["完成最终结论确认"],
                      immediateNextAction: "验证端口配置并输出最终报告",
                    }
                  : {
                      status: "COMPLETED",
                      deliverableSummary: "已基于状态记忆 v1 完成全部验证！",
                      establishedFacts: [
                        {
                          fact: "端口定义在 index.ts",
                          sourcePointer: "src/server/index.ts#L45",
                        },
                        {
                          fact: "默认端口为 4320",
                          sourcePointer: "src/server/index.ts#L45",
                        },
                      ],
                      openHypotheses: [],
                      appliedChanges: [],
                      verificationChecks: [
                        {
                          command: "tsc --noEmit",
                          outcome: "PASS",
                          keyOutputOrPointer: "0 errors",
                        },
                      ],
                      deadEnds: [{ approach: "全局环境变量硬编码", reasonFailed: "不支持多实例" }],
                      remainingPlan: [],
                      immediateNextAction: "",
                    };

              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: `${stateJson.deliverableSummary}\n<avent_state>${JSON.stringify(stateJson)}</avent_state>`,
                  },
                },
              });
              return { stopReason: "end_turn" };
            })
            .onRequest(acp.methods.agent.session.close, async (ctx) => {
              closedSessions.push(ctx.params.sessionId);
              return {};
            });
        },
      });

      const task = store.createTask({
        cwd: tmpDir,
        providerId: "agy",
        modelId: "gemini-4-carbon",
        thoughtLevel: "high",
        permissionMode: "default",
        draft: true,
      });
      assert.equal(task.status, "DRAFT");

      // Auto-approve when `approval_requested` fires!
      const completedPromise = new Promise<void>((resolve) => {
        const unsub = engine.subscribe((liveEv) => {
          if (liveEv.type === "approval_requested") {
            engine.resolveApproval(liveEv.approval.id, {
              decision: "allow_always",
              rulePattern: "Bash(node check-port*)",
              ruleScope: "workspace",
            });
          }
          if (liveEv.type === "pulse_finished" && liveEv.pulse.pulseNumber === 2) {
            unsub();
            setTimeout(resolve, 25);
          }
        });
      });

      engine.sendUserMessage(task.id, { text: "扫描端口配置并验证构建" });
      await completedPromise;

      const finalTask = store.getTask(task.id)!;
      assert.equal(finalTask.status, "COMPLETED");
      assert.equal(finalTask.currentVersion, 2);
      assert.equal(finalTask.pulseCount, 2);
      assert.deepEqual(closedSessions, ["ephemeral-session-1", "ephemeral-session-2"]);

      // Verify clean transcript items (no `<avent_state>` leaked!)
      const items = store.listTaskItems(task.id);
      assert.ok(items.some((i) => i.kind === "user" && i.text === "扫描端口配置并验证构建"));
      const textItems = items.filter((i) => i.kind === "text");
      assert.ok(textItems.length >= 2);
      assert.ok(
        textItems.every((i) => i.kind === "text" && !i.text.includes("<avent_state>"))
      );

      // Verify usage ledger recorded tokens
      const usage = store.getUsageReport("7d");
      assert.ok(usage.totals.totalTokens > 0);
      assert.equal(usage.totals.turnCount, 2);

      // Verify `@任务` cross-task reference injects distilled SemanticState into Task #2!
      const task2 = store.createTask({
        cwd: tmpDir,
        providerId: "agy",
        modelId: "gemini-4-carbon",
        thoughtLevel: "high",
        permissionMode: "bypassPermissions",
        draft: true,
      });

      const task2Done = new Promise<void>((resolve) => {
        const unsub = engine.subscribe((ev) => {
          if (ev.type === "pulse_finished" && ev.taskId === task2.id && ev.pulse.pulseNumber === 2) {
            unsub();
            setTimeout(resolve, 25);
          }
        });
      });

      engine.sendUserMessage(task2.id, {
        text: "请结合刚才端口排查的结果写一份简报",
        refs: [{ taskId: task.id, title: finalTask.title }],
      });
      await task2Done;

      const task2FirstPrompt = seenPrompts[2];
      assert.ok(task2FirstPrompt.includes("<referenced_tasks>"));
      assert.ok(task2FirstPrompt.includes("默认端口为 4320"));
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("keeps objective undecided on greeting, lets model set title/objective & auto-add directives, and persists per-model thoughtLevels", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "avent-meta-"));
    const dbDir = path.join(tmpDir, ".avent");
    const store = new AventStore(dbDir, tmpDir);
    try {
      // 1. Verify persisted provider capabilities with per-model thoughtLevels survive reload
      store.saveProviderCapabilities({
        providerId: "agy",
        tierName: "Google AI Ultra",
        defaultModel: "gemini-4-neon",
        defaultThoughtLevel: "high",
        probedAt: new Date().toISOString(),
        models: [
          {
            value: "gemini-4-neon",
            name: "Gemini 4 Neon",
            thoughtLevels: [
              { value: "low", name: "低 (Low)" },
              { value: "high", name: "高 (High)" },
              { value: "xhigh", name: "极高 (Extra)" },
            ],
            defaultThoughtLevel: "high",
          },
          {
            value: "gemini-pro-orchestrator-neon",
            name: "Orchestrator (Neon)",
            thoughtLevels: [],
          },
        ],
      });

      const reloadedRegistry = new ProviderRegistry(process.cwd(), store);
      const agyStatus = reloadedRegistry.listProviderStatuses().find((p) => p.id === "agy")!;
      assert.equal(agyStatus.tierName, "Google AI Ultra");
      assert.equal(agyStatus.defaultModel, "gemini-4-neon");
      const neon = agyStatus.models.find((m) => m.value === "gemini-4-neon")!;
      assert.ok(neon.thoughtLevels?.some((l) => l.value === "xhigh"));
      const orch = agyStatus.models.find((m) => m.value === "gemini-pro-orchestrator-neon")!;
      assert.deepEqual(orch.thoughtLevels, []);

      // 2. Verify undecided objective on greeting -> model sets title/objective & newDirectives on Turn 2
      const seenPrompts: string[] = [];
      const engine = new PulseEngine({
        store,
        registry: reloadedRegistry,
        projectRoot: process.cwd(),
        aventApiUrl: "http://127.0.0.1:0",
        mockAgentFactory: (_task, pulseNumber) =>
          acp
            .agent({ name: `mock-meta-${pulseNumber}` })
            .onRequest(acp.methods.agent.initialize, async () => ({
              protocolVersion: acp.PROTOCOL_VERSION,
              agentCapabilities: { sessionCapabilities: { close: {} } },
              agentInfo: { name: "mock-acp", version: "1.0.0" },
            }))
            .onRequest(acp.methods.agent.session.new, async () => ({
              sessionId: `sess-meta-${pulseNumber}`,
            }))
            .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
              const promptText =
                ctx.params.prompt[0]?.type === "text" ? ctx.params.prompt[0].text : "";
              seenPrompts.push(promptText);

              const statePayload =
                pulseNumber === 1
                  ? {
                      status: "WAITING_HUMAN",
                      deliverableSummary: "你好！请问今天想一起处理什么任务？",
                      establishedFacts: [],
                      openHypotheses: [],
                      appliedChanges: [],
                      verificationChecks: [],
                      deadEnds: [],
                      remainingPlan: [],
                      immediateNextAction: "",
                    }
                  : pulseNumber === 2
                    ? {
                        status: "WAITING_HUMAN",
                        taskTitle: "调整登录会话超时配置",
                        taskObjective: "将登录超时修改为 30 分钟并补充单测",
                        newDirectives: ["不要修改数据库迁移文件", "始终使用 npm.cmd 运行测试"],
                        deliverableSummary: "明白，我已记录目标与约定，接下来开始排查配置。",
                        establishedFacts: [],
                        openHypotheses: [],
                        appliedChanges: [],
                        verificationChecks: [],
                        deadEnds: [],
                        remainingPlan: [],
                        immediateNextAction: "",
                      }
                    : {
                        status: "COMPLETED",
                        taskTitle: "尝试覆盖用户标题",
                        taskObjective: "尝试覆盖用户锁定的目标",
                        newDirectives: ["始终使用 npm.cmd 运行测试"], // duplicate should be ignored
                        deliverableSummary: "已完成！",
                        establishedFacts: [],
                        openHypotheses: [],
                        appliedChanges: [],
                        verificationChecks: [],
                        deadEnds: [],
                        remainingPlan: [],
                        immediateNextAction: "",
                      };

              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: `<avent_state>${JSON.stringify(statePayload)}</avent_state>`,
                  },
                },
              });
              return { stopReason: "end_turn" };
            })
            .onRequest(acp.methods.agent.session.close, async () => ({})),
      });

      const task = store.createTask({
        cwd: tmpDir,
        providerId: "agy",
        modelId: "gemini-4-neon",
        thoughtLevel: "xhigh",
        permissionMode: "bypassPermissions",
        draft: true,
      });

      const waitForPulse = (num: number) =>
        new Promise<void>((resolve) => {
          const unsub = engine.subscribe((ev) => {
            if (ev.type === "pulse_finished" && ev.taskId === task.id && ev.pulse.pulseNumber === num) {
              unsub();
              setTimeout(resolve, 20);
            }
          });
        });

      // Turn 1: User greets with "你好" -> objective MUST stay undecided!
      const p1 = waitForPulse(1);
      engine.sendUserMessage(task.id, { text: "你好" });
      await p1;

      const afterGreeting = store.getTask(task.id)!;
      assert.equal(afterGreeting.originalObjective, "");
      assert.equal(afterGreeting.title, "新任务");
      assert.ok(seenPrompts[0].includes('status="undecided"'));

      // Turn 2: User states concrete task + durable constraints -> model sets title, objective & newDirectives
      const p2 = waitForPulse(2);
      engine.sendUserMessage(task.id, {
        text: "帮我把登录超时改成 30 分钟并补单测。注意不要动迁移文件，始终用 npm.cmd 跑测试。",
      });
      await p2;

      const afterTurn2 = store.getTask(task.id)!;
      assert.equal(afterTurn2.title, "调整登录会话超时配置");
      assert.equal(afterTurn2.originalObjective, "将登录超时修改为 30 分钟并补充单测");
      assert.equal(afterTurn2.steeringDirectives.length, 2);
      assert.equal(afterTurn2.steeringDirectives[0].source, "model");

      // User manually locks objective & title -> Turn 3 model attempt to overwrite must be ignored, duplicate directive ignored
      store.updateTaskMeta(task.id, {
        title: "用户手动定名",
        originalObjective: "用户手动锁定的精准目标",
      });

      const p3 = waitForPulse(3);
      engine.sendUserMessage(task.id, { text: "继续完成吧" });
      await p3;

      // Turn 3 prompt must include the model-extracted persistent directives!
      assert.ok(seenPrompts[2].includes("不要修改数据库迁移文件"));
      assert.ok(seenPrompts[2].includes("始终使用 npm.cmd 运行测试"));

      const afterTurn3 = store.getTask(task.id)!;
      assert.equal(afterTurn3.title, "用户手动定名");
      assert.equal(afterTurn3.originalObjective, "用户手动锁定的精准目标");
      assert.equal(afterTurn3.steeringDirectives.length, 2); // deduplicated!
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("cleans orphaned empty DRAFT tasks on startup, honors zero workspaces across restarts, and re-attaches tasks when re-adding a workspace", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "avent-ws-"));
    const dbDir = path.join(tmpDir, ".avent");
    let store = new AventStore(dbDir, tmpDir);
    try {
      const ws = store.listWorkspaces()[0];
      assert.ok(ws);

      // Create 1 empty DRAFT task and 1 active task with a transcript item
      const emptyDraft = store.createTask({
        workspaceId: ws.id,
        cwd: tmpDir,
        providerId: "agy",
        modelId: "gemini-4-neon",
        thoughtLevel: "high",
        draft: true,
      });
      const realTask = store.createTask({
        workspaceId: ws.id,
        cwd: tmpDir,
        providerId: "agy",
        modelId: "gemini-4-neon",
        thoughtLevel: "high",
        draft: false,
        objective: "保留这个真实任务",
      });
      store.upsertTaskItem(realTask.id, {
        id: "item-1",
        kind: "user",
        text: "保留这个真实任务",
        attachments: [],
        refs: [],
        createdAt: new Date().toISOString(),
      });

      // Remove the only workspace -> 0 workspaces
      store.deleteWorkspace(ws.id);
      assert.equal(store.listWorkspaces().length, 0);
      store.close();

      // Re-open store with defaultWorkspacePath: must keep 0 workspaces and purge empty DRAFT
      store = new AventStore(dbDir, tmpDir);
      assert.equal(store.listWorkspaces().length, 0);
      assert.equal(store.getTask(emptyDraft.id), null);
      assert.ok(store.getTask(realTask.id));

      // Re-add the folder -> historical task automatically re-attaches!
      const reAdded = store.addWorkspace(tmpDir);
      assert.equal(store.listWorkspaces().length, 1);
      const reAttached = store.getTask(realTask.id)!;
      assert.equal(reAttached.workspaceId, reAdded.id);
      assert.equal(reAdded.taskCount, 1);

      // No built-in skills by default
      assert.deepEqual(store.listSkills(reAdded.id), []);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
