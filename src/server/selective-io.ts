import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

export const DEFAULT_MAX_READ_CHARS = 6000;
export const HARD_MAX_READ_CHARS = 8000;

/**
 * Spill oversized output to disk so a single file read or command stdout never bloats KV cache.
 * Implements arXiv:2611.05306v1 Section 2.4.2 & Appendix E.
 */
export function spillIfOversized(params: {
  spillsDir: string;
  taskId: string;
  label: string;
  content: string;
  maxChars?: number;
}): { text: string; spilledPath?: string; truncated: boolean } {
  const maxChars = Math.min(params.maxChars ?? DEFAULT_MAX_READ_CHARS, HARD_MAX_READ_CHARS);
  if (params.content.length <= maxChars) {
    return { text: params.content, truncated: false };
  }

  const taskSpillDir = path.join(params.spillsDir, params.taskId);
  mkdirSync(taskSpillDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(params.content).digest("hex").slice(0, 10);
  const safeLabel = params.label.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
  const spillFile = path.join(taskSpillDir, `${safeLabel}_${hash}.txt`);
  writeFileSync(spillFile, params.content, "utf8");

  const lines = params.content.split(/\r?\n/);
  const headChars = Math.floor(maxChars * 0.75);
  const tailChars = maxChars - headChars;
  const preview =
    params.content.slice(0, headChars) +
    `\n\n... [AVENT CONTEXT FIREWALL: Spilled ${params.content.length} chars (${lines.length} lines) -> ${spillFile}]\n` +
    `[To inspect specific passages without blowing context budget, call avent_doc_grep or avent_doc_read on "${spillFile}"] ...\n\n` +
    params.content.slice(-tailChars);

  return { text: preview, spilledPath: spillFile, truncated: true };
}

/**
 * Bounded window document reader (arXiv:2611.05306v1 Appendix E.1 `doc-read`).
 */
export function boundedDocRead(params: {
  cwd: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}): string {
  const resolved = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(params.cwd, params.filePath);

  if (!existsSync(resolved)) {
    return `Error: File does not exist: ${resolved}`;
  }
  const st = statSync(resolved);
  if (st.isDirectory()) {
    const entries = readdirSync(resolved).slice(0, 100);
    return `Directory ${resolved} (${entries.length} items shown):\n` + entries.join("\n");
  }

  const maxChars = Math.min(params.maxChars ?? DEFAULT_MAX_READ_CHARS, HARD_MAX_READ_CHARS);
  const raw = readFileSync(resolved, "utf8");
  const allLines = raw.split(/\r?\n/);
  const totalLines = allLines.length;

  const start = Math.max(1, params.startLine ?? 1);
  const requestedEnd = params.endLine ? Math.min(totalLines, params.endLine) : totalLines;

  const outLines: string[] = [];
  let charCount = 0;
  let actualEnd = start - 1;

  for (let i = start; i <= requestedEnd; i++) {
    const formatted = `${i}: ${allLines[i - 1]}`;
    if (charCount + formatted.length + 1 > maxChars && outLines.length > 0) {
      break;
    }
    outLines.push(formatted);
    charCount += formatted.length + 1;
    actualEnd = i;
  }

  const nextHint =
    actualEnd < totalLines
      ? ` | next window: avent_doc_read(filePath="${resolved}", startLine=${actualEnd + 1}, endLine=${Math.min(totalLines, actualEnd + 80)})`
      : " | [EOF]";

  return `[${resolved} | lines ${start}:${actualEnd} of ${totalLines}${nextHint}]\n` + outLines.join("\n");
}

/**
 * Fast regex search across workspace or spill files using bundled ripgrep.
 */
export function surgicalGrep(params: {
  cwd: string;
  pattern: string;
  targetPath?: string;
  maxMatches?: number;
}): string {
  const maxMatches = Math.min(params.maxMatches ?? 40, 100);
  const searchTarget = params.targetPath
    ? path.isAbsolute(params.targetPath)
      ? params.targetPath
      : path.resolve(params.cwd, params.targetPath)
    : params.cwd;

  if (rgPath && existsSync(rgPath)) {
    const res = spawnSync(
      rgPath,
      [
        "-n",
        "-i",
        "--max-count",
        String(maxMatches),
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.git/**",
        params.pattern,
        searchTarget,
      ],
      { cwd: params.cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
    );
    const stdout = (res.stdout || "").trim();
    if (!stdout) {
      return `No matches found for pattern "${params.pattern}" in ${searchTarget}.`;
    }
    const lines = stdout.split(/\r?\n/).slice(0, maxMatches);
    return (
      `[Matches: ${lines.length} shown (use avent_doc_read around line numbers for context)]\n` +
      lines.join("\n").slice(0, DEFAULT_MAX_READ_CHARS)
    );
  }

  // Fallback pure-JS search on single file if ripgrep binary is unavailable
  if (existsSync(searchTarget) && statSync(searchTarget).isFile()) {
    const re = new RegExp(params.pattern, "i");
    const lines = readFileSync(searchTarget, "utf8").split(/\r?\n/);
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
      if (re.test(lines[i])) {
        hits.push(`${searchTarget}:${i + 1}:${lines[i].slice(0, 220)}`);
      }
    }
    return hits.length > 0 ? hits.join("\n") : `No matches found in ${searchTarget}.`;
  }

  return `Search target not accessible: ${searchTarget}`;
}

/**
 * Lossless history search across archived prior pulses (arXiv:2611.05306v1 Section 3.1).
 */
export function searchPulseHistory(params: {
  archiveDir: string;
  taskId: string;
  query: string;
  maxMatches?: number;
}): string {
  const taskDir = path.join(params.archiveDir, params.taskId);
  if (!existsSync(taskDir)) {
    return "No prior pulse archives exist for this task yet.";
  }

  const files = readdirSync(taskDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    return "No prior pulse archives exist for this task yet.";
  }

  const maxMatches = Math.min(params.maxMatches ?? 25, 60);
  let re: RegExp;
  try {
    re = new RegExp(params.query, "i");
  } catch {
    const escaped = params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(escaped, "i");
  }

  const hits: string[] = [];
  for (const file of files) {
    const full = path.join(taskDir, file);
    const lines = readFileSync(full, "utf8").split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (line && re.test(line)) {
        hits.push(`[${file}#L${idx + 1}] ${line.slice(0, 320)}`);
        if (hits.length >= maxMatches) break;
      }
    }
    if (hits.length >= maxMatches) break;
  }

  if (hits.length === 0) {
    return `No matches found in archived pulse history for "${params.query}".`;
  }
  return `[Archived Pulse History Matches (${hits.length})]\n` + hits.join("\n");
}
