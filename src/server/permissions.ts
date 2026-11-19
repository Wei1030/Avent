import path from "node:path";
import type {
  PermissionEvaluationPreview,
  PermissionMode,
  PermissionRuleRecord,
  ToolCategory,
} from "../shared/types.js";
import {
  analyzeShellCommand,
  isPathInsideRoot,
  type ShellCommandAnalysis,
} from "./shell-parser.js";

export interface NormalizedToolDescriptor {
  toolName: string;
  category: ToolCategory;
  specifier: string;
  displayDetail: string;
  filePath?: string;
  isEditOrWrite: boolean;
  isReadOnly: boolean;
  isRisky: boolean;
  outsideWorkspace: boolean;
  reasons: string[];
  suggestedRule: string;
  shellAnalysis?: ShellCommandAnalysis;
}

const READ_ONLY_PATTERNS = [
  /^read/i,
  /^grep/i,
  /^glob/i,
  /^ls$/i,
  /^list_dir/i,
  /^view_file/i,
  /^find_by_name/i,
  /^grep_search/i,
  /avent_doc_read/i,
  /avent_doc_grep/i,
  /avent_history_grep/i,
];

const DELETE_MOVE_PATTERNS = [
  /^delete/i,
  /^remove/i,
  /^unlink/i,
  /^rm_/i,
  /^move_file/i,
  /^rename_file/i,
  /^mv$/i,
];

const EDIT_WRITE_PATTERNS = [
  /^edit/i,
  /^write/i,
  /^multi_edit/i,
  /^replace/i,
  /^create_file/i,
  /^patch/i,
  /^apply_patch/i,
];

const SHELL_PATTERNS = [
  /^bash$/i,
  /^sh$/i,
  /^zsh$/i,
  /^powershell$/i,
  /^pwsh$/i,
  /^cmd$/i,
  /^run_command$/i,
  /^terminal/i,
  /^execute/i,
];

export interface DescribeToolOptions {
  rawKind?: string | null;
  cwd?: string;
  allowedReadRoots?: string[];
}

export function describeToolCall(
  rawName: string,
  rawTitle: string,
  rawInput: unknown,
  options?: DescribeToolOptions
): NormalizedToolDescriptor {
  const inputObj =
    rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  let canonical = (rawName || rawTitle || "Tool").trim();
  if (canonical.includes(" ")) {
    canonical = canonical.split(/\s+/)[0];
  }

  const commandStr = String(
    inputObj.command ?? inputObj.CommandLine ?? inputObj.cmd ?? ""
  ).trim();
  const filePathStr = String(
    inputObj.file_path ??
      inputObj.filePath ??
      inputObj.path ??
      inputObj.Path ??
      inputObj.targetPath ??
      inputObj.TargetFile ??
      ""
  ).trim();
  const destPathStr = String(
    inputObj.destination ?? inputObj.dest ?? inputObj.newPath ?? inputObj.new_path ?? ""
  ).trim();
  const patternStr = String(inputObj.pattern ?? inputObj.query ?? "").trim();

  const rawKind = (options?.rawKind ?? "").toLowerCase();

  // 1. Determine structured ToolCategory (Fail-Closed: unrecognized tools => "other", never read-only)
  const isShell =
    SHELL_PATTERNS.some((re) => re.test(canonical)) ||
    rawKind === "execute" ||
    Boolean(commandStr);

  let category: ToolCategory = "other";
  if (isShell) {
    category = "shell";
  } else if (
    rawKind === "delete" ||
    rawKind === "move" ||
    DELETE_MOVE_PATTERNS.some((re) => re.test(canonical))
  ) {
    category = "delete";
  } else if (
    rawKind === "edit" ||
    EDIT_WRITE_PATTERNS.some((re) => re.test(canonical)) ||
    /\b(write_to_file|replace_file|edit_file)\b/i.test(rawTitle)
  ) {
    category = "edit";
  } else if (
    rawKind === "read" ||
    rawKind === "search" ||
    READ_ONLY_PATTERNS.some((re) => re.test(canonical) || re.test(rawTitle))
  ) {
    category = "read";
  } else {
    category = "other";
  }

  // Normalized user-facing tool label
  let normalizedTool = canonical;
  if (category === "shell") normalizedTool = "Bash";
  else if (category === "delete") {
    normalizedTool = rawKind === "move" || /move|rename|mv/i.test(canonical) ? "Move" : "Delete";
  } else if (category === "edit") {
    normalizedTool = /^write|create/i.test(canonical) ? "Write" : "Edit";
  } else if (category === "read") {
    if (/avent_doc_read|^read|view_file/i.test(canonical)) normalizedTool = "Read";
    else if (/avent_doc_grep|^grep/i.test(canonical)) normalizedTool = "Grep";
    else if (/^glob|find_by_name/i.test(canonical)) normalizedTool = "Glob";
  }

  const specifier = commandStr || filePathStr || patternStr || rawTitle || "";
  const displayDetail =
    commandStr ||
    (filePathStr && destPathStr
      ? `${filePathStr} → ${destPathStr}`
      : filePathStr && patternStr
        ? `${patternStr} · ${filePathStr}`
        : filePathStr || patternStr || rawTitle || "");

  // 2. Deep analysis for Shell commands vs Path-Boundary check for structured tools
  if (category === "shell") {
    const shellCmd = commandStr || rawTitle || "";
    const shellAnalysis = analyzeShellCommand(shellCmd, {
      cwd: options?.cwd,
      allowedReadRoots: options?.allowedReadRoots,
    });

    let suggestedRule = "";
    const canSuggest =
      !shellAnalysis.isRisky &&
      !shellAnalysis.outsideWorkspace &&
      !shellAnalysis.hasRedirection &&
      !shellAnalysis.hasCommandSub &&
      !shellAnalysis.hasDynamicEval;
    if (canSuggest && shellAnalysis.segments.length > 0) {
      const targetSeg =
        shellAnalysis.segments.find((s) => s.classification !== "read_only") ??
        shellAnalysis.segments[0];
      const prefix = targetSeg.tokens.slice(0, 2).join(" ").trim();
      if (prefix) suggestedRule = `Bash(${prefix}*)`;
    }

    return {
      toolName: normalizedTool,
      category,
      specifier: shellCmd,
      displayDetail: shellCmd || displayDetail,
      filePath: undefined,
      isEditOrWrite: false,
      isReadOnly: shellAnalysis.isReadOnly,
      isRisky: shellAnalysis.isRisky,
      outsideWorkspace: shellAnalysis.outsideWorkspace,
      reasons: shellAnalysis.reasons,
      suggestedRule,
      shellAnalysis,
    };
  }

  // Non-shell path boundary validation
  const reasons: string[] = [];
  let outsideWorkspace = false;
  const cwd = options?.cwd?.trim() ? path.resolve(options.cwd) : "";
  const allowedReadRoots = (options?.allowedReadRoots ?? []).filter(Boolean);

  if (cwd) {
    const pathsToCheck = [filePathStr, destPathStr].filter(Boolean);
    for (const p of pathsToCheck) {
      const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
      const inside = isPathInsideRoot(resolved, cwd);
      const insideAllowedRead =
        category === "read" && allowedReadRoots.some((r) => isPathInsideRoot(resolved, r));
      if (!inside && !insideAllowedRead) {
        outsideWorkspace = true;
        reasons.push(`目标路径位于当前任务工作目录之外：${p}`);
      }
    }
  }

  let isRisky = false;
  if (category === "delete") {
    isRisky = true;
    reasons.push("文件删除或移动属于高影响/不可逆操作，默认需要人工确认");
  } else if (category === "other") {
    reasons.push(`外部或未分类工具 (${canonical})，按 Fail-Closed 原则需人工确认`);
  }

  const isEditOrWrite = category === "edit";
  const isReadOnly = category === "read" && !outsideWorkspace;

  // Build suggested rule (avoid suggesting broad rules for outside-workspace or delete actions)
  let suggestedRule = "";
  if (!outsideWorkspace && !isRisky) {
    if (filePathStr) {
      const normalizedPath = filePathStr.replace(/\\/g, "/");
      const slashIdx = normalizedPath.indexOf("/");
      suggestedRule =
        slashIdx > 0
          ? `${normalizedTool}(${normalizedPath.slice(0, slashIdx)}/**)`
          : `${normalizedTool}(*)`;
    } else {
      suggestedRule = normalizedTool;
    }
  }

  return {
    toolName: normalizedTool,
    category,
    specifier,
    displayDetail,
    filePath: filePathStr || undefined,
    isEditOrWrite,
    isReadOnly,
    isRisky,
    outsideWorkspace,
    reasons,
    suggestedRule,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLE_STAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLE_STAR___/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchShellPattern(ruleSpec: string, commandText: string): boolean {
  const cmdEscaped = ruleSpec
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${cmdEscaped}$`, "i").test(commandText.trim());
}

/**
 * Matches a single rule like `Bash`, `Edit(src/**)`, `Bash(npm.cmd test*)`, or `mcp__github__*`.
 * For Shell commands, `overrideShellText` allows matching a single split sub-command cleanly.
 */
export function matchesPermissionRule(
  rulePattern: string,
  descriptor: NormalizedToolDescriptor,
  rawName: string,
  overrideShellText?: string
): boolean {
  const trimmed = rulePattern.trim();
  if (!trimmed) return false;

  const parenMatch = /^([A-Za-z0-9_:-]+)\(([\s\S]*)\)$/.exec(trimmed);
  if (!parenMatch) {
    const toolRe = globToRegExp(trimmed);
    return toolRe.test(descriptor.toolName) || toolRe.test(rawName);
  }

  const [, ruleTool, ruleSpec] = parenMatch;
  const toolRe = globToRegExp(ruleTool);
  if (!toolRe.test(descriptor.toolName) && !toolRe.test(rawName)) {
    return false;
  }

  if (descriptor.category === "shell") {
    const targetCmd = overrideShellText ?? descriptor.specifier;
    return matchShellPattern(ruleSpec, targetCmd);
  }

  const specNormalized = descriptor.specifier.replace(/\\/g, "/");
  return globToRegExp(ruleSpec).test(specNormalized);
}

/**
 * Matches a rule against a shell command by testing the full string AND each individual split segment.
 * Used for `deny` and `ask` rules so compound chaining (`npm test && git push --force`) NEVER evades them.
 */
function matchesRuleAnySegment(
  rulePattern: string,
  descriptor: NormalizedToolDescriptor,
  rawName: string
): boolean {
  if (matchesPermissionRule(rulePattern, descriptor, rawName)) {
    return true;
  }
  if (descriptor.category === "shell" && descriptor.shellAnalysis) {
    return descriptor.shellAnalysis.segments.some((seg) =>
      matchesPermissionRule(rulePattern, descriptor, rawName, seg.raw)
    );
  }
  return false;
}

export type PermissionEvaluationResult =
  | { action: "allow"; provenance: string }
  | { action: "deny"; provenance: string }
  | { action: "ask"; provenance: string };

/**
 * Evaluates tool permissions in strict fail-closed precedence order:
 * 1. Explicit `deny` rules (matched against full command AND every split sub-command)
 * 2. Explicit `ask` rules (matched against full command AND every split sub-command)
 * 3. Hard Safety Gates:
 *    - Workspace path boundary escape (always `ask`, even in acceptEdits / bypassPermissions)
 *    - Destructive / high-risk operations (rm, Remove-Item, git reset --hard, pipe-to-shell, file Delete, etc. -> always `ask`)
 * 4. `bypassPermissions` mode (only reached if in-workspace, non-risky, and not denied/asked)
 * 5. Shell compound / hazard gate:
 *    - Redirection (`>` / `>>`), command substitution (`$(...)` / backticks), or dynamic eval (`eval` / `iex` / `bash -c`)
 *      CANNOT piggyback on prefix `allow` rules or built-in read-only whitelist -> forced `ask`
 *    - For clean single or compound shell commands: EVERY split segment must independently be either
 *      pure `read_only` OR matched by an explicit `allow` rule!
 * 6. Non-shell explicit `allow` rules -> built-in safe `read` -> `acceptEdits` (edit only, NOT delete!) -> `ask`
 */
export function evaluateToolPermission(params: {
  mode: PermissionMode;
  rules: PermissionRuleRecord[];
  descriptor: NormalizedToolDescriptor;
  rawName: string;
}): PermissionEvaluationResult {
  const { mode, rules, descriptor, rawName } = params;

  // 1. Explicit deny rules (highest precedence, inspects every sub-command)
  for (const r of rules) {
    if (r.behavior === "deny" && matchesRuleAnySegment(r.rule, descriptor, rawName)) {
      return { action: "deny", provenance: `命中拒绝规则 ${r.rule}` };
    }
  }

  // 2. Explicit ask rules (inspects every sub-command)
  for (const r of rules) {
    if (r.behavior === "ask" && matchesRuleAnySegment(r.rule, descriptor, rawName)) {
      return { action: "ask", provenance: `命中询问规则 ${r.rule}` };
    }
  }

  // 3. Hard Safety Gates (never bypassed by mode or broad allow rules)
  if (descriptor.outsideWorkspace) {
    return {
      action: "ask",
      provenance: "越出当前任务工作目录，强制人工确认",
    };
  }

  if (descriptor.isRisky) {
    return {
      action: "ask",
      provenance: descriptor.reasons[0] || "检测到高危或删除操作，需人工确认",
    };
  }

  // 4. Full-auto mode (only for in-workspace, non-risky operations)
  if (mode === "bypassPermissions") {
    return { action: "allow", provenance: "全自动执行模式（工作区内常规操作）" };
  }

  // 5. Shell commands: strict per-segment Fail-Closed evaluation
  if (descriptor.category === "shell") {
    const analysis = descriptor.shellAnalysis;
    if (!analysis || analysis.segments.length === 0) {
      return { action: "ask", provenance: "无法解析的终端命令，需人工确认" };
    }

    // Syntax hazards cannot piggyback on allow prefix rules or read-only whitelist!
    if (analysis.hasRedirection) {
      return { action: "ask", provenance: "包含输出重定向（> / >>），禁止自动放行" };
    }
    if (analysis.hasCommandSub) {
      return { action: "ask", provenance: "包含命令替换（$(...) 或反引号），禁止自动放行" };
    }
    if (analysis.hasDynamicEval) {
      return { action: "ask", provenance: "包含嵌套 Shell 或动态求值，禁止自动放行" };
    }

    const allowRules = rules.filter((r) => r.behavior === "allow");
    const matchedAllowRules: string[] = [];
    let readOnlyCount = 0;

    for (const seg of analysis.segments) {
      if (seg.classification === "read_only") {
        readOnlyCount++;
        continue;
      }
      const matched = allowRules.find((r) =>
        matchesPermissionRule(r.rule, descriptor, rawName, seg.raw)
      );
      if (matched) {
        if (!matchedAllowRules.includes(matched.rule)) {
          matchedAllowRules.push(matched.rule);
        }
        continue;
      }
      // Fail-Closed: any segment not strictly proven read-only and not explicitly allowed forces `ask`!
      return {
        action: "ask",
        provenance:
          analysis.hasCompound
            ? `复合命令中的子命令「${seg.raw.slice(0, 60)}」未命中允许规则，需人工确认`
            : seg.reasons[0] || "非常规终端命令，需人工确认",
      };
    }

    if (matchedAllowRules.length > 0) {
      return {
        action: "allow",
        provenance: `命中允许规则 ${matchedAllowRules.join("、")}`,
      };
    }
    if (readOnlyCount === analysis.segments.length) {
      return { action: "allow", provenance: "纯只读终端命令自动放行" };
    }
    return { action: "ask", provenance: "需要人工确认" };
  }

  // 6. Non-shell structured tools (`read`, `edit`, `other`)
  for (const r of rules) {
    if (r.behavior === "allow" && matchesPermissionRule(r.rule, descriptor, rawName)) {
      return { action: "allow", provenance: `命中允许规则 ${r.rule}` };
    }
  }

  if (descriptor.isReadOnly) {
    return { action: "allow", provenance: "工作区内只读工具自动放行" };
  }

  if (mode === "acceptEdits" && descriptor.category === "edit") {
    return { action: "allow", provenance: "自动接受工作区内文件编辑" };
  }

  return {
    action: "ask",
    provenance: descriptor.reasons[0] || "需要人工确认",
  };
}

/**
 * Helper used by the `/api/rules/evaluate` interactive simulator in Settings -> Permissions.
 */
export function previewToolPermission(params: {
  toolKind: "shell" | "edit" | "delete" | "read" | "other";
  inputText: string;
  mode: PermissionMode;
  rules: PermissionRuleRecord[];
  cwd?: string;
}): PermissionEvaluationPreview {
  const { toolKind, inputText, mode, rules, cwd } = params;
  const trimmed = inputText.trim();

  let rawName = "Bash";
  let rawKind: string = "execute";
  let rawInput: Record<string, unknown> = { command: trimmed };

  if (toolKind === "edit") {
    rawName = "Edit";
    rawKind = "edit";
    rawInput = { file_path: trimmed };
  } else if (toolKind === "delete") {
    rawName = "Delete";
    rawKind = "delete";
    rawInput = { file_path: trimmed };
  } else if (toolKind === "read") {
    rawName = "Read";
    rawKind = "read";
    rawInput = { file_path: trimmed };
  } else if (toolKind === "other") {
    rawName = trimmed || "mcp_tool";
    rawKind = "other";
    rawInput = {};
  }

  const descriptor = describeToolCall(rawName, trimmed, rawInput, { rawKind, cwd });
  const result = evaluateToolPermission({ mode, rules, descriptor, rawName });

  return {
    action: result.action,
    provenance: result.provenance,
    toolName: descriptor.toolName,
    category: descriptor.category,
    isReadOnly: descriptor.isReadOnly,
    isRisky: descriptor.isRisky,
    outsideWorkspace: descriptor.outsideWorkspace,
    reasons: descriptor.reasons,
    suggestedRule: descriptor.suggestedRule,
    hazards: {
      hasCompound: descriptor.shellAnalysis?.hasCompound ?? false,
      hasRedirection: descriptor.shellAnalysis?.hasRedirection ?? false,
      hasCommandSub: descriptor.shellAnalysis?.hasCommandSub ?? false,
      hasDynamicEval: descriptor.shellAnalysis?.hasDynamicEval ?? false,
      hasPipeToShell: descriptor.shellAnalysis?.hasPipeToShell ?? false,
    },
    subCommands: (descriptor.shellAnalysis?.segments ?? []).map((s) => ({
      raw: s.raw,
      executable: s.executable,
      classification: s.classification,
      reasons: s.reasons,
    })),
  };
}
