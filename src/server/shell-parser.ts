import { realpathSync } from "node:fs";
import path from "node:path";

export type ShellSegmentClass = "read_only" | "write_or_unknown" | "destructive";

export interface ShellSegmentAnalysis {
  raw: string;
  tokens: string[];
  executable: string;
  classification: ShellSegmentClass;
  reasons: string[];
  outsideWorkspacePaths: string[];
}

export interface ShellCommandAnalysis {
  raw: string;
  segments: ShellSegmentAnalysis[];
  hasCompound: boolean;
  hasRedirection: boolean;
  hasCommandSub: boolean;
  hasDynamicEval: boolean;
  hasPipeToShell: boolean;
  outsideWorkspace: boolean;
  outsideWorkspacePaths: string[];
  isReadOnly: boolean;
  isRisky: boolean;
  reasons: string[];
}

/**
 * Resolves a path through symlinks/junctions starting from the nearest existing ancestor,
 * so even not-yet-created target files cannot escape via symlinked parent directories.
 */
export function resolveCanonicalPath(p: string): string {
  const abs = path.resolve(p);
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try {
      const realAncestor = realpathSync.native(cur);
      const rel = path.relative(cur, abs);
      return rel ? path.join(realAncestor, rel) : realAncestor;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
    }
  }
}

export function isPathInsideRoot(targetPath: string, rootDir: string): boolean {
  if (!rootDir) return true;
  const realRoot = resolveCanonicalPath(rootDir);
  const realTarget = resolveCanonicalPath(targetPath);

  if (process.platform === "win32") {
    const rLow = realRoot.toLowerCase();
    const tLow = realTarget.toLowerCase();
    if (rLow === tLow) return true;
    const rel = path.relative(rLow, tLow);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  if (realRoot === realTarget) return true;
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeExecutable(token: string): string {
  const trimmed = token.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return "";
  // Strip leading `&` call operator in PowerShell if attached
  const cleaned = trimmed.replace(/^&/, "");
  const base = path.basename(cleaned.replace(/\\/g, "/")).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, "");
}

interface RawSplitSegment {
  raw: string;
  tokens: string[];
  operatorBefore: string;
  hasRedirection: boolean;
  hasCommandSub: boolean;
}

const SAFE_NULL_TARGETS = new Set(["/dev/null", "$null", "nul", "null"]);

/**
 * Quote-aware shell/PowerShell splitter and hazard scanner.
 * Preserves Windows backslashes in file paths while splitting on unquoted control operators.
 */
function splitAndScanShell(command: string): {
  segments: RawSplitSegment[];
  hasRedirection: boolean;
  hasCommandSub: boolean;
} {
  const segments: RawSplitSegment[] = [];
  let hasRedirection = false;
  let hasCommandSub = false;
  let segHasRedir = false;
  let segHasCmdSub = false;

  let quote: "'" | '"' | null = null;
  let curTokens: string[] = [];
  let curToken = "";
  let tokenStarted = false;
  let segStart = 0;
  let operatorBefore = "";

  const pushToken = () => {
    if (tokenStarted || curToken.length > 0) {
      curTokens.push(curToken);
      curToken = "";
      tokenStarted = false;
    }
  };

  const pushSegment = (endIdx: number, nextOp: string) => {
    pushToken();
    const raw = command.slice(segStart, endIdx).trim();
    if (raw.length > 0 || curTokens.length > 0) {
      segments.push({
        raw,
        tokens: curTokens,
        operatorBefore,
        hasRedirection: segHasRedir,
        hasCommandSub: segHasCmdSub,
      });
    }
    curTokens = [];
    operatorBefore = nextOp;
    segHasRedir = false;
    segHasCmdSub = false;
  };

  const len = command.length;
  for (let i = 0; i < len; i++) {
    const ch = command[i];
    const next = i + 1 < len ? command[i + 1] : "";

    // Inside single quotes: completely literal (PowerShell `''` is escaped single quote)
    if (quote === "'") {
      if (ch === "'") {
        if (next === "'") {
          curToken += "'";
          i++;
        } else {
          quote = null;
        }
      } else {
        curToken += ch;
      }
      continue;
    }

    // Inside double quotes
    if (quote === '"') {
      if (ch === "$" && next === "(") {
        hasCommandSub = true;
        segHasCmdSub = true;
        curToken += "$(";
        i++;
        continue;
      }
      if (ch === "`") {
        // PowerShell escape inside double quotes (e.g., `", `n, `t, `$, ``)
        if (next && '"$nrt0abfv`'.includes(next)) {
          curToken += next;
          i++;
          continue;
        }
        // Check for POSIX backtick command substitution `...`
        const closeBt = command.indexOf("`", i + 1);
        if (closeBt > i + 1) {
          hasCommandSub = true;
          segHasCmdSub = true;
        }
        curToken += ch;
        continue;
      }
      if (ch === "\\" && (next === '"' || next === "$" || next === "`")) {
        curToken += next;
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
      } else {
        curToken += ch;
      }
      continue;
    }

    // Unquoted state
    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    // Escapes outside quotes: only escape shell metacharacters so Windows `D:\src\file` stays intact!
    if (ch === "\\" && next && " \t'\"|&;><$`()".includes(next)) {
      curToken += next;
      tokenStarted = true;
      i++;
      continue;
    }

    // Command substitution $(...)
    if (ch === "$" && next === "(") {
      hasCommandSub = true;
      segHasCmdSub = true;
      curToken += "$(";
      tokenStarted = true;
      i++;
      continue;
    }

    // Backtick command substitution `...`
    if (ch === "`") {
      const closeBt = command.indexOf("`", i + 1);
      if (closeBt > i + 1) {
        hasCommandSub = true;
        segHasCmdSub = true;
      }
      curToken += ch;
      tokenStarted = true;
      continue;
    }

    // Process substitution <(...) or >(...)
    if ((ch === "<" || ch === ">") && next === "(") {
      hasCommandSub = true;
      segHasCmdSub = true;
      curToken += ch + next;
      tokenStarted = true;
      i++;
      continue;
    }

    // Here-doc <<
    if (ch === "<" && next === "<") {
      hasRedirection = true;
      segHasRedir = true;
      curToken += "<<";
      tokenStarted = true;
      i++;
      continue;
    }

    // Redirections: `2>&1`, `1>&2`, `2>/dev/null`, `2>$null`, `>`, `>>`, `*>`, `1>`, `2>`, `&>`
    const isFdPrefix =
      (ch === "1" || ch === "2" || ch === "3" || ch === "*" || ch === "&") &&
      next === ">" &&
      !tokenStarted &&
      curToken.length === 0;

    if (ch === ">" || isFdPrefix) {
      const sliceFrom = command.slice(i);
      // Allow harmless fd duplication `2>&1` or `1>&2`
      if (/^[12]>&[12](?:\s|$|[;|&])/.test(sliceFrom)) {
        const m = /^([12]>&[12])/.exec(sliceFrom)!;
        pushToken();
        i += m[1].length - 1;
        continue;
      }
      // Allow harmless null discard: `2>/dev/null`, `2>$null`, `2>nul`, `>/dev/null`, `>$null`
      const nullRedir = /^([12*&]?)>>?\s*([^\s;|&]+)/i.exec(sliceFrom);
      if (nullRedir && SAFE_NULL_TARGETS.has(nullRedir[2].toLowerCase())) {
        pushToken();
        i += nullRedir[0].length - 1;
        continue;
      }
      // Any other output redirection writes/truncates a file!
      hasRedirection = true;
      segHasRedir = true;
      pushToken();
      if (isFdPrefix) i++;
      if (command[i + 1] === ">" || command[i + 1] === "|") i++;
      continue;
    }

    // Control operators that split compound commands: &&, ||, ;, |, &, newline
    if (ch === "\n" || ch === "\r") {
      pushSegment(i, "\n");
      if (ch === "\r" && next === "\n") i++;
      segStart = i + 1;
      continue;
    }
    if (ch === ";") {
      pushSegment(i, ";");
      segStart = i + 1;
      continue;
    }
    if (ch === "&" && next === "&") {
      pushSegment(i, "&&");
      i++;
      segStart = i + 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      pushSegment(i, "||");
      i++;
      segStart = i + 1;
      continue;
    }
    if (ch === "|") {
      pushSegment(i, "|");
      segStart = i + 1;
      continue;
    }
    if (ch === "&") {
      // Background operator `&` (except PowerShell call operator `& "cmd"` at start of segment)
      if (curTokens.length === 0 && !tokenStarted && curToken.length === 0) {
        // PowerShell call operator `&`
        continue;
      }
      pushSegment(i, "&");
      segStart = i + 1;
      continue;
    }

    // Whitespace delimits tokens
    if (ch === " " || ch === "\t") {
      pushToken();
      continue;
    }

    curToken += ch;
    tokenStarted = true;
  }

  pushSegment(len, "");
  return { segments, hasRedirection, hasCommandSub };
}

// ============================================================================
// Command Classification Tables (Strict Read-Only Whitelist + Destructive Detection)
// ============================================================================

const DYNAMIC_EVAL_EXECUTABLES = new Set([
  "eval",
  "source",
  ".",
  "iex",
  "invoke-expression",
  "invoke-command",
  "icm",
  "start-process",
  "saps",
  "start",
]);

const FILE_DELETE_EXECUTABLES = new Set([
  "rm",
  "unlink",
  "del",
  "erase",
  "rd",
  "rmdir",
  "remove-item",
  "ri",
  "clear-content",
  "clc",
]);

const SYSTEM_DESTRUCTIVE_EXECUTABLES = new Set([
  "shred",
  "format",
  "diskpart",
  "mkfs",
  "fdisk",
  "dd",
  "shutdown",
  "reboot",
  "chmod",
  "chown",
  "icacls",
  "takeown",
  "cacls",
]);

/**
 * Checks whether a delete target would wipe the workspace root itself, wildcard everything at root,
 * or touch `.git` metadata (which destroys version history and cannot be undone with git).
 */
export function isCatastrophicDeleteTarget(
  rawTarget: string,
  virtualCwd: string,
  rootCwd: string
): boolean {
  const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) return false;
  const normSlash = cleaned.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (
    normSlash === "." ||
    normSlash === "./" ||
    normSlash === "*" ||
    normSlash === "./*" ||
    normSlash === "/" ||
    /^[a-z]:$/i.test(normSlash) ||
    /^[a-z]:\/\*?$/i.test(normSlash)
  ) {
    return true;
  }
  if (/(^|\/)\.git($|\/)/i.test(normSlash)) {
    return true;
  }
  if (rootCwd) {
    const resolved = path.isAbsolute(cleaned)
      ? path.resolve(cleaned)
      : path.resolve(virtualCwd || rootCwd, cleaned);
    const canonRoot = resolveCanonicalPath(rootCwd);
    const canonTarget = resolveCanonicalPath(resolved);
    const sameAsRoot =
      process.platform === "win32"
        ? canonRoot.toLowerCase() === canonTarget.toLowerCase()
        : canonRoot === canonTarget;
    if (sameAsRoot) return true;
    const rel = path.relative(canonRoot, canonTarget).replace(/\\/g, "/");
    if (rel === ".git" || rel.startsWith(".git/")) return true;
  }
  return false;
}

const NETWORK_FETCH_EXECUTABLES = new Set([
  "curl",
  "wget",
  "irm",
  "invoke-restmethod",
  "iwr",
  "invoke-webrequest",
]);

const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "iex",
  "invoke-expression",
  "node",
  "python",
  "python3",
  "py",
]);

const PURE_READ_ONLY_EXECUTABLES = new Set([
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "tree",
  "pwd",
  "get-location",
  "gl",
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "nl",
  "rg",
  "ripgrep",
  "grep",
  "egrep",
  "fgrep",
  "select-string",
  "sls",
  "findstr",
  "which",
  "where",
  "get-command",
  "gcm",
  "whoami",
  "hostname",
  "uname",
  "echo",
  "write-output",
  "printf",
  "true",
  "false",
  "date",
  "get-date",
  "uniq",
  "cut",
  "tr",
  "measure-object",
  "measure",
  "format-table",
  "ft",
  "format-list",
  "fl",
  "out-string",
  "select-object",
  "select",
]);

const CD_EXECUTABLES = new Set(["cd", "set-location", "sl", "push-location", "pushd"]);

const GIT_PURE_READ_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "describe",
  "shortlog",
  "blame",
  "ls-files",
  "ls-tree",
  "cat-file",
  "merge-base",
  "rev-list",
  "grep",
]);

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

const DESTRUCTIVE_INLINE_CODE_REGEX =
  /\b(rm\s+-[a-z]*[rf]|rmSync|rmdirSync|unlinkSync|rmtree|os\.remove|os\.unlink|Remove-Item|ri\s+-|del\s+\/[fsq]|rd\s+\/[sq]|rmdir\s+\/[sq]|git\s+reset\s+--hard|git\s+push\s+(?:.*\s)?(?:-f|--force)|git\s+clean\s+-[a-z]*f|drop\s+table|drop\s+database|truncate\s+table)\b/i;

function stripLeadingEnvAssignments(tokens: string[]): {
  tokens: string[];
  hadEnvMutation: boolean;
} {
  let idx = 0;
  let hadEnvMutation = false;
  while (idx < tokens.length) {
    const tk = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tk)) {
      idx++;
      continue;
    }
    if (tk.toLowerCase() === "env" && idx + 1 < tokens.length) {
      idx++;
      continue;
    }
    // PowerShell `$env:FOO = "bar"` statement
    if (/^\$env:/i.test(tk)) {
      hadEnvMutation = true;
      break;
    }
    break;
  }
  return { tokens: tokens.slice(idx), hadEnvMutation };
}

function classifyGitSegment(args: string[]): {
  classification: ShellSegmentClass;
  reasons: string[];
  explicitDirs: string[];
} {
  const explicitDirs: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--version" || a === "-v" || a === "--help" || a === "-h") {
      return { classification: "read_only", reasons: [], explicitDirs };
    }
    if (a === "-C" && i + 1 < args.length) {
      explicitDirs.push(args[i + 1]);
      i += 2;
      continue;
    }
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
      explicitDirs.push(a.slice(a.indexOf("=") + 1));
      i++;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(a) && i + 1 < args.length) {
      if (a === "--git-dir" || a === "--work-tree") explicitDirs.push(args[i + 1]);
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }

  const sub = (args[i] ?? "").toLowerCase();
  const subArgs = args.slice(i + 1);
  if (!sub) {
    return { classification: "read_only", reasons: [], explicitDirs };
  }

  // Destructive git operations
  if (sub === "reset" && subArgs.some((a) => a === "--hard" || a === "--merge")) {
    return {
      classification: "destructive",
      reasons: ["git reset --hard 会丢弃未提交改动"],
      explicitDirs,
    };
  }
  if (
    sub === "push" &&
    subArgs.some(
      (a) =>
        a === "-f" ||
        a === "--force" ||
        a.startsWith("--force-with-lease") ||
        a === "--delete" ||
        /^\+[^+]/.test(a)
    )
  ) {
    return {
      classification: "destructive",
      reasons: ["git push 强制推送或删除远端分支"],
      explicitDirs,
    };
  }
  if (
    sub === "clean" &&
    !subArgs.some((a) => a === "-n" || a === "--dry-run") &&
    subArgs.some((a) => /^-[a-z]*f/i.test(a) || a === "--force")
  ) {
    return {
      classification: "destructive",
      reasons: ["git clean -f 会永久删除未追踪文件"],
      explicitDirs,
    };
  }
  if (
    (sub === "checkout" && subArgs.some((a) => a === "--" || a === "." || a === "-f" || a === "--force")) ||
    (sub === "restore" && !subArgs.some((a) => a === "--staged" && subArgs.length === 1))
  ) {
    return {
      classification: "destructive",
      reasons: [`git ${sub} 可能覆盖未提交的工作区改动`],
      explicitDirs,
    };
  }
  if (sub === "branch" && subArgs.some((a) => a === "-D" || a === "-d" || a === "--delete")) {
    return {
      classification: "destructive",
      reasons: ["git branch 删除分支操作"],
      explicitDirs,
    };
  }
  if (sub === "stash" && subArgs.some((a) => a === "drop" || a === "clear")) {
    return {
      classification: "destructive",
      reasons: ["git stash drop/clear 会永久丢弃暂存记录"],
      explicitDirs,
    };
  }

  // Pure read-only git subcommands
  if (GIT_PURE_READ_SUBCOMMANDS.has(sub)) {
    // Watch out for `git diff --output=...`
    if (sub === "diff" && subArgs.some((a) => a.startsWith("--output"))) {
      return {
        classification: "write_or_unknown",
        reasons: ["git diff --output 会写入文件"],
        explicitDirs,
      };
    }
    return { classification: "read_only", reasons: [], explicitDirs };
  }

  if (sub === "branch") {
    const mutationFlags = new Set([
      "-d",
      "-D",
      "-m",
      "-M",
      "-c",
      "-C",
      "-f",
      "--delete",
      "--move",
      "--copy",
      "--force",
      "--set-upstream-to",
      "--unset-upstream",
      "--edit-description",
    ]);
    const hasMutFlag = subArgs.some(
      (a) => mutationFlags.has(a) || a.startsWith("--set-upstream-to=")
    );
    const hasPositional = subArgs.some((a) => !a.startsWith("-"));
    const isList = subArgs.some((a) => a === "-l" || a === "--list");
    if (!hasMutFlag && (!hasPositional || isList)) {
      return { classification: "read_only", reasons: [], explicitDirs };
    }
  }

  if (sub === "tag") {
    if (subArgs.length === 0 || subArgs.some((a) => a === "-l" || a === "--list")) {
      const hasMut = subArgs.some((a) => a === "-d" || a === "-a" || a === "-f" || a === "--delete");
      if (!hasMut) return { classification: "read_only", reasons: [], explicitDirs };
    }
  }

  if (sub === "remote") {
    const firstPos = subArgs.find((a) => !a.startsWith("-"))?.toLowerCase();
    if (!firstPos || firstPos === "show" || firstPos === "get-url") {
      return { classification: "read_only", reasons: [], explicitDirs };
    }
  }

  if (sub === "stash") {
    const firstPos = subArgs.find((a) => !a.startsWith("-"))?.toLowerCase();
    if (firstPos === "list" || firstPos === "show") {
      return { classification: "read_only", reasons: [], explicitDirs };
    }
  }

  if (sub === "worktree") {
    const firstPos = subArgs.find((a) => !a.startsWith("-"))?.toLowerCase();
    if (firstPos === "list") {
      return { classification: "read_only", reasons: [], explicitDirs };
    }
  }

  if (sub === "config") {
    const readFlags = new Set(["--get", "--get-all", "--list", "-l", "--show-origin", "--get-regexp"]);
    if (subArgs.some((a) => readFlags.has(a)) && !subArgs.some((a) => a.startsWith("--unset") || a === "--replace-all" || a === "--add")) {
      return { classification: "read_only", reasons: [], explicitDirs };
    }
  }

  return {
    classification: "write_or_unknown",
    reasons: [`git ${sub} 属于可能修改仓库状态的命令`],
    explicitDirs,
  };
}

function looksLikePathArg(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (/^(https?:|ssh:|git@|mailto:|file:\/\/)/i.test(token)) return false;
  // npm scoped package like `@types/node`
  if (/^@[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(token)) return false;
  // git revision ranges like `HEAD~1..HEAD` or `main..dev` (not `../`)
  if (/^[A-Za-z0-9._~^-]+\.\.[A-Za-z0-9._~^-]*$/.test(token) && !token.startsWith("..")) {
    return false;
  }
  // Explicit absolute paths, parent traversal, or home paths
  if (
    token === ".." ||
    token.startsWith("../") ||
    token.startsWith("..\\") ||
    token.includes("/../") ||
    token.includes("\\..\\") ||
    token.endsWith("/..") ||
    token.endsWith("\\..") ||
    /^[a-zA-Z]:[\\/]/.test(token) ||
    token.startsWith("\\\\") ||
    token.startsWith("~/") ||
    token.startsWith("~\\") ||
    token === "~"
  ) {
    return true;
  }
  // Unix absolute path (skip Windows slash-flags like `/s`, `/q`, `/f`, `/PID`)
  if (token.startsWith("/") && /^\/[A-Za-z0-9._-]+\//.test(token)) {
    return true;
  }
  return false;
}

function checkSegmentPathBoundary(
  tokens: string[],
  extraDirs: string[],
  virtualCwd: string,
  rootCwd: string,
  isReadOnlySeg: boolean,
  allowedReadRoots: string[]
): string[] {
  if (!rootCwd) return [];
  const escaped: string[] = [];

  const checkOne = (rawTarget: string) => {
    const expanded =
      rawTarget === "~" || rawTarget.startsWith("~/") || rawTarget.startsWith("~\\")
        ? path.join(process.env.USERPROFILE || process.env.HOME || "/", rawTarget.slice(1))
        : rawTarget;
    const resolved = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(virtualCwd, expanded);
    if (isPathInsideRoot(resolved, rootCwd)) return;
    if (isReadOnlySeg && allowedReadRoots.some((r) => isPathInsideRoot(resolved, r))) {
      return;
    }
    if (!escaped.includes(rawTarget)) {
      escaped.push(rawTarget);
    }
  };

  for (const d of extraDirs) checkOne(d);
  for (const tk of tokens.slice(1)) {
    // Also handle `--flag=C:\outside\path`
    const eqIdx = tk.startsWith("-") ? tk.indexOf("=") : -1;
    const candidate = eqIdx > 0 ? tk.slice(eqIdx + 1) : tk;
    if (looksLikePathArg(candidate)) {
      checkOne(candidate);
    }
  }
  return escaped;
}

export function analyzeShellCommand(
  command: string,
  options?: {
    cwd?: string;
    allowedReadRoots?: string[];
  }
): ShellCommandAnalysis {
  const rootCwd = options?.cwd?.trim() ? path.resolve(options.cwd) : "";
  const allowedReadRoots = (options?.allowedReadRoots ?? []).filter(Boolean);
  let virtualCwd = rootCwd;

  const { segments: rawSegments, hasRedirection, hasCommandSub } = splitAndScanShell(command);

  const analyzedSegments: ShellSegmentAnalysis[] = [];
  const globalReasons: string[] = [];
  let hasDynamicEval = false;
  let hasPipeToShell = false;

  if (hasRedirection) {
    globalReasons.push("包含输出重定向（> / >>），可能写入或覆盖文件");
  }
  if (hasCommandSub) {
    globalReasons.push("包含命令替换（$(...) 或反引号），存在动态执行风险");
  }

  for (let idx = 0; idx < rawSegments.length; idx++) {
    const seg = rawSegments[idx];
    const { tokens, hadEnvMutation } = stripLeadingEnvAssignments(seg.tokens);
    const executable = tokens[0] ? normalizeExecutable(tokens[0]) : "";
    const args = tokens.slice(1);
    const segReasons: string[] = [];
    let classification: ShellSegmentClass = "write_or_unknown";
    let extraDirs: string[] = [];

    if (hadEnvMutation) {
      classification = "write_or_unknown";
      segReasons.push("修改环境变量表达式");
    } else if (!executable) {
      classification = "write_or_unknown";
    } else if (DYNAMIC_EVAL_EXECUTABLES.has(executable)) {
      hasDynamicEval = true;
      classification = "write_or_unknown";
      segReasons.push(`动态求值或间接执行命令 (${executable})`);
      if (DESTRUCTIVE_INLINE_CODE_REGEX.test(seg.raw)) {
        classification = "destructive";
        segReasons.push("动态执行内容中包含高危删除或破坏性操作");
      }
    } else if (SYSTEM_DESTRUCTIVE_EXECUTABLES.has(executable)) {
      classification = "destructive";
      segReasons.push(`高危系统或磁盘修改命令 (${executable})`);
    } else if (FILE_DELETE_EXECUTABLES.has(executable)) {
      const targetArgs = args.filter(
        (a) => a && !a.startsWith("-") && !/^\/[a-z]+$/i.test(a)
      );
      const hitsCatastrophic =
        targetArgs.length === 0 ||
        targetArgs.some((t) => isCatastrophicDeleteTarget(t, virtualCwd, rootCwd));
      if (hitsCatastrophic) {
        classification = "destructive";
        segReasons.push(`高危删除操作：可能清空整个工作区根目录或 .git 历史 (${executable})`);
      } else {
        classification = "write_or_unknown";
        segReasons.push(`工作区内删除文件/目录命令 (${executable})，全自动模式下自动放行，其余模式需确认`);
      }
    } else if (
      (executable === "bash" || executable === "sh" || executable === "zsh" || executable === "dash") &&
      args.some((a) => a === "-c" || a === "-lc")
    ) {
      hasDynamicEval = true;
      classification = DESTRUCTIVE_INLINE_CODE_REGEX.test(seg.raw)
        ? "destructive"
        : "write_or_unknown";
      segReasons.push(
        classification === "destructive"
          ? `嵌套 Shell (${executable} -c) 中包含高危破坏性操作`
          : `嵌套 Shell 执行 (${executable} -c)`
      );
    } else if (executable === "cmd" && args.some((a) => /^\/[ck]$/i.test(a))) {
      hasDynamicEval = true;
      classification = DESTRUCTIVE_INLINE_CODE_REGEX.test(seg.raw)
        ? "destructive"
        : "write_or_unknown";
      segReasons.push(
        classification === "destructive"
          ? "嵌套 cmd /c 中包含高危删除或破坏性操作"
          : "嵌套 cmd /c 执行子命令"
      );
    } else if (
      (executable === "powershell" || executable === "pwsh") &&
      args.some((a) => /^-(c|command|e|ec|enc|encodedcommand|f|file)$/i.test(a))
    ) {
      hasDynamicEval = true;
      const isEncoded = args.some((a) => /^-(e|ec|enc|encodedcommand)$/i.test(a));
      classification =
        isEncoded || DESTRUCTIVE_INLINE_CODE_REGEX.test(seg.raw)
          ? "destructive"
          : "write_or_unknown";
      segReasons.push(
        isEncoded
          ? "检测到 PowerShell 编码命令 (-EncodedCommand)，无法静态确认安全性"
          : classification === "destructive"
            ? "嵌套 PowerShell 命令中包含高危破坏性操作"
            : "嵌套 PowerShell 执行子命令"
      );
    } else if (
      (executable === "node" && args.some((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print")) ||
      ((executable === "python" || executable === "python3" || executable === "py") && args.some((a) => a === "-c"))
    ) {
      hasDynamicEval = true;
      classification = DESTRUCTIVE_INLINE_CODE_REGEX.test(seg.raw)
        ? "destructive"
        : "write_or_unknown";
      segReasons.push(
        classification === "destructive"
          ? `内联脚本 (${executable}) 中包含高危文件删除操作`
          : `内联脚本执行 (${executable})，无法静态保证只读`
      );
    } else if (executable === "git") {
      const gitRes = classifyGitSegment(args);
      classification = gitRes.classification;
      segReasons.push(...gitRes.reasons);
      extraDirs = gitRes.explicitDirs;
    } else if (CD_EXECUTABLES.has(executable)) {
      const target = args.find((a) => !a.startsWith("-"));
      if (!target || target === "-") {
        classification = "write_or_unknown";
        if (rootCwd) {
          extraDirs = ["~"];
          segReasons.push("切换目录到主目录或未知上级目录");
        }
      } else {
        const nextDir = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(virtualCwd || rootCwd || ".", target);
        if (rootCwd && !isPathInsideRoot(nextDir, rootCwd)) {
          extraDirs = [target];
          classification = "write_or_unknown";
          segReasons.push(`切换目录 (${target}) 越出了当前任务工作目录`);
        } else {
          virtualCwd = nextDir;
          classification = "read_only";
        }
      }
    } else if (executable === "find") {
      const isDestructiveFind = args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir");
      classification = isDestructiveFind ? "destructive" : "write_or_unknown";
      segReasons.push(
        isDestructiveFind ? "find 包含 -delete 或 -exec，存在高危修改/删除风险" : "find 命令需人工确认"
      );
    } else if (executable === "sort") {
      const hasOut = args.some((a) => a === "-o" || a.startsWith("--output"));
      classification = hasOut ? "write_or_unknown" : "read_only";
      if (hasOut) segReasons.push("sort -o 会写入文件");
    } else if (executable === "tsc" && args.includes("--noEmit")) {
      classification = "read_only";
    } else if (
      (executable === "node" ||
        executable === "npm" ||
        executable === "pnpm" ||
        executable === "yarn" ||
        executable === "python" ||
        executable === "python3" ||
        executable === "tsc") &&
      args.length === 1 &&
      (args[0] === "-v" || args[0] === "--version")
    ) {
      classification = "read_only";
    } else if (
      (executable === "select-object" || executable === "select") &&
      seg.raw.includes("{")
    ) {
      classification = "write_or_unknown";
      segReasons.push("PowerShell Select-Object 包含脚本块，需人工确认");
    } else if (PURE_READ_ONLY_EXECUTABLES.has(executable)) {
      classification = "read_only";
    } else if (DESTRUCTIVE_INLINE_CODE_REGEX.test(seg.raw)) {
      classification = "destructive";
      segReasons.push("命令行中包含高危破坏性操作");
    } else {
      classification = "write_or_unknown";
      segReasons.push(`未列入纯只读白名单的命令 (${executable})，按 Fail-Closed 原则需确认或命中显式允许规则`);
    }

    // Pipe-to-shell check: e.g. `curl ... | bash` or `irm ... | iex`
    if (seg.operatorBefore === "|" && SHELL_INTERPRETERS.has(executable)) {
      const prevSeg = analyzedSegments[analyzedSegments.length - 1];
      if (prevSeg && NETWORK_FETCH_EXECUTABLES.has(prevSeg.executable)) {
        hasPipeToShell = true;
        classification = "destructive";
        segReasons.push("检测到远程下载内容直接通过管道交由脚本引擎执行");
      }
    }

    // Per-segment redirection / command-substitution downgrades read_only -> write_or_unknown
    if (seg.hasRedirection && classification === "read_only") {
      classification = "write_or_unknown";
      segReasons.push("包含输出重定向，可能写入或覆盖文件");
    }
    if (seg.hasCommandSub && classification === "read_only") {
      classification = "write_or_unknown";
      segReasons.push("包含命令替换，无法静态保证只读");
    }

    const outsidePaths = checkSegmentPathBoundary(
      tokens,
      extraDirs,
      virtualCwd,
      rootCwd,
      classification === "read_only",
      allowedReadRoots
    );
    if (outsidePaths.length > 0) {
      segReasons.push(`涉及工作目录之外的路径：${outsidePaths.join(", ")}`);
    }

    analyzedSegments.push({
      raw: seg.raw,
      tokens,
      executable,
      classification,
      reasons: segReasons,
      outsideWorkspacePaths: outsidePaths,
    });
  }

  const allOutsidePaths = [
    ...new Set(analyzedSegments.flatMap((s) => s.outsideWorkspacePaths)),
  ];
  const outsideWorkspace = allOutsidePaths.length > 0;
  const hasDestructive = analyzedSegments.some((s) => s.classification === "destructive");
  const isRisky = hasDestructive || hasPipeToShell;

  const isReadOnly =
    analyzedSegments.length > 0 &&
    !hasRedirection &&
    !hasCommandSub &&
    !hasDynamicEval &&
    !hasPipeToShell &&
    !outsideWorkspace &&
    analyzedSegments.every((s) => s.classification === "read_only");

  // Prioritize destructive & boundary reasons before routine Fail-Closed explanations
  const destructiveReasons = analyzedSegments
    .filter((s) => s.classification === "destructive")
    .flatMap((s) => s.reasons);
  const otherReasons = analyzedSegments
    .filter((s) => s.classification !== "destructive")
    .flatMap((s) => s.reasons);
  const combinedReasons = [...destructiveReasons, ...globalReasons, ...otherReasons];

  return {
    raw: command,
    segments: analyzedSegments,
    hasCompound: analyzedSegments.length > 1,
    hasRedirection,
    hasCommandSub,
    hasDynamicEval,
    hasPipeToShell,
    outsideWorkspace,
    outsideWorkspacePaths: allOutsidePaths,
    isReadOnly,
    isRisky,
    reasons: [...new Set(combinedReasons)],
  };
}
