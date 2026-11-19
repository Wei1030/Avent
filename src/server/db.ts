import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type {
  AppPreferences,
  AventEvent,
  AventEventType,
  CompatibleEndpointRecord,
  InstructionDoc,
  McpServerRecord,
  McpToolSummary,
  PermissionMode,
  PermissionRuleRecord,
  ProviderId,
  PulseMode,
  PulseRecord,
  PulseTraceEntry,
  SemanticState,
  SkillRecord,
  SteeringDirective,
  TaskRecord,
  TaskStatus,
  TranscriptItem,
  UsageBreakdownRow,
  UsageDayBucket,
  UsageReport,
  WorkspaceRecord,
} from "../shared/types.js";

const DEFAULT_PREFS: AppPreferences = {
  uiLanguage: "auto",
  defaultProviderId: "agy",
  defaultPermissionMode: "acceptEdits",
  autoVerifyEdits: true,
  desktopNotifications: true,
  maxAutoContinues: 10,
};

const BUILTIN_SKILLS: SkillRecord[] = [
  {
    id: "builtin:verify",
    name: "verify",
    description: "运行类型检查、构建与测试，验证当前任务的代码改动是否可靠",
    scope: "builtin",
    argumentHint: "[可选测试范围]",
    editable: false,
    updatedAt: "2026-11-18T00:00:00.000Z",
    content: `请对当前工作区中的近期修改执行完整的工程验证：
1. 检查项目配置（如 package.json / tsconfig.json）以确定正确的类型检查与测试命令。
2. 运行类型检查与相关单元测试。
3. 若发现错误，直接定位原因并修复；验证通过后，将精确命令与结果写入状态记忆的验证记录中。`,
  },
  {
    id: "builtin:changes-summary",
    name: "changes-summary",
    description: "梳理当前工作区未提交的 Git 变更，生成结构化改动说明",
    scope: "builtin",
    editable: false,
    updatedAt: "2026-11-18T00:00:00.000Z",
    content: `请检查当前工作区的 Git 状态与未提交差异（git status / git diff --stat），按模块归纳核心改动点、潜在影响面以及建议的验证步骤。`,
  },
  {
    id: "builtin:investigate",
    name: "investigate",
    description: "针对问题或模块进行精确定位分析，将关键结论带行号沉淀到状态记忆",
    scope: "builtin",
    argumentHint: "<问题描述或模块名>",
    editable: false,
    updatedAt: "2026-11-18T00:00:00.000Z",
    content: `请使用按需检索与分段读取方式深入排查目标问题：
1. 先用正则检索定位相关符号与调用链，避免整文件盲读。
2. 区分已验证的事实（附带精确 file#line）与尚待验证的假设。
3. 给出清晰的根因结论与下一步可执行建议。`,
  },
];

export class AventStore {
  public readonly dataDir: string;
  public readonly spillsDir: string;
  public readonly archiveDir: string;
  public readonly globalSkillsDir: string;
  private db: DatabaseSync;
  private gitCache = new Map<string, { at: number; branch?: string; clean?: boolean }>();

  constructor(baseDir: string, defaultWorkspacePath?: string) {
    this.dataDir = baseDir;
    this.spillsDir = path.join(baseDir, "spills");
    this.archiveDir = path.join(baseDir, "archive", "pulses");
    this.globalSkillsDir = path.join(baseDir, "skills");
    mkdirSync(this.spillsDir, { recursive: true });
    mkdirSync(this.archiveDir, { recursive: true });
    mkdirSync(this.globalSkillsDir, { recursive: true });

    const dbPath = path.join(baseDir, "avent.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
    this.ensureMigrations();

    if (defaultWorkspacePath) {
      this.ensureDefaultWorkspace(defaultWorkspacePath);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        original_objective TEXT NOT NULL,
        completion_criteria_json TEXT NOT NULL,
        steering_json TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        thought_level TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
        pulse_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0,
        pulse_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        latest_state_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_states (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        pulse_number INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, version),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pulses (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        pulse_number INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        action_count INTEGER NOT NULL DEFAULT 0,
        max_actions INTEGER NOT NULL,
        baseline_tokens INTEGER NOT NULL DEFAULT 0,
        net_tokens INTEGER NOT NULL DEFAULT 0,
        net_token_limit INTEGER NOT NULL,
        peak_total_tokens INTEGER NOT NULL DEFAULT 0,
        session_closed INTEGER NOT NULL DEFAULT 0,
        result_state_version INTEGER,
        deliverable_summary TEXT NOT NULL DEFAULT '',
        error_message TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        url TEXT,
        headers_json TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        error_message TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS permission_rules (
        id TEXT PRIMARY KEY,
        behavior TEXT NOT NULL,
        rule TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prefs (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS compatible_endpoints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_hint TEXT NOT NULL,
        models_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
    `);
  }

  private ensureMigrations(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has("workspace_id")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';`);
    }
    if (!colNames.has("tags_json")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';`);
    }
    if (!colNames.has("permission_mode")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'acceptEdits';`);
    }
    if (!colNames.has("total_tokens")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;`);
    }

    // Seed default safety permission rules once if empty
    const ruleCount = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM permission_rules`).get() as { cnt: number }
    ).cnt;
    if (ruleCount === 0) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO permission_rules (id, behavior, rule, scope, workspace_id, note, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          "deny",
          "Bash(git push --force*)",
          "global",
          "防止强制覆盖远端分支",
          now
        );
      this.db
        .prepare(
          `INSERT INTO permission_rules (id, behavior, rule, scope, workspace_id, note, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          "allow",
          "Bash(npm.cmd test*)",
          "global",
          "允许运行单元测试",
          now
        );
      this.db
        .prepare(
          `INSERT INTO permission_rules (id, behavior, rule, scope, workspace_id, note, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          "allow",
          "Bash(npm.cmd run typecheck*)",
          "global",
          "允许运行 TypeScript 类型检查",
          now
        );
    }
  }

  public ensureDefaultWorkspace(wsPath: string): WorkspaceRecord {
    const resolved = path.resolve(wsPath);
    const existing = this.db
      .prepare(`SELECT * FROM workspaces WHERE LOWER(path) = LOWER(?)`)
      .get(resolved) as Record<string, unknown> | undefined;

    let wsId: string;
    if (existing) {
      wsId = String(existing.id);
    } else {
      const count = (
        this.db.prepare(`SELECT COUNT(*) as cnt FROM workspaces`).get() as { cnt: number }
      ).cnt;
      if (count > 0) {
        const first = this.db
          .prepare(`SELECT * FROM workspaces ORDER BY pinned DESC, last_active_at DESC LIMIT 1`)
          .get() as Record<string, unknown>;
        return this.mapWorkspaceRow(first);
      }
      const created = this.addWorkspace(resolved);
      wsId = created.id;
    }

    // Attach any legacy tasks missing workspace_id
    this.db
      .prepare(`UPDATE tasks SET workspace_id = ? WHERE workspace_id = '' AND LOWER(cwd) = LOWER(?)`)
      .run(wsId, resolved);

    // Backfill transcript items for any v0.1 tasks that don't have task_items yet
    const orphanTasks = this.db
      .prepare(
        `SELECT id, original_objective, latest_state_json, created_at, updated_at
         FROM tasks
         WHERE id NOT IN (SELECT DISTINCT task_id FROM task_items)
           AND original_objective != ''`
      )
      .all() as Array<Record<string, unknown>>;

    for (const t of orphanTasks) {
      const tid = String(t.id);
      this.upsertTaskItem(tid, {
        id: crypto.randomUUID(),
        kind: "user",
        text: String(t.original_objective),
        attachments: [],
        refs: [],
        createdAt: String(t.created_at),
      });
      if (t.latest_state_json) {
        try {
          const st = JSON.parse(String(t.latest_state_json)) as SemanticState;
          if (st.deliverableSummary) {
            this.upsertTaskItem(tid, {
              id: crypto.randomUUID(),
              kind: "text",
              text: st.deliverableSummary,
              createdAt: st.createdAt || String(t.updated_at),
            });
          }
        } catch {
          // ignore
        }
      }
    }

    return this.getWorkspace(wsId)!;
  }

  // =========================================================================
  // Workspaces & Filesystem
  // =========================================================================

  public addWorkspace(folderPath: string, name?: string): WorkspaceRecord {
    const resolved = path.resolve(folderPath);
    const existing = this.db
      .prepare(`SELECT * FROM workspaces WHERE LOWER(path) = LOWER(?)`)
      .get(resolved) as Record<string, unknown> | undefined;
    if (existing) {
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE workspaces SET last_active_at = ? WHERE id = ?`)
        .run(now, String(existing.id));
      return this.getWorkspace(String(existing.id))!;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const wsName = (name?.trim() || path.basename(resolved) || resolved).slice(0, 80);
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, path, pinned, created_at, last_active_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      )
      .run(id, wsName, resolved, now, now);
    return this.getWorkspace(id)!;
  }

  public getWorkspace(id: string): WorkspaceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM workspaces WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkspaceRow(row) : null;
  }

  public getWorkspaceByPath(cwd: string): WorkspaceRecord | null {
    const resolved = path.resolve(cwd);
    const row = this.db
      .prepare(`SELECT * FROM workspaces WHERE LOWER(path) = LOWER(?)`)
      .get(resolved) as Record<string, unknown> | undefined;
    return row ? this.mapWorkspaceRow(row) : null;
  }

  public listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM workspaces ORDER BY pinned DESC, last_active_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapWorkspaceRow(r));
  }

  public updateWorkspace(id: string, patch: { pinned?: boolean; name?: string }): WorkspaceRecord | null {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const nextPinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : ws.pinned ? 1 : 0;
    const nextName = patch.name?.trim() || ws.name;
    this.db
      .prepare(`UPDATE workspaces SET pinned = ?, name = ? WHERE id = ?`)
      .run(nextPinned, nextName, id);
    return this.getWorkspace(id);
  }

  public touchWorkspace(id: string): void {
    if (!id) return;
    this.db
      .prepare(`UPDATE workspaces SET last_active_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  public deleteWorkspace(id: string): void {
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
  }

  private getGitMeta(wsPath: string): { branch?: string; clean?: boolean } {
    const cached = this.gitCache.get(wsPath);
    const now = Date.now();
    if (cached && now - cached.at < 10000) {
      return { branch: cached.branch, clean: cached.clean };
    }
    if (!existsSync(path.join(wsPath, ".git"))) {
      this.gitCache.set(wsPath, { at: now });
      return {};
    }
    try {
      const br = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: wsPath,
        encoding: "utf8",
        timeout: 1500,
      });
      const branch = br.status === 0 ? br.stdout.trim() : undefined;
      const st = spawnSync("git", ["status", "--porcelain"], {
        cwd: wsPath,
        encoding: "utf8",
        timeout: 1500,
      });
      const clean = st.status === 0 ? st.stdout.trim().length === 0 : undefined;
      this.gitCache.set(wsPath, { at: now, branch, clean });
      return { branch, clean };
    } catch {
      return {};
    }
  }

  private mapWorkspaceRow(r: Record<string, unknown>): WorkspaceRecord {
    const id = String(r.id);
    const wsPath = String(r.path);
    const stats = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status IN ('PULSING', 'WAITING_APPROVAL') THEN 1 ELSE 0 END) as running
         FROM tasks WHERE workspace_id = ?`
      )
      .get(id) as { total: number; running: number | null };
    const git = this.getGitMeta(wsPath);
    return {
      id,
      name: String(r.name),
      path: wsPath,
      pinned: Number(r.pinned) === 1,
      branch: git.branch,
      gitClean: git.clean,
      taskCount: Number(stats.total || 0),
      runningCount: Number(stats.running || 0),
      createdAt: String(r.created_at),
      lastActiveAt: String(r.last_active_at),
    };
  }

  public listWorkspaceFiles(wsPath: string, query = "", limit = 60): string[] {
    if (!existsSync(wsPath)) return [];
    const results: string[] = [];
    const lowerQ = query.toLowerCase();
    const skipDirs = new Set([
      "node_modules",
      ".git",
      ".avent",
      "dist",
      ".next",
      "coverage",
      "build",
      "target",
    ]);

    const walk = (dir: string, relPrefix: string, depth: number) => {
      if (depth > 4 || results.length >= 400) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env.example") {
          if (e.isDirectory() && skipDirs.has(e.name)) continue;
          if (e.name === ".git" || e.name === ".avent") continue;
        }
        if (e.isDirectory()) {
          if (skipDirs.has(e.name)) continue;
          walk(path.join(dir, e.name), relPrefix ? `${relPrefix}/${e.name}` : e.name, depth + 1);
        } else if (e.isFile()) {
          const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          if (!lowerQ || rel.toLowerCase().includes(lowerQ)) {
            results.push(rel);
          }
        }
      }
    };

    walk(wsPath, "", 0);
    return results.slice(0, limit);
  }

  // =========================================================================
  // Tasks & Transcript Items
  // =========================================================================

  public createTask(input: {
    workspaceId?: string;
    title?: string;
    objective?: string;
    completionCriteria?: string[];
    cwd: string;
    providerId: ProviderId;
    modelId: string;
    thoughtLevel: string;
    permissionMode?: PermissionMode;
    pulseMode?: PulseMode;
    draft?: boolean;
  }): TaskRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const resolvedCwd = path.resolve(input.cwd);

    let wsId = input.workspaceId || "";
    if (!wsId) {
      const foundWs = this.getWorkspaceByPath(resolvedCwd) ?? this.addWorkspace(resolvedCwd);
      wsId = foundWs.id;
    }
    this.touchWorkspace(wsId);

    const cleanObjective = (input.objective ?? "").trim();
    const isDraft = Boolean(input.draft) || cleanObjective.length === 0;
    const title =
      input.title?.trim() ||
      (cleanObjective ? cleanObjective.split(/\r?\n/)[0].slice(0, 64) : "新任务");
    const criteria =
      input.completionCriteria && input.completionCriteria.length > 0
        ? input.completionCriteria
        : ["完整准确地达成用户的任务目标，若修改了代码或文件需完成验证。"];

    const prefs = this.getPreferences();
    const permMode = input.permissionMode ?? prefs.defaultPermissionMode;
    const pulseMode = input.pulseMode ?? "micro-stretch";
    const initialStatus: TaskStatus = isDraft ? "DRAFT" : "IDLE";

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, workspace_id, title, original_objective, completion_criteria_json, steering_json,
          tags_json, cwd, provider_id, model_id, thought_level, permission_mode, pulse_mode,
          status, current_version, pulse_count, total_tokens, latest_state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?)`
      )
      .run(
        id,
        wsId,
        title,
        cleanObjective,
        JSON.stringify(criteria),
        JSON.stringify([]),
        resolvedCwd,
        input.providerId,
        input.modelId,
        input.thoughtLevel,
        permMode,
        pulseMode,
        initialStatus,
        now,
        now
      );

    return this.getTask(id)!;
  }

  public promoteDraftObjective(taskId: string, firstMessage: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.originalObjective.trim().length > 0 && task.status !== "DRAFT") {
      return task;
    }
    const clean = firstMessage.trim();
    const nextTitle =
      task.title === "新任务" || task.title === "New Task" || !task.title.trim()
        ? clean.split(/\r?\n/)[0].slice(0, 64) || task.title
        : task.title;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, original_objective = ?, status = 'IDLE', updated_at = ? WHERE id = ?`
      )
      .run(nextTitle, clean, now, taskId);
    return this.getTask(taskId)!;
  }

  public listTasks(workspaceId?: string): TaskRecord[] {
    const rows = workspaceId
      ? (this.db
          .prepare(`SELECT * FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC`)
          .all(workspaceId) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM tasks ORDER BY updated_at DESC`)
          .all() as Record<string, unknown>[]);
    return rows.map((r) => this.mapTaskRow(r));
  }

  public getTask(taskId: string): TaskRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapTaskRow(row) : null;
  }

  public updateTaskStatus(taskId: string, status: TaskStatus): TaskRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, taskId);
    return this.getTask(taskId)!;
  }

  public updateTaskMeta(
    taskId: string,
    patch: {
      title?: string;
      tags?: string[];
      permissionMode?: PermissionMode;
      providerId?: ProviderId;
      modelId?: string;
      thoughtLevel?: string;
      pulseMode?: PulseMode;
    }
  ): TaskRecord {
    const cur = this.getTask(taskId);
    if (!cur) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET
           title = ?,
           tags_json = ?,
           permission_mode = ?,
           provider_id = ?,
           model_id = ?,
           thought_level = ?,
           pulse_mode = ?,
           updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.title?.trim() || cur.title,
        JSON.stringify(patch.tags ?? cur.tags),
        patch.permissionMode ?? cur.permissionMode,
        patch.providerId ?? cur.providerId,
        patch.modelId ?? cur.modelId,
        patch.thoughtLevel ?? cur.thoughtLevel,
        patch.pulseMode ?? cur.pulseMode,
        now,
        taskId
      );
    return this.getTask(taskId)!;
  }

  public updateTaskProvider(
    taskId: string,
    providerId: ProviderId,
    modelId: string,
    thoughtLevel: string,
    pulseMode?: PulseMode
  ): TaskRecord {
    return this.updateTaskMeta(taskId, { providerId, modelId, thoughtLevel, pulseMode });
  }

  public addSteeringDirective(taskId: string, directiveText: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const entry: SteeringDirective = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      directive: directiveText.trim(),
    };
    const updated = [...task.steeringDirectives, entry];
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE tasks SET steering_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(updated), now, taskId);
    return this.getTask(taskId)!;
  }

  public removeSteeringDirective(taskId: string, directiveId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const updated = task.steeringDirectives.filter((d) => d.id !== directiveId);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE tasks SET steering_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(updated), now, taskId);
    return this.getTask(taskId)!;
  }

  public upsertTaskItem(taskId: string, item: TranscriptItem): TranscriptItem {
    const existing = this.db
      .prepare(`SELECT seq FROM task_items WHERE id = ?`)
      .get(item.id) as { seq: number } | undefined;
    if (existing) {
      this.db
        .prepare(`UPDATE task_items SET item_json = ? WHERE id = ?`)
        .run(JSON.stringify(item), item.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO task_items (id, task_id, kind, item_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(item.id, taskId, item.kind, JSON.stringify(item), item.createdAt);
    }
    return item;
  }

  public listTaskItems(taskId: string): TranscriptItem[] {
    const rows = this.db
      .prepare(`SELECT item_json FROM task_items WHERE task_id = ? ORDER BY seq ASC`)
      .all(taskId) as Array<{ item_json: string }>;
    return rows.map((r) => JSON.parse(r.item_json) as TranscriptItem);
  }

  public appendEvent(taskId: string, type: AventEventType, payload: string): AventEvent {
    const event: AventEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO events (id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(event.id, event.taskId, event.type, event.payload, event.createdAt);
    this.db
      .prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`)
      .run(event.createdAt, taskId);
    return event;
  }

  public listEvents(taskId: string): AventEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      type: String(r.type) as AventEventType,
      payload: String(r.payload),
      createdAt: String(r.created_at),
    }));
  }

  public createPulse(input: {
    taskId: string;
    providerId: ProviderId;
    modelId: string;
    maxActions: number;
    netTokenLimit: number;
  }): PulseRecord {
    const task = this.getTask(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    const pulseNumber = task.pulseCount + 1;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(`UPDATE tasks SET pulse_count = ?, status = 'PULSING', updated_at = ? WHERE id = ?`)
      .run(pulseNumber, now, input.taskId);
    this.touchWorkspace(task.workspaceId);

    this.db
      .prepare(
        `INSERT INTO pulses (
          id, task_id, pulse_number, provider_id, model_id, status,
          action_count, max_actions, baseline_tokens, net_tokens, net_token_limit,
          peak_total_tokens, session_closed, started_at
        ) VALUES (?, ?, ?, ?, ?, 'RUNNING', 0, ?, 0, 0, ?, 0, 0, ?)`
      )
      .run(
        id,
        input.taskId,
        pulseNumber,
        input.providerId,
        input.modelId,
        input.maxActions,
        input.netTokenLimit,
        now
      );

    const taskArchiveDir = path.join(this.archiveDir, input.taskId);
    mkdirSync(taskArchiveDir, { recursive: true });

    return this.getPulse(id)!;
  }

  public updatePulseTelemetry(
    pulseId: string,
    telemetry: {
      actionCount: number;
      baselineTokens: number;
      netTokens: number;
      peakTotalTokens: number;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE pulses SET action_count = ?, baseline_tokens = ?, net_tokens = ?, peak_total_tokens = ? WHERE id = ?`
      )
      .run(
        telemetry.actionCount,
        telemetry.baselineTokens,
        telemetry.netTokens,
        telemetry.peakTotalTokens,
        pulseId
      );
  }

  public appendPulseTrace(taskId: string, pulseNumber: number, entry: PulseTraceEntry): void {
    const taskArchiveDir = path.join(this.archiveDir, taskId);
    mkdirSync(taskArchiveDir, { recursive: true });
    const archiveFile = path.join(
      taskArchiveDir,
      `pulse_${String(pulseNumber).padStart(4, "0")}.jsonl`
    );
    appendFileSync(archiveFile, JSON.stringify(entry) + "\n", "utf8");
  }

  public readPulseTraces(taskId: string, pulseNumber: number): PulseTraceEntry[] {
    const archiveFile = path.join(
      this.archiveDir,
      taskId,
      `pulse_${String(pulseNumber).padStart(4, "0")}.jsonl`
    );
    if (!existsSync(archiveFile)) return [];
    const lines = readFileSync(archiveFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    const entries: PulseTraceEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as PulseTraceEntry);
      } catch {
        // skip malformed
      }
    }
    return entries;
  }

  public finishPulse(
    pulseId: string,
    result: {
      status: "COMMITTED" | "FAILED" | "CANCELLED";
      sessionClosed: boolean;
      resultStateVersion: number | null;
      deliverableSummary: string;
      errorMessage?: string | null;
      inputTokens?: number;
      outputTokens?: number;
    }
  ): PulseRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pulses SET
          status = ?,
          session_closed = ?,
          result_state_version = ?,
          deliverable_summary = ?,
          error_message = ?,
          ended_at = ?
        WHERE id = ?`
      )
      .run(
        result.status,
        result.sessionClosed ? 1 : 0,
        result.resultStateVersion,
        result.deliverableSummary,
        result.errorMessage ?? null,
        now,
        pulseId
      );

    const pulse = this.getPulse(pulseId)!;
    const inTok = Math.max(0, result.inputTokens ?? Math.round(pulse.netTokens * 0.65));
    const outTok = Math.max(0, result.outputTokens ?? Math.round(pulse.netTokens * 0.35));
    if (inTok + outTok > 0) {
      const task = this.getTask(pulse.taskId);
      if (task) {
        this.recordUsage({
          workspaceId: task.workspaceId,
          taskId: task.id,
          providerId: pulse.providerId,
          modelId: pulse.modelId,
          inputTokens: inTok,
          outputTokens: outTok,
        });
      }
    }

    return pulse;
  }

  public getPulse(pulseId: string): PulseRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM pulses WHERE id = ?`)
      .get(pulseId) as Record<string, unknown> | undefined;
    return row ? this.mapPulseRow(row) : null;
  }

  public listPulses(taskId: string, includeTraces = false): PulseRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM pulses WHERE task_id = ? ORDER BY pulse_number ASC`)
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => {
      const rec = this.mapPulseRow(r);
      if (includeTraces) {
        rec.traces = this.readPulseTraces(taskId, rec.pulseNumber);
      }
      return rec;
    });
  }

  public commitSemanticState(
    taskId: string,
    pulseNumber: number,
    providerId: ProviderId,
    modelId: string,
    draft: Omit<SemanticState, "version" | "pulseNumber" | "providerId" | "modelId" | "createdAt">
  ): SemanticState {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const nextVersion = task.currentVersion + 1;
    const now = new Date().toISOString();

    const fullState: SemanticState = {
      ...draft,
      version: nextVersion,
      pulseNumber,
      providerId,
      modelId,
      createdAt: now,
    };

    const nextTaskStatus: TaskStatus =
      draft.status === "COMPLETED"
        ? "COMPLETED"
        : draft.status === "WAITING_HUMAN"
          ? "WAITING_HUMAN"
          : draft.status === "FAILED"
            ? "FAILED"
            : "PULSING";

    this.db
      .prepare(
        `INSERT INTO semantic_states (
          task_id, version, pulse_number, provider_id, model_id, status, state_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        nextVersion,
        pulseNumber,
        providerId,
        modelId,
        fullState.status,
        JSON.stringify(fullState),
        now
      );

    this.db
      .prepare(
        `UPDATE tasks SET current_version = ?, latest_state_json = ?, status = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextVersion, JSON.stringify(fullState), nextTaskStatus, now, taskId);

    return fullState;
  }

  public listStates(taskId: string): SemanticState[] {
    const rows = this.db
      .prepare(`SELECT state_json FROM semantic_states WHERE task_id = ? ORDER BY version ASC`)
      .all(taskId) as Array<{ state_json: string }>;
    return rows.map((r) => JSON.parse(r.state_json) as SemanticState);
  }

  public deleteTask(taskId: string): void {
    this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
  }

  // =========================================================================
  // MCP Servers
  // =========================================================================

  public listMcpServers(workspaceId?: string): McpServerRecord[] {
    const builtInAvent: McpServerRecord = {
      id: "builtin:avent-state",
      name: "avent",
      scope: "global",
      transport: "stdio",
      enabled: true,
      builtIn: true,
      command: process.execPath,
      args: ["dist/avent-mcp.mjs"],
      status: "ready",
      updatedAt: new Date().toISOString(),
      tools: [
        {
          name: "avent_commit_state",
          description: "提交并沉淀当前任务的结构化状态记忆（事实、修改记录、排除项与剩余计划）",
          readOnly: false,
        },
        {
          name: "avent_doc_read",
          description: "按行区间精准读取文件片段（自动控制单次读取体量）",
          readOnly: true,
        },
        {
          name: "avent_doc_grep",
          description: "基于 Ripgrep 的高速代码与转存片段检索",
          readOnly: true,
        },
        {
          name: "avent_history_grep",
          description: "按需检索该任务过往归档的原始执行日志",
          readOnly: true,
        },
      ],
    };

    const rows = this.db
      .prepare(`SELECT * FROM mcp_servers ORDER BY scope ASC, name ASC`)
      .all() as Record<string, unknown>[];

    const dbRecords = rows
      .filter((r) => !workspaceId || r.scope === "global" || r.workspace_id === workspaceId)
      .map((r) => this.mapMcpRow(r));

    // Also discover `.mcp.json` inside the selected workspace if present
    const discovered: McpServerRecord[] = [];
    if (workspaceId) {
      const ws = this.getWorkspace(workspaceId);
      if (ws) {
        const mcpJsonPath = path.join(ws.path, ".mcp.json");
        if (existsSync(mcpJsonPath)) {
          try {
            const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8")) as {
              mcpServers?: Record<string, Record<string, unknown>>;
            };
            for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
              if (dbRecords.some((d) => d.name === name && d.workspaceId === workspaceId)) continue;
              discovered.push({
                id: `file:${workspaceId}:${name}`,
                name,
                scope: "workspace",
                workspaceId,
                transport: cfg.url ? (cfg.type === "sse" ? "sse" : "http") : "stdio",
                enabled: true,
                fromFile: ".mcp.json",
                command: typeof cfg.command === "string" ? cfg.command : undefined,
                args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
                url: typeof cfg.url === "string" ? cfg.url : undefined,
                status: "idle",
                tools: [],
                updatedAt: new Date().toISOString(),
              });
            }
          } catch {
            // ignore malformed .mcp.json
          }
        }
      }
    }

    return [builtInAvent, ...dbRecords, ...discovered];
  }

  public saveMcpServer(input: {
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
  }): McpServerRecord {
    const id = input.id && !input.id.startsWith("builtin:") ? input.id : crypto.randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled !== false ? 1 : 0;
    const status = enabled ? "idle" : "disabled";

    const existing = this.db
      .prepare(`SELECT id FROM mcp_servers WHERE id = ?`)
      .get(id) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE mcp_servers SET
             name = ?, scope = ?, workspace_id = ?, transport = ?, enabled = ?,
             command = ?, args_json = ?, env_json = ?, url = ?, headers_json = ?,
             status = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name.trim(),
          input.scope,
          input.scope === "workspace" ? input.workspaceId ?? null : null,
          input.transport,
          enabled,
          input.command ?? null,
          JSON.stringify(input.args ?? []),
          JSON.stringify(input.env ?? {}),
          input.url ?? null,
          JSON.stringify(input.headers ?? {}),
          status,
          now,
          id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO mcp_servers (
             id, name, scope, workspace_id, transport, enabled,
             command, args_json, env_json, url, headers_json, status, tools_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
        )
        .run(
          id,
          input.name.trim(),
          input.scope,
          input.scope === "workspace" ? input.workspaceId ?? null : null,
          input.transport,
          enabled,
          input.command ?? null,
          JSON.stringify(input.args ?? []),
          JSON.stringify(input.env ?? {}),
          input.url ?? null,
          JSON.stringify(input.headers ?? {}),
          status,
          now
        );
    }

    const row = this.db
      .prepare(`SELECT * FROM mcp_servers WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return this.mapMcpRow(row);
  }

  public updateMcpProbeResult(
    id: string,
    probe: { status: McpServerRecord["status"]; tools: McpToolSummary[]; errorMessage?: string }
  ): McpServerRecord | null {
    if (id.startsWith("builtin:") || id.startsWith("file:")) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mcp_servers SET status = ?, tools_json = ?, error_message = ?, updated_at = ? WHERE id = ?`
      )
      .run(probe.status, JSON.stringify(probe.tools), probe.errorMessage ?? null, now, id);
    const row = this.db
      .prepare(`SELECT * FROM mcp_servers WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMcpRow(row) : null;
  }

  public setMcpEnabled(id: string, enabled: boolean): McpServerRecord | null {
    if (id.startsWith("builtin:")) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE mcp_servers SET enabled = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, enabled ? "idle" : "disabled", now, id);
    const row = this.db
      .prepare(`SELECT * FROM mcp_servers WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMcpRow(row) : null;
  }

  public deleteMcpServer(id: string): void {
    if (id.startsWith("builtin:")) return;
    this.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
  }

  private mapMcpRow(r: Record<string, unknown>): McpServerRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      scope: String(r.scope) as "global" | "workspace",
      workspaceId: r.workspace_id ? String(r.workspace_id) : undefined,
      transport: String(r.transport) as McpServerRecord["transport"],
      enabled: Number(r.enabled) === 1,
      command: r.command ? String(r.command) : undefined,
      args: r.args_json ? (JSON.parse(String(r.args_json)) as string[]) : undefined,
      env: r.env_json ? (JSON.parse(String(r.env_json)) as Record<string, string>) : undefined,
      url: r.url ? String(r.url) : undefined,
      headers: r.headers_json
        ? (JSON.parse(String(r.headers_json)) as Record<string, string>)
        : undefined,
      status: String(r.status) as McpServerRecord["status"],
      errorMessage: r.error_message ? String(r.error_message) : undefined,
      tools: r.tools_json ? (JSON.parse(String(r.tools_json)) as McpToolSummary[]) : [],
      updatedAt: String(r.updated_at),
    };
  }

  // =========================================================================
  // Skills & Instructions
  // =========================================================================

  public listSkills(workspaceId?: string): SkillRecord[] {
    const out: SkillRecord[] = [...BUILTIN_SKILLS];

    const loadDir = (
      dir: string,
      scope: "global" | "workspace",
      wsId?: string,
      editable = true
    ) => {
      if (!existsSync(dir)) return;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const full = path.join(dir, file);
        try {
          const st = statSync(full);
          if (!st.isFile()) continue;
          const raw = readFileSync(full, "utf8");
          const parsed = parseSkillMarkdown(raw, path.basename(file, ".md"));
          out.push({
            id: `${scope}:${wsId || "global"}:${parsed.name}`,
            name: parsed.name,
            description: parsed.description,
            argumentHint: parsed.argumentHint,
            scope,
            workspaceId: wsId,
            filePath: full,
            content: raw,
            editable,
            updatedAt: st.mtime.toISOString(),
          });
        } catch {
          // ignore unreadable skill
        }
      }
    };

    loadDir(this.globalSkillsDir, "global");

    if (workspaceId) {
      const ws = this.getWorkspace(workspaceId);
      if (ws) {
        loadDir(path.join(ws.path, ".avent", "skills"), "workspace", workspaceId, true);
        loadDir(path.join(ws.path, ".claude", "commands"), "workspace", workspaceId, true);
      }
    }

    return out;
  }

  public saveSkill(input: {
    name: string;
    description: string;
    argumentHint?: string;
    scope: "global" | "workspace";
    workspaceId?: string;
    body: string;
  }): SkillRecord {
    const slug = input.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug) throw new Error("技能名称需包含字母或数字（如 code-check）");

    let targetDir = this.globalSkillsDir;
    if (input.scope === "workspace" && input.workspaceId) {
      const ws = this.getWorkspace(input.workspaceId);
      if (!ws) throw new Error("未找到目标工作区");
      targetDir = path.join(ws.path, ".avent", "skills");
    }
    mkdirSync(targetDir, { recursive: true });
    const fullPath = path.join(targetDir, `${slug}.md`);

    const hasFrontmatter = input.body.trimStart().startsWith("---");
    const fullMarkdown = hasFrontmatter
      ? input.body
      : [
          "---",
          `description: ${input.description.trim() || slug}`,
          ...(input.argumentHint?.trim() ? [`argument-hint: ${input.argumentHint.trim()}`] : []),
          "---",
          "",
          input.body.trim(),
          "",
        ].join("\n");

    writeFileSync(fullPath, fullMarkdown, "utf8");
    const st = statSync(fullPath);
    const parsed = parseSkillMarkdown(fullMarkdown, slug);
    return {
      id: `${input.scope}:${input.workspaceId || "global"}:${slug}`,
      name: slug,
      description: parsed.description,
      argumentHint: parsed.argumentHint,
      scope: input.scope,
      workspaceId: input.workspaceId,
      filePath: fullPath,
      content: fullMarkdown,
      editable: true,
      updatedAt: st.mtime.toISOString(),
    };
  }

  public deleteSkill(skillId: string): boolean {
    const parts = skillId.split(":");
    if (parts.length < 3 || parts[0] === "builtin") return false;
    const [scope, wsId, name] = parts;
    const skills = this.listSkills(scope === "workspace" ? wsId : undefined);
    const match = skills.find((s) => s.id === skillId || (s.scope === scope && s.name === name));
    if (match?.filePath && existsSync(match.filePath)) {
      unlinkSync(match.filePath);
      return true;
    }
    return false;
  }

  public getInstructions(scope: "global" | "workspace", workspaceId?: string): InstructionDoc {
    if (scope === "global") {
      const fp = path.join(this.dataDir, "AVENT.md");
      const exists = existsSync(fp);
      return {
        scope: "global",
        filePath: fp,
        exists,
        content: exists ? readFileSync(fp, "utf8") : "",
      };
    }

    const ws = workspaceId ? this.getWorkspace(workspaceId) : null;
    if (!ws) {
      throw new Error("未选择有效工作区");
    }
    const fp = path.join(ws.path, "AVENT.md");
    const exists = existsSync(fp);
    const candidates = ["AVENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"];
    const discoveredFiles: Array<{ name: string; path: string; size: number }> = [];
    for (const c of candidates) {
      const cp = path.join(ws.path, c);
      if (existsSync(cp)) {
        try {
          discoveredFiles.push({ name: c, path: cp, size: statSync(cp).size });
        } catch {
          // ignore
        }
      }
    }

    return {
      scope: "workspace",
      workspaceId: ws.id,
      filePath: fp,
      exists,
      content: exists ? readFileSync(fp, "utf8") : "",
      discoveredFiles,
    };
  }

  public saveInstructions(
    scope: "global" | "workspace",
    content: string,
    workspaceId?: string
  ): InstructionDoc {
    const doc = this.getInstructions(scope, workspaceId);
    mkdirSync(path.dirname(doc.filePath), { recursive: true });
    writeFileSync(doc.filePath, content, "utf8");
    return this.getInstructions(scope, workspaceId);
  }

  /**
   * Collects merged global + workspace instructions (bounded to 4000 chars) to inject into task prompts.
   */
  public loadCombinedInstructionsForWorkspace(cwd: string): string {
    const blocks: string[] = [];
    const globalFile = path.join(this.dataDir, "AVENT.md");
    if (existsSync(globalFile)) {
      const txt = readFileSync(globalFile, "utf8").trim();
      if (txt) blocks.push(`[Global AVENT.md]\n${txt.slice(0, 1500)}`);
    }

    for (const name of ["AVENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const fp = path.join(cwd, name);
      if (existsSync(fp)) {
        try {
          const txt = readFileSync(fp, "utf8").trim();
          if (txt) blocks.push(`[Workspace ${name}]\n${txt.slice(0, 2000)}`);
        } catch {
          // ignore
        }
      }
    }
    return blocks.join("\n\n").slice(0, 4000);
  }

  // =========================================================================
  // Permission Rules
  // =========================================================================

  public listPermissionRules(workspaceId?: string): PermissionRuleRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM permission_rules ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows
      .filter((r) => !workspaceId || r.scope === "global" || r.workspace_id === workspaceId)
      .map((r) => ({
        id: String(r.id),
        behavior: String(r.behavior) as PermissionRuleRecord["behavior"],
        rule: String(r.rule),
        scope: String(r.scope) as PermissionRuleRecord["scope"],
        workspaceId: r.workspace_id ? String(r.workspace_id) : undefined,
        note: r.note ? String(r.note) : undefined,
        createdAt: String(r.created_at),
      }));
  }

  public addPermissionRule(input: {
    behavior: "allow" | "ask" | "deny";
    rule: string;
    scope: "global" | "workspace";
    workspaceId?: string;
    note?: string;
  }): PermissionRuleRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, behavior, rule, scope, workspace_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.behavior,
        input.rule.trim(),
        input.scope,
        input.scope === "workspace" ? input.workspaceId ?? null : null,
        input.note?.trim() ?? null,
        now
      );
    return {
      id,
      behavior: input.behavior,
      rule: input.rule.trim(),
      scope: input.scope,
      workspaceId: input.scope === "workspace" ? input.workspaceId : undefined,
      note: input.note?.trim(),
      createdAt: now,
    };
  }

  public deletePermissionRule(id: string): void {
    this.db.prepare(`DELETE FROM permission_rules WHERE id = ?`).run(id);
  }

  // =========================================================================
  // Usage Ledger & Analytics
  // =========================================================================

  public recordUsage(entry: {
    workspaceId: string;
    taskId: string;
    providerId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
  }): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const total = entry.inputTokens + entry.outputTokens;
    this.db
      .prepare(
        `INSERT INTO usage_ledger (
           id, day, workspace_id, task_id, provider_id, model_id, input_tokens, output_tokens, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        day,
        entry.workspaceId,
        entry.taskId,
        entry.providerId,
        entry.modelId,
        entry.inputTokens,
        entry.outputTokens,
        now.toISOString()
      );
    this.db
      .prepare(`UPDATE tasks SET total_tokens = total_tokens + ? WHERE id = ?`)
      .run(total, entry.taskId);
  }

  public getUsageReport(range: "7d" | "30d" | "all", workspaceId?: string): UsageReport {
    const daysCount = range === "7d" ? 7 : range === "30d" ? 30 : 14;
    const cutoffDate =
      range === "all"
        ? "1970-01-01"
        : new Date(Date.now() - (daysCount - 1) * 86400_000).toISOString().slice(0, 10);

    const rows = (
      workspaceId
        ? this.db
            .prepare(`SELECT * FROM usage_ledger WHERE day >= ? AND workspace_id = ?`)
            .all(cutoffDate, workspaceId)
        : this.db.prepare(`SELECT * FROM usage_ledger WHERE day >= ?`).all(cutoffDate)
    ) as Array<Record<string, unknown>>;

    // Pre-seed continuous calendar days so chart always looks crisp
    const dayMap = new Map<string, UsageDayBucket>();
    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      dayMap.set(d, {
        day: d,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        byProvider: {},
      });
    }

    let totalIn = 0;
    let totalOut = 0;
    const wsAgg = new Map<
      string,
      { tasks: Set<string>; turns: number; inTok: number; outTok: number }
    >();
    const modelAgg = new Map<
      string,
      { providerId: string; modelId: string; tasks: Set<string>; turns: number; inTok: number; outTok: number }
    >();

    for (const r of rows) {
      const day = String(r.day);
      const wsId = String(r.workspace_id);
      const tid = String(r.task_id);
      const pid = String(r.provider_id);
      const mid = String(r.model_id);
      const inT = Number(r.input_tokens || 0);
      const outT = Number(r.output_tokens || 0);
      const sum = inT + outT;

      totalIn += inT;
      totalOut += outT;

      let bucket = dayMap.get(day);
      if (!bucket) {
        bucket = { day, inputTokens: 0, outputTokens: 0, totalTokens: 0, byProvider: {} };
        dayMap.set(day, bucket);
      }
      bucket.inputTokens += inT;
      bucket.outputTokens += outT;
      bucket.totalTokens += sum;
      bucket.byProvider[pid] = (bucket.byProvider[pid] ?? 0) + sum;

      const wEntry = wsAgg.get(wsId) ?? { tasks: new Set(), turns: 0, inTok: 0, outTok: 0 };
      wEntry.tasks.add(tid);
      wEntry.turns += 1;
      wEntry.inTok += inT;
      wEntry.outTok += outT;
      wsAgg.set(wsId, wEntry);

      const mKey = `${pid}:${mid}`;
      const mEntry = modelAgg.get(mKey) ?? {
        providerId: pid,
        modelId: mid,
        tasks: new Set(),
        turns: 0,
        inTok: 0,
        outTok: 0,
      };
      mEntry.tasks.add(tid);
      mEntry.turns += 1;
      mEntry.inTok += inT;
      mEntry.outTok += outT;
      modelAgg.set(mKey, mEntry);
    }

    const wsLookup = new Map(this.listWorkspaces().map((w) => [w.id, w]));
    const byWorkspace: UsageBreakdownRow[] = [...wsAgg.entries()]
      .map(([wsId, v]) => ({
        key: wsId,
        label: wsLookup.get(wsId)?.name || "未命名工作区",
        subLabel: wsLookup.get(wsId)?.path,
        tasks: v.tasks.size,
        turns: v.turns,
        inputTokens: v.inTok,
        outputTokens: v.outTok,
        totalTokens: v.inTok + v.outTok,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const byModel: UsageBreakdownRow[] = [...modelAgg.values()]
      .map((v) => ({
        key: `${v.providerId}:${v.modelId}`,
        label: v.modelId,
        subLabel:
          v.providerId === "agy"
            ? "Google AI"
            : v.providerId === "claude"
              ? "Claude Code"
              : "OpenAI Codex",
        tasks: v.tasks.size,
        turns: v.turns,
        inputTokens: v.inTok,
        outputTokens: v.outTok,
        totalTokens: v.inTok + v.outTok,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const allTasks = this.listTasks(workspaceId);
    const completedCount = allTasks.filter((t) => t.status === "COMPLETED").length;

    return {
      range,
      totals: {
        totalTokens: totalIn + totalOut,
        inputTokens: totalIn,
        outputTokens: totalOut,
        taskCount: allTasks.filter((t) => t.status !== "DRAFT").length,
        completedCount,
        turnCount: rows.length,
      },
      days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
      byWorkspace,
      byModel,
    };
  }

  // =========================================================================
  // Preferences & Compatible Endpoints
  // =========================================================================

  public getPreferences(): AppPreferences {
    const row = this.db
      .prepare(`SELECT value_json FROM prefs WHERE key = 'app_preferences'`)
      .get() as { value_json: string } | undefined;
    if (!row) return { ...DEFAULT_PREFS };
    try {
      return { ...DEFAULT_PREFS, ...(JSON.parse(row.value_json) as Partial<AppPreferences>) };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  public savePreferences(patch: Partial<AppPreferences>): AppPreferences {
    const merged: AppPreferences = { ...this.getPreferences(), ...patch };
    this.db
      .prepare(
        `INSERT INTO prefs (key, value_json) VALUES ('app_preferences', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(JSON.stringify(merged));
    return merged;
  }

  public listCompatibleEndpoints(): CompatibleEndpointRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM compatible_endpoints ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      baseUrl: String(r.base_url),
      apiKeyHint: String(r.api_key_hint),
      models: JSON.parse(String(r.models_json)) as string[],
      enabled: Number(r.enabled) === 1,
      createdAt: String(r.created_at),
    }));
  }

  public addCompatibleEndpoint(input: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    models: string[];
  }): CompatibleEndpointRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const key = (input.apiKey ?? "").trim();
    const hint = key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : key ? "已设置" : "未设置";
    this.db
      .prepare(
        `INSERT INTO compatible_endpoints (id, name, base_url, api_key_hint, models_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(id, input.name.trim(), input.baseUrl.trim(), hint, JSON.stringify(input.models), now);
    return {
      id,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      apiKeyHint: hint,
      models: input.models,
      enabled: true,
      createdAt: now,
    };
  }

  public deleteCompatibleEndpoint(id: string): void {
    this.db.prepare(`DELETE FROM compatible_endpoints WHERE id = ?`).run(id);
  }

  public close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      this.db.exec("PRAGMA journal_mode = DELETE;");
    } catch {
      // ignore if already closed
    }
    this.db.close();
  }

  // =========================================================================
  // Row Mappers
  // =========================================================================

  private mapTaskRow(r: Record<string, unknown>): TaskRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id || ""),
      title: String(r.title),
      originalObjective: String(r.original_objective),
      completionCriteria: JSON.parse(String(r.completion_criteria_json)) as string[],
      steeringDirectives: JSON.parse(String(r.steering_json)) as SteeringDirective[],
      tags: r.tags_json ? (JSON.parse(String(r.tags_json)) as string[]) : [],
      cwd: String(r.cwd),
      providerId: String(r.provider_id) as ProviderId,
      modelId: String(r.model_id),
      thoughtLevel: String(r.thought_level),
      permissionMode: (r.permission_mode
        ? String(r.permission_mode)
        : "acceptEdits") as PermissionMode,
      pulseMode: String(r.pulse_mode) as PulseMode,
      status: String(r.status) as TaskStatus,
      currentVersion: Number(r.current_version),
      pulseCount: Number(r.pulse_count),
      totalTokens: Number(r.total_tokens || 0),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      latestState: r.latest_state_json
        ? (JSON.parse(String(r.latest_state_json)) as SemanticState)
        : null,
    };
  }

  private mapPulseRow(r: Record<string, unknown>): PulseRecord {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      pulseNumber: Number(r.pulse_number),
      providerId: String(r.provider_id) as ProviderId,
      modelId: String(r.model_id),
      status: String(r.status) as PulseRecord["status"],
      actionCount: Number(r.action_count),
      maxActions: Number(r.max_actions),
      baselineTokens: Number(r.baseline_tokens),
      netTokens: Number(r.net_tokens),
      netTokenLimit: Number(r.net_token_limit),
      peakTotalTokens: Number(r.peak_total_tokens),
      sessionClosed: Number(r.session_closed) === 1,
      resultStateVersion: r.result_state_version !== null ? Number(r.result_state_version) : null,
      deliverableSummary: String(r.deliverable_summary ?? ""),
      errorMessage: r.error_message !== null ? String(r.error_message) : null,
      startedAt: String(r.started_at),
      endedAt: r.ended_at !== null ? String(r.ended_at) : null,
    };
  }
}

function parseSkillMarkdown(
  raw: string,
  fallbackName: string
): { name: string; description: string; argumentHint?: string; body: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!fm) {
    const firstLine = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean);
    return {
      name: fallbackName,
      description: firstLine?.slice(0, 100) || fallbackName,
      body: raw,
    };
  }
  const meta: Record<string, string> = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || fallbackName,
    argumentHint: meta["argument-hint"] || meta.argumentHint,
    body: fm[2].trim(),
  };
}
