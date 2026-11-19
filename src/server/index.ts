import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AventStore } from "./db.js";
import { ProviderRegistry } from "./providers/registry.js";
import { PulseEngine } from "./pulse-engine.js";
import { probeMcpServer } from "./mcp-probe.js";
import { boundedDocRead, searchPulseHistory, surgicalGrep } from "./selective-io.js";
import type {
  ApprovalDecisionPayload,
  AttachmentItem,
  PermissionMode,
  ProviderId,
  PulseMode,
  TaskProviderId,
  TaskRef,
} from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

function listWindowsDrives(): Array<{ name: string; path: string }> {
  const drives: Array<{ name: string; path: string }> = [];
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const rootPath = `${letter}:\\`;
    if (existsSync(rootPath)) {
      drives.push({ name: `${letter}:`, path: rootPath });
    }
  }
  if (existsSync("C:\\") && !drives.some((d) => d.name === "C:")) {
    drives.unshift({ name: "C:", path: "C:\\" });
  }
  return drives;
}

export function createAventApp(options?: {
  dataDir?: string;
  port?: number;
  projectRoot?: string;
  skipBackgroundProbe?: boolean;
}) {
  const root = options?.projectRoot ?? projectRoot;
  const dataDir = options?.dataDir ?? path.join(root, ".avent");
  const port = options?.port ?? Number(process.env.AVENT_PORT || 4320);

  const store = new AventStore(dataDir, root);
  const registry = new ProviderRegistry(root, store);
  const engine = new PulseEngine({
    store,
    registry,
    projectRoot: root,
    aventApiUrl: `http://127.0.0.1:${port}`,
  });

  // Non-blocking background capability probe on fresh installs (discovers live models + per-model thought levels)
  if (!options?.skipBackgroundProbe) {
    setTimeout(() => {
      const statuses = registry.listProviderStatuses();
      for (const p of statuses) {
        if (p.available && !registry.hasPersistedCapabilities(p.id)) {
          void registry.probeProvider(p.id, root).then((res) => {
            if (res.ok) {
              engine.broadcast({
                type: "providers_updated",
                providers: registry.listProviderStatuses(),
              });
            }
          });
        }
      }
    }, 800);
  }

  const app = new Hono();

  // --- Bootstrap & Health ---

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "avent",
      defaultCwd: root,
    })
  );

  app.get("/api/bootstrap", (c) => {
    const workspaces = store.listWorkspaces();
    const tasks = store.listTasks().map((t) => engine.decorateTask(t)!);
    return c.json({
      workspaces,
      tasks,
      approvals: engine.listPendingApprovals(),
      providers: registry.listProviderStatuses(),
      endpoints: store.listCompatibleEndpoints(),
      prefs: store.getPreferences(),
      defaultCwd: root,
    });
  });

  // --- Workspaces & Filesystem ---

  app.get("/api/workspaces", (c) => {
    return c.json({ workspaces: store.listWorkspaces() });
  });

  app.post("/api/workspaces", async (c) => {
    const body = await c.req.json<{ path: string; name?: string }>();
    const rawPath = (body.path || "").trim();
    if (!rawPath || !existsSync(rawPath)) {
      return c.json({ error: "文件夹不存在或无法访问" }, 400);
    }
    try {
      const st = statSync(rawPath);
      if (!st.isDirectory()) {
        return c.json({ error: "所选路径不是文件夹" }, 400);
      }
    } catch {
      return c.json({ error: "无法读取所选文件夹" }, 400);
    }
    const ws = store.addWorkspace(rawPath, body.name);
    const workspaces = store.listWorkspaces();
    engine.broadcast({ type: "workspace_updated", workspaces });
    return c.json({ workspace: ws, workspaces }, 201);
  });

  app.patch("/api/workspaces/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ pinned?: boolean; name?: string }>();
    const ws = store.updateWorkspace(id, body);
    if (!ws) return c.json({ error: "工作区不存在" }, 404);
    const workspaces = store.listWorkspaces();
    engine.broadcast({ type: "workspace_updated", workspaces });
    return c.json({ workspace: ws, workspaces });
  });

  app.delete("/api/workspaces/:id", (c) => {
    const id = c.req.param("id");
    store.deleteWorkspace(id);
    const workspaces = store.listWorkspaces();
    engine.broadcast({ type: "workspace_updated", workspaces });
    return c.json({ ok: true, workspaces });
  });

  app.get("/api/fs/browse", (c) => {
    const reqPath = (c.req.query("path") || "").trim();
    if (!reqPath && process.platform === "win32") {
      return c.json({
        currentPath: "",
        parentPath: null,
        roots: listWindowsDrives(),
        homePath: os.homedir(),
        directories: listWindowsDrives(),
      });
    }

    const target = reqPath ? path.resolve(reqPath) : os.homedir();
    if (!existsSync(target)) {
      return c.json({ error: "路径不存在" }, 404);
    }

    const dirs: Array<{ name: string; path: string }> = [];
    try {
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith("$")) {
          dirs.push({ name: entry.name, path: path.join(target, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // ignore permission errors on system dirs
    }

    const parent = path.dirname(target);
    const parentPath =
      parent && parent !== target
        ? parent
        : process.platform === "win32"
          ? ""
          : null;

    return c.json({
      currentPath: target,
      parentPath,
      roots: process.platform === "win32" ? listWindowsDrives() : [{ name: "/", path: "/" }],
      homePath: os.homedir(),
      directories: dirs,
    });
  });

  app.get("/api/workspaces/:id/files", (c) => {
    const ws = store.getWorkspace(c.req.param("id"));
    if (!ws) return c.json({ error: "工作区不存在" }, 404);
    const q = c.req.query("q") || "";
    return c.json({ files: store.listWorkspaceFiles(ws.path, q, 60) });
  });

  app.get("/api/workspaces/:id/file-content", (c) => {
    const ws = store.getWorkspace(c.req.param("id"));
    if (!ws) return c.json({ error: "工作区不存在" }, 404);
    const relOrAbs = (c.req.query("path") || "").trim();
    if (!relOrAbs) return c.json({ error: "缺少文件路径" }, 400);

    // Strip optional `#L10-L25` pointer if passed directly
    const cleanPath = relOrAbs.split("#")[0];
    const resolved = path.isAbsolute(cleanPath)
      ? path.resolve(cleanPath)
      : path.resolve(ws.path, cleanPath);

    // Ensure target is inside workspace or Avent spills directory
    const wsNorm = path.resolve(ws.path).toLowerCase();
    const spillsNorm = path.resolve(store.spillsDir).toLowerCase();
    const resNorm = resolved.toLowerCase();
    if (!resNorm.startsWith(wsNorm) && !resNorm.startsWith(spillsNorm)) {
      return c.json({ error: "出于安全限制，仅支持预览工作区内的文件" }, 403);
    }
    if (!existsSync(resolved)) {
      return c.json({ error: "文件不存在" }, 404);
    }
    const raw = readFileSync(resolved, "utf8");
    const lines = raw.split(/\r?\n/);
    return c.json({
      path: path.relative(ws.path, resolved).replace(/\\/g, "/"),
      totalLines: lines.length,
      content: lines.slice(0, 800).join("\n"),
      truncated: lines.length > 800,
    });
  });

  // --- Providers ---

  app.get("/api/providers", (c) => {
    return c.json({
      providers: registry.listProviderStatuses(),
      endpoints: store.listCompatibleEndpoints(),
      defaultCwd: root,
    });
  });

  app.post("/api/providers/:id/check", async (c) => {
    const providerId = c.req.param("id") as ProviderId;
    const result = await registry.probeProvider(providerId, root);
    const providers = registry.listProviderStatuses();
    engine.broadcast({ type: "providers_updated", providers });
    return c.json({
      ...result,
      providers,
    });
  });

  // --- Tasks & Approvals ---

  app.get("/api/tasks", (c) => {
    const wsId = c.req.query("workspaceId") || undefined;
    const tasks = store.listTasks(wsId).map((t) => engine.decorateTask(t)!);
    return c.json({ tasks });
  });

  app.post("/api/tasks", async (c) => {
    const body = await c.req.json<{
      workspaceId?: string;
      title?: string;
      objective?: string;
      completionCriteria?: string[];
      cwd?: string;
      providerId?: ProviderId;
      modelId?: string;
      thoughtLevel?: string;
      permissionMode?: PermissionMode;
      pulseMode?: PulseMode;
      draft?: boolean;
      attachments?: AttachmentItem[];
      refs?: TaskRef[];
    }>();

    const prefs = store.getPreferences();
    const providerId: ProviderId = body.providerId || prefs.defaultProviderId || "agy";
    const spec = registry.getLaunchSpec(providerId);

    let cwd = body.cwd?.trim() || "";
    if (!cwd && body.workspaceId) {
      cwd = store.getWorkspace(body.workspaceId)?.path || "";
    }
    if (!cwd) {
      cwd = store.listWorkspaces()[0]?.path || root;
    }

    const objectiveText = (body.objective ?? "").trim();
    const isDraft = Boolean(body.draft) || objectiveText.length === 0;
    const chosenModelId = body.modelId || spec.info.defaultModel;
    const chosenModelMeta = spec.info.models.find((m) => m.value === chosenModelId);
    const chosenThoughtLevel =
      body.thoughtLevel ??
      (chosenModelMeta?.thoughtLevels?.length === 0
        ? ""
        : chosenModelMeta?.defaultThoughtLevel || spec.info.defaultThoughtLevel);

    const task = store.createTask({
      workspaceId: body.workspaceId,
      title: body.title,
      objective: "",
      completionCriteria: body.completionCriteria,
      cwd,
      providerId,
      modelId: chosenModelId,
      thoughtLevel: chosenThoughtLevel,
      permissionMode: body.permissionMode || prefs.defaultPermissionMode,
      pulseMode: body.pulseMode || "micro-stretch",
      draft: true,
    });

    if (!isDraft && objectiveText) {
      const sent = engine.sendUserMessage(task.id, {
        text: objectiveText,
        attachments: body.attachments,
        refs: body.refs,
      });
      return c.json({ task: sent.task }, 201);
    }

    const decorated = engine.decorateTask(task)!;
    engine.broadcast({ type: "task_updated", task: decorated });
    engine.broadcast({ type: "workspace_updated", workspaces: store.listWorkspaces() });
    return c.json({ task: decorated }, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const taskId = c.req.param("id");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json({
      task: engine.decorateTask(task)!,
      items: store.listTaskItems(taskId),
      states: store.listStates(taskId),
      events: store.listEvents(taskId),
      pulses: store.listPulses(taskId, false),
      approvals: engine.listPendingApprovals(taskId),
    });
  });

  app.patch("/api/tasks/:id", async (c) => {
    const taskId = c.req.param("id");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const body = await c.req.json<{
      title?: string;
      originalObjective?: string;
      tags?: string[];
      permissionMode?: PermissionMode;
      providerId?: TaskProviderId;
      modelId?: string;
      thoughtLevel?: string;
      pulseMode?: PulseMode;
    }>();

    let nextModel = body.modelId;
    let nextThought = body.thoughtLevel;
    const targetProvider = body.providerId ?? task.providerId;

    if (!targetProvider.startsWith("endpoint:")) {
      const spec = registry.getLaunchSpec(targetProvider as ProviderId);
      if (body.providerId && body.providerId !== task.providerId && !nextModel) {
        nextModel = spec.info.defaultModel;
      }
      const effectiveModelId = nextModel ?? task.modelId;
      const modelMeta = spec.info.models.find((m) => m.value === effectiveModelId);
      const allowedLevels =
        modelMeta?.thoughtLevels !== undefined
          ? modelMeta.thoughtLevels
          : spec.info.thoughtLevels;

      if (allowedLevels.length === 0) {
        nextThought = "";
      } else {
        const candidateThought = nextThought ?? task.thoughtLevel;
        if (!allowedLevels.some((lv) => lv.value === candidateThought)) {
          nextThought =
            modelMeta?.defaultThoughtLevel ||
            spec.info.defaultThoughtLevel ||
            allowedLevels[0].value;
        }
      }
    }

    const updated = store.updateTaskMeta(taskId, {
      ...body,
      modelId: nextModel,
      thoughtLevel: nextThought,
    });
    const decorated = engine.decorateTask(updated)!;
    engine.broadcast({ type: "task_updated", task: decorated });
    return c.json({ task: decorated });
  });

  app.patch("/api/tasks/:id/provider", async (c) => {
    const taskId = c.req.param("id");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    const body = await c.req.json<{
      providerId: ProviderId;
      modelId?: string;
      thoughtLevel?: string;
      pulseMode?: PulseMode;
    }>();
    const spec = registry.getLaunchSpec(body.providerId);
    const updated = store.updateTaskProvider(
      taskId,
      body.providerId,
      body.modelId || spec.info.defaultModel,
      body.thoughtLevel || spec.info.defaultThoughtLevel,
      body.pulseMode
    );
    const decorated = engine.decorateTask(updated)!;
    engine.broadcast({ type: "task_updated", task: decorated });
    return c.json({ task: decorated });
  });

  app.post("/api/tasks/:id/send", async (c) => {
    const taskId = c.req.param("id");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    const body = await c.req.json<{
      text: string;
      attachments?: AttachmentItem[];
      refs?: TaskRef[];
      interruptCurrent?: boolean;
    }>();
    if (!body.text?.trim()) {
      return c.json({ error: "消息内容不能为空" }, 400);
    }
    const res = engine.sendUserMessage(taskId, body);
    return c.json(res);
  });

  // Backward-compatible `/events` endpoint
  app.post("/api/tasks/:id/events", async (c) => {
    const taskId = c.req.param("id");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    const body = await c.req.json<{
      message: string;
      asSteering?: boolean;
      interruptCurrent?: boolean;
    }>();
    const text = (body.message || "").trim();
    if (!text) return c.json({ error: "消息内容不能为空" }, 400);

    if (body.asSteering) {
      const updated = store.addSteeringDirective(taskId, text);
      const decorated = engine.decorateTask(updated)!;
      engine.broadcast({ type: "task_updated", task: decorated });
      return c.json({ task: decorated });
    }
    const res = engine.sendUserMessage(taskId, {
      text,
      interruptCurrent: body.interruptCurrent,
    });
    return c.json({ task: res.task });
  });

  app.post("/api/tasks/:id/steering", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ directive: string }>();
    if (!body.directive?.trim()) {
      return c.json({ error: "约定内容不能为空" }, 400);
    }
    const updated = store.addSteeringDirective(taskId, body.directive);
    const decorated = engine.decorateTask(updated)!;
    engine.broadcast({ type: "task_updated", task: decorated });
    return c.json({ task: decorated });
  });

  app.delete("/api/tasks/:id/steering/:directiveId", (c) => {
    const taskId = c.req.param("id");
    const directiveId = c.req.param("directiveId");
    const updated = store.removeSteeringDirective(taskId, directiveId);
    const decorated = engine.decorateTask(updated)!;
    engine.broadcast({ type: "task_updated", task: decorated });
    return c.json({ task: decorated });
  });

  app.delete("/api/tasks/:id/queue/:queueId", (c) => {
    const ok = engine.removeQueuedMessage(c.req.param("id"), c.req.param("queueId"));
    return c.json({ ok });
  });

  app.post("/api/tasks/:id/cancel", (c) => {
    const taskId = c.req.param("id");
    const cancelled = engine.cancelTaskPulse(taskId);
    return c.json({ ok: true, cancelled });
  });

  app.post("/api/tasks/:id/resume", (c) => {
    const taskId = c.req.param("id");
    const task = store.getTask(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    const ev = store.appendEvent(
      taskId,
      "PULSE_CONTINUE",
      task.latestState?.immediateNextAction || "继续执行当前任务剩余工作"
    );
    engine.triggerEvent(taskId, ev);
    return c.json({ ok: true });
  });

  app.delete("/api/tasks/:id", (c) => {
    const taskId = c.req.param("id");
    engine.cancelTaskPulse(taskId);
    store.deleteTask(taskId);
    engine.broadcast({ type: "task_deleted", taskId });
    engine.broadcast({ type: "workspace_updated", workspaces: store.listWorkspaces() });
    return c.json({ ok: true });
  });

  app.get("/api/approvals", (c) => {
    return c.json({ approvals: engine.listPendingApprovals() });
  });

  app.post("/api/approvals/:id/decide", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<ApprovalDecisionPayload>();
    const ok = engine.resolveApproval(id, body);
    if (!ok) return c.json({ error: "该审批请求已处理或已失效" }, 404);
    return c.json({ ok: true });
  });

  // --- MCP Servers ---

  app.get("/api/mcp", (c) => {
    const wsId = c.req.query("workspaceId") || undefined;
    return c.json({ servers: store.listMcpServers(wsId) });
  });

  app.post("/api/mcp", async (c) => {
    const body = await c.req.json<{
      id?: string;
      name: string;
      scope: "global" | "workspace";
      workspaceId?: string;
      transport: "stdio" | "http" | "sse";
      enabled?: boolean;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    }>();
    if (!body.name?.trim()) return c.json({ error: "名称不能为空" }, 400);
    const saved = store.saveMcpServer(body);
    return c.json({ server: saved }, 201);
  });

  app.patch("/api/mcp/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ enabled: boolean }>();
    const updated = store.setMcpEnabled(id, Boolean(body.enabled));
    if (!updated) return c.json({ error: "无法修改内置或文件发现的 MCP 服务" }, 400);
    return c.json({ server: updated });
  });

  app.post("/api/mcp/:id/test", async (c) => {
    const id = c.req.param("id");
    const wsId = c.req.query("workspaceId") || undefined;
    const all = store.listMcpServers(wsId);
    const found = all.find((s) => s.id === id);
    if (!found) return c.json({ error: "未找到 MCP 服务" }, 404);

    if (found.builtIn) {
      return c.json({ ok: true, server: found });
    }

    const cwd = (found.workspaceId && store.getWorkspace(found.workspaceId)?.path) || root;
    const probe = await probeMcpServer(found, cwd);
    const updated = store.updateMcpProbeResult(id, {
      status: probe.ok ? "ready" : "error",
      tools: probe.tools,
      errorMessage: probe.errorMessage,
    });
    return c.json({
      ok: probe.ok,
      server:
        updated ?? {
          ...found,
          status: probe.ok ? "ready" : "error",
          tools: probe.tools,
          errorMessage: probe.errorMessage,
        },
      errorMessage: probe.errorMessage,
    });
  });

  app.delete("/api/mcp/:id", (c) => {
    store.deleteMcpServer(c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Skills & Instructions ---

  app.get("/api/skills", (c) => {
    const wsId = c.req.query("workspaceId") || undefined;
    return c.json({ skills: store.listSkills(wsId) });
  });

  app.post("/api/skills", async (c) => {
    const body = await c.req.json<{
      name: string;
      description: string;
      argumentHint?: string;
      scope: "global" | "workspace";
      workspaceId?: string;
      body: string;
    }>();
    try {
      const skill = store.saveSkill(body);
      return c.json({ skill }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/skills/:id", (c) => {
    const ok = store.deleteSkill(decodeURIComponent(c.req.param("id")));
    return c.json({ ok });
  });

  app.get("/api/instructions", (c) => {
    const scope = (c.req.query("scope") === "workspace" ? "workspace" : "global") as
      | "global"
      | "workspace";
    const wsId = c.req.query("workspaceId") || undefined;
    try {
      return c.json({ doc: store.getInstructions(scope, wsId) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/instructions", async (c) => {
    const body = await c.req.json<{
      scope: "global" | "workspace";
      workspaceId?: string;
      content: string;
    }>();
    try {
      const doc = store.saveInstructions(body.scope, body.content ?? "", body.workspaceId);
      return c.json({ doc });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // --- Usage, Rules, Prefs & Compatible Endpoints ---

  app.get("/api/usage", (c) => {
    const r = c.req.query("range");
    const range = r === "30d" || r === "all" ? r : "7d";
    const wsId = c.req.query("workspaceId") || undefined;
    return c.json({ report: store.getUsageReport(range, wsId) });
  });

  app.get("/api/rules", (c) => {
    const wsId = c.req.query("workspaceId") || undefined;
    return c.json({ rules: store.listPermissionRules(wsId) });
  });

  app.post("/api/rules", async (c) => {
    const body = await c.req.json<{
      behavior: "allow" | "ask" | "deny";
      rule: string;
      scope: "global" | "workspace";
      workspaceId?: string;
      note?: string;
    }>();
    if (!body.rule?.trim()) return c.json({ error: "规则表达式不能为空" }, 400);
    const rule = store.addPermissionRule(body);
    return c.json({ rule }, 201);
  });

  app.delete("/api/rules/:id", (c) => {
    store.deletePermissionRule(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/prefs", (c) => {
    return c.json({ prefs: store.getPreferences() });
  });

  app.put("/api/prefs", async (c) => {
    const body = await c.req.json();
    const prefs = store.savePreferences(body);
    return c.json({ prefs });
  });

  app.post("/api/endpoints", async (c) => {
    const body = await c.req.json<{
      name: string;
      baseUrl: string;
      apiKey?: string;
      models: string[];
    }>();
    if (!body.name?.trim() || !body.baseUrl?.trim()) {
      return c.json({ error: "名称与接口地址不能为空" }, 400);
    }
    const endpoint = store.addCompatibleEndpoint(body);
    return c.json({ endpoint }, 201);
  });

  app.delete("/api/endpoints/:id", (c) => {
    store.deleteCompatibleEndpoint(c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- SSE Real-Time Stream ---

  app.get("/api/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let alive = true;
      const unsubscribe = engine.subscribe((ev) => {
        if (!alive) return;
        void stream.writeSSE({
          event: "avent",
          data: JSON.stringify(ev),
        });
      });

      stream.onAbort(() => {
        alive = false;
        unsubscribe();
      });

      while (alive) {
        await stream.writeSSE({ event: "ping", data: "{}" });
        await stream.sleep(15000);
      }
    });
  });

  // --- Internal Localhost IPC for Avent Stdio MCP Server ---

  app.post("/api/internal/pulses/:pulseId/commit-state", async (c) => {
    const pulseId = c.req.param("pulseId");
    const body = await c.req.json();
    try {
      const res = engine.commitStateFromMcp(pulseId, {
        status: body.status,
        taskTitle: typeof body.taskTitle === "string" ? body.taskTitle : undefined,
        taskObjective: typeof body.taskObjective === "string" ? body.taskObjective : undefined,
        newDirectives: Array.isArray(body.newDirectives) ? body.newDirectives : undefined,
        deliverableSummary: body.deliverableSummary,
        establishedFacts: body.establishedFacts ?? [],
        openHypotheses: body.openHypotheses ?? [],
        appliedChanges: body.appliedChanges ?? [],
        verificationChecks: body.verificationChecks ?? [],
        deadEnds: body.deadEnds ?? [],
        remainingPlan: body.remainingPlan ?? [],
        immediateNextAction: body.immediateNextAction ?? "",
        humanQuestion: body.humanQuestion,
      });
      return c.json({ ok: true, ...res });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/internal/selective/read", async (c) => {
    const body = await c.req.json<{
      taskId: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
      maxChars?: number;
    }>();
    const task = store.getTask(body.taskId);
    const cwd = task?.cwd || root;
    const text = boundedDocRead({
      cwd,
      filePath: body.filePath,
      startLine: body.startLine,
      endLine: body.endLine,
      maxChars: body.maxChars,
    });
    return c.json({ text });
  });

  app.post("/api/internal/selective/grep", async (c) => {
    const body = await c.req.json<{
      taskId: string;
      pattern: string;
      targetPath?: string;
      maxMatches?: number;
    }>();
    const task = store.getTask(body.taskId);
    const cwd = task?.cwd || root;
    const text = surgicalGrep({
      cwd,
      pattern: body.pattern,
      targetPath: body.targetPath,
      maxMatches: body.maxMatches,
    });
    return c.json({ text });
  });

  app.post("/api/internal/selective/history", async (c) => {
    const body = await c.req.json<{
      taskId: string;
      query: string;
      maxMatches?: number;
    }>();
    const text = searchPulseHistory({
      archiveDir: store.archiveDir,
      taskId: body.taskId,
      query: body.query,
      maxMatches: body.maxMatches,
    });
    return c.json({ text });
  });

  // --- Static Frontend Serving ---

  app.get("/styles.css", (c) => {
    const css = readFileSync(path.join(root, "public", "styles.css"), "utf8");
    return c.text(css, 200, { "Content-Type": "text/css; charset=utf-8" });
  });

  app.get("/assets/:file", (c) => {
    const file = path.basename(c.req.param("file"));
    const full = path.join(root, "public", "assets", file);
    if (!existsSync(full)) return c.notFound();
    const content = readFileSync(full, "utf8");
    const ct = file.endsWith(".map")
      ? "application/json; charset=utf-8"
      : "application/javascript; charset=utf-8";
    return c.text(content, 200, { "Content-Type": ct });
  });

  app.get("*", (c) => {
    const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
    return c.html(html);
  });

  return { app, store, registry, engine, port };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const { app, port } = createAventApp();
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
    console.log(`\n⚡ Avent Workbench listening at http://localhost:${info.port}`);
  });
}
