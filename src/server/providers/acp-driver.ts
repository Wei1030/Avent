import * as acp from "@agentclientprotocol/sdk";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { getEncoding } from "js-tiktoken";
import { spillIfOversized } from "../selective-io.js";
import { describeToolCall } from "../permissions.js";
import { isPathInsideRoot, resolveCanonicalPath } from "../shell-parser.js";
import type { RawClaudeRateLimitInfo } from "../quotas.js";
import type { ProviderLaunchSpec, ProviderRegistry } from "./registry.js";
import type {
  McpServerRecord,
  ProviderId,
  PulseTraceEntry,
  SemanticState,
  SemanticStateCommitDraft,
  TranscriptToolOutput,
} from "../../shared/types.js";

const tokenizer = (() => {
  try {
    return getEncoding("o200k_base");
  } catch {
    return null;
  }
})();

export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (tokenizer) {
    try {
      return tokenizer.encode(text).length;
    } catch {
      // fallback
    }
  }
  return Math.ceil(text.length / 3.5);
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback
    }
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

interface ManagedTerminal {
  id: string;
  proc: ChildProcess;
  output: string;
  truncated: boolean;
  byteLimit: number;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
}

export interface ToolPermissionCheckInput {
  toolCallId: string;
  rawName: string;
  rawTitle: string;
  rawKind?: string | null;
  rawInput?: unknown;
}

export interface ToolPermissionCheckResult {
  allowed: boolean;
  provenance?: string;
  denialMessage?: string;
}

export interface ExecuteAcpPulseInput {
  taskId: string;
  pulseId: string;
  pulseNumber: number;
  cwd: string;
  spillsDir: string;
  mcpBundlePath: string;
  aventApiUrl: string;
  userMcpServers?: McpServerRecord[];
  providerId: ProviderId;
  launchSpecOverride?: ProviderLaunchSpec;
  isCompatibleEndpoint?: boolean;
  modelId: string;
  thoughtLevel: string;
  maxActions: number;
  netTokenLimit: number;
  workPrompt: string;
  compactionPrompt: string;
  getCommittedState: () => SemanticState | null;
  onFallbackCommit: (draft: SemanticStateCommitDraft) => SemanticState;
  onProvidersUpdated?: () => void;
  onRateLimitEvent?: (info: RawClaudeRateLimitInfo) => void;
  onCheckPermission?: (req: ToolPermissionCheckInput) => Promise<ToolPermissionCheckResult>;
  onThoughtDelta?: (delta: string) => void;
  onAssistantDelta?: (delta: string) => void;
  onToolEvent?: (ev: {
    toolCallId: string;
    tool: string;
    detail: string;
    filePath?: string;
    status: "running" | "waiting" | "ok" | "error" | "denied";
    provenance?: string;
    denialMessage?: string;
    output?: TranscriptToolOutput;
  }) => void;
  onTelemetry: (t: {
    actionCount: number;
    baselineTokens: number;
    netTokens: number;
    peakTotalTokens: number;
  }) => void;
  onTrace: (entry: PulseTraceEntry) => void;
  abortSignal?: AbortSignal;
  mockAgentApp?: acp.AgentApp;
}

export interface ExecuteAcpPulseResult {
  sessionClosed: boolean;
  committedState: SemanticState;
  actionCount: number;
  baselineTokens: number;
  netTokens: number;
  peakTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

function isAventCommitTool(nameOrTitle: string): boolean {
  const lower = nameOrTitle.toLowerCase();
  return lower.includes("avent_commit_state") || lower.includes("commit_state");
}

function buildSimpleLineDiff(before: string | null, after: string): string[] {
  if (before === null) {
    const added = after.split(/\r?\n/).slice(0, 60);
    return ["@@ new file @@", ...added.map((l) => `+${l}`)];
  }
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const out: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let diffCount = 0;
  for (let i = 0; i < maxLen && out.length < 80; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (diffCount === 0) out.push(`@@ line ${i + 1} @@`);
    if (o !== undefined) out.push(`-${o}`);
    if (n !== undefined) out.push(`+${n}`);
    diffCount += 1;
  }
  return out;
}

function extractToolOutput(rawOutput: unknown, contentBlocks?: unknown[]): TranscriptToolOutput | undefined {
  if (Array.isArray(contentBlocks)) {
    for (const blk of contentBlocks) {
      if (blk && typeof blk === "object") {
        const b = blk as Record<string, unknown>;
        if (b.type === "diff" && typeof b.newText === "string") {
          const oldTxt = typeof b.oldText === "string" ? b.oldText : null;
          const lines = buildSimpleLineDiff(oldTxt, b.newText);
          if (lines.length > 0) {
            return { type: "diff", lines, filePath: typeof b.path === "string" ? b.path : undefined };
          }
        }
      }
    }
  }

  if (!rawOutput) return undefined;
  const text =
    typeof rawOutput === "string"
      ? rawOutput
      : typeof (rawOutput as Record<string, unknown>).output === "string"
        ? String((rawOutput as Record<string, unknown>).output)
        : typeof (rawOutput as Record<string, unknown>).text === "string"
          ? String((rawOutput as Record<string, unknown>).text)
          : JSON.stringify(rawOutput, null, 2);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return { type: "text", text: trimmed.slice(0, 3200) };
}

export async function executeAcpPulse(
  registry: ProviderRegistry,
  input: ExecuteAcpPulseInput
): Promise<ExecuteAcpPulseResult> {
  let phase: "WORK" | "COMPACTING" = "WORK";
  let budgetExhausted = false;
  let cancelSentForWatermark = false;
  let activeSessionId = "";

  let actionCount = 0;
  let baselineTokens = 0;
  let baselineCaptured = false;
  let estimatedInputTokens = estimateTokens(input.workPrompt);
  let estimatedOutputTokens = 0;
  let reportedUsedTokens = 0;
  let peakTotalTokens = estimatedInputTokens;

  const countedToolCallIds = new Set<string>();
  const toolMetaById = new Map<
    string,
    { tool: string; detail: string; filePath?: string; provenance?: string }
  >();
  const terminals = new Map<string, ManagedTerminal>();
  let collectedAssistantText = "";

  const computeNetTokens = (): number => {
    const est = estimatedInputTokens + estimatedOutputTokens;
    if (reportedUsedTokens > 0 && baselineCaptured) {
      return Math.max(est, Math.max(0, reportedUsedTokens - baselineTokens));
    }
    return est;
  };

  const emitTelemetry = () => {
    const net = computeNetTokens();
    const total = baselineTokens > 0 ? Math.max(peakTotalTokens, baselineTokens + net) : net;
    peakTotalTokens = Math.max(peakTotalTokens, total);
    input.onTelemetry({
      actionCount,
      baselineTokens,
      netTokens: net,
      peakTotalTokens,
    });
  };

  const trace = (kind: PulseTraceEntry["kind"], summary: string) => {
    input.onTrace({
      timestamp: new Date().toISOString(),
      kind,
      summary: summary.slice(0, 1200),
    });
  };

  // Track tool operations already authorized via `session/request_permission` so secondary
  // fallback gates on `fs/write_text_file` & `terminal/create` never double-prompt.
  const approvedWritePaths = new Set<string>();
  const approvedCommands = new Set<string>();

  const clientApp = acp
    .client({ name: "avent-runtime" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const rawName = ctx.params.toolCall.name || "";
      const rawTitle = ctx.params.toolCall.title || "";
      const rawKind = ctx.params.toolCall.kind ?? null;
      const toolLabel = `${rawName} ${rawTitle}`.trim();
      const toolId = ctx.params.toolCall.toolCallId;

      const selectAllow = (): acp.RequestPermissionResponse => {
        const allowOpt = ctx.params.options.find(
          (o) => o.kind === "allow_once" || o.kind === "allow_always"
        );
        if (allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
      };

      const selectReject = (): acp.RequestPermissionResponse => {
        const rejectOpt = ctx.params.options.find(
          (o) => o.kind === "reject_once" || o.kind === "reject_always"
        );
        if (rejectOpt) {
          return { outcome: { outcome: "selected", optionId: rejectOpt.optionId } };
        }
        return { outcome: { outcome: "cancelled" } };
      };

      // Internal state commit tool is always silently permitted
      if (isAventCommitTool(toolLabel)) {
        return selectAllow();
      }

      if (input.getCommittedState() !== null || phase === "COMPACTING") {
        return selectReject();
      }

      const currentNet = computeNetTokens();
      const hitActionLimit = input.maxActions > 0 && actionCount >= input.maxActions;
      if (hitActionLimit || currentNet >= input.netTokenLimit) {
        budgetExhausted = true;
        return selectReject();
      }

      const desc = describeToolCall(rawName, rawTitle, ctx.params.toolCall.rawInput, {
        rawKind,
        cwd: input.cwd,
        allowedReadRoots: [input.spillsDir],
      });
      toolMetaById.set(toolId, {
        tool: desc.toolName,
        detail: desc.displayDetail,
        filePath: desc.filePath,
      });

      if (input.onCheckPermission) {
        const decision = await input.onCheckPermission({
          toolCallId: toolId,
          rawName,
          rawTitle,
          rawKind,
          rawInput: ctx.params.toolCall.rawInput,
        });
        if (!decision.allowed) {
          input.onToolEvent?.({
            toolCallId: toolId,
            tool: desc.toolName,
            detail: desc.displayDetail,
            filePath: desc.filePath,
            status: "denied",
            provenance: decision.provenance,
            denialMessage: decision.denialMessage,
          });
          trace("permission", `已拒绝工具调用: ${desc.toolName} ${desc.displayDetail}`);
          return selectReject();
        }
        if ((desc.category === "edit" || desc.category === "delete") && desc.filePath) {
          const absP = path.isAbsolute(desc.filePath)
            ? desc.filePath
            : path.resolve(input.cwd, desc.filePath);
          approvedWritePaths.add(resolveCanonicalPath(absP).toLowerCase());
        }
        if (desc.category === "shell" && desc.specifier) {
          approvedCommands.add(desc.specifier.trim());
        }
        toolMetaById.set(toolId, {
          tool: desc.toolName,
          detail: desc.displayDetail,
          filePath: desc.filePath,
          provenance: decision.provenance,
        });
      }

      if (!countedToolCallIds.has(toolId)) {
        countedToolCallIds.add(toolId);
        actionCount += 1;
      }
      if (ctx.params.toolCall.rawInput) {
        estimatedOutputTokens += estimateTokens(JSON.stringify(ctx.params.toolCall.rawInput));
      }

      input.onToolEvent?.({
        toolCallId: toolId,
        tool: desc.toolName,
        detail: desc.displayDetail,
        filePath: desc.filePath,
        status: "running",
        provenance: toolMetaById.get(toolId)?.provenance,
      });

      emitTelemetry();
      trace("permission", `执行工具 #${actionCount}: ${desc.toolName} ${desc.displayDetail}`);
      return selectAllow();
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      const targetPath = path.isAbsolute(ctx.params.path)
        ? ctx.params.path
        : path.resolve(input.cwd, ctx.params.path);

      // Secondary boundary gate: reading files outside task.cwd (and outside Avent spillsDir) requires permission
      const withinReadBounds =
        isPathInsideRoot(targetPath, input.cwd) ||
        isPathInsideRoot(targetPath, input.spillsDir);
      if (!withinReadBounds && input.onCheckPermission) {
        const decision = await input.onCheckPermission({
          toolCallId: `fsread:${Date.now()}`,
          rawName: "Read",
          rawTitle: targetPath,
          rawKind: "read",
          rawInput: { file_path: targetPath },
        });
        if (!decision.allowed) {
          trace("permission", `已拒绝越界读取文件: ${targetPath}`);
          throw acp.RequestError.invalidParams(
            undefined,
            decision.denialMessage || `Permission denied: ${decision.provenance || "read outside workspace rejected"}`
          );
        }
      }

      if (!existsSync(targetPath)) {
        throw new Error(`File not found: ${targetPath}`);
      }
      const raw = readFileSync(targetPath, "utf8");
      const allLines = raw.split(/\r?\n/);
      const startIdx = Math.max(0, (ctx.params.line ?? 1) - 1);
      const sliced =
        ctx.params.limit && ctx.params.limit > 0
          ? allLines.slice(startIdx, startIdx + ctx.params.limit).join("\n")
          : allLines.slice(startIdx).join("\n");

      const guarded = spillIfOversized({
        spillsDir: input.spillsDir,
        taskId: input.taskId,
        label: path.basename(targetPath),
        content: sliced,
      });
      estimatedInputTokens += estimateTokens(guarded.text);
      emitTelemetry();
      trace("tool", `读取文件 ${path.relative(input.cwd, targetPath) || path.basename(targetPath)}`);
      return { content: guarded.text };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      const targetPath = path.isAbsolute(ctx.params.path)
        ? ctx.params.path
        : path.resolve(input.cwd, ctx.params.path);
      const canonKey = resolveCanonicalPath(targetPath).toLowerCase();

      // Secondary fallback permission gate (catches ACP agents calling fs/write_text_file without prior request_permission)
      if (input.onCheckPermission) {
        if (approvedWritePaths.has(canonKey)) {
          approvedWritePaths.delete(canonKey);
        } else {
          const decision = await input.onCheckPermission({
            toolCallId: `fswrite_perm:${Date.now()}`,
            rawName: "Write",
            rawTitle: targetPath,
            rawKind: "edit",
            rawInput: { file_path: targetPath },
          });
          if (!decision.allowed) {
            trace("permission", `已拒绝直接写入文件: ${targetPath}`);
            throw acp.RequestError.invalidParams(
              undefined,
              decision.denialMessage || `Permission denied: ${decision.provenance || "write rejected"}`
            );
          }
        }
      }

      const before = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, ctx.params.content, "utf8");
      estimatedOutputTokens += estimateTokens(ctx.params.content);
      emitTelemetry();

      const rel = path.relative(input.cwd, targetPath).replace(/\\/g, "/");
      const diffLines = buildSimpleLineDiff(before, ctx.params.content);
      const syntheticId = `fswrite:${rel}:${Date.now()}`;
      if (phase === "WORK") {
        input.onToolEvent?.({
          toolCallId: syntheticId,
          tool: before === null ? "Write" : "Edit",
          detail: rel,
          filePath: rel,
          status: "ok",
          output: diffLines.length > 0 ? { type: "diff", lines: diffLines, filePath: rel } : undefined,
        });
      }
      trace("tool", `写入文件 ${rel} (${ctx.params.content.length} chars)`);
      return {};
    })
    .onRequest(acp.methods.client.terminal.create, async (ctx) => {
      const termId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const termCwd = ctx.params.cwd || input.cwd;
      const fullCmd = [ctx.params.command, ...(ctx.params.args ?? [])].join(" ").trim();
      const termCwdOutside = !isPathInsideRoot(termCwd, input.cwd);

      // Secondary fallback permission gate for direct terminal/create calls
      if (input.onCheckPermission) {
        if (!termCwdOutside && fullCmd && approvedCommands.has(fullCmd)) {
          approvedCommands.delete(fullCmd);
        } else {
          const checkCmd = termCwdOutside ? `cd "${termCwd}" && ${fullCmd}` : fullCmd;
          const decision = await input.onCheckPermission({
            toolCallId: `term_perm:${termId}`,
            rawName: "Bash",
            rawTitle: checkCmd,
            rawKind: "execute",
            rawInput: { command: checkCmd },
          });
          if (!decision.allowed) {
            trace("permission", `已拒绝终端命令执行: ${checkCmd}`);
            throw acp.RequestError.invalidParams(
              undefined,
              decision.denialMessage || `Permission denied: ${decision.provenance || "terminal command rejected"}`
            );
          }
        }
      }

      const byteLimit = ctx.params.outputByteLimit ?? 64 * 1024;
      const envObj: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (const pair of ctx.params.env ?? []) {
        envObj[pair.name] = pair.value;
      }

      const child = spawn(ctx.params.command, ctx.params.args ?? [], {
        cwd: termCwd,
        env: envObj,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const managed: ManagedTerminal = {
        id: termId,
        proc: child,
        output: "",
        truncated: false,
        byteLimit,
        exitCode: null,
        signal: null,
        exitPromise: new Promise((resolve) => {
          child.on("close", (code, sig) => {
            managed.exitCode = code;
            managed.signal = sig;
            resolve({ exitCode: code, signal: sig });
          });
          child.on("error", (err) => {
            managed.output += `\nProcess error: ${err.message}`;
            managed.exitCode = 1;
            resolve({ exitCode: 1, signal: null });
          });
        }),
      };

      const onChunk = (chunk: Buffer) => {
        managed.output += chunk.toString("utf8");
        if (Buffer.byteLength(managed.output, "utf8") > managed.byteLimit) {
          managed.output = managed.output.slice(-Math.floor(managed.byteLimit * 0.85));
          managed.truncated = true;
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      terminals.set(termId, managed);
      trace("tool", `终端命令: ${ctx.params.command} ${(ctx.params.args ?? []).join(" ")}`);
      return { terminalId: termId };
    })
    .onRequest(acp.methods.client.terminal.output, async (ctx) => {
      const t = terminals.get(ctx.params.terminalId);
      if (!t) {
        return { output: "", truncated: false };
      }
      const guarded = spillIfOversized({
        spillsDir: input.spillsDir,
        taskId: input.taskId,
        label: t.id,
        content: t.output,
      });
      return {
        output: guarded.text,
        truncated: t.truncated || guarded.truncated,
        exitStatus:
          t.exitCode !== null || t.signal !== null
            ? { exitCode: t.exitCode ?? undefined, signal: t.signal ?? undefined }
            : undefined,
      };
    })
    .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
      const t = terminals.get(ctx.params.terminalId);
      if (!t) return {};
      const res = await t.exitPromise;
      const guarded = spillIfOversized({
        spillsDir: input.spillsDir,
        taskId: input.taskId,
        label: t.id,
        content: t.output,
      });
      estimatedInputTokens += estimateTokens(guarded.text);
      emitTelemetry();
      return {
        exitCode: res.exitCode ?? undefined,
        signal: res.signal ?? undefined,
      };
    })
    .onRequest(acp.methods.client.terminal.kill, async (ctx) => {
      const t = terminals.get(ctx.params.terminalId);
      if (t) killProcessTree(t.proc);
      return {};
    })
    .onRequest(acp.methods.client.terminal.release, async (ctx) => {
      const t = terminals.get(ctx.params.terminalId);
      if (t) {
        killProcessTree(t.proc);
        terminals.delete(ctx.params.terminalId);
      }
      return {};
    })
    .onNotification(acp.methods.client.session.update, async (ctx) => {
      const u = ctx.params.update;
      if (u.sessionUpdate === "agent_thought_chunk" && u.content.type === "text") {
        estimatedOutputTokens += estimateTokens(u.content.text);
        if (phase === "WORK" && u.content.text) {
          input.onThoughtDelta?.(u.content.text);
        }
        emitTelemetry();
      } else if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
        collectedAssistantText += u.content.text;
        estimatedOutputTokens += estimateTokens(u.content.text);
        if (phase === "WORK" && u.content.text) {
          input.onAssistantDelta?.(u.content.text);
        }
        emitTelemetry();
      } else if (u.sessionUpdate === "tool_call") {
        const rawName = u.name || "";
        const rawTitle = u.title || "";
        const label = `${rawName} ${rawTitle}`.trim();

        if (!isAventCommitTool(label)) {
          if (!countedToolCallIds.has(u.toolCallId)) {
            countedToolCallIds.add(u.toolCallId);
            actionCount += 1;
            trace("tool", `调用工具 #${actionCount}: ${label || u.toolCallId}`);
          }
          const desc = describeToolCall(rawName, rawTitle, u.rawInput, {
            rawKind: u.kind ?? null,
            cwd: input.cwd,
            allowedReadRoots: [input.spillsDir],
          });
          const prev = toolMetaById.get(u.toolCallId);
          toolMetaById.set(u.toolCallId, {
            tool: prev?.tool || desc.toolName,
            detail: prev?.detail || desc.displayDetail,
            filePath: prev?.filePath || desc.filePath,
            provenance: prev?.provenance,
          });

          if (phase === "WORK") {
            const st =
              u.status === "completed"
                ? "ok"
                : u.status === "failed"
                  ? "error"
                  : "running";
            input.onToolEvent?.({
              toolCallId: u.toolCallId,
              tool: prev?.tool || desc.toolName,
              detail: prev?.detail || desc.displayDetail,
              filePath: prev?.filePath || desc.filePath,
              status: st,
              provenance: prev?.provenance,
              output: extractToolOutput(u.rawOutput, u.content as unknown[] | undefined),
            });
          }
        }

        if (u.rawInput) {
          estimatedOutputTokens += estimateTokens(JSON.stringify(u.rawInput));
        }
        emitTelemetry();

        const hitActionLimit = input.maxActions > 0 && actionCount > input.maxActions;
        if (
          phase === "WORK" &&
          !cancelSentForWatermark &&
          input.getCommittedState() === null &&
          (hitActionLimit || computeNetTokens() >= input.netTokenLimit) &&
          activeSessionId
        ) {
          budgetExhausted = true;
          cancelSentForWatermark = true;
          void ctx.agent.notify(acp.methods.agent.session.cancel, { sessionId: activeSessionId });
        }
      } else if (u.sessionUpdate === "tool_call_update") {
        const meta = toolMetaById.get(u.toolCallId);
        if (u.rawOutput) {
          const outStr = typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput);
          estimatedInputTokens += Math.min(estimateTokens(outStr), 3000);
          emitTelemetry();
        }
        if (meta && phase === "WORK") {
          const st =
            u.status === "completed"
              ? "ok"
              : u.status === "failed"
                ? "error"
                : "running";
          input.onToolEvent?.({
            toolCallId: u.toolCallId,
            tool: meta.tool,
            detail: meta.detail,
            filePath: meta.filePath,
            status: st,
            provenance: meta.provenance,
            output: extractToolOutput(u.rawOutput, u.content as unknown[] | undefined),
          });
        }
      } else if (u.sessionUpdate === "usage_update") {
        const estSum = estimatedInputTokens + estimatedOutputTokens;
        if (!baselineCaptured && u.used > 0) {
          baselineTokens = Math.max(0, u.used - estSum);
          baselineCaptured = true;
        }
        reportedUsedTokens = u.used;
        peakTotalTokens = Math.max(peakTotalTokens, u.used);
        const claudeRateLimit = (u._meta as Record<string, unknown> | undefined)?.[
          "_claude/rateLimit"
        ];
        if (claudeRateLimit && typeof claudeRateLimit === "object") {
          input.onRateLimitEvent?.(claudeRateLimit as RawClaudeRateLimitInfo);
        }
        emitTelemetry();
      }
    });

  let proc: ChildProcess | null = null;
  let sessionClosed = false;

  const target: acp.Stream | acp.AgentApp = (() => {
    if (input.mockAgentApp) {
      return input.mockAgentApp;
    }
    const spec = input.launchSpecOverride ?? registry.getLaunchSpec(input.providerId);
    const childEnv: Record<string, string | undefined> = { ...process.env };
    for (const k of spec.unsetEnv ?? []) {
      delete childEnv[k];
    }
    Object.assign(childEnv, spec.env);
    proc = spawn(spec.command, spec.args, {
      cwd: input.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.on("error", (err) => {
      trace("system", `进程启动错误: ${err.message}`);
    });

    if (!proc.stdin || !proc.stdout) {
      throw new Error(`Failed to open stdio pipes for provider ${input.providerId}`);
    }

    return acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    );
  })();

  // Build MCP servers array (Avent state & selective reader + enabled user stdio MCP servers)
  const sessionMcpServers: acp.McpServer[] = [
    {
      name: "avent",
      command: process.execPath,
      args: [input.mcpBundlePath],
      env: [
        { name: "AVENT_API_URL", value: input.aventApiUrl },
        { name: "AVENT_TASK_ID", value: input.taskId },
        { name: "AVENT_PULSE_ID", value: input.pulseId },
      ],
    },
  ];

  for (const m of input.userMcpServers ?? []) {
    if (!m.builtIn && m.enabled && m.transport === "stdio" && m.command) {
      sessionMcpServers.push({
        name: m.name,
        command: m.command,
        args: m.args ?? [],
        env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })),
      });
    }
  }

  try {
    await clientApp.connectWith(target, async (agent) => {
      const abortListener = () => {
        if (activeSessionId) {
          void agent.notify(acp.methods.agent.session.cancel, { sessionId: activeSessionId });
        }
      };
      input.abortSignal?.addEventListener("abort", abortListener, { once: true });

      try {
        const initRes = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: "avent", version: "0.2.0" },
        });

        const newSessionRes = await agent.request(acp.methods.agent.session.new, {
          cwd: input.cwd,
          mcpServers: sessionMcpServers,
        });

        activeSessionId = newSessionRes.sessionId;

        const agyMeta = (newSessionRes._meta as Record<string, unknown> | undefined)?.antigravity as
          | { tier?: { name?: string } }
          | undefined;
        const observedTier = agyMeta?.tier?.name;
        let capsChanged = false;

        let activeConfigOptions = newSessionRes.configOptions ?? [];
        const initModelOpt = activeConfigOptions.find(
          (o) => o.type === "select" && (o.id === "model" || o.category === "model")
        );

        if (!input.isCompatibleEndpoint) {
          if (
            registry.recordObservedConfigOptions(
              input.providerId,
              initModelOpt && initModelOpt.type === "select"
                ? initModelOpt.currentValue
                : undefined,
              activeConfigOptions,
              observedTier
            )
          ) {
            capsChanged = true;
          }

          if (
            initModelOpt &&
            initModelOpt.type === "select" &&
            input.modelId &&
            input.modelId !== "default"
          ) {
            const flatValues = initModelOpt.options.flatMap((item) =>
              "options" in item ? item.options.map((sub) => sub.value) : [item.value]
            );
            if (flatValues.includes(input.modelId)) {
              const upd = await agent.request(acp.methods.agent.session.setConfigOption, {
                sessionId: activeSessionId,
                configId: initModelOpt.id,
                value: input.modelId,
              });
              if (upd.configOptions && upd.configOptions.length > 0) {
                activeConfigOptions = upd.configOptions;
                if (
                  registry.recordObservedConfigOptions(
                    input.providerId,
                    input.modelId,
                    activeConfigOptions,
                    observedTier
                  )
                ) {
                  capsChanged = true;
                }
              }
            }
          }

          if (capsChanged) {
            input.onProvidersUpdated?.();
          }
        }

        const thoughtOpt = activeConfigOptions.find(
          (o) =>
            o.type === "select" &&
            (o.id === "thought_level" ||
              o.category === "thought_level" ||
              o.id === "reasoning_effort" ||
              o.id === "thinking_level")
        );
        if (
          thoughtOpt &&
          thoughtOpt.type === "select" &&
          input.thoughtLevel &&
          input.thoughtLevel !== "off"
        ) {
          const flatValues = thoughtOpt.options.flatMap((item) =>
            "options" in item ? item.options.map((sub) => sub.value) : [item.value]
          );
          if (flatValues.includes(input.thoughtLevel)) {
            await agent.request(acp.methods.agent.session.setConfigOption, {
              sessionId: activeSessionId,
              configId: thoughtOpt.id,
              value: input.thoughtLevel,
            });
          }
        }

        emitTelemetry();

        // Phase 1: Bounded execution round
        try {
          await agent.request(acp.methods.agent.session.prompt, {
            sessionId: activeSessionId,
            prompt: [{ type: "text", text: input.workPrompt }],
          });
        } catch (err) {
          if (!budgetExhausted && !input.abortSignal?.aborted) {
            throw err;
          }
        }

        if (input.getCommittedState() === null && !budgetExhausted) {
          const phase1Json = tryExtractFallbackStateJson(collectedAssistantText);
          if (phase1Json) {
            input.onFallbackCommit(phase1Json);
          }
        }

        // Phase 2: State handoff commit if not yet committed
        if (input.getCommittedState() === null && !input.abortSignal?.aborted) {
          phase = "COMPACTING";
          collectedAssistantText = "";
          await agent.request(acp.methods.agent.session.prompt, {
            sessionId: activeSessionId,
            prompt: [{ type: "text", text: input.compactionPrompt }],
          });
        }

        if (input.getCommittedState() === null) {
          const parsedFallback = tryExtractFallbackStateJson(collectedAssistantText);
          if (parsedFallback) {
            input.onFallbackCommit(parsedFallback);
          } else {
            const cleanText =
              stripAventStateTag(collectedAssistantText).trim() || "已完成当前阶段处理。";
            input.onFallbackCommit({
              status: budgetExhausted ? "CONTINUE" : "WAITING_HUMAN",
              deliverableSummary: cleanText,
              establishedFacts: [],
              openHypotheses: [],
              appliedChanges: [],
              verificationChecks: [],
              deadEnds: [],
              remainingPlan: budgetExhausted ? ["继续完成剩余步骤"] : [],
              immediateNextAction: budgetExhausted ? "核对进展并继续执行剩余计划" : "",
            });
          }
        }

        if (initRes.agentCapabilities?.sessionCapabilities?.close && activeSessionId) {
          await agent.request(acp.methods.agent.session.close, {
            sessionId: activeSessionId,
          });
          sessionClosed = true;
        } else {
          sessionClosed = true;
        }
      } finally {
        input.abortSignal?.removeEventListener("abort", abortListener);
      }
    });
  } catch (err) {
    const rl = (err as { data?: { rateLimit?: unknown } } | null)?.data?.rateLimit;
    if (rl && typeof rl === "object") {
      input.onRateLimitEvent?.(rl as RawClaudeRateLimitInfo);
    }
    throw err;
  } finally {
    for (const t of terminals.values()) {
      killProcessTree(t.proc);
    }
    terminals.clear();
    if (proc) {
      killProcessTree(proc);
    }
  }

  const finalState = input.getCommittedState();
  if (!finalState) {
    throw new Error("Execution round exited without producing a SemanticState");
  }

  const net = computeNetTokens();
  const totalEst = Math.max(1, estimatedInputTokens + estimatedOutputTokens);
  const inputShare = Math.round((net * estimatedInputTokens) / totalEst);
  const outputShare = Math.max(0, net - inputShare);

  return {
    sessionClosed,
    committedState: finalState,
    actionCount,
    baselineTokens,
    netTokens: net,
    peakTotalTokens,
    inputTokens: inputShare,
    outputTokens: outputShare,
  };
}

export function stripAventStateTag(text: string): string {
  return text.replace(/<avent_state>[\s\S]*?<\/avent_state>/gi, "").trim();
}

function tryExtractFallbackStateJson(text: string): SemanticStateCommitDraft | null {
  const match =
    text.match(/<avent_state>([\s\S]*?)<\/avent_state>/i) ||
    text.match(/```json\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1].trim()) as Record<string, unknown>;
    if (typeof obj.deliverableSummary !== "string" || typeof obj.status !== "string") {
      return null;
    }
    const validStatuses = new Set(["CONTINUE", "WAITING_HUMAN", "COMPLETED", "FAILED"]);
    const status = validStatuses.has(obj.status)
      ? (obj.status as SemanticState["status"])
      : "WAITING_HUMAN";
    return {
      status,
      taskTitle: typeof obj.taskTitle === "string" ? obj.taskTitle : undefined,
      taskObjective: typeof obj.taskObjective === "string" ? obj.taskObjective : undefined,
      newDirectives: Array.isArray(obj.newDirectives)
        ? obj.newDirectives.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        : undefined,
      deliverableSummary: obj.deliverableSummary,
      establishedFacts: Array.isArray(obj.establishedFacts) ? obj.establishedFacts : [],
      openHypotheses: Array.isArray(obj.openHypotheses) ? obj.openHypotheses : [],
      appliedChanges: Array.isArray(obj.appliedChanges) ? obj.appliedChanges : [],
      verificationChecks: Array.isArray(obj.verificationChecks) ? obj.verificationChecks : [],
      deadEnds: Array.isArray(obj.deadEnds) ? obj.deadEnds : [],
      remainingPlan: Array.isArray(obj.remainingPlan) ? obj.remainingPlan : [],
      immediateNextAction:
        typeof obj.immediateNextAction === "string" ? obj.immediateNextAction : "",
      humanQuestion: typeof obj.humanQuestion === "string" ? obj.humanQuestion : undefined,
    };
  } catch {
    return null;
  }
}
