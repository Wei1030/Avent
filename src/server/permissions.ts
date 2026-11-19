import type { PermissionMode, PermissionRuleRecord } from "../shared/types.js";

export interface NormalizedToolDescriptor {
  toolName: string;
  specifier: string;
  displayDetail: string;
  filePath?: string;
  isEditOrWrite: boolean;
  isReadOnly: boolean;
  isRisky: boolean;
  suggestedRule: string;
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

const EDIT_WRITE_PATTERNS = [
  /^edit/i,
  /^write/i,
  /^multi_edit/i,
  /^replace/i,
  /^create_file/i,
  /^patch/i,
];

const SHELL_PATTERNS = [
  /^bash$/i,
  /^sh$/i,
  /^powershell$/i,
  /^cmd$/i,
  /^run_command$/i,
  /^terminal/i,
  /^execute/i,
];

const RISKY_SHELL_REGEX =
  /\b(rm\s+-rf|del\s+\/[fsq]|Remove-Item\s+.*-Recurse|git\s+reset\s+--hard|git\s+push\s+--force|git\s+clean\s+-fd|drop\s+table|format\s+[a-z]:)/i;

export function describeToolCall(
  rawName: string,
  rawTitle: string,
  rawInput: unknown
): NormalizedToolDescriptor {
  const inputObj =
    rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  let canonical = (rawName || rawTitle || "Tool").trim();
  // Clean up MCP prefixes for readability while preserving matching
  if (canonical.includes(" ")) {
    canonical = canonical.split(/\s+/)[0];
  }

  const commandStr = String(
    inputObj.command ?? inputObj.CommandLine ?? inputObj.cmd ?? ""
  ).trim();
  const filePathStr = String(
    inputObj.file_path ?? inputObj.filePath ?? inputObj.path ?? inputObj.Path ?? inputObj.targetPath ?? ""
  ).trim();
  const patternStr = String(inputObj.pattern ?? inputObj.query ?? "").trim();

  const isShell = SHELL_PATTERNS.some((re) => re.test(canonical)) || Boolean(commandStr);
  const isEditOrWrite =
    !isShell &&
    (EDIT_WRITE_PATTERNS.some((re) => re.test(canonical)) ||
      rawTitle.toLowerCase().includes("write") ||
      rawTitle.toLowerCase().includes("edit"));
  const isReadOnly =
    !isShell &&
    !isEditOrWrite &&
    READ_ONLY_PATTERNS.some((re) => re.test(canonical) || re.test(rawTitle));

  let normalizedTool = canonical;
  if (isShell) normalizedTool = "Bash";
  else if (isEditOrWrite && /^write|create/i.test(canonical)) normalizedTool = "Write";
  else if (isEditOrWrite) normalizedTool = "Edit";
  else if (/avent_doc_read|^read|view_file/i.test(canonical)) normalizedTool = "Read";
  else if (/avent_doc_grep|^grep/i.test(canonical)) normalizedTool = "Grep";

  const specifier = commandStr || filePathStr || patternStr || rawTitle || "";
  const displayDetail =
    commandStr ||
    (filePathStr && patternStr ? `${patternStr} · ${filePathStr}` : filePathStr || patternStr || rawTitle || "");

  const isRisky = isShell && RISKY_SHELL_REGEX.test(commandStr || rawTitle);

  let suggestedRule = normalizedTool;
  if (isShell && commandStr) {
    const firstTokens = commandStr.split(/\s+/).slice(0, 2).join(" ");
    suggestedRule = `Bash(${firstTokens}*)`;
  } else if (filePathStr) {
    const normalizedPath = filePathStr.replace(/\\/g, "/");
    const slashIdx = normalizedPath.indexOf("/");
    suggestedRule =
      slashIdx > 0
        ? `${normalizedTool}(${normalizedPath.slice(0, slashIdx)}/**)`
        : `${normalizedTool}(*)`;
  }

  return {
    toolName: normalizedTool,
    specifier,
    displayDetail,
    filePath: filePathStr || undefined,
    isEditOrWrite,
    isReadOnly,
    isRisky,
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

/**
 * Matches a rule like `Bash`, `Edit(src/**)`, `Bash(npm test*)`, or `mcp__github__*`.
 */
export function matchesPermissionRule(
  rulePattern: string,
  descriptor: NormalizedToolDescriptor,
  rawName: string
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

  const specNormalized = descriptor.specifier.replace(/\\/g, "/");
  // For shell commands, `*` should also match spaces and slashes!
  if (descriptor.toolName === "Bash") {
    const cmdEscaped = ruleSpec
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${cmdEscaped}$`, "i").test(descriptor.specifier);
  }

  return globToRegExp(ruleSpec).test(specNormalized);
}

export type PermissionEvaluationResult =
  | { action: "allow"; provenance: string }
  | { action: "deny"; provenance: string }
  | { action: "ask"; provenance: string };

/**
 * Evaluates permission rules in strict precedence order:
 * 1. Explicit `deny` rules
 * 2. Explicit `ask` rules
 * 3. `bypassPermissions` mode (unless matched by deny/ask above)
 * 4. Explicit `allow` rules
 * 5. `acceptEdits` mode for file edits/writes & read-only tools
 * 6. Safe read-only tools in `default` mode
 * 7. Interactive human approval (`ask`)
 */
export function evaluateToolPermission(params: {
  mode: PermissionMode;
  rules: PermissionRuleRecord[];
  descriptor: NormalizedToolDescriptor;
  rawName: string;
}): PermissionEvaluationResult {
  const { mode, rules, descriptor, rawName } = params;

  for (const r of rules) {
    if (r.behavior === "deny" && matchesPermissionRule(r.rule, descriptor, rawName)) {
      return { action: "deny", provenance: `命中拒绝规则 ${r.rule}` };
    }
  }

  for (const r of rules) {
    if (r.behavior === "ask" && matchesPermissionRule(r.rule, descriptor, rawName)) {
      return { action: "ask", provenance: `命中询问规则 ${r.rule}` };
    }
  }

  if (mode === "bypassPermissions" && !descriptor.isRisky) {
    return { action: "allow", provenance: "全自动执行模式" };
  }

  for (const r of rules) {
    if (r.behavior === "allow" && matchesPermissionRule(r.rule, descriptor, rawName)) {
      return { action: "allow", provenance: `命中允许规则 ${r.rule}` };
    }
  }

  if (descriptor.isReadOnly) {
    return { action: "allow", provenance: "只读工具自动放行" };
  }

  if (mode === "acceptEdits" && descriptor.isEditOrWrite) {
    return { action: "allow", provenance: "自动接受文件编辑" };
  }

  return { action: "ask", provenance: "需要人工确认" };
}
