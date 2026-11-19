import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AventStore } from "../db.js";
import type {
  EndpointProtocol,
  EndpointThinkingMode,
  PersistedProviderCapabilities,
  ProviderId,
  ProviderModelOption,
  ProviderStatusInfo,
  ThoughtLevelOption,
} from "../../shared/types.js";

export interface ProviderLaunchSpec {
  id: ProviderId;
  command: string;
  args: string[];
  env: Record<string, string>;
  unsetEnv?: string[];
  info: ProviderStatusInfo;
}

const THOUGHT_LABEL_MAP: Record<string, string> = {
  default: "默认 (Default)",
  off: "关闭 (Off)",
  none: "关闭 (None)",
  minimal: "极简 (Minimal)",
  low: "低 (Low)",
  medium: "中 (Medium)",
  high: "高 (High)",
  xhigh: "极高 (Extra)",
  max: "最高 (Max)",
};

export function formatThoughtLevelLabel(value: string, fallbackName?: string): string {
  const mapped = THOUGHT_LABEL_MAP[value.toLowerCase()];
  if (mapped) return mapped;
  return fallbackName && fallbackName !== value ? `${fallbackName} (${value})` : value;
}

function findThoughtConfigOption(configOptions: acp.SessionConfigOption[] | undefined) {
  return (configOptions ?? []).find(
    (o) =>
      o.type === "select" &&
      (o.id === "thought_level" ||
        o.category === "thought_level" ||
        o.id === "reasoning_effort" ||
        o.id === "thinking_level")
  );
}

function extractSelectOptions(
  opt: acp.SessionConfigOption | undefined
): Array<{ value: string; name: string }> {
  if (!opt || opt.type !== "select") return [];
  return opt.options.flatMap((item) =>
    "options" in item
      ? item.options.map((sub) => ({ value: sub.value, name: sub.name }))
      : [{ value: item.value, name: item.name }]
  );
}

function extractThoughtLevelsFromConfig(
  configOptions: acp.SessionConfigOption[] | undefined
): { levels: ThoughtLevelOption[]; currentValue?: string } {
  const tl = findThoughtConfigOption(configOptions);
  if (!tl || tl.type !== "select") {
    return { levels: [] };
  }
  const levels = extractSelectOptions(tl).map((o) => ({
    value: o.value,
    name: formatThoughtLevelLabel(o.value, o.name),
  }));
  return { levels, currentValue: tl.currentValue };
}

function findExecutableOnWindowsOrPosix(
  binaryName: string,
  candidatePaths: string[]
): string | undefined {
  for (const candidate of candidatePaths) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const probeCmd = process.platform === "win32" ? "where.exe" : "which";
  const mergedPath = getMergedUserSystemPath();
  const res = spawnSync(probeCmd, [binaryName], {
    encoding: "utf8",
    env: { ...process.env, PATH: mergedPath, Path: mergedPath },
  });
  if (res.status === 0 && res.stdout) {
    const first = res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && existsSync(first)) return first;
  }
  return undefined;
}

export function getMergedUserSystemPath(): string {
  if (process.platform !== "win32") {
    return process.env.PATH || "";
  }
  const home = process.env.USERPROFILE || "";
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const extraDirs: string[] = [
    path.join(home, ".local", "bin"),
    path.join(process.env.APPDATA || "", "npm"),
  ];

  const wingetPkgs = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  if (existsSync(wingetPkgs)) {
    try {
      for (const entry of readdirSync(wingetPkgs)) {
        if (entry.startsWith("Google.AntigravityCLI")) {
          extraDirs.push(path.join(wingetPkgs, entry));
        }
      }
    } catch {
      // ignore permission errors
    }
  }

  const current = process.env.Path || process.env.PATH || "";
  return [...extraDirs, current].filter(Boolean).join(";");
}

function killProc(proc: ChildProcess): void {
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

export class ProviderRegistry {
  private projectRoot: string;
  private store?: AventStore;
  private capsByProvider = new Map<ProviderId, PersistedProviderCapabilities>();
  private verifiedLive = new Set<ProviderId>(["agy"]);
  private binCache: { at: number; agy?: string; claude?: string; codex?: string } | null = null;
  private probingInFlight = new Map<ProviderId, Promise<{ ok: boolean; status: ProviderStatusInfo; detail: string }>>();

  constructor(projectRoot: string, store?: AventStore) {
    this.projectRoot = projectRoot;
    this.store = store;

    // Hydrate persisted capabilities from SQLite immediately so restarts retain live models & thought levels
    if (this.store) {
      for (const cap of this.store.listProviderCapabilities()) {
        const normalized: PersistedProviderCapabilities = {
          ...cap,
          thoughtLevels: cap.thoughtLevels?.map((l) => ({
            value: l.value,
            name: formatThoughtLevelLabel(l.value, l.name),
          })),
          models: cap.models.map((m) => ({
            ...m,
            thoughtLevels: m.thoughtLevels?.map((l) => ({
              value: l.value,
              name: formatThoughtLevelLabel(l.value, l.name),
            })),
          })),
        };
        this.capsByProvider.set(cap.providerId, normalized);
        this.verifiedLive.add(cap.providerId);
      }
    }
  }

  public hasPersistedCapabilities(providerId: ProviderId): boolean {
    return this.capsByProvider.has(providerId);
  }

  public recordObservedTier(providerId: ProviderId, tierName: string): void {
    if (!tierName) return;
    this.verifiedLive.add(providerId);
    const existing = this.capsByProvider.get(providerId);
    if (existing) {
      if (existing.tierName !== tierName) {
        const updated: PersistedProviderCapabilities = {
          ...existing,
          tierName,
          probedAt: new Date().toISOString(),
        };
        this.capsByProvider.set(providerId, updated);
        this.store?.saveProviderCapabilities(updated);
      }
    }
  }

  /**
   * Opportunistically merges live `configOptions` returned during normal task `session/new`
   * or `session/set_config_option` calls and persists them into SQLite.
   */
  public recordObservedConfigOptions(
    providerId: ProviderId,
    activeModelId: string | undefined,
    configOptions: acp.SessionConfigOption[] | undefined,
    tierName?: string
  ): boolean {
    if (!configOptions || configOptions.length === 0) {
      if (tierName) this.recordObservedTier(providerId, tierName);
      return false;
    }

    const existing = this.capsByProvider.get(providerId);
    const modelOpt = configOptions.find(
      (o) => o.type === "select" && (o.id === "model" || o.category === "model")
    );
    const extractedModels = extractSelectOptions(modelOpt);
    const thought = extractThoughtLevelsFromConfig(configOptions);

    // Build merged models list preserving previously discovered per-model thoughtLevels
    const prevByVal = new Map((existing?.models ?? []).map((m) => [m.value, m]));
    const baseModels: ProviderModelOption[] =
      extractedModels.length > 0
        ? extractedModels.map((m) => {
            const prev = prevByVal.get(m.value);
            return {
              value: m.value,
              name: m.name,
              thoughtLevels: prev?.thoughtLevels,
              defaultThoughtLevel: prev?.defaultThoughtLevel,
            };
          })
        : [...(existing?.models ?? [])];

    const currentModelVal =
      activeModelId ||
      (modelOpt && modelOpt.type === "select" ? modelOpt.currentValue : undefined);

    if (currentModelVal && baseModels.length > 0) {
      const idx = baseModels.findIndex((m) => m.value === currentModelVal);
      if (idx >= 0) {
        baseModels[idx] = {
          ...baseModels[idx],
          thoughtLevels: thought.levels,
          defaultThoughtLevel: thought.currentValue,
        };
      }
    }

    const nextCaps: PersistedProviderCapabilities = {
      providerId,
      tierName: tierName || existing?.tierName,
      models: baseModels.length > 0 ? baseModels : existing?.models ?? [],
      defaultModel:
        (modelOpt && modelOpt.type === "select" && modelOpt.currentValue) ||
        existing?.defaultModel,
      thoughtLevels:
        thought.levels.length > 0 ? thought.levels : existing?.thoughtLevels,
      defaultThoughtLevel: thought.currentValue || existing?.defaultThoughtLevel,
      probedAt: new Date().toISOString(),
    };

    const changed = JSON.stringify(existing) !== JSON.stringify(nextCaps);
    this.capsByProvider.set(providerId, nextCaps);
    this.verifiedLive.add(providerId);
    if (changed) {
      this.store?.saveProviderCapabilities(nextCaps);
    }
    return changed;
  }

  public getLaunchSpec(providerId: ProviderId): ProviderLaunchSpec {
    const specs = this.getAllSpecs();
    const found = specs.find((s) => s.id === providerId);
    if (!found) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return found;
  }

  /**
   * Route A: Executes a compatible API endpoint through the matching ACP bridge
   * (`claude-agent-acp` for Anthropic Messages endpoints, `codex-acp` for OpenAI endpoints),
   * strictly isolating user subscription credentials from third-party endpoints.
   */
  public getEndpointLaunchSpec(params: {
    protocol: EndpointProtocol;
    baseUrl: string;
    apiKey: string;
    modelId: string;
    thinkingMode: EndpointThinkingMode;
    thoughtLevel?: string;
  }): ProviderLaunchSpec {
    const bridgeProvider: ProviderId = params.protocol === "openai" ? "codex" : "claude";
    const baseSpec = this.getLaunchSpec(bridgeProvider);
    if (!baseSpec.info.available) {
      const cliHint =
        bridgeProvider === "claude"
          ? "需先在本机安装 claude CLI 以驱动 Anthropic 兼容端点"
          : "需先在本机安装 codex CLI 以驱动 OpenAI 兼容端点";
      throw new Error(`无法启动兼容端点执行驱动：${cliHint}`);
    }

    const token = params.apiKey.trim() || "no-token";
    if (params.protocol === "anthropic") {
      const disableThinking =
        params.thinkingMode === "none" || params.thoughtLevel === "off";
      return {
        ...baseSpec,
        unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
        env: {
          ...baseSpec.env,
          ANTHROPIC_BASE_URL: params.baseUrl.trim(),
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_MODEL: params.modelId,
          ANTHROPIC_DEFAULT_OPUS_MODEL: params.modelId,
          ANTHROPIC_DEFAULT_SONNET_MODEL: params.modelId,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: params.modelId,
          ANTHROPIC_DEFAULT_FABLE_MODEL: params.modelId,
          ANTHROPIC_SMALL_FAST_MODEL: params.modelId,
          CLAUDE_CODE_SUBAGENT_MODEL: params.modelId,
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          ...(disableThinking ? { MAX_THINKING_TOKENS: "0" } : {}),
        },
      };
    }

    return {
      ...baseSpec,
      unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      env: {
        ...baseSpec.env,
        OPENAI_BASE_URL: params.baseUrl.trim(),
        OPENAI_API_KEY: token,
        OPENAI_MODEL: params.modelId,
      },
    };
  }

  public listProviderStatuses(): ProviderStatusInfo[] {
    return this.getAllSpecs().map((s) => s.info);
  }

  /**
   * Performs a live ACP handshake (`initialize` + `session/new`), probes every available
   * model's supported `thought_level` / `reasoning_effort` options in one session, closes
   * cleanly (`session/close`), and persists the full capability matrix to SQLite.
   */
  public async probeProvider(
    providerId: ProviderId,
    cwd?: string
  ): Promise<{ ok: boolean; status: ProviderStatusInfo; detail: string }> {
    const inflight = this.probingInFlight.get(providerId);
    if (inflight) return inflight;

    const job = this.runProbeProvider(providerId, cwd).finally(() => {
      this.probingInFlight.delete(providerId);
    });
    this.probingInFlight.set(providerId, job);
    return job;
  }

  private async runProbeProvider(
    providerId: ProviderId,
    cwd?: string
  ): Promise<{ ok: boolean; status: ProviderStatusInfo; detail: string }> {
    this.binCache = null;
    const spec = this.getLaunchSpec(providerId);
    if (!spec.info.available) {
      return {
        ok: false,
        status: spec.info,
        detail: spec.info.statusMessage,
      };
    }

    let proc: ChildProcess | null = null;
    try {
      proc = spawn(spec.command, spec.args, {
        cwd: cwd || this.projectRoot,
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!proc.stdin || !proc.stdout) {
        throw new Error("无法打开进程标准输入输出管道");
      }

      const stream = acp.ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
      );

      const clientApp = acp.client({ name: "avent-provider-probe" });
      let detail = "已连接";

      await Promise.race([
        clientApp.connectWith(stream, async (agent) => {
          const initRes = await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "avent", version: "0.2.0" },
          });
          const sRes = await agent.request(acp.methods.agent.session.new, {
            cwd: cwd || this.projectRoot,
            mcpServers: [],
          });

          const agyMeta = (sRes._meta as Record<string, unknown> | undefined)?.antigravity as
            | { tier?: { name?: string } }
            | undefined;
          const observedTier = agyMeta?.tier?.name;
          if (observedTier) {
            detail = `已连接订阅 · ${observedTier}`;
          } else {
            detail = `ACP 握手正常 (${initRes.agentInfo?.name || providerId})`;
          }

          const initConfig = sRes.configOptions ?? [];
          const modelOpt = initConfig.find(
            (o) => o.type === "select" && (o.id === "model" || o.category === "model")
          );
          const initThought = extractThoughtLevelsFromConfig(initConfig);
          const discoveredModels: ProviderModelOption[] = [];

          if (modelOpt && modelOpt.type === "select") {
            const rawList = extractSelectOptions(modelOpt);
            for (const m of rawList) {
              // Fast path: reuse initial configOptions if this model is already active
              if (m.value === modelOpt.currentValue) {
                discoveredModels.push({
                  value: m.value,
                  name: m.name,
                  thoughtLevels: initThought.levels,
                  defaultThoughtLevel: initThought.currentValue,
                });
                continue;
              }
              try {
                const upd = await agent.request(acp.methods.agent.session.setConfigOption, {
                  sessionId: sRes.sessionId,
                  configId: modelOpt.id,
                  value: m.value,
                });
                const tl = extractThoughtLevelsFromConfig(upd.configOptions);
                discoveredModels.push({
                  value: m.value,
                  name: m.name,
                  thoughtLevels: tl.levels,
                  defaultThoughtLevel: tl.currentValue,
                });
              } catch {
                discoveredModels.push({
                  value: m.value,
                  name: m.name,
                  thoughtLevels: initThought.levels,
                  defaultThoughtLevel: initThought.currentValue,
                });
              }
            }
          }

          const caps: PersistedProviderCapabilities = {
            providerId,
            tierName: observedTier || this.capsByProvider.get(providerId)?.tierName,
            models: discoveredModels.length > 0 ? discoveredModels : spec.info.models,
            defaultModel:
              (modelOpt && modelOpt.type === "select" && modelOpt.currentValue) ||
              discoveredModels[0]?.value ||
              spec.info.defaultModel,
            thoughtLevels:
              initThought.levels.length > 0 ? initThought.levels : spec.info.thoughtLevels,
            defaultThoughtLevel: initThought.currentValue || spec.info.defaultThoughtLevel,
            probedAt: new Date().toISOString(),
          };
          this.capsByProvider.set(providerId, caps);
          this.verifiedLive.add(providerId);
          this.store?.saveProviderCapabilities(caps);

          if (discoveredModels.length > 0) {
            detail += `（已同步 ${discoveredModels.length} 个模型与思考强度）`;
          }

          if (initRes.agentCapabilities?.sessionCapabilities?.close) {
            await agent.request(acp.methods.agent.session.close, { sessionId: sRes.sessionId });
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("检测超时（18 秒内未完成握手）")), 18000)
        ),
      ]);

      return {
        ok: true,
        status: this.getLaunchSpec(providerId).info,
        detail,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: this.getLaunchSpec(providerId).info,
        detail: msg,
      };
    } finally {
      if (proc) killProc(proc);
    }
  }

  private resolveCachedBins(): { agy?: string; claude?: string; codex?: string } {
    const now = Date.now();
    if (this.binCache && now - this.binCache.at < 60_000) {
      return this.binCache;
    }
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const localAppData = process.env.LOCALAPPDATA || "";
    const wingetAgyCandidates: string[] = [];
    const wingetPkgs = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    if (existsSync(wingetPkgs)) {
      try {
        for (const dir of readdirSync(wingetPkgs)) {
          if (dir.startsWith("Google.AntigravityCLI")) {
            wingetAgyCandidates.push(path.join(wingetPkgs, dir, "agy.exe"));
          }
        }
      } catch {
        // ignore
      }
    }
    const agy = findExecutableOnWindowsOrPosix("agy", wingetAgyCandidates);
    const claude = findExecutableOnWindowsOrPosix("claude", [
      path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    ]);
    const codex = findExecutableOnWindowsOrPosix("codex", [
      path.join(
        process.env.APPDATA || "",
        "npm",
        process.platform === "win32" ? "codex.cmd" : "codex"
      ),
    ]);
    this.binCache = { at: now, agy, claude, codex };
    return this.binCache;
  }

  private getAllSpecs(): ProviderLaunchSpec[] {
    const mergedPath = getMergedUserSystemPath();
    const bins = this.resolveCachedBins();

    // 1. Google Antigravity ACP (`agy acp`) — 100% ACP-discovered models & thought levels
    const agyBin = bins.agy;
    const agyCap = this.capsByProvider.get("agy");
    const agyTier = agyCap?.tierName;
    const agyModels: ProviderModelOption[] = agyCap?.models ?? [];

    const agySpec: ProviderLaunchSpec = {
      id: "agy",
      command: agyBin || "agy",
      args: ["acp"],
      env: { PATH: mergedPath, Path: mergedPath },
      info: {
        id: "agy",
        name: "Google Antigravity",
        shortName: "Google AI",
        subscriptionLabel: agyTier || "Google AI Pro / Ultra",
        adapterLabel: "Native ACP (agy acp)",
        available: Boolean(agyBin),
        verified: Boolean(agyBin) && Boolean(agyCap),
        tierName: agyTier,
        binaryPath: agyBin,
        loginCommand: "agy acp --login",
        statusMessage: agyBin
          ? `已就绪${agyTier ? ` · ${agyTier}` : ""} (${path.basename(agyBin)})`
          : "未检测到 agy CLI（安装 Google.AntigravityCLI 后在终端执行 agy acp --login）",
        models: agyModels,
        defaultModel: agyCap?.defaultModel || agyModels[0]?.value || "",
        thoughtLevels: agyCap?.thoughtLevels ?? [],
        defaultThoughtLevel: agyCap?.defaultThoughtLevel || "",
        lastProbedAt: agyCap?.probedAt,
      },
    };

    // 2. Anthropic Claude Code ACP (`@agentclientprotocol/claude-agent-acp`) — 100% ACP-discovered
    const claudeBridgeJs = path.join(
      this.projectRoot,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
      "dist",
      "index.js"
    );
    const claudeCliBin = bins.claude;
    const claudeBridgeExists = existsSync(claudeBridgeJs);
    const claudeCap = this.capsByProvider.get("claude");
    const claudeModels: ProviderModelOption[] = claudeCap?.models ?? [];

    const claudeSpec: ProviderLaunchSpec = {
      id: "claude",
      command: process.execPath,
      args: [claudeBridgeJs],
      env: { PATH: mergedPath, Path: mergedPath },
      info: {
        id: "claude",
        name: "Anthropic Claude Code",
        shortName: "Claude Code",
        subscriptionLabel: claudeCap?.tierName || "Claude Pro / Max",
        adapterLabel: "@agentclientprotocol/claude-agent-acp",
        available: claudeBridgeExists && Boolean(claudeCliBin),
        verified: Boolean(claudeCap),
        tierName: claudeCap?.tierName,
        binaryPath: claudeCliBin,
        loginCommand: "claude /login",
        statusMessage:
          claudeBridgeExists && claudeCliBin
            ? `已接入适配器 (${path.basename(claudeCliBin)} 已安装)`
            : "已内置适配器（需本地安装并在终端登录 claude CLI）",
        models: claudeModels,
        defaultModel: claudeCap?.defaultModel || claudeModels[0]?.value || "",
        thoughtLevels: claudeCap?.thoughtLevels ?? [],
        defaultThoughtLevel: claudeCap?.defaultThoughtLevel || "",
        lastProbedAt: claudeCap?.probedAt,
      },
    };

    // 3. OpenAI Codex ACP (`@agentclientprotocol/codex-acp`) — 100% ACP-discovered
    const codexBridgeJs = path.join(
      this.projectRoot,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
      "index.js"
    );
    const codexCliBin = bins.codex;
    const codexBridgeExists = existsSync(codexBridgeJs);
    const codexCap = this.capsByProvider.get("codex");
    const codexModels: ProviderModelOption[] = codexCap?.models ?? [];

    const codexSpec: ProviderLaunchSpec = {
      id: "codex",
      command: process.execPath,
      args: [codexBridgeJs],
      env: { PATH: mergedPath, Path: mergedPath },
      info: {
        id: "codex",
        name: "OpenAI Codex",
        shortName: "Codex",
        subscriptionLabel: codexCap?.tierName || "ChatGPT Plus / Pro",
        adapterLabel: "@agentclientprotocol/codex-acp",
        available: codexBridgeExists && Boolean(codexCliBin),
        verified: Boolean(codexCap),
        tierName: codexCap?.tierName,
        binaryPath: codexCliBin || codexBridgeJs,
        loginCommand: "codex login",
        statusMessage: codexCliBin
          ? `已接入适配器 (${path.basename(codexCliBin)} 已安装)`
          : "已内置适配器（需本地安装并在终端执行 codex login）",
        models: codexModels,
        defaultModel: codexCap?.defaultModel || codexModels[0]?.value || "",
        thoughtLevels: codexCap?.thoughtLevels ?? [],
        defaultThoughtLevel: codexCap?.defaultThoughtLevel || "",
        lastProbedAt: codexCap?.probedAt,
      },
    };

    return [agySpec, claudeSpec, codexSpec];
  }
}
