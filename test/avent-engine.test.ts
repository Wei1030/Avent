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

  it("registers agy, claude-agent-acp, and codex-acp subscription drivers", () => {
    const registry = new ProviderRegistry(process.cwd());
    const statuses = registry.listProviderStatuses();
    assert.deepEqual(
      statuses.map((s) => s.id),
      ["agy", "claude", "codex"]
    );
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
});
