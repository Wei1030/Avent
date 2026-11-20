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
import { hasWorkspaceWorktreeInitConfigSync } from "./worktrees.js";
import type {
  AppPreferences,
  AventEvent,
  AventEventType,
  CompatibleEndpointModel,
  CompatibleEndpointRecord,
  EndpointProtocol,
  InstructionDoc,
  McpServerRecord,
  McpToolSummary,
  PermissionMode,
  PermissionRuleRecord,
  PersistedProviderCapabilities,
  ProviderId,
  ProviderQuotaSnapshot,
  PulseMode,
  PulseRecord,
  PulseTraceEntry,
  SemanticState,
  SkillRecord,
  SteeringDirective,
  TaskItemsPageResponse,
  TaskProviderId,
  TaskRecord,
  TaskStatus,
  TranscriptItem,
  UsageBreakdownRow,
  UsageDayBucket,
  UsageReport,
  UsageWindowProviderItem,
  UsageWindowSummary,
  WorkspaceRecord,
} from "../shared/types.js";

const DEFAULT_PREFS: AppPreferences = {
  uiLanguage: "auto",
  defaultProviderId: "agy",
  defaultModelId: "",
  defaultThoughtLevel: "",
  defaultPermissionMode: "bypassPermissions",
  desktopNotifications: true,
  contextNetTokenLimit: 14000,
};

export const MIN_CONTEXT_NET_TOKEN_LIMIT = 4000;
export const MAX_CONTEXT_NET_TOKEN_LIMIT = 200000;

function sanitizeContextNetTokenLimit(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PREFS.contextNetTokenLimit;
  return Math.max(MIN_CONTEXT_NET_TOKEN_LIMIT, Math.min(MAX_CONTEXT_NET_TOKEN_LIMIT, Math.round(n)));
}

export class AventStore {
  public readonly dataDir: string;
  public readonly spillsDir: string;
  public readonly archiveDir: string;
  public readonly globalSkillsDir: string;
  private db: DatabaseSync;
  private gitCache = new Map<
    string,
    { at: number; isGitRepo: boolean; branch?: string; clean?: boolean }
  >();

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
    this.cleanupEmptyDraftTasks();

    if (defaultWorkspacePath) {
      this.ensureDefaultWorkspace(defaultWorkspacePath);
    }
  }

  private cleanupEmptyDraftTasks(): void {
    this.db
      .prepare(
        `DELETE FROM tasks
         WHERE status = 'DRAFT'
           AND id NOT IN (SELECT DISTINCT task_id FROM task_items)`
      )
      .run();
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
        title_source TEXT NOT NULL DEFAULT 'auto',
        original_objective TEXT NOT NULL,
        objective_source TEXT NOT NULL DEFAULT 'auto',
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

      CREATE INDEX IF NOT EXISTS idx_task_items_task_seq ON task_items(task_id, seq);

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
        protocol TEXT NOT NULL DEFAULT 'anthropic',
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
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
    if (!colNames.has("title_source")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';`);
    }
    if (!colNames.has("objective_source")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN objective_source TEXT NOT NULL DEFAULT 'auto';`);
    }
    if (!colNames.has("worktree_path")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';`);
    }
    if (!colNames.has("worktree_branch")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN worktree_branch TEXT NOT NULL DEFAULT '';`);
    }
    if (!colNames.has("worktree_base_branch")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN worktree_base_branch TEXT NOT NULL DEFAULT '';`);
    }
    if (!colNames.has("worktree_base_commit")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN worktree_base_commit TEXT NOT NULL DEFAULT '';`);
    }
    if (!colNames.has("worktree_merged_at")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN worktree_merged_at TEXT NOT NULL DEFAULT '';`);
    }
    if (!colNames.has("worktree_removed")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN worktree_removed INTEGER NOT NULL DEFAULT 0;`);
    }

    const wsCols = this.db
      .prepare(`PRAGMA table_info(workspaces)`)
      .all() as Array<{ name: string }>;
    const wsColNames = new Set(wsCols.map((c) => c.name));
    if (!wsColNames.has("worktree_root")) {
      this.db.exec(`ALTER TABLE workspaces ADD COLUMN worktree_root TEXT NOT NULL DEFAULT '';`);
    }
    if (!wsColNames.has("worktree_setup_command")) {
      this.db.exec(
        `ALTER TABLE workspaces ADD COLUMN worktree_setup_command TEXT NOT NULL DEFAULT '';`
      );
    }
    if (!wsColNames.has("worktree_init_prompt")) {
      this.db.exec(
        `ALTER TABLE workspaces ADD COLUMN worktree_init_prompt TEXT NOT NULL DEFAULT '';`
      );
    }

    const epCols = this.db
      .prepare(`PRAGMA table_info(compatible_endpoints)`)
      .all() as Array<{ name: string }>;
    const epColNames = new Set(epCols.map((c) => c.name));
    if (!epColNames.has("protocol")) {
      this.db.exec(
        `ALTER TABLE compatible_endpoints ADD COLUMN protocol TEXT NOT NULL DEFAULT 'anthropic';`
      );
    }
    if (!epColNames.has("api_key")) {
      this.db.exec(
        `ALTER TABLE compatible_endpoints ADD COLUMN api_key TEXT NOT NULL DEFAULT '';`
      );
    }

    const usageCols = this.db
      .prepare(`PRAGMA table_info(usage_ledger)`)
      .all() as Array<{ name: string }>;
    const usageColNames = new Set(usageCols.map((c) => c.name));
    if (!usageColNames.has("workspace_path")) {
      this.db.exec(
        `ALTER TABLE usage_ledger ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';`
      );
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

    // Self-heal any orphaned usage_ledger rows whose workspace_id pointed to a removed-and-readded workspace
    this.db
      .prepare(
        `UPDATE usage_ledger
         SET workspace_id = (
           SELECT t.workspace_id FROM tasks t WHERE t.id = usage_ledger.task_id
         )
         WHERE (workspace_id = '' OR workspace_id NOT IN (SELECT id FROM workspaces))
           AND task_id IN (
             SELECT id FROM tasks WHERE workspace_id IN (SELECT id FROM workspaces)
           )`
      )
      .run();
    // Backfill workspace_path on usage_ledger for existing valid workspaces
    this.db
      .prepare(
        `UPDATE usage_ledger
         SET workspace_path = (
           SELECT w.path FROM workspaces w WHERE w.id = usage_ledger.workspace_id
         )
         WHERE workspace_path = ''
           AND workspace_id IN (SELECT id FROM workspaces)`
      )
      .run();
    // Re-attach orphaned usage_ledger rows whose stored workspace_path matches a re-added workspace
    this.db
      .prepare(
        `UPDATE usage_ledger
         SET workspace_id = (
           SELECT w.id FROM workspaces w WHERE LOWER(w.path) = LOWER(usage_ledger.workspace_path) LIMIT 1
         )
         WHERE workspace_path != ''
           AND (workspace_id = '' OR workspace_id NOT IN (SELECT id FROM workspaces))
           AND EXISTS (
             SELECT 1 FROM workspaces w WHERE LOWER(w.path) = LOWER(usage_ledger.workspace_path)
           )`
      )
      .run();
  }

  public ensureDefaultWorkspace(wsPath: string): WorkspaceRecord | null {
    const resolved = path.resolve(wsPath);
    const existing = this.db
      .prepare(`SELECT * FROM workspaces WHERE LOWER(path) = LOWER(?)`)
      .get(resolved) as Record<string, unknown> | undefined;

    const seededRow = this.db
      .prepare(`SELECT value_json FROM prefs WHERE key = 'workspace_seeded'`)
      .get() as { value_json: string } | undefined;

    let wsId: string;
    if (existing) {
      wsId = String(existing.id);
      if (!seededRow) {
        this.db
          .prepare(`INSERT OR REPLACE INTO prefs (key, value_json) VALUES ('workspace_seeded', 'true')`)
          .run();
      }
    } else {
      const count = (
        this.db.prepare(`SELECT COUNT(*) as cnt FROM workspaces`).get() as { cnt: number }
      ).cnt;
      if (count > 0) {
        if (!seededRow) {
          this.db
            .prepare(`INSERT OR REPLACE INTO prefs (key, value_json) VALUES ('workspace_seeded', 'true')`)
            .run();
        }
        const first = this.db
          .prepare(`SELECT * FROM workspaces ORDER BY pinned DESC, last_active_at DESC LIMIT 1`)
          .get() as Record<string, unknown>;
        return this.mapWorkspaceRow(first);
      }
      if (seededRow) {
        // User intentionally removed all workspaces; honor empty workspace list across restarts.
        return null;
      }
      const created = this.addWorkspace(resolved);
      this.db
        .prepare(`INSERT OR REPLACE INTO prefs (key, value_json) VALUES ('workspace_seeded', 'true')`)
        .run();
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
    this.db
      .prepare(`INSERT OR REPLACE INTO prefs (key, value_json) VALUES ('workspace_seeded', 'true')`)
      .run();
    // Collect orphaned old workspace_ids belonging to this folder before re-attaching tasks
    const oldWsRows = this.db
      .prepare(
        `SELECT DISTINCT workspace_id FROM tasks
         WHERE LOWER(cwd) = LOWER(?)
           AND workspace_id != ''
           AND workspace_id NOT IN (SELECT id FROM workspaces)`
      )
      .all(resolved) as Array<{ workspace_id: string }>;

    // Re-attach any historical tasks for this folder whose workspace entry was previously removed
    this.db
      .prepare(
        `UPDATE tasks
         SET workspace_id = ?
         WHERE LOWER(cwd) = LOWER(?)
           AND (workspace_id = '' OR workspace_id NOT IN (SELECT id FROM workspaces))`
      )
      .run(id, resolved);
    // Re-attach usage_ledger entries belonging to those re-attached tasks, old workspace_ids, or stored workspace_path
    this.db
      .prepare(
        `UPDATE usage_ledger
         SET workspace_id = ?, workspace_path = ?
         WHERE (task_id IN (SELECT id FROM tasks WHERE workspace_id = ?) OR LOWER(workspace_path) = LOWER(?))
           AND workspace_id != ?`
      )
      .run(id, resolved, id, resolved, id);
    for (const oldRow of oldWsRows) {
      this.db
        .prepare(
          `UPDATE usage_ledger
           SET workspace_id = ?, workspace_path = ?
           WHERE workspace_id = ?`
        )
        .run(id, resolved, oldRow.workspace_id);
    }
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

  public updateWorkspace(
    id: string,
    patch: {
      pinned?: boolean;
      name?: string;
      worktreeRoot?: string;
      worktreeSetupCommand?: string;
      worktreeInitPrompt?: string;
    }
  ): WorkspaceRecord | null {
    const ws = this.getWorkspace(id);
    if (!ws) return null;
    const nextPinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : ws.pinned ? 1 : 0;
    const nextName = patch.name?.trim() || ws.name;
    const nextWtRoot =
      patch.worktreeRoot !== undefined ? patch.worktreeRoot.trim() : ws.worktreeRoot || "";
    const nextWtCmd =
      patch.worktreeSetupCommand !== undefined
        ? patch.worktreeSetupCommand.trim()
        : ws.worktreeSetupCommand || "";
    const nextWtPrompt =
      patch.worktreeInitPrompt !== undefined
        ? patch.worktreeInitPrompt.trim()
        : ws.worktreeInitPrompt || "";
    this.db
      .prepare(
        `UPDATE workspaces
         SET pinned = ?, name = ?, worktree_root = ?, worktree_setup_command = ?, worktree_init_prompt = ?
         WHERE id = ?`
      )
      .run(nextPinned, nextName, nextWtRoot, nextWtCmd, nextWtPrompt, id);
    return this.getWorkspace(id);
  }

  public clearLegacyWorktreeDbConfig(id: string): void {
    this.db
      .prepare(
        `UPDATE workspaces SET worktree_setup_command = '', worktree_init_prompt = '' WHERE id = ?`
      )
      .run(id);
  }

  public invalidateGitCache(wsPath?: string): void {
    if (wsPath) this.gitCache.delete(wsPath);
    else this.gitCache.clear();
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

  private getGitMeta(wsPath: string): { isGitRepo: boolean; branch?: string; clean?: boolean } {
    const cached = this.gitCache.get(wsPath);
    const now = Date.now();
    if (cached && now - cached.at < 10000) {
      return { isGitRepo: cached.isGitRepo, branch: cached.branch, clean: cached.clean };
    }
    const gitEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
    try {
      const check = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: wsPath,
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
        env: gitEnv,
      });
      if (check.status !== 0 || check.stdout.trim() !== "true") {
        this.gitCache.set(wsPath, { at: now, isGitRepo: false });
        return { isGitRepo: false };
      }
      const br = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: wsPath,
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
        env: gitEnv,
      });
      const branch = br.status === 0 ? br.stdout.trim() : undefined;
      const st = spawnSync("git", ["status", "--porcelain"], {
        cwd: wsPath,
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
        env: gitEnv,
      });
      const clean = st.status === 0 ? st.stdout.trim().length === 0 : undefined;
      this.gitCache.set(wsPath, { at: now, isGitRepo: true, branch, clean });
      return { isGitRepo: true, branch, clean };
    } catch {
      this.gitCache.set(wsPath, { at: now, isGitRepo: false });
      return { isGitRepo: false };
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
         FROM tasks WHERE workspace_id = ? AND status != 'DRAFT'`
      )
      .get(id) as { total: number; running: number | null };
    const git = this.getGitMeta(wsPath);
    const legacySetup = r.worktree_setup_command ? String(r.worktree_setup_command) : undefined;
    const legacyPrompt = r.worktree_init_prompt ? String(r.worktree_init_prompt) : undefined;
    const hasWorktreeInitConfig = hasWorkspaceWorktreeInitConfigSync(wsPath, {
      setupCommand: legacySetup,
      initPrompt: legacyPrompt,
    });
    return {
      id,
      name: String(r.name),
      path: wsPath,
      pinned: Number(r.pinned) === 1,
      isGitRepo: git.isGitRepo,
      branch: git.branch,
      gitClean: git.clean,
      worktreeRoot: r.worktree_root ? String(r.worktree_root) : undefined,
      hasWorktreeInitConfig,
      worktreeSetupCommand: legacySetup,
      worktreeInitPrompt: legacyPrompt,
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
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    worktreeBaseCommit?: string;
    providerId: TaskProviderId;
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
    const explicitTitle = input.title?.trim() || "";
    const title = explicitTitle || "新任务";
    const titleSource = explicitTitle ? "user" : "auto";
    const objectiveSource = "auto";
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
          id, workspace_id, title, title_source, original_objective, objective_source,
          completion_criteria_json, steering_json,
          tags_json, cwd, worktree_path, worktree_branch, worktree_base_branch, worktree_base_commit,
          worktree_merged_at, worktree_removed,
          provider_id, model_id, thought_level, permission_mode, pulse_mode,
          status, current_version, pulse_count, total_tokens, latest_state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?)`
      )
      .run(
        id,
        wsId,
        title,
        titleSource,
        cleanObjective,
        objectiveSource,
        JSON.stringify(criteria),
        JSON.stringify([]),
        resolvedCwd,
        input.worktreePath?.trim() || "",
        input.worktreeBranch?.trim() || "",
        input.worktreeBaseBranch?.trim() || "",
        input.worktreeBaseCommit?.trim() || "",
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

  public updateTaskWorktree(
    taskId: string,
    patch: {
      cwd?: string;
      worktreeMergedAt?: string;
      worktreeRemoved?: boolean;
    }
  ): TaskRecord | null {
    const cur = this.getTask(taskId);
    if (!cur) return null;
    const now = new Date().toISOString();
    const nextCwd = patch.cwd ? path.resolve(patch.cwd) : cur.cwd;
    const nextMergedAt =
      patch.worktreeMergedAt !== undefined ? patch.worktreeMergedAt : cur.worktreeMergedAt || "";
    const nextRemoved =
      patch.worktreeRemoved !== undefined
        ? patch.worktreeRemoved
          ? 1
          : 0
        : cur.worktreeRemoved
          ? 1
          : 0;
    this.db
      .prepare(
        `UPDATE tasks
         SET cwd = ?, worktree_merged_at = ?, worktree_removed = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextCwd, nextMergedAt, nextRemoved, now, taskId);
    return this.getTask(taskId);
  }

  /**
   * Transitions a DRAFT task into active IDLE status on first message WITHOUT
   * prematurely locking raw first text (e.g. "你好") as the immutable objective.
   * The model will determine a clean `taskTitle` and `taskObjective` once a real goal is stated.
   */
  public activateDraftTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== "DRAFT") return task;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE tasks SET status = 'IDLE', updated_at = ? WHERE id = ?`)
      .run(now, taskId);
    return this.getTask(taskId)!;
  }

  public updateTaskObjectiveAndTitle(
    taskId: string,
    patch: { title?: string; objective?: string; source: "auto" | "user" }
  ): TaskRecord {
    const cur = this.getTask(taskId);
    if (!cur) throw new Error(`Task not found: ${taskId}`);

    let nextTitle = cur.title;
    let nextTitleSource = cur.titleSource;
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim().slice(0, 80);
      if (trimmed && (patch.source === "user" || cur.titleSource !== "user")) {
        nextTitle = trimmed;
        nextTitleSource = patch.source;
      }
    }

    let nextObj = cur.originalObjective;
    let nextObjSource = cur.objectiveSource;
    if (patch.objective !== undefined) {
      const trimmed = patch.objective.trim();
      if (patch.source === "user") {
        nextObj = trimmed;
        nextObjSource = trimmed ? "user" : "auto";
      } else if (trimmed && cur.objectiveSource !== "user") {
        nextObj = trimmed;
        nextObjSource = "auto";
      }
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, title_source = ?, original_objective = ?, objective_source = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextTitle, nextTitleSource, nextObj, nextObjSource, now, taskId);
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
      originalObjective?: string;
      tags?: string[];
      permissionMode?: PermissionMode;
      providerId?: TaskProviderId;
      modelId?: string;
      thoughtLevel?: string;
      pulseMode?: PulseMode;
    }
  ): TaskRecord {
    const cur = this.getTask(taskId);
    if (!cur) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    const hasTitlePatch = patch.title !== undefined && patch.title.trim().length > 0;
    const hasObjPatch = patch.originalObjective !== undefined;
    const nextTitle = hasTitlePatch ? patch.title!.trim() : cur.title;
    const nextTitleSource = hasTitlePatch ? "user" : cur.titleSource;
    const nextObj = hasObjPatch ? patch.originalObjective!.trim() : cur.originalObjective;
    const nextObjSource = hasObjPatch ? (nextObj ? "user" : "auto") : cur.objectiveSource;

    this.db
      .prepare(
        `UPDATE tasks SET
           title = ?,
           title_source = ?,
           original_objective = ?,
           objective_source = ?,
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
        nextTitle,
        nextTitleSource,
        nextObj,
        nextObjSource,
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
    providerId: TaskProviderId,
    modelId: string,
    thoughtLevel: string,
    pulseMode?: PulseMode
  ): TaskRecord {
    return this.updateTaskMeta(taskId, { providerId, modelId, thoughtLevel, pulseMode });
  }

  public addSteeringDirective(
    taskId: string,
    directiveText: string,
    source: "user" | "model" = "user"
  ): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const clean = directiveText.trim();
    if (!clean) return task;

    // Deduplicate case-insensitively so repeated auto-extractions never spam duplicates
    const normalized = clean.toLowerCase();
    if (task.steeringDirectives.some((d) => d.directive.trim().toLowerCase() === normalized)) {
      return task;
    }

    const entry: SteeringDirective = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      directive: clean,
      source,
    };
    const updated = [...task.steeringDirectives, entry];
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE tasks SET steering_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(updated), now, taskId);
    return this.getTask(taskId)!;
  }

  public listRecentUserMessages(taskId: string, limit = 4): string[] {
    const rows = this.db
      .prepare(
        `SELECT item_json FROM task_items WHERE task_id = ? AND kind = 'user' ORDER BY seq DESC LIMIT ?`
      )
      .all(taskId, limit) as Array<{ item_json: string }>;
    return rows
      .reverse()
      .map((r) => {
        try {
          const parsed = JSON.parse(r.item_json) as { text?: string };
          return parsed.text?.trim() || "";
        } catch {
          return "";
        }
      })
      .filter(Boolean);
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

  public listTaskItemsPage(
    taskId: string,
    opts?: { limit?: number; beforeSeq?: number }
  ): TaskItemsPageResponse {
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM task_items WHERE task_id = ?`)
      .get(taskId) as { cnt?: number } | undefined;
    const totalCount = Number(countRow?.cnt ?? 0);

    if (opts?.limit === undefined && opts?.beforeSeq === undefined) {
      const rows = this.db
        .prepare(`SELECT seq, item_json FROM task_items WHERE task_id = ? ORDER BY seq ASC`)
        .all(taskId) as Array<{ seq: number; item_json: string }>;
      return {
        items: rows.map((r) => JSON.parse(r.item_json) as TranscriptItem),
        totalCount,
        hasMore: false,
        oldestSeq: rows.length > 0 ? Number(rows[0].seq) : null,
      };
    }

    const limit = Math.max(1, Math.min(500, Math.floor(opts?.limit ?? 60)));
    const beforeSeq =
      opts?.beforeSeq !== undefined && Number.isFinite(opts.beforeSeq)
        ? Math.floor(opts.beforeSeq)
        : undefined;

    const rawRows = (
      beforeSeq !== undefined
        ? this.db
            .prepare(
              `SELECT seq, kind, item_json FROM task_items
               WHERE task_id = ? AND seq < ?
               ORDER BY seq DESC
               LIMIT ?`
            )
            .all(taskId, beforeSeq, limit + 1)
        : this.db
            .prepare(
              `SELECT seq, kind, item_json FROM task_items
               WHERE task_id = ?
               ORDER BY seq DESC
               LIMIT ?`
            )
            .all(taskId, limit + 1)
    ) as Array<{ seq: number; kind: string; item_json: string }>;

    let hasMore = rawRows.length > limit;
    const pageRows = rawRows.slice(0, limit).reverse();

    // Snap the upper boundary to a non-step item when possible so a pulse's StepsGroup isn't split mid-group
    if (
      hasMore &&
      pageRows.length > 0 &&
      (pageRows[0].kind === "thinking" || pageRows[0].kind === "tool")
    ) {
      const leadingStepRows = this.db
        .prepare(
          `SELECT seq, kind, item_json FROM task_items
           WHERE task_id = ? AND seq < ?
           ORDER BY seq DESC
           LIMIT 24`
        )
        .all(taskId, pageRows[0].seq) as Array<{
        seq: number;
        kind: string;
        item_json: string;
      }>;
      const extraSteps: Array<{ seq: number; kind: string; item_json: string }> = [];
      for (const r of leadingStepRows) {
        if (r.kind === "thinking" || r.kind === "tool") {
          extraSteps.push(r);
        } else {
          break;
        }
      }
      if (extraSteps.length > 0) {
        pageRows.unshift(...extraSteps.reverse());
        const olderExists = this.db
          .prepare(`SELECT 1 AS ok FROM task_items WHERE task_id = ? AND seq < ? LIMIT 1`)
          .get(taskId, pageRows[0].seq) as { ok?: number } | undefined;
        hasMore = Boolean(olderExists?.ok);
      }
    }

    return {
      items: pageRows.map((r) => JSON.parse(r.item_json) as TranscriptItem),
      totalCount,
      hasMore,
      oldestSeq: pageRows.length > 0 ? Number(pageRows[0].seq) : null,
    };
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
    providerId: TaskProviderId;
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
    providerId: TaskProviderId,
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
    const out: SkillRecord[] = [];

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
    const wsPath =
      (entry.workspaceId ? this.getWorkspace(entry.workspaceId)?.path : undefined) ||
      this.getTask(entry.taskId)?.cwd ||
      "";
    this.db
      .prepare(
        `INSERT INTO usage_ledger (
           id, day, workspace_id, workspace_path, task_id, provider_id, model_id, input_tokens, output_tokens, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        day,
        entry.workspaceId,
        wsPath,
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

  private formatProviderDisplayLabel(
    providerId: string,
    epById: Map<string, CompatibleEndpointRecord>
  ): string {
    if (providerId === "agy") return "Google AI";
    if (providerId === "claude") return "Claude Code";
    if (providerId === "codex") return "OpenAI Codex";
    if (providerId.startsWith("endpoint:")) {
      const ep = epById.get(providerId.slice("endpoint:".length));
      return ep ? `兼容端点 · ${ep.name}` : "兼容 API 端点";
    }
    return providerId || "其他";
  }

  private computeRollingWindow(
    hours: number,
    epById: Map<string, CompatibleEndpointRecord>,
    workspaceId?: string
  ): UsageWindowSummary {
    const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = (
      workspaceId
        ? this.db
            .prepare(
              `SELECT provider_id, input_tokens, output_tokens
               FROM usage_ledger
               WHERE created_at >= ? AND workspace_id = ?`
            )
            .all(sinceIso, workspaceId)
        : this.db
            .prepare(
              `SELECT provider_id, input_tokens, output_tokens
               FROM usage_ledger
               WHERE created_at >= ?`
            )
            .all(sinceIso)
    ) as Array<Record<string, unknown>>;

    let inputTokens = 0;
    let outputTokens = 0;
    const byProvMap = new Map<string, UsageWindowProviderItem>();

    for (const r of rows) {
      const pid = String(r.provider_id || "");
      const inT = Number(r.input_tokens || 0);
      const outT = Number(r.output_tokens || 0);
      inputTokens += inT;
      outputTokens += outT;

      const cur = byProvMap.get(pid) ?? {
        providerId: pid,
        label: this.formatProviderDisplayLabel(pid, epById),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: 0,
      };
      cur.inputTokens += inT;
      cur.outputTokens += outT;
      cur.totalTokens += inT + outT;
      cur.turns += 1;
      byProvMap.set(pid, cur);
    }

    return {
      hours,
      since: sinceIso,
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      turns: rows.length,
      byProvider: [...byProvMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    };
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

    const wsList = this.listWorkspaces();
    const wsLookup = new Map(wsList.map((w) => [w.id, w]));
    const epById = new Map(this.listCompatibleEndpoints().map((e) => [e.id, e]));
    const taskMetaRows = this.db
      .prepare(`SELECT id, workspace_id, cwd FROM tasks`)
      .all() as Array<{ id: string; workspace_id: string; cwd: string }>;
    const taskMetaById = new Map(taskMetaRows.map((t) => [t.id, t]));

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
      { tasks: Set<string>; turns: number; inTok: number; outTok: number; fallbackCwd?: string }
    >();
    const modelAgg = new Map<
      string,
      { providerId: string; modelId: string; tasks: Set<string>; turns: number; inTok: number; outTok: number }
    >();

    for (const r of rows) {
      const day = String(r.day);
      const rawWsId = String(r.workspace_id || "");
      const tid = String(r.task_id);
      const pid = String(r.provider_id);
      const mid = String(r.model_id);
      const inT = Number(r.input_tokens || 0);
      const outT = Number(r.output_tokens || 0);
      const sum = inT + outT;

      // Resolve orphaned workspace_id via current task record if workspace was removed & re-added
      const taskMeta = taskMetaById.get(tid);
      const effectiveWsId = wsLookup.has(rawWsId)
        ? rawWsId
        : taskMeta && wsLookup.has(taskMeta.workspace_id)
          ? taskMeta.workspace_id
          : rawWsId || "__removed__";

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

      const rowWsPath = String(r.workspace_path || "");
      const fallbackPath = rowWsPath || taskMeta?.cwd;
      const wEntry = wsAgg.get(effectiveWsId) ?? {
        tasks: new Set(),
        turns: 0,
        inTok: 0,
        outTok: 0,
        fallbackCwd: fallbackPath,
      };
      wEntry.tasks.add(tid);
      wEntry.turns += 1;
      wEntry.inTok += inT;
      wEntry.outTok += outT;
      if (!wEntry.fallbackCwd && fallbackPath) wEntry.fallbackCwd = fallbackPath;
      wsAgg.set(effectiveWsId, wEntry);

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

    const byWorkspace: UsageBreakdownRow[] = [...wsAgg.entries()]
      .map(([wsId, v]) => {
        const ws = wsLookup.get(wsId);
        return {
          key: wsId,
          label: ws?.name || (v.fallbackCwd ? `${path.basename(v.fallbackCwd)}（已移除）` : "已移除的工作区"),
          subLabel: ws?.path || v.fallbackCwd,
          tasks: v.tasks.size,
          turns: v.turns,
          inputTokens: v.inTok,
          outputTokens: v.outTok,
          totalTokens: v.inTok + v.outTok,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const byModel: UsageBreakdownRow[] = [...modelAgg.values()]
      .map((v) => ({
        key: `${v.providerId}:${v.modelId}`,
        label: v.modelId,
        subLabel: this.formatProviderDisplayLabel(v.providerId, epById),
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
      rolling5h: this.computeRollingWindow(5, epById, workspaceId),
      rolling7d: this.computeRollingWindow(24 * 7, epById, workspaceId),
      days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
      byWorkspace,
      byModel,
    };
  }

  public saveProviderQuota(snapshot: ProviderQuotaSnapshot): void {
    const key = `provider_quota:${snapshot.providerId}`;
    this.db
      .prepare(
        `INSERT INTO prefs (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, JSON.stringify(snapshot));
  }

  public getProviderQuota(providerId: ProviderId): ProviderQuotaSnapshot | null {
    const row = this.db
      .prepare(`SELECT value_json FROM prefs WHERE key = ?`)
      .get(`provider_quota:${providerId}`) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as ProviderQuotaSnapshot;
    } catch {
      return null;
    }
  }

  public listProviderQuotas(): ProviderQuotaSnapshot[] {
    const rows = this.db
      .prepare(`SELECT value_json FROM prefs WHERE key LIKE 'provider_quota:%'`)
      .all() as Array<{ value_json: string }>;
    const out: ProviderQuotaSnapshot[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.value_json) as ProviderQuotaSnapshot);
      } catch {
        // ignore malformed
      }
    }
    return out;
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
      const parsed = JSON.parse(row.value_json) as Partial<AppPreferences>;
      return {
        ...DEFAULT_PREFS,
        ...parsed,
        contextNetTokenLimit: sanitizeContextNetTokenLimit(parsed.contextNetTokenLimit),
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  public savePreferences(patch: Partial<AppPreferences>): AppPreferences {
    const cur = this.getPreferences();
    const merged: AppPreferences = {
      ...cur,
      ...patch,
      contextNetTokenLimit:
        patch.contextNetTokenLimit !== undefined
          ? sanitizeContextNetTokenLimit(patch.contextNetTokenLimit)
          : cur.contextNetTokenLimit,
    };
    this.db
      .prepare(
        `INSERT INTO prefs (key, value_json) VALUES ('app_preferences', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(JSON.stringify(merged));
    return merged;
  }

  public saveProviderCapabilities(caps: PersistedProviderCapabilities): void {
    const key = `provider_caps:${caps.providerId}`;
    this.db
      .prepare(
        `INSERT INTO prefs (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, JSON.stringify(caps));
  }

  public getProviderCapabilities(providerId: ProviderId): PersistedProviderCapabilities | null {
    const row = this.db
      .prepare(`SELECT value_json FROM prefs WHERE key = ?`)
      .get(`provider_caps:${providerId}`) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as PersistedProviderCapabilities;
    } catch {
      return null;
    }
  }

  public listProviderCapabilities(): PersistedProviderCapabilities[] {
    const rows = this.db
      .prepare(`SELECT value_json FROM prefs WHERE key LIKE 'provider_caps:%'`)
      .all() as Array<{ value_json: string }>;
    const out: PersistedProviderCapabilities[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.value_json) as PersistedProviderCapabilities);
      } catch {
        // ignore malformed
      }
    }
    return out;
  }

  private normalizeEndpointModels(rawJson: string): CompatibleEndpointModel[] {
    try {
      const parsed = JSON.parse(rawJson) as unknown[];
      if (!Array.isArray(parsed)) return [];
      const out: CompatibleEndpointModel[] = [];
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          out.push({ id: item.trim(), thinkingMode: "none" });
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const id = String(obj.id ?? obj.name ?? "").trim();
          if (!id) continue;
          const tm = String(obj.thinkingMode ?? "none");
          const validTm =
            tm === "toggle" || tm === "standard" || tm === "extended" ? tm : "none";
          out.push({
            id,
            name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : undefined,
            thinkingMode: validTm,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private mapEndpointRow(r: Record<string, unknown>): CompatibleEndpointRecord {
    const rawKey = String(r.api_key ?? "");
    const hint = String(r.api_key_hint ?? "");
    return {
      id: String(r.id),
      name: String(r.name),
      protocol: (r.protocol === "openai" ? "openai" : "anthropic") as EndpointProtocol,
      baseUrl: String(r.base_url),
      apiKeySet: rawKey.length > 0 || (hint.length > 0 && hint !== "未设置"),
      apiKeyHint: hint || "未设置",
      models: this.normalizeEndpointModels(String(r.models_json ?? "[]")),
      enabled: Number(r.enabled) === 1,
      createdAt: String(r.created_at),
    };
  }

  public listCompatibleEndpoints(): CompatibleEndpointRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM compatible_endpoints ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapEndpointRow(r));
  }

  public getCompatibleEndpoint(id: string): CompatibleEndpointRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM compatible_endpoints WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapEndpointRow(row) : null;
  }

  public getCompatibleEndpointSecret(
    id: string
  ): { record: CompatibleEndpointRecord; apiKey: string } | null {
    const row = this.db
      .prepare(`SELECT * FROM compatible_endpoints WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      record: this.mapEndpointRow(row),
      apiKey: String(row.api_key ?? ""),
    };
  }

  public addCompatibleEndpoint(input: {
    name?: string;
    protocol?: EndpointProtocol;
    baseUrl?: string;
    apiKey?: string;
    models?: Array<CompatibleEndpointModel | string>;
  }): CompatibleEndpointRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const name = (input.name ?? "").trim() || "新兼容端点";
    const protocol: EndpointProtocol = input.protocol === "openai" ? "openai" : "anthropic";
    const baseUrl = (input.baseUrl ?? "").trim();
    const key = (input.apiKey ?? "").trim();
    const hint =
      key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : key ? "已设置" : "未设置";
    const models = this.normalizeEndpointModels(JSON.stringify(input.models ?? []));

    this.db
      .prepare(
        `INSERT INTO compatible_endpoints (id, name, protocol, base_url, api_key, api_key_hint, models_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(id, name, protocol, baseUrl, key, hint, JSON.stringify(models), now);
    return this.getCompatibleEndpoint(id)!;
  }

  public updateCompatibleEndpoint(
    id: string,
    patch: {
      name?: string;
      protocol?: EndpointProtocol;
      baseUrl?: string;
      apiKey?: string | null;
      models?: CompatibleEndpointModel[];
      enabled?: boolean;
    }
  ): CompatibleEndpointRecord | null {
    const existing = this.getCompatibleEndpointSecret(id);
    if (!existing) return null;

    const nextName = patch.name !== undefined ? patch.name.trim() || existing.record.name : existing.record.name;
    const nextProto: EndpointProtocol =
      patch.protocol === "openai" || patch.protocol === "anthropic"
        ? patch.protocol
        : existing.record.protocol;
    const nextUrl = patch.baseUrl !== undefined ? patch.baseUrl.trim() : existing.record.baseUrl;
    const nextModels =
      patch.models !== undefined
        ? this.normalizeEndpointModels(JSON.stringify(patch.models))
        : existing.record.models;
    const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.record.enabled ? 1 : 0;

    let nextKey = existing.apiKey;
    let nextHint = existing.record.apiKeyHint;
    if (patch.apiKey !== undefined) {
      const k = (patch.apiKey ?? "").trim();
      nextKey = k;
      nextHint = k.length > 8 ? `${k.slice(0, 4)}••••${k.slice(-4)}` : k ? "已设置" : "未设置";
    }

    this.db
      .prepare(
        `UPDATE compatible_endpoints
         SET name = ?, protocol = ?, base_url = ?, api_key = ?, api_key_hint = ?, models_json = ?, enabled = ?
         WHERE id = ?`
      )
      .run(nextName, nextProto, nextUrl, nextKey, nextHint, JSON.stringify(nextModels), nextEnabled, id);

    return this.getCompatibleEndpoint(id);
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
      titleSource: (r.title_source === "user" ? "user" : "auto") as "auto" | "user",
      originalObjective: String(r.original_objective),
      objectiveSource: (r.objective_source === "user" ? "user" : "auto") as "auto" | "user",
      completionCriteria: JSON.parse(String(r.completion_criteria_json)) as string[],
      steeringDirectives: JSON.parse(String(r.steering_json)) as SteeringDirective[],
      tags: r.tags_json ? (JSON.parse(String(r.tags_json)) as string[]) : [],
      cwd: String(r.cwd),
      worktreePath: r.worktree_path ? String(r.worktree_path) : undefined,
      worktreeBranch: r.worktree_branch ? String(r.worktree_branch) : undefined,
      worktreeBaseBranch: r.worktree_base_branch ? String(r.worktree_base_branch) : undefined,
      worktreeBaseCommit: r.worktree_base_commit ? String(r.worktree_base_commit) : undefined,
      worktreeMergedAt: r.worktree_merged_at ? String(r.worktree_merged_at) : undefined,
      worktreeRemoved: Number(r.worktree_removed || 0) === 1,
      providerId: String(r.provider_id) as TaskProviderId,
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
      providerId: String(r.provider_id) as TaskProviderId,
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
