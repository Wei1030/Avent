import crypto from "node:crypto";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { AventStore } from "./db.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { executeAcpPulse, stripAventStateTag } from "./providers/acp-driver.js";
import { describeToolCall, evaluateToolPermission } from "./permissions.js";
import type {
  ApprovalDecisionPayload,
  ApprovalRequest,
  AttachmentItem,
  AventEvent,
  LiveStreamEvent,
  ProviderId,
  PulseMode,
  QueuedMessage,
  SemanticState,
  SemanticStateCommitDraft,
  TaskRecord,
  TaskRef,
  TranscriptItem,
} from "../shared/types.js";

export function getBudgetForMode(mode: PulseMode): { maxActions: number; netTokenLimit: number } {
  if (mode === "sac") {
    return { maxActions: 1, netTokenLimit: 8000 };
  }
  return { maxActions: 5, netTokenLimit: 14000 };
}

interface PendingApprovalEntry {
  request: ApprovalRequest;
  resolve: (res: { allowed: boolean; provenance?: string; denialMessage?: string }) => void;
}

interface ActivePulseContext {
  taskId: string;
  pulseId: string;
  pulseNumber: number;
  committedState: SemanticState | null;
  abortController: AbortController;
}

export class PulseEngine {
  private store: AventStore;
  private registry: ProviderRegistry;
  private mcpBundlePath: string;
  private aventApiUrl: string;
  private activeByTask = new Map<string, ActivePulseContext>();
  private activeByPulse = new Map<string, ActivePulseContext>();
  private queuedByTask = new Map<string, Array<{ queueItem: QueuedMessage; promptPayload: string }>>();
  private pendingApprovals = new Map<string, PendingApprovalEntry>();
  private listeners = new Set<(ev: LiveStreamEvent) => void>();
  private mockAgentFactory?: (task: TaskRecord, pulseNumber: number) => acp.AgentApp;

  constructor(opts: {
    store: AventStore;
    registry: ProviderRegistry;
    projectRoot: string;
    aventApiUrl: string;
    mockAgentFactory?: (task: TaskRecord, pulseNumber: number) => acp.AgentApp;
  }) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.mcpBundlePath = path.join(opts.projectRoot, "dist", "avent-mcp.mjs");
    this.aventApiUrl = opts.aventApiUrl;
    this.mockAgentFactory = opts.mockAgentFactory;
  }

  public setApiUrl(url: string): void {
    this.aventApiUrl = url;
  }

  public subscribe(fn: (ev: LiveStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public broadcast(ev: LiveStreamEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  public isTaskPulsing(taskId: string): boolean {
    return this.activeByTask.has(taskId);
  }

  public listPendingApprovals(taskId?: string): ApprovalRequest[] {
    const all = [...this.pendingApprovals.values()].map((p) => p.request);
    return taskId ? all.filter((a) => a.taskId === taskId) : all;
  }

  public listQueuedMessages(taskId: string): QueuedMessage[] {
    return (this.queuedByTask.get(taskId) ?? []).map((q) => q.queueItem);
  }

  public removeQueuedMessage(taskId: string, queueId: string): boolean {
    const arr = this.queuedByTask.get(taskId);
    if (!arr) return false;
    const next = arr.filter((q) => q.queueItem.id !== queueId);
    this.queuedByTask.set(taskId, next);
    const t = this.decorateTask(this.store.getTask(taskId));
    if (t) this.broadcast({ type: "task_updated", task: t });
    return next.length !== arr.length;
  }

  public decorateTask(task: TaskRecord | null): TaskRecord | null {
    if (!task) return null;
    return {
      ...task,
      pendingApprovalCount: this.listPendingApprovals(task.id).length,
      queuedMessages: this.listQueuedMessages(task.id),
    };
  }

  public resolveApproval(approvalId: string, payload: ApprovalDecisionPayload): boolean {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return false;
    this.pendingApprovals.delete(approvalId);

    const { request } = entry;
    this.broadcast({
      type: "approval_resolved",
      approvalId,
      taskId: request.taskId,
    });

    // Restore PULSING status if no other approvals pending on this task
    if (this.listPendingApprovals(request.taskId).length === 0) {
      const updated = this.store.updateTaskStatus(request.taskId, "PULSING");
      this.broadcast({ type: "task_updated", task: this.decorateTask(updated)! });
    }

    if (payload.decision === "allow_always") {
      const pattern = (payload.rulePattern || request.suggestedRule).trim();
      if (pattern) {
        this.store.addPermissionRule({
          behavior: "allow",
          rule: pattern,
          scope: payload.ruleScope || "workspace",
          workspaceId: request.workspaceId,
          note: "通过审批面板添加",
        });
      }
      entry.resolve({ allowed: true, provenance: `已允许并记住 (${pattern})` });
      return true;
    }

    if (payload.decision === "allow_once") {
      entry.resolve({ allowed: true, provenance: "人工批准执行" });
      return true;
    }

    entry.resolve({
      allowed: false,
      provenance: "人工拒绝执行",
      denialMessage: payload.denialMessage?.trim() || undefined,
    });
    return true;
  }

  public cancelTaskPulse(taskId: string): boolean {
    // Reject any pending approvals for this task first so awaiting promises unblock cleanly
    for (const [id, entry] of this.pendingApprovals.entries()) {
      if (entry.request.taskId === taskId) {
        this.pendingApprovals.delete(id);
        this.broadcast({ type: "approval_resolved", approvalId: id, taskId });
        entry.resolve({ allowed: false, provenance: "已中断" });
      }
    }
    this.queuedByTask.delete(taskId);
    const active = this.activeByTask.get(taskId);
    if (!active) return false;
    active.abortController.abort();
    return true;
  }

  /**
   * Sends a user message into a task, expanding `/` skills, attachments, and `@任务` references.
   */
  public sendUserMessage(
    taskId: string,
    input: {
      text: string;
      attachments?: AttachmentItem[];
      refs?: TaskRef[];
      interruptCurrent?: boolean;
    }
  ): { task: TaskRecord; queued: boolean } {
    const rawText = input.text.trim();
    const attachments = input.attachments ?? [];
    const refs = input.refs ?? [];

    const taskBefore = this.store.getTask(taskId);
    if (!taskBefore) throw new Error(`Task not found: ${taskId}`);

    const wasDraft = taskBefore.status === "DRAFT";
    const task = wasDraft ? this.store.activateDraftTask(taskId) : taskBefore;

    const enrichedPrompt = this.buildEnrichedEventPayload(task, rawText, attachments, refs);

    if (input.interruptCurrent && this.isTaskPulsing(taskId)) {
      this.cancelTaskPulse(taskId);
    }

    if (this.isTaskPulsing(taskId)) {
      const queueItem: QueuedMessage = {
        id: crypto.randomUUID(),
        text: rawText,
        attachments,
        refs,
        createdAt: new Date().toISOString(),
      };
      const list = this.queuedByTask.get(taskId) ?? [];
      list.push({ queueItem, promptPayload: enrichedPrompt });
      this.queuedByTask.set(taskId, list);
      const decorated = this.decorateTask(this.store.getTask(taskId))!;
      this.broadcast({ type: "task_updated", task: decorated });
      return { task: decorated, queued: true };
    }

    const userItem: TranscriptItem = {
      id: crypto.randomUUID(),
      kind: "user",
      text: rawText,
      attachments,
      refs,
      createdAt: new Date().toISOString(),
    };
    this.upsertAndBroadcastItem(taskId, userItem);

    const ev = this.store.appendEvent(
      taskId,
      wasDraft ? "TASK_CREATED" : "USER_MESSAGE",
      enrichedPrompt
    );
    this.triggerEvent(taskId, ev);
    return { task: this.decorateTask(this.store.getTask(taskId))!, queued: false };
  }

  private buildEnrichedEventPayload(
    task: TaskRecord,
    rawText: string,
    attachments: AttachmentItem[],
    refs: TaskRef[]
  ): string {
    const sections: string[] = [];

    // Expand leading `/skill-name` if matching a known skill
    const slashMatch = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(rawText);
    if (slashMatch) {
      const [, skillName, restArgs] = slashMatch;
      const skills = this.store.listSkills(task.workspaceId);
      const matched = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
      if (matched) {
        sections.push(
          `<invoked_skill name="/${matched.name}">\n${matched.content}\n</invoked_skill>`
        );
        if (restArgs?.trim()) {
          sections.push(`User Arguments:\n${restArgs.trim()}`);
        }
      } else {
        sections.push(rawText);
      }
    } else {
      sections.push(rawText);
    }

    // Inject referenced tasks' distilled SemanticState conclusions (`@任务`)
    if (refs.length > 0) {
      const refBlocks: string[] = [];
      for (const r of refs) {
        const refTask = this.store.getTask(r.taskId);
        if (!refTask) continue;
        const st = refTask.latestState;
        if (st) {
          const facts = st.establishedFacts
            .slice(0, 8)
            .map((f) => `- ${f.fact} (${f.sourcePointer})`)
            .join("\n");
          const changes = st.appliedChanges
            .slice(0, 6)
            .map((c) => `- ${c.filePath}: ${c.summary}`)
            .join("\n");
          refBlocks.push(
            `### Referenced Task: 「${refTask.title}」 (status=${refTask.status}, state=v${st.version})\n` +
              `Summary:\n${st.deliverableSummary}\n` +
              (facts ? `Verified Facts:\n${facts}\n` : "") +
              (changes ? `Applied Changes:\n${changes}\n` : "")
          );
        } else {
          refBlocks.push(
            `### Referenced Task: 「${refTask.title}」\nObjective: ${refTask.originalObjective}`
          );
        }
      }
      if (refBlocks.length > 0) {
        sections.push(`<referenced_tasks>\n${refBlocks.join("\n\n")}\n</referenced_tasks>`);
      }
    }

    // Inject attached file references or pasted snippets
    if (attachments.length > 0) {
      const attLines = attachments.map((a) => {
        if (a.path) {
          return `- Attached File: ${a.path} (${a.meta})`;
        }
        if (a.content && a.kind === "paste") {
          return `- Pasted Snippet (${a.name}):\n\`\`\`\n${a.content.slice(0, 3000)}\n\`\`\``;
        }
        return `- Attachment: ${a.name} (${a.meta})`;
      });
      sections.push(`<attachments>\n${attLines.join("\n")}\n</attachments>`);
    }

    return sections.join("\n\n");
  }

  private upsertAndBroadcastItem(taskId: string, item: TranscriptItem): void {
    this.store.upsertTaskItem(taskId, item);
    this.broadcast({ type: "item_upserted", taskId, item });
  }

  /**
   * Invoked by the built-in Avent MCP server (`avent_commit_state` tool) over localhost IPC.
   */
  public commitStateFromMcp(
    pulseId: string,
    draft: SemanticStateCommitDraft
  ): { version: number; message: string } {
    const ctx = this.activeByPulse.get(pulseId);
    if (!ctx) {
      throw new Error(`No active round found for pulseId=${pulseId}`);
    }
    if (ctx.committedState) {
      return {
        version: ctx.committedState.version,
        message: "State was already committed for this round.",
      };
    }

    const task = this.store.getTask(ctx.taskId);
    if (!task) throw new Error(`Task not found: ${ctx.taskId}`);

    // 1. Apply model-determined taskTitle & taskObjective (respects manual user locks)
    if (draft.taskTitle?.trim() || draft.taskObjective?.trim()) {
      this.store.updateTaskObjectiveAndTitle(ctx.taskId, {
        title: draft.taskTitle,
        objective: draft.taskObjective,
        source: "auto",
      });
    }

    // 2. Directly persist any durable rules/preferences detected by the model
    if (Array.isArray(draft.newDirectives) && draft.newDirectives.length > 0) {
      for (const dir of draft.newDirectives) {
        if (typeof dir === "string" && dir.trim()) {
          this.store.addSteeringDirective(ctx.taskId, dir.trim(), "model");
        }
      }
    }

    const { taskTitle: _tt, taskObjective: _to, newDirectives: _nd, ...stateFields } = draft;

    const prefs = this.store.getPreferences();
    const hasUnverifiedEdits =
      prefs.autoVerifyEdits &&
      stateFields.appliedChanges.length > 0 &&
      stateFields.appliedChanges.some((c) => !c.verified) &&
      stateFields.verificationChecks.length === 0;

    let adjustedDraft = stateFields;
    let message = "Handoff recorded cleanly.";
    if (stateFields.status === "COMPLETED" && hasUnverifiedEdits) {
      adjustedDraft = {
        ...stateFields,
        status: "CONTINUE",
        remainingPlan: [
          "运行构建或测试验证刚刚完成的修改，确认无误后再标记已完成",
          ...stateFields.remainingPlan,
        ],
        immediateNextAction:
          stateFields.immediateNextAction || "对已修改的文件执行测试或类型检查验证",
      };
      message =
        "Note: Unverified file changes detected without verificationChecks; downgraded status to CONTINUE so the next round verifies changes.";
    }

    const saved = this.store.commitSemanticState(
      ctx.taskId,
      ctx.pulseNumber,
      task.providerId,
      task.modelId,
      adjustedDraft
    );
    ctx.committedState = saved;

    this.broadcast({ type: "state_committed", taskId: ctx.taskId, state: saved });
    const updatedTask = this.decorateTask(this.store.getTask(ctx.taskId))!;
    this.broadcast({ type: "task_updated", task: updatedTask });

    return { version: saved.version, message };
  }

  public triggerEvent(taskId: string, event: AventEvent): void {
    this.broadcast({ type: "event_added", taskId, event });
    if (this.activeByTask.has(taskId)) {
      return;
    }
    void this.runPulseLoop(taskId, event);
  }

  private async runPulseLoop(taskId: string, initialEvent: AventEvent): Promise<void> {
    let currentEvent: AventEvent | undefined = initialEvent;
    let burstCount = 0;
    const maxContinues = Math.max(1, this.store.getPreferences().maxAutoContinues || 10);

    while (currentEvent && burstCount < maxContinues) {
      burstCount += 1;
      const task = this.store.getTask(taskId);
      if (!task) return;

      const budget = getBudgetForMode(task.pulseMode);
      const pulse = this.store.createPulse({
        taskId,
        providerId: task.providerId,
        modelId: task.modelId,
        maxActions: budget.maxActions,
        netTokenLimit: budget.netTokenLimit,
      });

      const abortController = new AbortController();
      const ctx: ActivePulseContext = {
        taskId,
        pulseId: pulse.id,
        pulseNumber: pulse.pulseNumber,
        committedState: null,
        abortController,
      };
      this.activeByTask.set(taskId, ctx);
      this.activeByPulse.set(pulse.id, ctx);

      const refreshedTask = this.store.getTask(taskId)!;
      this.broadcast({ type: "task_updated", task: this.decorateTask(refreshedTask)! });
      this.broadcast({
        type: "workspace_updated",
        workspaces: this.store.listWorkspaces(),
      });
      this.broadcast({ type: "pulse_started", taskId, pulse });

      const projectInstructions = this.store.loadCombinedInstructionsForWorkspace(
        refreshedTask.cwd
      );
      const recentUserMessages = refreshedTask.originalObjective.trim()
        ? []
        : this.store.listRecentUserMessages(taskId, 4);
      const workPrompt = buildPulseWorkPrompt(
        refreshedTask,
        currentEvent,
        budget,
        projectInstructions,
        recentUserMessages
      );
      const compactionPrompt = buildPulseCompactionPrompt(refreshedTask);

      // Streaming transcript item state for this round
      const roundStartedMs = Date.now();
      let thoughtItemId: string | null = null;
      let thoughtStartedMs = 0;
      let thoughtText = "";

      let textItemId: string | null = null;
      let rawStreamedAssistant = "";
      const toolItemIds = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();

      const finalizeThoughtIfOpen = () => {
        if (thoughtItemId && thoughtText.trim()) {
          const secs = Math.max(1, Math.round((Date.now() - thoughtStartedMs) / 1000));
          this.upsertAndBroadcastItem(taskId, {
            id: thoughtItemId,
            kind: "thinking",
            text: thoughtText.trim(),
            seconds: secs,
            streaming: false,
            createdAt: new Date(thoughtStartedMs).toISOString(),
          });
        }
      };

      try {
        if (refreshedTask.providerId.startsWith("endpoint:")) {
          throw new Error(
            "当前兼容端点仅保存了模型配置，暂未绑定 ACP 执行驱动；请在底部模型选择器切换至 Google Antigravity / Claude Code / Codex 订阅执行。"
          );
        }
        const userMcpServers = this.store.listMcpServers(refreshedTask.workspaceId);

        const result = await executeAcpPulse(this.registry, {
          taskId,
          pulseId: pulse.id,
          pulseNumber: pulse.pulseNumber,
          cwd: refreshedTask.cwd,
          spillsDir: this.store.spillsDir,
          mcpBundlePath: this.mcpBundlePath,
          aventApiUrl: this.aventApiUrl,
          userMcpServers,
          providerId: refreshedTask.providerId as ProviderId,
          modelId: refreshedTask.modelId,
          thoughtLevel: refreshedTask.thoughtLevel,
          maxActions: budget.maxActions,
          netTokenLimit: budget.netTokenLimit,
          workPrompt,
          compactionPrompt,
          abortSignal: abortController.signal,
          mockAgentApp: this.mockAgentFactory
            ? this.mockAgentFactory(refreshedTask, pulse.pulseNumber)
            : undefined,
          getCommittedState: () => ctx.committedState,
          onFallbackCommit: (draft) => {
            this.commitStateFromMcp(pulse.id, draft);
            return ctx.committedState!;
          },
          onProvidersUpdated: () => {
            this.broadcast({
              type: "providers_updated",
              providers: this.registry.listProviderStatuses(),
            });
          },
          onCheckPermission: async (req) => {
            const latestTask = this.store.getTask(taskId) ?? refreshedTask;
            const rules = this.store.listPermissionRules(latestTask.workspaceId);
            const desc = describeToolCall(req.rawName, req.rawTitle, req.rawInput);
            const evaluated = evaluateToolPermission({
              mode: latestTask.permissionMode,
              rules,
              descriptor: desc,
              rawName: req.rawName,
            });

            if (evaluated.action === "allow") {
              return { allowed: true, provenance: evaluated.provenance };
            }
            if (evaluated.action === "deny") {
              return { allowed: false, provenance: evaluated.provenance };
            }

            // Interactive approval required!
            finalizeThoughtIfOpen();
            const existingTool = toolItemIds.get(req.toolCallId);
            const waitingCard: Extract<TranscriptItem, { kind: "tool" }> = {
              id: existingTool?.id ?? crypto.randomUUID(),
              kind: "tool",
              toolCallId: req.toolCallId,
              tool: desc.toolName,
              detail: desc.displayDetail,
              filePath: desc.filePath,
              status: "waiting",
              provenance: evaluated.provenance,
              createdAt: existingTool?.createdAt ?? new Date().toISOString(),
            };
            toolItemIds.set(req.toolCallId, waitingCard);
            this.upsertAndBroadcastItem(taskId, waitingCard);

            const approval: ApprovalRequest = {
              id: crypto.randomUUID(),
              taskId,
              taskTitle: latestTask.title,
              workspaceId: latestTask.workspaceId,
              toolCallId: req.toolCallId,
              toolName: desc.toolName,
              detail: desc.displayDetail,
              rawInput: req.rawInput,
              risky: desc.isRisky,
              suggestedRule: desc.suggestedRule,
              createdAt: new Date().toISOString(),
            };

            const waitingTask = this.store.updateTaskStatus(taskId, "WAITING_APPROVAL");

            return await new Promise<{
              allowed: boolean;
              provenance?: string;
              denialMessage?: string;
            }>((resolve) => {
              this.pendingApprovals.set(approval.id, { request: approval, resolve });
              this.broadcast({ type: "approval_requested", approval });
              this.broadcast({
                type: "task_updated",
                task: this.decorateTask(waitingTask)!,
              });
            });
          },
          onThoughtDelta: (delta) => {
            if (!thoughtItemId) {
              thoughtItemId = crypto.randomUUID();
              thoughtStartedMs = Date.now();
            }
            thoughtText += delta;
            this.upsertAndBroadcastItem(taskId, {
              id: thoughtItemId,
              kind: "thinking",
              text: thoughtText,
              seconds: Math.max(1, Math.round((Date.now() - thoughtStartedMs) / 1000)),
              streaming: true,
              createdAt: new Date(thoughtStartedMs).toISOString(),
            });
          },
          onToolEvent: (ev) => {
            finalizeThoughtIfOpen();
            // Reset thought block so subsequent thoughts after a tool call form a fresh block
            thoughtItemId = null;
            thoughtText = "";

            const prev = toolItemIds.get(ev.toolCallId);
            const item: Extract<TranscriptItem, { kind: "tool" }> = {
              id: prev?.id ?? crypto.randomUUID(),
              kind: "tool",
              toolCallId: ev.toolCallId,
              tool: ev.tool,
              detail: ev.detail || prev?.detail || "",
              filePath: ev.filePath ?? prev?.filePath,
              status: ev.status,
              provenance: ev.provenance ?? prev?.provenance,
              denialMessage: ev.denialMessage ?? prev?.denialMessage,
              output: ev.output ?? prev?.output,
              createdAt: prev?.createdAt ?? new Date().toISOString(),
            };
            toolItemIds.set(ev.toolCallId, item);
            this.upsertAndBroadcastItem(taskId, item);
          },
          onAssistantDelta: (delta) => {
            finalizeThoughtIfOpen();
            rawStreamedAssistant += delta;
            const visible = stripAventStateTag(rawStreamedAssistant);
            if (!visible) return;
            if (!textItemId) {
              textItemId = crypto.randomUUID();
            }
            this.upsertAndBroadcastItem(taskId, {
              id: textItemId,
              kind: "text",
              text: visible,
              streaming: true,
              createdAt: new Date().toISOString(),
            });
          },
          onTelemetry: (t) => {
            this.store.updatePulseTelemetry(pulse.id, t);
            this.broadcast({
              type: "pulse_telemetry",
              taskId,
              pulseId: pulse.id,
              actionCount: t.actionCount,
              maxActions: budget.maxActions,
              baselineTokens: t.baselineTokens,
              netTokens: t.netTokens,
              netTokenLimit: budget.netTokenLimit,
              peakTotalTokens: t.peakTotalTokens,
            });
          },
          onTrace: (entry) => {
            this.store.appendPulseTrace(taskId, pulse.pulseNumber, entry);
            this.broadcast({
              type: "pulse_trace",
              taskId,
              pulseId: pulse.id,
              entry,
            });
          },
        });

        finalizeThoughtIfOpen();

        // Mark any still-running tool cards as finished
        for (const tItem of toolItemIds.values()) {
          if (tItem.status === "running") {
            this.upsertAndBroadcastItem(taskId, { ...tItem, status: "ok" });
          }
        }

        const cleanVisibleStream = stripAventStateTag(rawStreamedAssistant);
        if (textItemId && cleanVisibleStream) {
          this.upsertAndBroadcastItem(taskId, {
            id: textItemId,
            kind: "text",
            text: cleanVisibleStream,
            streaming: false,
            aborted: abortController.signal.aborted,
            createdAt: new Date().toISOString(),
          });
        } else if (result.committedState.deliverableSummary.trim()) {
          // Ensure user always sees a crisp Markdown deliverable in the conversation!
          this.upsertAndBroadcastItem(taskId, {
            id: textItemId ?? crypto.randomUUID(),
            kind: "text",
            text: result.committedState.deliverableSummary.trim(),
            streaming: false,
            aborted: abortController.signal.aborted,
            createdAt: new Date().toISOString(),
          });
        }

        const donePulse = this.store.finishPulse(pulse.id, {
          status: abortController.signal.aborted ? "CANCELLED" : "COMMITTED",
          sessionClosed: result.sessionClosed,
          resultStateVersion: result.committedState.version,
          deliverableSummary: result.committedState.deliverableSummary,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });

        const elapsedSecs = Math.max(1, Math.round((Date.now() - roundStartedMs) / 1000));
        this.upsertAndBroadcastItem(taskId, {
          id: crypto.randomUUID(),
          kind: "footer",
          turn: pulse.pulseNumber,
          seconds: elapsedSecs,
          toolCalls: result.actionCount,
          tokens: result.netTokens,
          stateVersion: result.committedState.version,
          stopReason: abortController.signal.aborted
            ? "interrupted"
            : result.committedState.status === "CONTINUE"
              ? "阶段小结并继续"
              : result.committedState.status === "COMPLETED"
                ? "已完成"
                : "等待反馈",
          createdAt: new Date().toISOString(),
        });

        this.broadcast({ type: "pulse_finished", taskId, pulse: donePulse });

        this.activeByTask.delete(taskId);
        this.activeByPulse.delete(pulse.id);

        if (abortController.signal.aborted) {
          const cancelledTask = this.store.updateTaskStatus(taskId, "WAITING_HUMAN");
          this.broadcast({ type: "task_updated", task: this.decorateTask(cancelledTask)! });
          this.broadcast({ type: "workspace_updated", workspaces: this.store.listWorkspaces() });
          return;
        }

        // Priority 1: Dequeue next user message if the user sent one while running
        const queue = this.queuedByTask.get(taskId);
        if (queue && queue.length > 0) {
          const next = queue.shift()!;
          if (queue.length === 0) this.queuedByTask.delete(taskId);
          this.upsertAndBroadcastItem(taskId, {
            id: crypto.randomUUID(),
            kind: "user",
            text: next.queueItem.text,
            attachments: next.queueItem.attachments,
            refs: next.queueItem.refs,
            createdAt: new Date().toISOString(),
          });
          currentEvent = this.store.appendEvent(taskId, "USER_MESSAGE", next.promptPayload);
          this.broadcast({ type: "event_added", taskId, event: currentEvent });
          continue;
        }

        // Priority 2: Autonomous continuation when SemanticState indicates `CONTINUE`
        if (result.committedState.status === "CONTINUE") {
          currentEvent = this.store.appendEvent(
            taskId,
            "PULSE_CONTINUE",
            result.committedState.immediateNextAction || "继续执行剩余计划"
          );
          this.broadcast({ type: "event_added", taskId, event: currentEvent });
          continue;
        }

        currentEvent = undefined;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finalizeThoughtIfOpen();
        this.upsertAndBroadcastItem(taskId, {
          id: crypto.randomUUID(),
          kind: "notice",
          tone: "warn",
          text: abortController.signal.aborted
            ? "已停止当前执行轮次。"
            : `执行中断：${message}`,
          createdAt: new Date().toISOString(),
        });

        const failedPulse = this.store.finishPulse(pulse.id, {
          status: abortController.signal.aborted ? "CANCELLED" : "FAILED",
          sessionClosed: true,
          resultStateVersion: ctx.committedState?.version ?? null,
          deliverableSummary: ctx.committedState?.deliverableSummary ?? "",
          errorMessage: message,
        });
        this.activeByTask.delete(taskId);
        this.activeByPulse.delete(pulse.id);

        const updatedTask = this.store.updateTaskStatus(
          taskId,
          abortController.signal.aborted ? "WAITING_HUMAN" : "FAILED"
        );
        this.broadcast({ type: "pulse_finished", taskId, pulse: failedPulse });
        this.broadcast({ type: "task_updated", task: this.decorateTask(updatedTask)! });
        this.broadcast({ type: "workspace_updated", workspaces: this.store.listWorkspaces() });
        return;
      }
    }

    const finalTask = this.store.getTask(taskId);
    if (finalTask && finalTask.status === "PULSING") {
      const paused = this.store.updateTaskStatus(taskId, "WAITING_HUMAN");
      this.broadcast({ type: "task_updated", task: this.decorateTask(paused)! });
    }
    this.broadcast({ type: "workspace_updated", workspaces: this.store.listWorkspaces() });
  }
}

function buildPulseWorkPrompt(
  task: TaskRecord,
  event: AventEvent,
  budget: { maxActions: number; netTokenLimit: number },
  projectInstructions: string,
  recentUserMessages: string[] = []
): string {
  const steeringBlock =
    task.steeringDirectives.length > 0
      ? task.steeringDirectives
          .map((d, idx) => `${idx + 1}. ${d.directive}`)
          .join("\n")
      : "(None)";

  const stateBlock = task.latestState
    ? JSON.stringify(
        {
          version: task.latestState.version,
          lastDeliverableSummary: task.latestState.deliverableSummary,
          establishedFacts: task.latestState.establishedFacts,
          openHypotheses: task.latestState.openHypotheses,
          appliedChanges: task.latestState.appliedChanges,
          verificationChecks: task.latestState.verificationChecks,
          deadEnds: task.latestState.deadEnds,
          remainingPlan: task.latestState.remainingPlan,
          immediateNextAction: task.latestState.immediateNextAction,
        },
        null,
        2
      )
    : "Initial round (v0): No prior state exists yet.";

  const instructionsSection = projectInstructions
    ? `\n<project_instructions>\n${projectInstructions}\n</project_instructions>\n`
    : "";

  const hasObjective = task.originalObjective.trim().length > 0;
  const objectiveSection = hasObjective
    ? `<task_objective status="confirmed" source="${task.objectiveSource}">
Task Title: ${task.title}
Working Directory: ${task.cwd}

Confirmed Objective:
${task.originalObjective}

Completion Criteria:
${task.completionCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
</task_objective>`
    : `<task_objective status="undecided">
Task Title: ${task.title}
Working Directory: ${task.cwd}

Objective Status: UNDECIDED (待明确) — No concrete task goal has been established yet.${
        recentUserMessages.length > 0
          ? `\nRecent User Messages:\n${recentUserMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
          : ""
      }
</task_objective>`;

  return `You are operating inside **Avent**, a task-oriented engineering workbench powered by bounded context resets and structured Task State Memory (arXiv:2611.05306v1).
Raw chat logs are NOT carried across execution rounds. Everything that persists is in \`<task_objective>\`, \`<persistent_directives>\`, and \`<current_task_state>\` below.
${instructionsSection}
${objectiveSection}

<persistent_directives>
${steeringBlock}
</persistent_directives>

<current_task_state>
${stateBlock}
</current_task_state>

<current_request type="${event.type}" timestamp="${event.createdAt}">
${event.payload}
</current_request>

<execution_guidelines>
1. **Bounded Actions & Selective Reading**: Take at most **${budget.maxActions}** external tool call(s) in this round. Prefer \`avent_doc_grep\` and \`avent_doc_read\` for large files, and \`avent_history_grep\` if you ever need raw logs from an earlier round.
2. **Respect Excluded Dead-Ends**: Do NOT repeat approaches listed in \`deadEnds\`. Separate verified facts (\`establishedFacts\` with exact \`path#Lstart-Lend\` pointers) from unverified \`openHypotheses\`.
3. **Natural User Communication**: Write clear, natural responses in the user's language. NEVER mention internal implementation jargon such as "pulse", "micro-session", "SSSM", or "watermark" to the user.
4. **Task Title, Objective & Durable Directives (Automatic State Maintenance)**:
   - **\`taskTitle\` & \`taskObjective\`**:
     - If \`<task_objective>\` is \`undecided\` AND the user only sent a greeting or small talk (e.g. "你好", "hi", "在吗") without stating a concrete task, **LEAVE \`taskObjective\` OMITTED/EMPTY** so it stays undecided, reply warmly, and set \`status = "WAITING_HUMAN"\`.
     - As soon as the user expresses a concrete engineering/analysis goal, distill a concise \`taskTitle\` (6–24 chars) and clear \`taskObjective\` in \`avent_commit_state\`.
     - If \`<task_objective>\` is already confirmed and the user explicitly expands or pivots scope, you may refine \`taskObjective\` (Avent automatically preserves user-locked edits).
   - **\`newDirectives\`**: Whenever the user expresses a durable preference, constraint, or standing rule for this task (e.g. "不要动迁移文件", "始终使用中文回复", "用 npm.cmd 执行命令"), include it directly in \`newDirectives\` in \`avent_commit_state\` — no need to ask permission first (the user can delete any directive in one click). Do NOT repeat rules already listed in \`<persistent_directives>\`.
5. **Completion & State Commit**:
   - Write your helpful response for the user, and before ending your turn call \`avent_commit_state\` (from the \`avent\` MCP server):
     - \`status = "COMPLETED"\` when the user's concrete task/request is satisfied and any code edits are verified.
     - \`status = "WAITING_HUMAN"\` when you answered a greeting/question and await follow-up, or need user clarification.
     - \`status = "CONTINUE"\` when autonomous steps remain beyond this ${budget.maxActions}-action round; fill \`remainingPlan\` and \`immediateNextAction\`.
   - Once \`avent_commit_state\` succeeds, stop calling tools and end your turn immediately.
</execution_guidelines>`;
}

function buildPulseCompactionPrompt(task: TaskRecord): string {
  return `External workspace tools are now paused for this round so your progress on "${task.title}" can be saved into Task State Memory.
Call the MCP tool \`avent_commit_state\` RIGHT NOW (do NOT call bash, file, or search tools):
1. \`status\`: "COMPLETED" if satisfied, "WAITING_HUMAN" if awaiting user follow-up/decision, or "CONTINUE" if more autonomous steps remain.
2. \`taskTitle\` & \`taskObjective\`: Set concise title and distilled objective if a concrete goal is clear (leave \`taskObjective\` empty if user only sent a greeting without a concrete goal).
3. \`newDirectives\`: Any NEW durable user constraints/preferences expressed in this turn that are not yet in \`<persistent_directives>\`.
4. \`deliverableSummary\`: Clean, natural response or progress summary for the user (in the user's language; do NOT use internal terms like pulse/micro-session/SSSM).
5. \`establishedFacts\`: Verified observations with exact \`file#line\` pointers.
6. \`appliedChanges\` & \`verificationChecks\`: Modified files and check outcomes.
7. \`deadEnds\`: Approaches ruled out.
8. \`remainingPlan\` & \`immediateNextAction\`: Remaining steps and exact next action if status="CONTINUE".

(Fallback only if \`avent_commit_state\` is unreachable: output \`<avent_state>{ ...valid JSON... }</avent_state>\`.)`;
}
