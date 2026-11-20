import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type { AventStore } from "./db.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaPoolGroup,
  QuotaWindowBucket,
} from "../shared/types.js";

const QUOTA_CACHE_TTL_MS = 60_000;
const PROVIDER_ORDER: ProviderId[] = ["agy", "claude", "codex"];

export interface RawClaudeRateLimitInfo {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number | string;
  isUsingOverage?: boolean;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function killProc(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
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

function sortBuckets(buckets: QuotaWindowBucket[]): QuotaWindowBucket[] {
  const rank = (w: QuotaWindowBucket["window"]) => (w === "5h" ? 0 : w === "weekly" ? 1 : 2);
  return [...buckets].sort((a, b) => rank(a.window) - rank(b.window) || a.id.localeCompare(b.id));
}

function localizeAgyGroupName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "gemini models") return "Gemini 模型池";
  if (lower === "claude and gpt models") return "Claude & GPT 模型池";
  return name.trim();
}

function localizeWindowLabel(window: "5h" | "weekly" | "other", fallback: string): string {
  if (window === "5h") return "5 小时窗口";
  if (window === "weekly") return "每周窗口";
  return fallback;
}

/**
 * Pure parser for `agy -p "/usage" --output-format json` stdout.
 */
export function parseAgyUsageJson(
  rawStdout: string,
  meta?: { planLabel?: string; checkedAt?: string }
): ProviderQuotaSnapshot {
  const checkedAt = meta?.checkedAt ?? new Date().toISOString();
  const trimmed = rawStdout.trim();
  // Locate the JSON object in case stderr/banner leaked before it
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error("agy /usage 未返回有效 JSON");
  }

  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
    status?: string;
    command?: {
      name?: string;
      data?: {
        groups?: Array<{
          name?: string;
          description?: string;
          buckets?: Array<{
            id?: string;
            name?: string;
            description?: string;
            window?: string;
            remaining_fraction?: number;
            reset_time?: string;
          }>;
        }>;
      };
    };
  };

  const rawGroups = parsed.command?.data?.groups;
  if (!Array.isArray(rawGroups)) {
    throw new Error("agy /usage 返回缺少 command.data.groups 字段");
  }

  const groups: QuotaPoolGroup[] = rawGroups.map((g, gi) => {
    const rawName = String(g.name || `模型池 ${gi + 1}`);
    const buckets: QuotaWindowBucket[] = (g.buckets ?? []).map((b, bi) => {
      const win: QuotaWindowBucket["window"] =
        b.window === "5h" ? "5h" : b.window === "weekly" ? "weekly" : "other";
      const frac =
        typeof b.remaining_fraction === "number" && Number.isFinite(b.remaining_fraction)
          ? clamp(b.remaining_fraction, 0, 1)
          : 1;
      const remainingPercent = Math.round(frac * 100);
      const usedPercent = clamp(100 - remainingPercent, 0, 100);
      return {
        id: String(b.id || `${gi}-${bi}`),
        label: localizeWindowLabel(win, String(b.name || "额度窗口")),
        window: win,
        usedPercent,
        remainingPercent,
        resetsAt: typeof b.reset_time === "string" && b.reset_time ? b.reset_time : undefined,
        status:
          remainingPercent === 0
            ? "rejected"
            : remainingPercent <= 15
              ? "allowed_warning"
              : "allowed",
        description: typeof b.description === "string" ? b.description : undefined,
      };
    });

    return {
      id: rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: localizeAgyGroupName(rawName),
      description: typeof g.description === "string" ? g.description : undefined,
      buckets: sortBuckets(buckets),
    };
  });

  return {
    providerId: "agy",
    providerName: "Google Antigravity",
    available: true,
    planLabel: meta?.planLabel,
    source: "active_cli",
    checkedAt,
    groups,
  };
}

interface RawClaudeUsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface RawClaudeUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: RawClaudeUsageWindow | null;
    seven_day?: RawClaudeUsageWindow | null;
    seven_day_opus?: RawClaudeUsageWindow | null;
    seven_day_sonnet?: RawClaudeUsageWindow | null;
    model_scoped?: Array<{
      display_name: string;
      utilization: number | null;
      resets_at: string | null;
    }>;
    extra_usage?: {
      is_enabled: boolean;
      monthly_limit: number | null;
      used_credits: number | null;
      utilization: number | null;
      currency?: string | null;
    } | null;
  } | null;
}

function formatClaudePlanLabel(raw?: string | null, fallback?: string): string | undefined {
  const s = (raw || "").trim();
  if (!s) return fallback;
  if (/^claude\s+/i.test(s)) return s;
  return `Claude ${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

function retainUnexpiredBuckets(
  existing: ProviderQuotaSnapshot | null | undefined,
  nowMs: number
): QuotaWindowBucket[] {
  if (!existing) return [];
  const kept: QuotaWindowBucket[] = [];
  for (const g of existing.groups) {
    for (const b of g.buckets) {
      if (!b.resetsAt) {
        kept.push(b);
      } else {
        const ts = Date.parse(b.resetsAt);
        if (!Number.isNaN(ts) && ts > nowMs) {
          kept.push(b);
        }
      }
    }
  }
  return sortBuckets(kept);
}

/**
 * Pure parser for `@anthropic-ai/claude-agent-sdk`'s `usage_EXPERIMENTAL_*` response,
 * preserving unexpired live `rate_limit_event` windows when the active endpoint returns `rate_limits: null`.
 */
export function parseClaudeUsagePayload(
  payload: RawClaudeUsageResponse,
  meta?: {
    planLabel?: string;
    existing?: ProviderQuotaSnapshot | null;
    checkedAt?: string;
  }
): ProviderQuotaSnapshot {
  const checkedAt = meta?.checkedAt ?? new Date().toISOString();
  const nowMs = Date.parse(checkedAt) || Date.now();
  const planLabel = formatClaudePlanLabel(payload.subscription_type, meta?.planLabel);

  const buckets: QuotaWindowBucket[] = [];
  const pushWindow = (
    id: string,
    label: string,
    win: QuotaWindowBucket["window"],
    w?: RawClaudeUsageWindow | null
  ) => {
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return;
    const usedPercent = clamp(Math.round(w.utilization), 0, 100);
    buckets.push({
      id,
      label,
      window: win,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: w.resets_at || undefined,
      status: usedPercent >= 100 ? "rejected" : usedPercent >= 85 ? "allowed_warning" : "allowed",
    });
  };

  let extraNote: string | undefined;
  const rl = payload.rate_limits_available ? payload.rate_limits : null;
  if (rl) {
    pushWindow("five_hour", "5 小时窗口", "5h", rl.five_hour);
    pushWindow("seven_day", "每周窗口（全部模型）", "weekly", rl.seven_day);
    if (Array.isArray(rl.model_scoped) && rl.model_scoped.length > 0) {
      for (const m of rl.model_scoped) {
        pushWindow(
          `weekly_${m.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          `每周窗口（${m.display_name}）`,
          "weekly",
          m
        );
      }
    } else {
      pushWindow("seven_day_opus", "每周窗口（Opus）", "weekly", rl.seven_day_opus);
      pushWindow("seven_day_sonnet", "每周窗口（Sonnet）", "weekly", rl.seven_day_sonnet);
    }
    if (rl.extra_usage?.is_enabled && rl.extra_usage.used_credits !== null) {
      const cur = rl.extra_usage.currency || "USD";
      const lim = rl.extra_usage.monthly_limit;
      extraNote = `已开启超额按量付费（已用 ${rl.extra_usage.used_credits} ${cur}${lim !== null ? ` / 上限 ${lim} ${cur}` : ""}）`;
    }
  }

  if (buckets.length > 0) {
    return {
      providerId: "claude",
      providerName: "Anthropic Claude Code",
      available: true,
      planLabel,
      source: "active_sdk",
      checkedAt,
      groups: [
        {
          id: "claude-subscription",
          name: planLabel || "Claude 订阅额度",
          buckets: sortBuckets(buckets),
        },
      ],
      extraNote,
    };
  }

  // Active SDK returned `rate_limits: null` -> preserve unexpired windows captured during live turns
  const preserved = retainUnexpiredBuckets(meta?.existing, nowMs);
  if (preserved.length > 0) {
    return {
      providerId: "claude",
      providerName: "Anthropic Claude Code",
      available: true,
      planLabel,
      source: "passive_event",
      checkedAt: meta?.existing?.checkedAt ?? checkedAt,
      groups: [
        {
          id: "claude-subscription",
          name: planLabel || "Claude 订阅额度",
          buckets: preserved,
        },
      ],
      extraNote:
        "实时百分比来自最近一次 Claude 对话响应的 rate_limit_event（主动接口当前未返回窗口数值）。",
    };
  }

  return {
    providerId: "claude",
    providerName: "Anthropic Claude Code",
    available: true,
    planLabel,
    source: "active_sdk",
    checkedAt,
    groups: [],
    extraNote: payload.rate_limits_available
      ? "已识别订阅；Claude 主动接口当前未下发百分比，执行任意 Claude 对话后将自动从 rate_limit_event 捕获并更新。"
      : "当前登录方式未报告订阅窗口限额（若使用 API Key 则按量计费，无 5 小时/每周窗口）。",
  };
}

/**
 * Merges a live `rate_limit_event` (`SDKRateLimitInfo`, received from `claude-agent-acp`
 * via `usage_update._meta["_claude/rateLimit"]` or turn failure data) into the persisted Claude snapshot.
 */
export function mergeClaudeRateLimitEvent(
  existing: ProviderQuotaSnapshot | null,
  info: RawClaudeRateLimitInfo,
  meta?: { planLabel?: string; nowIso?: string }
): ProviderQuotaSnapshot | null {
  const rateLimitType = String(info.rateLimitType || "").trim();
  const hasUtil = typeof info.utilization === "number" && Number.isFinite(info.utilization);
  const isRejected = info.status === "rejected";
  if (!hasUtil && !isRejected) {
    return null;
  }

  const nowIso = meta?.nowIso ?? new Date().toISOString();
  const usedPercent = hasUtil
    ? info.utilization! <= 1
      ? clamp(Math.round(info.utilization! * 100), 0, 100)
      : clamp(Math.round(info.utilization!), 0, 100)
    : 100;

  let resetsAt: string | undefined;
  if (typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    resetsAt = new Date(ms).toISOString();
  } else if (typeof info.resetsAt === "string" && info.resetsAt.trim()) {
    const parsed = Date.parse(info.resetsAt);
    resetsAt = Number.isNaN(parsed) ? info.resetsAt : new Date(parsed).toISOString();
  }

  const id = rateLimitType || "five_hour";
  const win: QuotaWindowBucket["window"] =
    id === "five_hour" ? "5h" : id.startsWith("seven_day") ? "weekly" : "other";
  const label =
    id === "five_hour"
      ? "5 小时窗口"
      : id === "seven_day"
        ? "每周窗口（全部模型）"
        : id === "seven_day_opus"
          ? "每周窗口（Opus）"
          : id === "seven_day_sonnet"
            ? "每周窗口（Sonnet）"
            : id;

  const status: QuotaWindowBucket["status"] =
    info.status === "rejected"
      ? "rejected"
      : info.status === "allowed_warning" || usedPercent >= 85
        ? "allowed_warning"
        : "allowed";

  const nextBucket: QuotaWindowBucket = {
    id,
    label,
    window: win,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    status,
  };

  const prevBuckets = existing?.groups[0]?.buckets ?? [];
  const mergedMap = new Map<string, QuotaWindowBucket>(prevBuckets.map((b) => [b.id, b]));
  mergedMap.set(nextBucket.id, nextBucket);

  const planLabel = existing?.planLabel || meta?.planLabel;
  return {
    providerId: "claude",
    providerName: "Anthropic Claude Code",
    available: true,
    planLabel,
    source: "passive_event",
    checkedAt: nowIso,
    groups: [
      {
        id: "claude-subscription",
        name: planLabel || "Claude 订阅额度",
        buckets: sortBuckets([...mergedMap.values()]),
      },
    ],
    extraNote: "实时额度已从 Claude 运行期 rate_limit_event 自动捕获。",
  };
}

/**
 * Pure parser for `@agentclientprotocol/codex-acp`'s `/status` Markdown output.
 * Format emitted by `formatSingleRateLimit`:
 *   `**5h limit:** 82% left (resets ...)`
 *   `**Weekly limit:** 65% left (resets ...)`
 *   `**Credits:** unlimited` / `**Credits:** $12.50`
 */
export function parseCodexStatusMarkdown(
  markdown: string,
  meta?: { planLabel?: string; checkedAt?: string }
): ProviderQuotaSnapshot {
  const checkedAt = meta?.checkedAt ?? new Date().toISOString();
  const buckets: QuotaWindowBucket[] = [];
  let creditsNote: string | undefined;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const limitMatch = /^\*\*([^*]+?):\*\*\s*(\d+(?:\.\d+)?)%\s*left(?:\s*\((?:resets?\s+)?([^)]+)\))?/i.exec(
      line
    );
    if (limitMatch) {
      const rawLabel = limitMatch[1].trim();
      const remainingPercent = clamp(Math.round(Number(limitMatch[2])), 0, 100);
      const resetRaw = limitMatch[3]?.trim();
      const lower = rawLabel.toLowerCase();
      const win: QuotaWindowBucket["window"] = /5\s*h|5-hour|hour/i.test(lower)
        ? "5h"
        : /week|7\s*d|day/i.test(lower)
          ? "weekly"
          : "other";
      const label =
        win === "5h"
          ? "5 小时窗口"
          : win === "weekly"
            ? "每周窗口"
            : rawLabel;

      let resetsAt: string | undefined;
      let description: string | undefined;
      if (resetRaw) {
        const parsed = Date.parse(resetRaw);
        if (!Number.isNaN(parsed)) {
          resetsAt = new Date(parsed).toISOString();
        } else {
          description = `重置时间：${resetRaw}`;
        }
      }

      buckets.push({
        id: rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        label,
        window: win,
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt,
        description,
        status:
          remainingPercent === 0
            ? "rejected"
            : remainingPercent <= 15
              ? "allowed_warning"
              : "allowed",
      });
      continue;
    }

    const creditMatch = /^\*\*([^*]*Credits):\*\*\s*(.+)$/i.exec(line);
    if (creditMatch) {
      creditsNote = `Credits: ${creditMatch[2].trim()}`;
    }
  }

  return {
    providerId: "codex",
    providerName: "OpenAI Codex",
    available: true,
    planLabel: meta?.planLabel,
    source: "active_acp",
    checkedAt,
    groups:
      buckets.length > 0
        ? [
            {
              id: "codex-subscription",
              name: meta?.planLabel || "Codex 订阅额度",
              buckets: sortBuckets(buckets),
            },
          ]
        : [],
    extraNote:
      creditsNote ||
      (buckets.length === 0 ? "Codex 已连接，但当前未返回 5 小时/每周限额数据。" : undefined),
  };
}

function runCommandCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProc(child);
      reject(new Error(`查询额度超时 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export class QuotaService {
  private store: AventStore;
  private registry: ProviderRegistry;
  private projectRoot: string;
  private onUpdated?: (quotas: ProviderQuotaSnapshot[]) => void;
  private inFlight = new Map<ProviderId, Promise<ProviderQuotaSnapshot>>();

  constructor(params: {
    store: AventStore;
    registry: ProviderRegistry;
    projectRoot: string;
    onUpdated?: (quotas: ProviderQuotaSnapshot[]) => void;
  }) {
    this.store = params.store;
    this.registry = params.registry;
    this.projectRoot = params.projectRoot;
    this.onUpdated = params.onUpdated;
  }

  public listCachedQuotas(): ProviderQuotaSnapshot[] {
    const statuses = new Map(this.registry.listProviderStatuses().map((p) => [p.id, p]));
    return PROVIDER_ORDER.map((id) => {
      const info = statuses.get(id);
      const saved = this.store.getProviderQuota(id);
      const available = Boolean(info?.available);
      if (!available) {
        return {
          providerId: id,
          providerName: info?.name || id,
          available: false,
          planLabel: info?.tierName,
          source: "unavailable",
          checkedAt: saved?.checkedAt,
          groups: [],
          extraNote:
            id === "codex"
              ? "未检测到本机 codex CLI；安装并执行 codex login 后可自动查询 5 小时与每周额度。"
              : id === "claude"
                ? "未检测到本机 claude CLI；安装并执行 claude /login 后可查询订阅额度。"
                : "未检测到本机 agy CLI；安装并执行 agy acp --login 后可查询订阅额度。",
        };
      }
      if (saved) {
        return {
          ...saved,
          available: true,
          providerName: info?.name || saved.providerName,
          planLabel: saved.planLabel || info?.tierName || info?.subscriptionLabel,
        };
      }
      return {
        providerId: id,
        providerName: info?.name || id,
        available: true,
        planLabel: info?.tierName || info?.subscriptionLabel,
        source: id === "agy" ? "active_cli" : id === "claude" ? "active_sdk" : "active_acp",
        groups: [],
        extraNote: "尚未拉取额度，点击右上角「刷新额度」即可实时查询（零 Token 消耗）。",
      };
    });
  }

  public recordClaudeRateLimitEvent(info: RawClaudeRateLimitInfo): ProviderQuotaSnapshot | null {
    const existing = this.store.getProviderQuota("claude");
    const claudeInfo = this.registry.listProviderStatuses().find((p) => p.id === "claude");
    const merged = mergeClaudeRateLimitEvent(existing, info, {
      planLabel: claudeInfo?.tierName || claudeInfo?.subscriptionLabel,
    });
    if (!merged) return null;
    this.store.saveProviderQuota(merged);
    this.onUpdated?.(this.listCachedQuotas());
    return merged;
  }

  public async refreshQuotas(options?: {
    providerId?: ProviderId;
    force?: boolean;
  }): Promise<ProviderQuotaSnapshot[]> {
    const targets: ProviderId[] = options?.providerId ? [options.providerId] : PROVIDER_ORDER;
    await Promise.all(targets.map((pid) => this.refreshOne(pid, Boolean(options?.force))));
    const all = this.listCachedQuotas();
    this.onUpdated?.(all);
    return all;
  }

  private async refreshOne(providerId: ProviderId, force: boolean): Promise<ProviderQuotaSnapshot> {
    const spec = this.registry.getLaunchSpec(providerId);
    if (!spec.info.available) {
      return this.listCachedQuotas().find((q) => q.providerId === providerId)!;
    }

    const cached = this.store.getProviderQuota(providerId);
    if (!force && cached?.checkedAt && !cached.error) {
      const age = Date.now() - Date.parse(cached.checkedAt);
      if (!Number.isNaN(age) && age < QUOTA_CACHE_TTL_MS) {
        return cached;
      }
    }

    const inflight = this.inFlight.get(providerId);
    if (inflight) return inflight;

    const job = (async (): Promise<ProviderQuotaSnapshot> => {
      try {
        let snapshot: ProviderQuotaSnapshot;
        if (providerId === "agy") {
          snapshot = await this.probeAgyQuota();
        } else if (providerId === "claude") {
          snapshot = await this.probeClaudeQuota(cached);
        } else {
          snapshot = await this.probeCodexQuota();
        }
        this.store.saveProviderQuota(snapshot);
        return snapshot;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const fallback: ProviderQuotaSnapshot = {
          providerId,
          providerName: spec.info.name,
          available: true,
          planLabel: cached?.planLabel || spec.info.tierName || spec.info.subscriptionLabel,
          source: cached?.source ?? "unavailable",
          checkedAt: cached?.checkedAt ?? new Date().toISOString(),
          groups: cached?.groups ?? [],
          extraNote: cached?.extraNote,
          error: `刷新失败：${msg}`,
        };
        this.store.saveProviderQuota(fallback);
        return fallback;
      }
    })().finally(() => {
      this.inFlight.delete(providerId);
    });

    this.inFlight.set(providerId, job);
    return job;
  }

  private async probeAgyQuota(): Promise<ProviderQuotaSnapshot> {
    const spec = this.registry.getLaunchSpec("agy");
    const res = await runCommandCapture(
      spec.command,
      ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"],
      { ...process.env, ...spec.env },
      20_000
    );
    if (res.exitCode !== 0 && !res.stdout.trim()) {
      throw new Error((res.stderr || `退出码 ${res.exitCode}`).trim());
    }
    return parseAgyUsageJson(res.stdout, {
      planLabel: spec.info.tierName || spec.info.subscriptionLabel,
    });
  }

  private async probeClaudeQuota(
    existing: ProviderQuotaSnapshot | null
  ): Promise<ProviderQuotaSnapshot> {
    const spec = this.registry.getLaunchSpec("claude");
    const acpPkgJson = path.join(
      this.projectRoot,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "package.json"
    );
    const req = createRequire(acpPkgJson);
    const sdkEntry = req.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkMod = (await import(pathToFileURL(sdkEntry).href)) as {
      query: (params: {
        prompt: AsyncIterable<unknown>;
        options: Record<string, unknown>;
      }) => {
        initializationResult: () => Promise<{
          account?: { email?: string; subscriptionType?: string };
        }>;
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts?: {
          skipBehaviors?: boolean;
        }) => Promise<RawClaudeUsageResponse>;
        close: () => void;
      };
    };

    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    async function* emptyStream() {
      await hold;
    }

    const q = sdkMod.query({
      prompt: emptyStream(),
      options: {
        cwd: os.homedir(),
        persistSession: false,
        env: { ...process.env, ...spec.env },
        ...(spec.info.binaryPath ? { pathToClaudeCodeExecutable: spec.info.binaryPath } : {}),
      },
    });

    const timer = setTimeout(() => {
      try {
        q.close();
      } catch {
        // ignore
      }
    }, 18_000);

    try {
      const init = await q.initializationResult();
      const subType = init.account?.subscriptionType;
      if (subType) {
        this.registry.recordObservedTier("claude", subType);
      }
      const rawUsage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      });
      return parseClaudeUsagePayload(rawUsage, {
        planLabel: subType || spec.info.tierName || spec.info.subscriptionLabel,
        existing,
      });
    } finally {
      clearTimeout(timer);
      release();
      try {
        q.close();
      } catch {
        // ignore
      }
    }
  }

  private async probeCodexQuota(): Promise<ProviderQuotaSnapshot> {
    const spec = this.registry.getLaunchSpec("codex");
    let proc: ChildProcess | null = null;
    try {
      proc = spawn(spec.command, spec.args, {
        cwd: this.projectRoot,
        env: { ...process.env, ...spec.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!proc.stdin || !proc.stdout) {
        throw new Error("无法打开 Codex ACP 标准流");
      }

      const stream = acp.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
      );

      let collectedText = "";
      const clientApp = acp
        .client({ name: "avent-codex-quota-probe" })
        .onNotification(acp.methods.client.session.update, async (ctx) => {
          const u = ctx.params.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            collectedText += u.content.text;
          }
        });

      await Promise.race([
        clientApp.connectWith(stream, async (agent) => {
          const initRes = await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "avent", version: "0.2.0" },
          });
          const sRes = await agent.request(acp.methods.agent.session.new, {
            cwd: this.projectRoot,
            mcpServers: [],
          });
          await agent.request(acp.methods.agent.session.prompt, {
            sessionId: sRes.sessionId,
            prompt: [{ type: "text", text: "/status" }],
          });
          if (initRes.agentCapabilities?.sessionCapabilities?.close) {
            await agent.request(acp.methods.agent.session.close, {
              sessionId: sRes.sessionId,
            });
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Codex /status 查询超时（18s）")), 18_000)
        ),
      ]);

      return parseCodexStatusMarkdown(collectedText, {
        planLabel: spec.info.tierName || spec.info.subscriptionLabel,
      });
    } finally {
      if (proc) killProc(proc);
    }
  }
}
