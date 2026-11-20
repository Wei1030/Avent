import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceRecord,
  WorkspaceWorktreeConfig,
  WorktreeConfigScope,
  WorktreeLiveStatus,
  WorktreeMergeResult,
  WorktreeRepoGitState,
} from "../shared/types.js";
import { isPathInsideRoot, resolveCanonicalPath } from "./shell-parser.js";

const execFileAsync = promisify(execFile);

export const WORKTREE_REPO_CONFIG_REL = ".avent/worktree.json";
export const WORKTREE_LOCAL_CONFIG_REL = ".avent/worktree.local.json";
const WORKTREE_LOCAL_EXCLUDE_PATTERN = "**/.avent/worktree.local.json";

const GIT_ENV_BASE: NodeJS.ProcessEnv = {
  ...process.env,
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
};

function errMsg(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").trim();
    if (detail) return detail;
  }
  return String(err);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: GIT_ENV_BASE,
  });
  return stdout.trimEnd();
}

function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

function slugify(text: string, fallback = "task"): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 26);
  return cleaned || fallback;
}

function isAbsoluteOsPath(p: string): boolean {
  if (process.platform === "win32") {
    return /^([a-z]:[\\/]|\\\\[^\\/])/i.test(p);
  }
  return path.isAbsolute(p);
}

export function defaultWorktreesRoot(): string {
  return path.join(os.homedir(), ".avent", "worktrees");
}

async function findEnclosingGitRepo(dir: string): Promise<string | null> {
  let cur = path.resolve(dir);
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  try {
    const top = await git(cur, "rev-parse", "--show-toplevel");
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

export async function validateWorktreeRoot(
  rawRoot: string,
  allWorkspaces: WorkspaceRecord[]
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const trimmed = rawRoot.trim();
  if (!trimmed) {
    return { ok: true, dir: defaultWorktreesRoot() };
  }
  if (!isAbsoluteOsPath(trimmed)) {
    return { ok: false, error: "工作树存放根目录必须填写完整的绝对路径" };
  }
  const resolved = path.resolve(trimmed);

  for (const ws of allWorkspaces) {
    if (isPathInsideRoot(resolved, ws.path)) {
      return {
        ok: false,
        error: `不能放在工作区「${ws.name}」的目录内部，请放到仓库外部的独立目录`,
      };
    }
  }

  const enclosingRepo = await findEnclosingGitRepo(resolved);
  if (enclosingRepo) {
    return {
      ok: false,
      error: `该路径位于 Git 仓库 (${enclosingRepo}) 内部，容易干扰主仓库状态，请选择仓库外的目录`,
    };
  }

  try {
    mkdirSync(resolved, { recursive: true });
    const probe = path.join(resolved, `.avent-wt-probe-${crypto.randomUUID().slice(0, 8)}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (err) {
    return {
      ok: false,
      error: `无法创建或写入目录：${errMsg(err)}`,
    };
  }

  return { ok: true, dir: resolved };
}

async function findFreeWorktreeSlot(
  workspacePath: string,
  wsHomeDir: string,
  baseSlug: string
): Promise<{ branch: string; dir: string }> {
  const knownDirs = new Set<string>();
  try {
    const porcelain = await git(workspacePath, "worktree", "list", "--porcelain");
    for (const line of splitLines(porcelain)) {
      if (line.startsWith("worktree ")) {
        knownDirs.add(resolveCanonicalPath(line.slice("worktree ".length)).toLowerCase());
      }
    }
  } catch {
    // ignore
  }

  for (let i = 1; i <= 50; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const name = `${baseSlug}${suffix}`;
    const branch = `avent/${name}`;
    const dir = path.join(wsHomeDir, name);
    const dirKey = resolveCanonicalPath(dir).toLowerCase();
    if (existsSync(dir) || knownDirs.has(dirKey)) continue;
    const branchExists = await git(
      workspacePath,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`
    ).then(
      () => true,
      () => false
    );
    if (branchExists) continue;
    return { branch, dir };
  }

  const fallback = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
  return {
    branch: `avent/${fallback}`,
    dir: path.join(wsHomeDir, fallback),
  };
}

export interface SetupCommandResult {
  ran: boolean;
  ranScopes: WorktreeConfigScope[];
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

// =========================================================================
// Project-Directory Worktree Config Files (Repo vs Local) & Git Controls
// =========================================================================

interface RawWorktreeFileData {
  exists: boolean;
  setupCommand: string;
  initPrompt: string;
}

function normalizeScriptText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readWorktreeConfigFileSync(filePath: string): RawWorktreeFileData {
  if (!existsSync(filePath)) {
    return { exists: false, setupCommand: "", initPrompt: "" };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { setupCommand?: unknown; initPrompt?: unknown };
    return {
      exists: true,
      setupCommand: typeof parsed.setupCommand === "string" ? normalizeScriptText(parsed.setupCommand) : "",
      initPrompt: typeof parsed.initPrompt === "string" ? normalizeScriptText(parsed.initPrompt) : "",
    };
  } catch {
    return { exists: true, setupCommand: "", initPrompt: "" };
  }
}

export function getEffectiveWorktreeConfigSync(
  wsPath: string,
  legacyFallback?: { setupCommand?: string; initPrompt?: string },
  secondaryRepoDir?: string
): {
  repoSetupCommand: string;
  localSetupCommand: string;
  repoInitPrompt: string;
  localInitPrompt: string;
  combinedInitPrompt: string;
  hasAny: boolean;
} {
  let repo = readWorktreeConfigFileSync(path.join(wsPath, WORKTREE_REPO_CONFIG_REL));
  if (!repo.exists && secondaryRepoDir && path.resolve(secondaryRepoDir) !== path.resolve(wsPath)) {
    repo = readWorktreeConfigFileSync(path.join(secondaryRepoDir, WORKTREE_REPO_CONFIG_REL));
  }
  const local = readWorktreeConfigFileSync(path.join(wsPath, WORKTREE_LOCAL_CONFIG_REL));

  let repoSetup = repo.setupCommand.trim();
  let localSetup = local.setupCommand.trim();
  let repoPrompt = repo.initPrompt.trim();
  let localPrompt = local.initPrompt.trim();

  // Graceful fallback to legacy DB columns only when neither project file exists
  if (!repo.exists && !local.exists && legacyFallback) {
    if (legacyFallback.setupCommand?.trim()) {
      localSetup = normalizeScriptText(legacyFallback.setupCommand).trim();
    }
    if (legacyFallback.initPrompt?.trim()) {
      localPrompt = normalizeScriptText(legacyFallback.initPrompt).trim();
    }
  }

  const combinedInitPrompt = [repoPrompt, localPrompt].filter(Boolean).join("\n\n");
  return {
    repoSetupCommand: repoSetup,
    localSetupCommand: localSetup,
    repoInitPrompt: repoPrompt,
    localInitPrompt: localPrompt,
    combinedInitPrompt,
    hasAny: Boolean(repoSetup || localSetup || combinedInitPrompt),
  };
}

export function hasWorkspaceWorktreeInitConfigSync(
  wsPath: string,
  legacyFallback?: { setupCommand?: string; initPrompt?: string }
): boolean {
  return getEffectiveWorktreeConfigSync(wsPath, legacyFallback).hasAny;
}

async function isGitRepoDir(wsPath: string): Promise<boolean> {
  if (!wsPath || !existsSync(wsPath)) return false;
  try {
    const out = await git(wsPath, "rev-parse", "--is-inside-work-tree");
    return out.trim() === "true";
  } catch {
    return false;
  }
}

async function resolveGitExcludePath(wsPath: string): Promise<string | null> {
  try {
    const relOrAbs = await git(wsPath, "rev-parse", "--git-path", "info/exclude");
    if (!relOrAbs) return null;
    return path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(wsPath, relOrAbs);
  } catch {
    return null;
  }
}

async function isFileTrackedInGit(wsPath: string, relPath: string): Promise<boolean> {
  try {
    await git(wsPath, "ls-files", "--error-unmatch", relPath);
    return true;
  } catch {
    return false;
  }
}

async function isPathIgnoredByGit(wsPath: string, relPath: string): Promise<boolean> {
  try {
    await git(wsPath, "check-ignore", "--no-index", "-q", relPath);
    return true;
  } catch {
    return false;
  }
}

async function isLocalConfigExcludedInGit(wsPath: string): Promise<boolean> {
  const excludePath = await resolveGitExcludePath(wsPath);
  if (!excludePath || !existsSync(excludePath)) return false;
  try {
    const content = readFileSync(excludePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    return (
      lines.includes(WORKTREE_LOCAL_EXCLUDE_PATTERN) ||
      lines.includes(WORKTREE_LOCAL_CONFIG_REL) ||
      lines.includes(`/${WORKTREE_LOCAL_CONFIG_REL}`)
    );
  } catch {
    return false;
  }
}

export async function ensureLocalWorktreeConfigExcluded(wsPath: string): Promise<boolean> {
  const excludePath = await resolveGitExcludePath(wsPath);
  if (!excludePath) return false;
  mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (
    lines.includes(WORKTREE_LOCAL_EXCLUDE_PATTERN) ||
    lines.includes(WORKTREE_LOCAL_CONFIG_REL)
  ) {
    return true;
  }
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  writeFileSync(
    excludePath,
    `${prefix}# Avent local worktree config (machine-local, never committed)\n${WORKTREE_LOCAL_EXCLUDE_PATTERN}\n`,
    "utf8"
  );
  return true;
}

export async function readWorkspaceWorktreeConfig(params: {
  workspaceId: string;
  workspacePath: string;
  worktreeRoot?: string;
}): Promise<WorkspaceWorktreeConfig> {
  const { workspaceId, workspacePath, worktreeRoot = "" } = params;
  const repoAbs = path.join(workspacePath, WORKTREE_REPO_CONFIG_REL);
  const localAbs = path.join(workspacePath, WORKTREE_LOCAL_CONFIG_REL);
  const repoFile = readWorktreeConfigFileSync(repoAbs);
  const localFile = readWorktreeConfigFileSync(localAbs);
  const isGitRepo = await isGitRepoDir(workspacePath);

  let repoGitState: WorktreeRepoGitState = "no_git";
  let wouldBeIgnored = false;
  let excludedInGit = false;
  let localTrackedInGit = false;

  if (isGitRepo) {
    const [repoTracked, repoIgnored, localExcluded, localTracked] = await Promise.all([
      isFileTrackedInGit(workspacePath, WORKTREE_REPO_CONFIG_REL),
      isPathIgnoredByGit(workspacePath, WORKTREE_REPO_CONFIG_REL),
      isLocalConfigExcludedInGit(workspacePath),
      isFileTrackedInGit(workspacePath, WORKTREE_LOCAL_CONFIG_REL),
    ]);
    wouldBeIgnored = repoIgnored;
    excludedInGit = localExcluded;
    localTrackedInGit = localTracked;

    if (!repoFile.exists) {
      repoGitState = "absent";
    } else if (repoTracked) {
      repoGitState = "tracked";
    } else if (repoIgnored) {
      repoGitState = "ignored";
    } else {
      repoGitState = "untracked";
    }
  }

  return {
    workspaceId,
    isGitRepo,
    worktreeRoot,
    repo: {
      relPath: WORKTREE_REPO_CONFIG_REL,
      absPath: repoAbs,
      exists: repoFile.exists,
      gitState: repoGitState,
      wouldBeIgnored,
      setupCommand: repoFile.setupCommand,
      initPrompt: repoFile.initPrompt,
    },
    local: {
      relPath: WORKTREE_LOCAL_CONFIG_REL,
      absPath: localAbs,
      exists: localFile.exists,
      excludedInGit,
      trackedInGit: localTrackedInGit,
      setupCommand: localFile.setupCommand,
      initPrompt: localFile.initPrompt,
    },
  };
}

function tryCleanupEmptyAventDir(wsPath: string): void {
  const dir = path.join(wsPath, ".avent");
  if (!existsSync(dir)) return;
  try {
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
    }
  } catch {
    // ignore if non-empty or locked
  }
}

export async function saveWorkspaceWorktreeConfig(params: {
  workspaceId: string;
  workspacePath: string;
  worktreeRoot?: string;
  scope: WorktreeConfigScope;
  setupCommand: string;
  initPrompt: string;
  forceTrackRepo?: boolean;
}): Promise<{ config: WorkspaceWorktreeConfig; forceTracked: boolean }> {
  const { workspaceId, workspacePath, worktreeRoot, scope, forceTrackRepo } = params;
  const setupCommand = normalizeScriptText(params.setupCommand).trim();
  const initPrompt = normalizeScriptText(params.initPrompt).trim();

  const relPath = scope === "repo" ? WORKTREE_REPO_CONFIG_REL : WORKTREE_LOCAL_CONFIG_REL;
  const absPath = path.join(workspacePath, relPath);
  let forceTracked = false;

  if (!setupCommand && !initPrompt) {
    if (existsSync(absPath)) {
      rmSync(absPath, { force: true });
    }
    tryCleanupEmptyAventDir(workspacePath);
  } else {
    mkdirSync(path.dirname(absPath), { recursive: true });
    const payload = {
      setupCommand,
      initPrompt,
    };
    writeFileSync(absPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    if (scope === "local") {
      await ensureLocalWorktreeConfigExcluded(workspacePath).catch(() => {});
    } else if (scope === "repo" && forceTrackRepo) {
      if (await isGitRepoDir(workspacePath)) {
        const alreadyTracked = await isFileTrackedInGit(workspacePath, WORKTREE_REPO_CONFIG_REL);
        const ignored = await isPathIgnoredByGit(workspacePath, WORKTREE_REPO_CONFIG_REL);
        if (!alreadyTracked && ignored) {
          await git(workspacePath, "add", "-f", WORKTREE_REPO_CONFIG_REL);
          forceTracked = true;
        }
      }
    }
  }

  const config = await readWorkspaceWorktreeConfig({
    workspaceId,
    workspacePath,
    worktreeRoot,
  });
  return { config, forceTracked };
}

export async function runWorktreeConfigGitAction(params: {
  workspaceId: string;
  workspacePath: string;
  worktreeRoot?: string;
  scope: WorktreeConfigScope;
  action: "track" | "force_track" | "untrack" | "ensure_exclude";
}): Promise<WorkspaceWorktreeConfig> {
  const { workspaceId, workspacePath, worktreeRoot, scope, action } = params;
  if (!(await isGitRepoDir(workspacePath))) {
    throw new Error("当前工作区不是 Git 仓库，无法执行 Git 追踪操作。");
  }

  const relPath = scope === "repo" ? WORKTREE_REPO_CONFIG_REL : WORKTREE_LOCAL_CONFIG_REL;
  const absPath = path.join(workspacePath, relPath);

  if (action === "ensure_exclude") {
    await ensureLocalWorktreeConfigExcluded(workspacePath);
  } else if (action === "track") {
    if (!existsSync(absPath)) {
      throw new Error(`文件 ${relPath} 尚未创建，请先保存配置。`);
    }
    await git(workspacePath, "add", relPath);
  } else if (action === "force_track") {
    if (scope !== "repo") {
      throw new Error("仅仓库共享配置文件允许强制加入 Git 追踪。");
    }
    if (!existsSync(absPath)) {
      throw new Error(`文件 ${relPath} 尚未创建，请先保存配置。`);
    }
    await git(workspacePath, "add", "-f", relPath);
  } else if (action === "untrack") {
    await git(workspacePath, "rm", "--cached", "--ignore-unmatch", relPath);
    if (scope === "local") {
      await ensureLocalWorktreeConfigExcluded(workspacePath);
    }
  }

  return readWorkspaceWorktreeConfig({ workspaceId, workspacePath, worktreeRoot });
}

// =========================================================================
// Multi-Line Setup Script Execution (Windows .cmd / PowerShell + Unix sh)
// =========================================================================

type ScriptShellKind = "cmd" | "powershell" | "sh" | "bash";

function detectSetupScriptShell(script: string): { kind: ScriptShellKind; body: string } {
  const normalized = normalizeScriptText(script).trim();
  const lines = normalized.split("\n");
  const first = lines[0]?.trim() || "";

  if (/^#!\s*(?:\/(?:usr\/)?bin\/(?:env\s+)?)?(pwsh|powershell)\b/i.test(first)) {
    return { kind: "powershell", body: lines.slice(1).join("\n").trim() };
  }
  if (/^#!\s*(cmd|bat)\b/i.test(first)) {
    return { kind: "cmd", body: lines.slice(1).join("\n").trim() };
  }
  if (/^#!\s*(?:\/(?:usr\/)?bin\/(?:env\s+)?)?bash\b/i.test(first)) {
    return { kind: "bash", body: lines.slice(1).join("\n").trim() };
  }
  if (/^#!\s*(?:\/(?:usr\/)?bin\/(?:env\s+)?)?(?:sh|zsh)\b/i.test(first)) {
    return { kind: "sh", body: lines.slice(1).join("\n").trim() };
  }

  if (process.platform === "win32") {
    const looksLikePowerShell =
      /(^|\s)(\$env:|\$PSScriptRoot|\$[a-zA-Z_]\w*\s*=|\b(?:Copy-Item|New-Item|Test-Path|Write-Host|Write-Output|Set-Location|Join-Path|Get-Item|Get-Content|Set-Content|Remove-Item|Start-Process|ForEach-Object|Where-Object)\b)/im.test(
        normalized
      );
    return { kind: looksLikePowerShell ? "powershell" : "cmd", body: normalized };
  }

  return { kind: "sh", body: normalized };
}

function buildWindowsCmdScript(body: string): string {
  const lines = body.split("\n");
  const hasBatchFlow = /^\s*(?:if|for|else|goto)\b|^\s*:|\(\s*$|^\s*\)/im.test(body);
  const hasEchoHeader = /^\s*@?echo\b/im.test(lines[0] || "");
  const out: string[] = [];
  if (!hasEchoHeader) {
    out.push("@echo off");
    out.push("chcp 65001 >nul");
  }

  const batchWrapperRe = /^(\s*)((?:npm|npx|pnpm|yarn|corepack)(?:\.cmd)?)(?=\s|$)/i;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // Allow `# comment` lines cleanly even inside Windows cmd scripts
    if (trimmed.startsWith("#")) {
      out.push(`rem ${trimmed.slice(1).trim()}`);
      continue;
    }
    const isComment = /^rem(?:\s|$)|^::/i.test(trimmed);
    const transformed =
      !isComment && !/^\s*call\s+/i.test(rawLine)
        ? rawLine.replace(batchWrapperRe, "$1call $2")
        : rawLine;
    out.push(transformed);
    if (!hasBatchFlow && !isComment && !/^\s*@?echo\s+(off|on)\s*$/i.test(trimmed)) {
      out.push("if errorlevel 1 exit /b %errorlevel%");
    }
  }

  return `${out.join("\r\n")}\r\n`;
}

function runSetupScript(
  script: string,
  cwd: string,
  envExtra: Record<string, string>,
  timeoutMs = 180_000
): Promise<Omit<SetupCommandResult, "ranScopes">> {
  const started = Date.now();
  const { kind, body } = detectSetupScriptShell(script);
  if (!body) {
    return Promise.resolve({
      ran: false,
      command: script,
      ok: true,
      exitCode: 0,
      durationMs: 0,
      output: "",
    });
  }

  const tmpId = `avent-wt-setup-${crypto.randomUUID().slice(0, 10)}`;
  let tmpFile = "";
  let exe = "";
  let args: string[] = [];

  if (kind === "powershell") {
    tmpFile = path.join(os.tmpdir(), `${tmpId}.ps1`);
    // UTF-8 BOM ensures Windows PowerShell 5.1 reads non-ASCII characters cleanly
    const psBody =
      `\uFEFF$ErrorActionPreference = 'Stop'\r\n` +
      `${body.replace(/\n/g, "\r\n")}\r\n` +
      `if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\r\n`;
    writeFileSync(tmpFile, psBody, "utf8");
    exe = process.platform === "win32" ? "powershell.exe" : "pwsh";
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile];
  } else if (kind === "cmd") {
    tmpFile = path.join(os.tmpdir(), `${tmpId}.cmd`);
    writeFileSync(tmpFile, buildWindowsCmdScript(body), "utf8");
    exe = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/c", tmpFile];
  } else {
    tmpFile = path.join(os.tmpdir(), `${tmpId}.sh`);
    writeFileSync(tmpFile, `set -e\n${body}\n`, "utf8");
    exe = kind === "bash" ? "bash" : "sh";
    args = [tmpFile];
  }

  const cleanupTmp = () => {
    try {
      if (tmpFile && existsSync(tmpFile)) rmSync(tmpFile, { force: true });
    } catch {
      // ignore
    }
  };

  return new Promise((resolve) => {
    let output = "";
    let settled = false;

    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...envExtra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 16000) {
        output = output.slice(-14000);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      cleanupTmp();
      resolve({
        ran: true,
        command: script,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        output: `${output}\n[初始化脚本执行超时 (${Math.round(timeoutMs / 1000)}s)]`.trim(),
      });
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupTmp();
      resolve({
        ran: true,
        command: script,
        ok: false,
        exitCode: 1,
        durationMs: Date.now() - started,
        output: `${output}\n${err.message}`.trim(),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupTmp();
      resolve({
        ran: true,
        command: script,
        ok: code === 0,
        exitCode: code,
        durationMs: Date.now() - started,
        output: output.trim(),
      });
    });
  });
}

export interface CreatedWorktreeInfo {
  worktreePath: string;
  cwd: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  setupResult?: SetupCommandResult;
}

export async function createTaskWorktree(params: {
  workspace: WorkspaceRecord;
  allWorkspaces: WorkspaceRecord[];
  taskHint?: string;
}): Promise<CreatedWorktreeInfo> {
  const { workspace, allWorkspaces, taskHint } = params;

  // Verify Git repo & HEAD commit exist
  let baseCommit: string;
  let baseBranch: string;
  let subPrefix = "";
  try {
    baseCommit = await git(workspace.path, "rev-parse", "HEAD");
    baseBranch = await git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
    subPrefix = await git(workspace.path, "rev-parse", "--show-prefix").catch(() => "");
  } catch (err) {
    throw new Error(
      `当前工作区不是有效的 Git 仓库或尚无任何提交，无法创建独立工作树：${errMsg(err)}`
    );
  }

  const rootCheck = await validateWorktreeRoot(workspace.worktreeRoot || "", allWorkspaces);
  if (!rootCheck.ok) {
    throw new Error(`工作树存放根目录配置无效：${rootCheck.error}`);
  }

  const wsFolderName = `${slugify(workspace.name, "ws")}-${workspace.id.slice(0, 8)}`;
  const wsHomeDir = path.join(rootCheck.dir, wsFolderName);
  mkdirSync(wsHomeDir, { recursive: true });

  const shortId = crypto.randomUUID().slice(0, 6);
  const baseSlug = `${slugify(taskHint || "task", "task")}-${shortId}`;
  const { branch, dir: wtRoot } = await findFreeWorktreeSlot(
    workspace.path,
    wsHomeDir,
    baseSlug
  );

  try {
    await git(workspace.path, "worktree", "add", "-b", branch, wtRoot, baseCommit);
  } catch (err) {
    throw new Error(`创建 Git 工作树失败：${errMsg(err)}`);
  }

  const cwd = subPrefix ? path.join(wtRoot, subPrefix) : wtRoot;
  mkdirSync(cwd, { recursive: true });

  const effectiveCfg = getEffectiveWorktreeConfigSync(
    workspace.path,
    {
      setupCommand: workspace.worktreeSetupCommand,
      initPrompt: workspace.worktreeInitPrompt,
    },
    cwd
  );

  const steps: Array<{ scope: WorktreeConfigScope; label: string; script: string }> = [];
  if (effectiveCfg.repoSetupCommand) {
    steps.push({ scope: "repo", label: "仓库初始化脚本", script: effectiveCfg.repoSetupCommand });
  }
  if (effectiveCfg.localSetupCommand) {
    steps.push({ scope: "local", label: "本地初始化脚本", script: effectiveCfg.localSetupCommand });
  }

  let setupResult: SetupCommandResult | undefined;
  if (steps.length > 0) {
    const envExtra = {
      AVENT_MAIN_WORKSPACE: workspace.path,
      AVENT_WORKTREE_PATH: wtRoot,
      AVENT_WORKTREE_CWD: cwd,
      AVENT_WORKTREE_BRANCH: branch,
      AVENT_WORKTREE_BASE_BRANCH: baseBranch,
    };
    const ranScopes: WorktreeConfigScope[] = [];
    const outputs: string[] = [];
    let totalDurationMs = 0;
    let ok = true;
    let exitCode: number | null = 0;

    for (const step of steps) {
      const r = await runSetupScript(step.script, cwd, envExtra);
      if (!r.ran) continue;
      ranScopes.push(step.scope);
      totalDurationMs += r.durationMs;
      if (r.output) {
        outputs.push(steps.length > 1 ? `[${step.label}]\n${r.output}` : r.output);
      }
      if (!r.ok) {
        ok = false;
        exitCode = r.exitCode;
        if (steps.length > 1 && !r.output) {
          outputs.push(`[${step.label}] 执行失败`);
        }
        break;
      }
    }

    if (ranScopes.length > 0) {
      setupResult = {
        ran: true,
        ranScopes,
        command: steps.map((s) => s.script).join("\n"),
        ok,
        exitCode,
        durationMs: totalDurationMs,
        output: outputs.join("\n\n").trim(),
      };
    }
  }

  return {
    worktreePath: wtRoot,
    cwd,
    branch,
    baseBranch,
    baseCommit,
    setupResult,
  };
}

async function isRebasingInWorktree(worktreePath: string): Promise<boolean> {
  try {
    const mergeDir = await git(worktreePath, "rev-parse", "--git-path", "rebase-merge");
    const applyDir = await git(worktreePath, "rev-parse", "--git-path", "rebase-apply");
    const absMerge = path.isAbsolute(mergeDir) ? mergeDir : path.resolve(worktreePath, mergeDir);
    const absApply = path.isAbsolute(applyDir) ? applyDir : path.resolve(worktreePath, applyDir);
    return existsSync(absMerge) || existsSync(absApply);
  } catch {
    return false;
  }
}

export async function getTaskWorktreeStatus(params: {
  workspacePath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  mergedAt?: string;
}): Promise<WorktreeLiveStatus> {
  const { workspacePath, worktreePath, branch, baseBranch, mergedAt } = params;
  const exists = Boolean(worktreePath && existsSync(worktreePath));

  let mainBranch: string | undefined;
  let mainDirtyCount: number | undefined;
  try {
    mainBranch = await git(workspacePath, "rev-parse", "--abbrev-ref", "HEAD");
    const mainPorcelain = await git(workspacePath, "status", "--porcelain");
    mainDirtyCount = splitLines(mainPorcelain).length;
  } catch {
    // ignore
  }

  if (!exists) {
    return {
      exists: false,
      path: worktreePath,
      branch,
      baseBranch,
      ahead: 0,
      behind: 0,
      dirtyFiles: [],
      rebasing: false,
      conflictFiles: [],
      merged: Boolean(mergedAt),
      mergedAt,
      mainBranch,
      mainDirtyCount,
    };
  }

  const dirtyFiles = splitLines(
    await git(worktreePath, "status", "--porcelain").catch(() => "")
  );
  const rebasing = await isRebasingInWorktree(worktreePath);
  const conflictFiles = rebasing
    ? splitLines(
        await git(worktreePath, "diff", "--name-only", "--diff-filter=U").catch(() => "")
      )
    : [];

  let ahead = 0;
  let behind = 0;
  if (baseBranch && baseBranch !== "HEAD" && branch) {
    ahead =
      Number(
        await git(workspacePath, "rev-list", "--count", `${baseBranch}..${branch}`).catch(
          () => "0"
        )
      ) || 0;
    behind =
      Number(
        await git(workspacePath, "rev-list", "--count", `${branch}..${baseBranch}`).catch(
          () => "0"
        )
      ) || 0;
  }

  return {
    exists: true,
    path: worktreePath,
    branch,
    baseBranch,
    ahead,
    behind,
    dirtyFiles,
    rebasing,
    conflictFiles,
    merged: Boolean(mergedAt) && ahead === 0 && dirtyFiles.length === 0,
    mergedAt,
    mainBranch,
    mainDirtyCount,
  };
}

/**
 * Safely merges a task's worktree branch back into its base branch:
 * 1. Optionally commits uncommitted changes inside the worktree.
 * 2. Rebases the worktree branch onto the latest baseBranch INSIDE the worktree (main workspace stays untouched!).
 * 3. If rebase conflicts occur, leaves conflicts inside the worktree so the task's agent can resolve them in-place.
 * 4. Once rebase succeeds cleanly, advances baseBranch via Fast-Forward ONLY (refusing to overwrite a dirty main workspace).
 */
export async function mergeTaskWorktree(params: {
  workspacePath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  autoCommit?: boolean;
  commitMessage?: string;
  mergedAt?: string;
}): Promise<WorktreeMergeResult> {
  const { workspacePath, worktreePath, branch, baseBranch, autoCommit = true, commitMessage } = params;

  const statusNow = () =>
    getTaskWorktreeStatus({
      workspacePath,
      worktreePath,
      branch,
      baseBranch,
      mergedAt: params.mergedAt,
    });

  if (!existsSync(worktreePath)) {
    return {
      ok: false,
      outcome: "error",
      message: "该任务的工作树目录已不存在，无法执行合并。",
      status: await statusNow(),
    };
  }

  if (!baseBranch || baseBranch === "HEAD") {
    return {
      ok: false,
      outcome: "error",
      message: "创建此工作树时主目录处于游离 HEAD 状态，没有明确的目标分支可供合回。",
      status: await statusNow(),
    };
  }

  const baseExists = await git(
    workspacePath,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${baseBranch}`
  ).then(
    () => true,
    () => false
  );
  if (!baseExists) {
    return {
      ok: false,
      outcome: "error",
      message: `目标分支 ${baseBranch} 在主仓库中已不存在。`,
      status: await statusNow(),
    };
  }

  // Check if already in an unfinished rebase
  if (await isRebasingInWorktree(worktreePath)) {
    const conflicts = splitLines(
      await git(worktreePath, "diff", "--name-only", "--diff-filter=U").catch(() => "")
    );
    return {
      ok: false,
      outcome: "conflict",
      message:
        conflicts.length > 0
          ? `工作树内仍有未解决的 Rebase 冲突（${conflicts.length} 个文件），请先让智能体解决冲突或中止 Rebase。`
          : "工作树内有尚未完成的 Rebase，请先完成或中止后再试。",
      conflictFiles: conflicts,
      status: await statusNow(),
    };
  }

  // 1. Auto-commit uncommitted work inside the worktree if present
  const dirtyFiles = splitLines(await git(worktreePath, "status", "--porcelain").catch(() => ""));
  if (dirtyFiles.length > 0) {
    if (!autoCommit) {
      return {
        ok: false,
        outcome: "error",
        message: `工作树内还有 ${dirtyFiles.length} 处未提交改动，请先提交后再合回。`,
        status: await statusNow(),
      };
    }
    try {
      await git(worktreePath, "add", "-A");
      const hasName = await git(worktreePath, "config", "user.name").catch(() => "");
      const hasEmail = await git(worktreePath, "config", "user.email").catch(() => "");
      const msg = (commitMessage || `Avent task: ${branch}`).trim();
      if (hasName && hasEmail) {
        await git(worktreePath, "commit", "-m", msg);
      } else {
        await git(
          worktreePath,
          "-c",
          "user.name=Avent",
          "-c",
          "user.email=avent@local",
          "commit",
          "-m",
          msg
        );
      }
    } catch (err) {
      return {
        ok: false,
        outcome: "error",
        message: `在工作树内自动提交改动失败：${errMsg(err)}`,
        status: await statusNow(),
      };
    }
  }

  // 2. Check if there are commits ahead of baseBranch
  const aheadBefore =
    Number(
      await git(workspacePath, "rev-list", "--count", `${baseBranch}..${branch}`).catch(() => "0")
    ) || 0;
  if (aheadBefore === 0) {
    return {
      ok: true,
      outcome: "nothing_to_merge",
      message: `工作树分支 ${branch} 相对 ${baseBranch} 没有新提交，无需合并。`,
      status: await statusNow(),
    };
  }

  // 3. Rebase INSIDE the worktree onto latest baseBranch (main workspace is NEVER touched!)
  const behindBefore =
    Number(
      await git(workspacePath, "rev-list", "--count", `${branch}..${baseBranch}`).catch(() => "0")
    ) || 0;
  if (behindBefore > 0) {
    try {
      await git(worktreePath, "rebase", baseBranch);
    } catch (err) {
      const conflicts = splitLines(
        await git(worktreePath, "diff", "--name-only", "--diff-filter=U").catch(() => "")
      );
      const stillRebasing = await isRebasingInWorktree(worktreePath);
      if (stillRebasing || conflicts.length > 0) {
        return {
          ok: false,
          outcome: "conflict",
          message: `在工作树内向 ${baseBranch} 执行 Rebase 时出现冲突（主目录未受任何影响）。你可以点击「让智能体解决冲突」就地修复，或点击「中止 Rebase」回退。`,
          conflictFiles: conflicts,
          status: await statusNow(),
        };
      }
      return {
        ok: false,
        outcome: "error",
        message: `工作树内 Rebase 失败：${errMsg(err)}`,
        status: await statusNow(),
      };
    }
  }

  // 4. Verify strict fast-forward ancestry before touching baseBranch
  const wtHead = await git(worktreePath, "rev-parse", "HEAD");
  const isAncestor = await git(
    workspacePath,
    "merge-base",
    "--is-ancestor",
    baseBranch,
    wtHead
  ).then(
    () => true,
    () => false
  );
  if (!isAncestor) {
    return {
      ok: false,
      outcome: "error",
      message: `无法对 ${baseBranch} 执行 Fast-Forward，请检查分支历史状态。`,
      status: await statusNow(),
    };
  }

  // 5. Fast-forward baseBranch safely
  const mainBranch = await git(workspacePath, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "");
  if (mainBranch === baseBranch) {
    const mainDirtyFiles = splitLines(
      await git(workspacePath, "status", "--porcelain").catch(() => "")
    );
    if (mainDirtyFiles.length > 0) {
      return {
        ok: false,
        outcome: "blocked_dirty_main",
        message: `工作树内 Rebase 已完成！但主工作区（${baseBranch}）当前有 ${mainDirtyFiles.length} 处未提交改动，为避免覆盖现场已暂停合回。请先提交或暂存主目录改动，再点一次「一键合回」即可完成 Fast-Forward。`,
        mainDirtyFiles,
        status: await statusNow(),
      };
    }

    try {
      await git(workspacePath, "merge", "--ff-only", branch);
    } catch (err) {
      return {
        ok: false,
        outcome: "error",
        message: `主目录 Fast-Forward 合回失败：${errMsg(err)}`,
        status: await statusNow(),
      };
    }
  } else {
    // Main checkout is on a different branch -> safe ref-only fast-forward advance!
    try {
      await git(workspacePath, "branch", "-f", baseBranch, wtHead);
    } catch (err) {
      return {
        ok: false,
        outcome: "error",
        message: `更新目标分支 ${baseBranch} 失败：${errMsg(err)}`,
        status: await statusNow(),
      };
    }
  }

  const mergedAt = new Date().toISOString();
  const finalStatus = await getTaskWorktreeStatus({
    workspacePath,
    worktreePath,
    branch,
    baseBranch,
    mergedAt,
  });

  return {
    ok: true,
    outcome: "merged",
    message: `已通过工作树内 Rebase + Fast-Forward 安全合回 ${baseBranch}（共 ${aheadBefore} 个提交）。`,
    status: finalStatus,
  };
}

export async function abortWorktreeRebase(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  await git(worktreePath, "rebase", "--abort");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function removeTaskWorktree(params: {
  workspacePath: string;
  worktreePath: string;
  branch?: string;
  deleteBranch?: boolean;
}): Promise<{ removedDir: boolean; deletedBranch: boolean; warning?: string }> {
  const { workspacePath, worktreePath, branch, deleteBranch = true } = params;
  let removedDir = !existsSync(worktreePath);
  let warning: string | undefined;

  if (!removedDir) {
    // Retry briefly for Windows handle release after killing child processes
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await git(workspacePath, "worktree", "remove", "--force", worktreePath);
        removedDir = !existsSync(worktreePath);
        if (removedDir) break;
      } catch {
        // retry or fallback to fs rmSync
      }
      await sleep(160);
    }

    if (!removedDir && existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 140 });
        removedDir = !existsSync(worktreePath);
      } catch (err) {
        warning = `工作树目录未能完全删除（可能仍有程序占用文件）：${errMsg(err)}`;
      }
    }
  }

  // Always prune git worktree metadata
  await git(workspacePath, "worktree", "prune").catch(() => {});

  let deletedBranch = false;
  if (deleteBranch && branch && branch !== "HEAD") {
    try {
      await git(workspacePath, "branch", "-D", branch);
      deletedBranch = true;
    } catch {
      // ignore if branch was already deleted or checked out elsewhere
    }
  }

  return { removedDir, deletedBranch, warning };
}
