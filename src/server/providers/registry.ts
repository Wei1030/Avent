import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ProviderId, ProviderModelOption, ProviderStatusInfo } from "../../shared/types.js";

export interface ProviderLaunchSpec {
  id: ProviderId;
  command: string;
  args: string[];
  env: Record<string, string>;
  info: ProviderStatusInfo;
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
  private cachedTierByProvider = new Map<ProviderId, string>();
  private cachedModelsByProvider = new Map<ProviderId, ProviderModelOption[]>();
  private verifiedLive = new Set<ProviderId>(["agy"]);
  private binCache: { at: number; agy?: string; claude?: string; codex?: string } | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  public recordObservedTier(providerId: ProviderId, tierName: string): void {
    if (tierName) {
      this.cachedTierByProvider.set(providerId, tierName);
      this.verifiedLive.add(providerId);
    }
  }

  public getLaunchSpec(providerId: ProviderId): ProviderLaunchSpec {
    const specs = this.getAllSpecs();
    const found = specs.find((s) => s.id === providerId);
    if (!found) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return found;
  }

  public listProviderStatuses(): ProviderStatusInfo[] {
    return this.getAllSpecs().map((s) => s.info);
  }

  /**
   * Performs a non-invasive ACP handshake (`initialize` + `session/new` + `session/close`)
   * to confirm subscription status and discover live model options.
   */
  public async probeProvider(
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
          if (agyMeta?.tier?.name) {
            this.recordObservedTier(providerId, agyMeta.tier.name);
            detail = `已连接订阅 · ${agyMeta.tier.name}`;
          } else {
            this.verifiedLive.add(providerId);
            detail = `ACP 握手正常 (${initRes.agentInfo?.name || providerId})`;
          }

          const modelOpt = (sRes.configOptions ?? []).find(
            (o) => o.id === "model" || o.category === "model"
          );
          if (modelOpt && modelOpt.type === "select") {
            const models: ProviderModelOption[] = modelOpt.options.flatMap((item) =>
              "options" in item
                ? item.options.map((sub) => ({ value: sub.value, name: sub.name }))
                : [{ value: item.value, name: item.name }]
            );
            if (models.length > 0) {
              this.cachedModelsByProvider.set(providerId, models);
            }
          }

          if (initRes.agentCapabilities?.sessionCapabilities?.close) {
            await agent.request(acp.methods.agent.session.close, { sessionId: sRes.sessionId });
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("检测超时（10 秒内未完成握手）")), 10000)
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

    // 1. Google Antigravity ACP (`agy acp`)
    const agyBin = bins.agy;
    const agyTier = this.cachedTierByProvider.get("agy");
    const agyModels = this.cachedModelsByProvider.get("agy") ?? [
      { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
      { value: "gemini-4-argon", name: "Gemini 4 Argon" },
      { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
      { value: "claude-opus-5-5", name: "Claude Opus 5.5 (Ultra)" },
      { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Ultra)" },
    ];

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
        verified: Boolean(agyBin) && this.verifiedLive.has("agy"),
        tierName: agyTier,
        binaryPath: agyBin,
        loginCommand: "agy acp --login",
        statusMessage: agyBin
          ? `已就绪${agyTier ? ` · ${agyTier}` : ""} (${path.basename(agyBin)})`
          : "未检测到 agy CLI（安装 Google.AntigravityCLI 后在终端执行 agy acp --login）",
        models: agyModels,
        defaultModel: "gemini-4-carbon",
        thoughtLevels: [
          { value: "high", name: "高 (High)" },
          { value: "medium", name: "中 (Medium)" },
          { value: "low", name: "低 (Low)" },
        ],
        defaultThoughtLevel: "high",
      },
    };

    // 2. Anthropic Claude Code ACP (`@agentclientprotocol/claude-agent-acp`)
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

    const claudeSpec: ProviderLaunchSpec = {
      id: "claude",
      command: process.execPath,
      args: [claudeBridgeJs],
      env: { PATH: mergedPath, Path: mergedPath },
      info: {
        id: "claude",
        name: "Anthropic Claude Code",
        shortName: "Claude Code",
        subscriptionLabel: "Claude Pro / Max",
        adapterLabel: "@agentclientprotocol/claude-agent-acp",
        available: claudeBridgeExists && Boolean(claudeCliBin),
        verified: this.verifiedLive.has("claude"),
        binaryPath: claudeCliBin,
        loginCommand: "claude /login",
        statusMessage:
          claudeBridgeExists && claudeCliBin
            ? `已接入适配器 (${path.basename(claudeCliBin)} 已安装)`
            : "已内置适配器（需本地安装并在终端登录 claude CLI）",
        models: this.cachedModelsByProvider.get("claude") ?? [
          { value: "default", name: "Claude Default (Subscription)" },
          { value: "claude-opus-4-5", name: "Claude Opus" },
          { value: "claude-sonnet-4-5", name: "Claude Sonnet" },
        ],
        defaultModel: "default",
        thoughtLevels: [
          { value: "high", name: "高 (High)" },
          { value: "medium", name: "中 (Medium)" },
        ],
        defaultThoughtLevel: "high",
      },
    };

    // 3. OpenAI Codex ACP (`@agentclientprotocol/codex-acp`)
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

    const codexSpec: ProviderLaunchSpec = {
      id: "codex",
      command: process.execPath,
      args: [codexBridgeJs],
      env: { PATH: mergedPath, Path: mergedPath },
      info: {
        id: "codex",
        name: "OpenAI Codex",
        shortName: "Codex",
        subscriptionLabel: "ChatGPT Plus / Pro",
        adapterLabel: "@agentclientprotocol/codex-acp",
        available: codexBridgeExists && Boolean(codexCliBin),
        verified: this.verifiedLive.has("codex"),
        binaryPath: codexCliBin || codexBridgeJs,
        loginCommand: "codex login",
        statusMessage: codexCliBin
          ? `已接入适配器 (${path.basename(codexCliBin)} 已安装)`
          : "已内置适配器（需本地安装并在终端执行 codex login）",
        models: this.cachedModelsByProvider.get("codex") ?? [
          { value: "default", name: "Codex Default (Subscription)" },
          { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        ],
        defaultModel: "default",
        thoughtLevels: [
          { value: "high", name: "高 (High)" },
          { value: "medium", name: "中 (Medium)" },
        ],
        defaultThoughtLevel: "high",
      },
    };

    return [agySpec, claudeSpec, codexSpec];
  }
}
