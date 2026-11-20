import { useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type {
  CompatibleEndpointModel,
  CompatibleEndpointRecord,
  EndpointProtocol,
  EndpointThinkingMode,
  InstructionDoc,
  PermissionEvaluationPreview,
  PermissionMode,
  PermissionRuleRecord,
  ProviderId,
  WorkspaceWorktreeConfig,
  WorktreeConfigScope,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { ModelPicker, resolveThoughtLevelsForSelection } from "../components/ModelPicker.js";
import { Button, Chip, Seg, Select, Status, Tabs } from "../components/ui.js";
import { cx, getPermissionModeOptions, isPlainEnter } from "../lib/format.js";

export function SettingsPage() {
  const { t } = useApp();
  return (
    <div className="settings">
      <nav className="settings-nav">
        <h2>{t("设置")}</h2>
        <NavLink to="/settings/general" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="gear" size={15} />
          <span>{t("通用")}</span>
        </NavLink>
        <NavLink to="/settings/permissions" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="shield" size={15} />
          <span>{t("权限")}</span>
        </NavLink>
        <NavLink to="/settings/worktree" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="branch" size={15} />
          <span>工作树</span>
        </NavLink>
        <NavLink
          to="/settings/instructions"
          className={({ isActive }) => cx(isActive && "active")}
        >
          <Icon name="file" size={15} />
          <span>{t("项目说明")}</span>
        </NavLink>
        <NavLink to="/settings/provider" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="cpu" size={15} />
          <span>{t("订阅与模型")}</span>
        </NavLink>
        <NavLink to="/settings/language" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="globe" size={15} />
          <span>{t("语言")}</span>
        </NavLink>
      </nav>

      <div className="settings-main">
        <Routes>
          <Route index element={<Navigate to="provider" replace />} />
          <Route path="general" element={<GeneralSettings />} />
          <Route path="permissions" element={<PermissionsSettings />} />
          <Route path="worktree" element={<WorktreeSettings />} />
          <Route path="instructions" element={<InstructionsSettings />} />
          <Route path="provider" element={<ProviderSettings />} />
          <Route path="language" element={<LanguageSettings />} />
        </Routes>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { prefs, providers, endpoints, updatePrefs, toast, t } = useApp();

  // Compute effective default model & thought levels
  const effectiveModelId = useMemo(() => {
    if (prefs.defaultModelId) return prefs.defaultModelId;
    if (prefs.defaultProviderId.startsWith("endpoint:")) {
      const ep = endpoints.find((e) => `endpoint:${e.id}` === prefs.defaultProviderId);
      return ep?.models[0]?.id || "";
    }
    const p = providers.find((x) => x.id === prefs.defaultProviderId);
    return p?.defaultModel || p?.models[0]?.value || "";
  }, [prefs.defaultProviderId, prefs.defaultModelId, providers, endpoints]);

  const { levels: thoughtLevels, defaultLevel } = useMemo(
    () =>
      resolveThoughtLevelsForSelection(
        providers,
        endpoints,
        prefs.defaultProviderId,
        effectiveModelId
      ),
    [providers, endpoints, prefs.defaultProviderId, effectiveModelId]
  );

  const effectiveThought = thoughtLevels.some((l) => l.value === prefs.defaultThoughtLevel)
    ? prefs.defaultThoughtLevel
    : defaultLevel;

  return (
    <>
      <h1>{t("通用")}</h1>
      <p className="lead">配置新建任务时默认选用的模型、思考强度与工具权限级别。</p>

      <div className="panel">
        <div className="panel-head">
          <h3>新任务默认配置</h3>
        </div>
        <div className="panel-body col" style={{ gap: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 16 }}>
            <div>
              <b>默认模型</b>
              <div className="hint">新建任务时自动选用此模型（支持所有官方订阅与兼容端点）</div>
            </div>
            <ModelPicker
              providerId={prefs.defaultProviderId}
              modelId={effectiveModelId}
              thoughtLevel={effectiveThought}
              placement="bottom"
              align="right"
              borderless={false}
              maxWidth={280}
              onSelect={(next) => {
                void updatePrefs({
                  defaultProviderId: next.providerId,
                  defaultModelId: next.modelId,
                  defaultThoughtLevel: next.thoughtLevel,
                });
                toast("已更新默认模型", "good");
              }}
            />
          </div>

          {thoughtLevels.length > 0 && (
            <div className="row" style={{ justifyContent: "space-between", gap: 16 }}>
              <div>
                <b>默认思考强度</b>
                <div className="hint">根据上方所选模型动态匹配其支持的思考档位</div>
              </div>
              <Select
                size="sm"
                className="w-220"
                icon="bulb"
                value={effectiveThought}
                options={thoughtLevels.map((lv) => ({ value: lv.value, label: lv.name }))}
                onChange={(v) => {
                  void updatePrefs({ defaultThoughtLevel: v });
                  toast("已更新默认思考强度", "good");
                }}
              />
            </div>
          )}

          <div className="row" style={{ justifyContent: "space-between", gap: 16 }}>
            <div>
              <b>默认权限模式</b>
              <div className="hint">新建任务时的工具确认级别（可在每个任务底部随时切换）</div>
            </div>
            <Select<PermissionMode>
              size="sm"
              className="w-220"
              icon="shield"
              align="right"
              value={prefs.defaultPermissionMode}
              options={getPermissionModeOptions(t)}
              onChange={(v) => {
                void updatePrefs({ defaultPermissionMode: v });
                toast("已更新默认权限模式", "good");
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

type RuleTargetTool = "Bash" | "Edit" | "Write" | "Delete" | "Read";

const RULE_TARGET_LABELS: Record<string, string> = {
  bash: "终端命令",
  shell: "终端命令",
  edit: "编辑文件",
  write: "写入文件",
  delete: "删除文件",
  move: "删除 / 移动",
  read: "读取文件",
  grep: "代码搜索",
  glob: "文件检索",
};

function parseRuleForDisplay(rule: string): { targetLabel: string; spec: string } {
  const trimmed = rule.trim();
  const m = /^([A-Za-z0-9_:-]+)\(([\s\S]*)\)$/.exec(trimmed);
  if (m) {
    const [, tool, spec] = m;
    const label = RULE_TARGET_LABELS[tool.toLowerCase()] ?? tool;
    return { targetLabel: label, spec: spec.trim() || "*" };
  }
  const label = RULE_TARGET_LABELS[trimmed.toLowerCase()];
  if (label) {
    return { targetLabel: label, spec: "全部" };
  }
  return { targetLabel: "工具", spec: trimmed };
}

function buildRuleExpression(targetTool: RuleTargetTool, rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return "";
  // If user pasted an explicit `Tool(...)` expression directly, preserve it without double-wrapping
  if (/^[A-Za-z0-9_:-]+\([\s\S]*\)$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed === "*" || trimmed === "全部") {
    return targetTool;
  }
  return `${targetTool}(${trimmed})`;
}

function PermissionsSettings() {
  const { activeWorkspace, prefs, toast, t } = useApp();
  const [rules, setRules] = useState<PermissionRuleRecord[]>([]);
  const [behavior, setBehavior] = useState<"allow" | "ask" | "deny">("allow");
  const [ruleTarget, setRuleTarget] = useState<RuleTargetTool>("Bash");
  const [scope, setScope] = useState<"workspace" | "global">(() =>
    activeWorkspace ? "workspace" : "global"
  );
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  // Focused terminal command tester
  const [testMode, setTestMode] = useState<PermissionMode>(prefs.defaultPermissionMode);
  const [testInput, setTestInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    preview: PermissionEvaluationPreview;
    cwd: string;
  } | null>(null);

  useEffect(() => {
    setTestMode(prefs.defaultPermissionMode);
  }, [prefs.defaultPermissionMode]);

  useEffect(() => {
    if (!activeWorkspace && scope === "workspace") {
      setScope("global");
    }
  }, [activeWorkspace, scope]);

  const load = async () => {
    const res = await api.listRules(activeWorkspace?.id);
    setRules(res.rules);
  };

  useEffect(() => {
    void load();
  }, [activeWorkspace?.id]);

  const runEvaluate = async (nextInput = testInput, nextMode = testMode) => {
    if (!nextInput.trim()) return;
    setTesting(true);
    try {
      const res = await api.evaluateRule({
        toolKind: "shell",
        inputText: nextInput,
        mode: nextMode,
        workspaceId: activeWorkspace?.id,
      });
      setTestResult(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setTesting(false);
    }
  };

  const handleAdd = async () => {
    const expr = buildRuleExpression(ruleTarget, pattern);
    if (!expr) return;
    try {
      await api.addRule({
        behavior,
        rule: expr,
        scope,
        workspaceId: scope === "workspace" ? activeWorkspace?.id : undefined,
        note: note.trim() || undefined,
      });
      setPattern("");
      setNote("");
      await load();
      toast("已添加权限规则", "good");
      if (testResult && testInput.trim()) {
        void runEvaluate();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await api.deleteRule(id);
      await load();
      toast("已删除权限规则", "good");
      if (testResult && testInput.trim()) {
        void runEvaluate();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  return (
    <>
      <h1>{t("权限")}</h1>
      <p className="lead">
        决定哪些操作自动放行、哪些需要你确认，以及配置永不放行或始终放行的自定义规则。
      </p>

      {/* 1. Clear Mode Comparison Matrix */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>三种权限模式的区别</h3>
          <span className="sub">可在「通用设置」设默认值，或在每个任务输入框左下角随时切换</span>
        </div>
        <div className="panel-body" style={{ padding: "8px 16px 12px" }}>
          <table className="perm-matrix">
            <thead>
              <tr>
                <th>操作类型</th>
                <th>默认询问</th>
                <th>自动接受编辑</th>
                <th>全自动执行</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>读取与搜索</b>
                  <span className="hint">读文件、代码搜索、纯只读终端命令（如 git status / ls / rg）</span>
                </td>
                <td><Status tone="good">自动</Status></td>
                <td><Status tone="good">自动</Status></td>
                <td><Status tone="good">自动</Status></td>
              </tr>
              <tr>
                <td>
                  <b>修改与新建文件</b>
                  <span className="hint">仅限当前任务工作目录内</span>
                </td>
                <td><Status tone="warn">需确认</Status></td>
                <td><Status tone="good">自动</Status></td>
                <td><Status tone="good">自动</Status></td>
              </tr>
              <tr>
                <td>
                  <b>终端命令、删除工作区文件与外部工具</b>
                  <span className="hint">构建、测试、脚本、删除工作区内文件、git 提交、MCP 工具等</span>
                </td>
                <td><Status tone="warn">需确认</Status></td>
                <td><Status tone="warn">需确认</Status></td>
                <td><Status tone="good">自动</Status></td>
              </tr>
              <tr>
                <td>
                  <b>高危破坏命令与越出工作目录</b>
                  <span className="hint">删除 .git / 根目录、git reset --hard、远端强推、访问目录外路径</span>
                </td>
                <td><Status tone="crit">强制确认</Status></td>
                <td><Status tone="crit">强制确认</Status></td>
                <td><Status tone="crit">强制确认</Status></td>
              </tr>
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 10 }}>
            下方的自定义规则优先级高于权限模式（拒绝 &gt; 询问 &gt; 安全底线 &gt; 允许）；复合终端命令（如{" "}
            <code className="mono">&&</code> / <code className="mono">;</code> / <code className="mono">|</code>）会先拆解再逐条检查。
          </div>
        </div>
      </div>

      {/* 2. Custom Rules List & Editor */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>自定义规则 ({rules.length})</h3>
          <span className="sub">
            {activeWorkspace ? `当前显示全局规则与「${activeWorkspace.name}」工作区规则` : "当前显示全局规则"}
          </span>
        </div>
        <div>
          {rules.length === 0 ? (
            <div className="empty" style={{ padding: "22px 16px" }}>
              暂无自定义规则，将按上方权限模式与安全底线判定。
            </div>
          ) : (
            rules.map((r) => {
              const parsed = parseRuleForDisplay(r.rule);
              return (
                <div key={r.id} className="rule-row">
                  <Status
                    tone={
                      r.behavior === "allow"
                        ? "good"
                        : r.behavior === "deny"
                          ? "crit"
                          : "warn"
                    }
                  >
                    {r.behavior === "allow" ? "允许" : r.behavior === "deny" ? "拒绝" : "询问"}
                  </Status>
                  <Chip outline>{parsed.targetLabel}</Chip>
                  <code className="mono" style={{ fontWeight: 600 }} title={r.rule}>
                    {parsed.spec}
                  </code>
                  <Chip>{r.scope === "global" ? "全局" : "当前工作区"}</Chip>
                  {r.note && <span className="muted truncate">{r.note}</span>}
                  <span className="grow" />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    title="删除规则"
                    onClick={() => void handleDeleteRule(r.id)}
                  />
                </div>
              );
            })
          )}
        </div>

        <div className="rule-editor">
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <Select<"allow" | "ask" | "deny">
              size="sm"
              className="perm-sel-sm"
              value={behavior}
              options={[
                { value: "allow", label: "允许" },
                { value: "ask", label: "询问" },
                { value: "deny", label: "拒绝" },
              ]}
              onChange={setBehavior}
            />
            <Select<RuleTargetTool>
              size="sm"
              className="perm-sel-md"
              value={ruleTarget}
              options={[
                { value: "Bash", label: "终端命令" },
                { value: "Edit", label: "编辑文件" },
                { value: "Write", label: "写入文件" },
                { value: "Delete", label: "删除文件" },
                { value: "Read", label: "读取文件" },
              ]}
              onChange={setRuleTarget}
            />
            <input
              className="input sm mono grow"
              style={{ minWidth: 180 }}
              placeholder={
                ruleTarget === "Bash"
                  ? "命令前缀或通配，如 npm.cmd run build*"
                  : "路径通配，如 src/**"
              }
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter(e)) void handleAdd();
              }}
            />
            <Select<"workspace" | "global">
              size="sm"
              className="perm-sel-md"
              value={scope}
              options={[
                { value: "workspace", label: "当前工作区", disabled: !activeWorkspace },
                { value: "global", label: "全局生效" },
              ]}
              onChange={setScope}
            />
            <input
              className="input sm"
              style={{ width: 130 }}
              placeholder="备注（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!pattern.trim()}
              onClick={() => void handleAdd()}
            >
              添加
            </Button>
          </div>
          <div className="hint">
            支持 <code className="mono">*</code> 通配符（如终端命令填{" "}
            <code className="mono">npm.cmd run build*</code>、编辑文件填{" "}
            <code className="mono">src/**</code>；也兼容直接粘贴{" "}
            <code className="mono">Bash(...)</code> 等规则表达式）。
          </div>
        </div>
      </div>

      {/* 3. Focused Single-Row Terminal Command Tester */}
      <div className="panel">
        <div className="panel-head">
          <h3>测试终端命令</h3>
          <span className="sub">不确定某条命令（或复合拼接、重定向）会不会命中上方规则或被拦截？输入即可实测</span>
        </div>
        <div className="panel-body col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input sm mono grow"
              placeholder="输入任意终端命令，例如 npm.cmd test && rm -rf dist 或 git push --force origin main"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter(e)) void runEvaluate();
              }}
            />
            <Select<PermissionMode>
              size="sm"
              className="perm-sel-lg"
              value={testMode}
              options={[
                { value: "default", label: "默认询问" },
                { value: "acceptEdits", label: "自动接受编辑" },
                { value: "bypassPermissions", label: "全自动执行" },
              ]}
              onChange={(m) => {
                setTestMode(m);
                if (testInput.trim()) void runEvaluate(testInput, m);
              }}
            />
            <Button
              variant="primary"
              size="sm"
              busy={testing}
              disabled={!testInput.trim()}
              onClick={() => void runEvaluate()}
            >
              测试
            </Button>
          </div>

          {testResult && (
            <div className={cx("perm-tester-result", testResult.preview.action)}>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <Status
                  tone={
                    testResult.preview.action === "allow"
                      ? "good"
                      : testResult.preview.action === "deny"
                        ? "crit"
                        : "warn"
                  }
                >
                  {testResult.preview.action === "allow"
                    ? "自动放行"
                    : testResult.preview.action === "deny"
                      ? "直接拒绝"
                      : "弹窗询问"}
                </Status>
                <span style={{ fontWeight: 500 }}>{testResult.preview.provenance}</span>
                <span className="grow" />
                {testResult.preview.outsideWorkspace && <Chip tone="crit">越出工作目录</Chip>}
                {testResult.preview.isRisky && <Chip tone="crit">高风险</Chip>}
                {testResult.preview.hazards.hasRedirection && <Chip tone="warn">输出重定向</Chip>}
                {testResult.preview.hazards.hasCommandSub && <Chip tone="warn">命令替换</Chip>}
                {testResult.preview.hazards.hasDynamicEval && <Chip tone="warn">动态求值</Chip>}
              </div>

              {testResult.preview.subCommands.length > 1 && (
                <div className="perm-subcmds">
                  <div className="hint" style={{ fontWeight: 600 }}>
                    拆解为 {testResult.preview.subCommands.length} 条子命令逐条检查：
                  </div>
                  {testResult.preview.subCommands.map((seg, i) => (
                    <div key={i} className="perm-subcmd-row">
                      <Status
                        tone={
                          seg.classification === "read_only"
                            ? "good"
                            : seg.classification === "destructive"
                              ? "crit"
                              : "warn"
                        }
                      >
                        {seg.classification === "read_only"
                          ? "只读"
                          : seg.classification === "destructive"
                            ? "高危"
                            : "需确认"}
                      </Status>
                      <code className="mono truncate" title={seg.raw}>
                        {seg.raw}
                      </code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const WORKTREE_INIT_PROMPT_EXAMPLE =
  "Windows 用目录联接 mklink /J，其他系统用符号链接 ln -s 把主目录的 node_modules 联接到工作树里。";

const WORKTREE_SETUP_PLACEHOLDER = [
  "# 支持多行脚本（Windows 默认 cmd，检测到 $env: / Copy-Item 或 #!pwsh 时走 PowerShell；macOS/Linux 走 sh）",
  'if exist "%AVENT_MAIN_WORKSPACE%\\.env" copy "%AVENT_MAIN_WORKSPACE%\\.env" .env',
  "npm.cmd ci --prefer-offline",
].join("\n");

function WorktreeSettings() {
  const { activeWorkspace, setWorkspaces, defaultWorktreesRoot, toast } = useApp();
  const [scope, setScope] = useState<WorktreeConfigScope>("repo");
  const [config, setConfig] = useState<WorkspaceWorktreeConfig | null>(null);
  const [loading, setLoading] = useState(false);

  // Per-scope editor state so switching between Repo and Local tabs preserves unsaved edits
  const [drafts, setDrafts] = useState<
    Record<WorktreeConfigScope, { setupCommand: string; initPrompt: string }>
  >({
    repo: { setupCommand: "", initPrompt: "" },
    local: { setupCommand: "", initPrompt: "" },
  });
  const [forceTrackOnSave, setForceTrackOnSave] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);

  // Machine-local worktree root (saved in local DB)
  const [wtRoot, setWtRoot] = useState("");
  const [rootDirty, setRootDirty] = useState(false);
  const [savingRoot, setSavingRoot] = useState(false);

  const syncFromConfig = (cfg: WorkspaceWorktreeConfig, syncScope?: WorktreeConfigScope) => {
    setConfig(cfg);
    setDrafts((prev) => ({
      repo:
        !syncScope || syncScope === "repo"
          ? { setupCommand: cfg.repo.setupCommand, initPrompt: cfg.repo.initPrompt }
          : prev.repo,
      local:
        !syncScope || syncScope === "local"
          ? { setupCommand: cfg.local.setupCommand, initPrompt: cfg.local.initPrompt }
          : prev.local,
    }));
  };

  useEffect(() => {
    setWtRoot(activeWorkspace?.worktreeRoot ?? "");
    setRootDirty(false);
    if (!activeWorkspace) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .getWorktreeConfig(activeWorkspace.id)
      .then((res) => {
        if (!cancelled) syncFromConfig(res.config);
      })
      .catch((err) => {
        if (!cancelled) toast(err instanceof Error ? err.message : String(err), "crit");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id]);

  useEffect(() => {
    setWtRoot(activeWorkspace?.worktreeRoot ?? "");
    setRootDirty(false);
  }, [activeWorkspace?.worktreeRoot]);

  const activeDraft = drafts[scope];
  const savedScope = config ? config[scope] : null;
  const repoDirty = Boolean(
    config &&
      (drafts.repo.setupCommand !== config.repo.setupCommand ||
        drafts.repo.initPrompt !== config.repo.initPrompt)
  );
  const localDirty = Boolean(
    config &&
      (drafts.local.setupCommand !== config.local.setupCommand ||
        drafts.local.initPrompt !== config.local.initPrompt)
  );
  const activeDirty = scope === "repo" ? repoDirty : localDirty;

  const updateActiveDraft = (patch: Partial<{ setupCommand: string; initPrompt: string }>) => {
    setDrafts((prev) => ({
      ...prev,
      [scope]: { ...prev[scope], ...patch },
    }));
  };

  const handleSaveConfig = async () => {
    if (!activeWorkspace) return;
    setSavingConfig(true);
    try {
      const res = await api.saveWorktreeConfig(activeWorkspace.id, {
        scope,
        setupCommand: activeDraft.setupCommand,
        initPrompt: activeDraft.initPrompt,
        forceTrackRepo: scope === "repo" ? forceTrackOnSave : false,
      });
      setWorkspaces(res.workspaces);
      syncFromConfig(res.config, scope);
      const isEmpty = !activeDraft.setupCommand.trim() && !activeDraft.initPrompt.trim();
      if (isEmpty) {
        toast(
          scope === "repo" ? "已清空并移除仓库工作树配置文件" : "已清空并移除本地工作树配置文件",
          "good"
        );
      } else if (scope === "repo") {
        toast(
          res.forceTracked
            ? "已保存 .avent/worktree.json 并强制加入 Git 追踪（git add -f）"
            : "已保存仓库工作树配置到 .avent/worktree.json",
          "good"
        );
      } else {
        toast(
          res.config.local.excludedInGit
            ? "已保存本地配置到 .avent/worktree.local.json（已写入 .git/info/exclude 强制忽略）"
            : "已保存本地工作树配置到 .avent/worktree.local.json",
          "good"
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleGitAction = async (
    action: "track" | "force_track" | "untrack" | "ensure_exclude"
  ) => {
    if (!activeWorkspace) return;
    setGitBusy(true);
    try {
      const res = await api.worktreeConfigGitAction(activeWorkspace.id, { scope, action });
      setWorkspaces(res.workspaces);
      setConfig(res.config);
      const msgMap: Record<typeof action, string> = {
        track: "已执行 git add，文件已加入暂存区",
        force_track: "已执行 git add -f，强制纳入 Git 追踪（后续改动将自动被 Git 识别）",
        untrack:
          scope === "local"
            ? "已移出 Git 追踪并写入 .git/info/exclude 强制忽略"
            : "已从 Git 索引移出追踪（本地文件已保留）",
        ensure_exclude: "已写入 .git/info/exclude 强制忽略本地配置文件",
      };
      toast(msgMap[action], "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setGitBusy(false);
    }
  };

  const handleSaveRoot = async () => {
    if (!activeWorkspace) return;
    setSavingRoot(true);
    try {
      const res = await api.updateWorkspace(activeWorkspace.id, {
        worktreeRoot: wtRoot.trim(),
      });
      setWorkspaces(res.workspaces);
      setRootDirty(false);
      toast("已保存本机工作树存放目录", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSavingRoot(false);
    }
  };

  const repoHasContent = Boolean(
    config && (config.repo.setupCommand.trim() || config.repo.initPrompt.trim())
  );
  const localHasContent = Boolean(
    config && (config.local.setupCommand.trim() || config.local.initPrompt.trim())
  );
  const showForceTrackCheckbox = Boolean(
    scope === "repo" &&
      config?.isGitRepo &&
      config.repo.wouldBeIgnored &&
      config.repo.gitState !== "tracked" &&
      (activeDraft.setupCommand.trim() || activeDraft.initPrompt.trim())
  );

  return (
    <>
      <h1>并行工作树（Git Worktree）</h1>
      <p className="lead">
        同一工作区内多任务并行开发时，可在新建任务输入框底部切换为「独立工作树」。初始化脚本与提示词直接保存在项目目录文件中，分为「仓库共享」与「本地私有」两层，拉出工作树时按「仓库 → 本地」顺序依次生效。
      </p>

      {!activeWorkspace ? (
        <div className="panel">
          <div className="empty">请先添加一个项目工作区后再配置工作树选项。</div>
        </div>
      ) : (
        <div className="col" style={{ gap: 16 }}>
          {/* Panel 1: Project-Directory Config Files (Repo vs Local) */}
          <div className="panel">
            <div className="panel-head">
              <Icon name="folder" size={16} className="accent" />
              <h3>{activeWorkspace.name}</h3>
              <span className="mono muted truncate" style={{ fontSize: 12 }}>
                {activeWorkspace.path}
              </span>
              <span className="grow" />
              {activeWorkspace.isGitRepo ? (
                <Chip mono icon="branch" tone="accent">
                  {activeWorkspace.branch || "Git 仓库"}
                </Chip>
              ) : (
                <Status tone="warn">非 Git 仓库</Status>
              )}
            </div>

            <div className="panel-body col" style={{ gap: 14 }}>
              {!activeWorkspace.isGitRepo && (
                <div className="notice warn">
                  <Icon name="warning" size={15} />
                  <span>当前工作区目录不是 Git 仓库，无法开启独立工作树隔离。</span>
                </div>
              )}

              {/* Repo vs Local Scope Selector */}
              <div className="wt-scope-grid">
                <button
                  type="button"
                  className={cx("wt-scope-card", scope === "repo" && "on")}
                  onClick={() => setScope("repo")}
                >
                  <div className="row" style={{ gap: 6, width: "100%" }}>
                    <Icon name="branch" size={14} className={scope === "repo" ? "accent" : "muted"} />
                    <b>仓库共享</b>
                    {repoHasContent && <Chip tone="good">已配置</Chip>}
                    {repoDirty && <Chip tone="warn">未保存</Chip>}
                    <span className="grow" />
                    <code className="mono muted" style={{ fontSize: 11 }}>
                      .avent/worktree.json
                    </code>
                  </div>
                  <div className="d">
                    随代码库提交与团队共享；若被 <code className="mono">.gitignore</code> 忽略，支持一键{" "}
                    <code className="mono">git add -f</code> 强制追踪。
                  </div>
                </button>

                <button
                  type="button"
                  className={cx("wt-scope-card", scope === "local" && "on")}
                  onClick={() => setScope("local")}
                >
                  <div className="row" style={{ gap: 6, width: "100%" }}>
                    <Icon name="lock" size={14} className={scope === "local" ? "accent" : "muted"} />
                    <b>本地私有</b>
                    {localHasContent && <Chip tone="accent">已配置</Chip>}
                    {localDirty && <Chip tone="warn">未保存</Chip>}
                    <span className="grow" />
                    <code className="mono muted" style={{ fontSize: 11 }}>
                      .avent/worktree.local.json
                    </code>
                  </div>
                  <div className="d">
                    仅在本机生效（如本机路径、私密脚本）；自动写入{" "}
                    <code className="mono">.git/info/exclude</code> 强制忽略，不修改{" "}
                    <code className="mono">.gitignore</code>。
                  </div>
                </button>
              </div>

              {/* Git Tracking / Ignore Control Bar */}
              {config?.isGitRepo && (
                <div className="wt-git-bar">
                  {scope === "repo" ? (
                    <>
                      {config.repo.gitState === "tracked" && (
                        <>
                          <Status tone="good">已纳入 Git 追踪</Status>
                          <span className="hint grow">
                            Git 将持续追踪 <code className="mono">{config.repo.relPath}</code>{" "}
                            的改动（即使 <code className="mono">.gitignore</code> 忽略了{" "}
                            <code className="mono">.avent/</code>）。
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            busy={gitBusy}
                            onClick={() => void handleGitAction("untrack")}
                          >
                            移出 Git 追踪
                          </Button>
                        </>
                      )}
                      {config.repo.gitState === "ignored" && (
                        <>
                          <Status tone="warn">当前被 .gitignore 忽略</Status>
                          <span className="hint grow">
                            项目 <code className="mono">.gitignore</code> 忽略了此路径，点击右侧按钮可执行{" "}
                            <code className="mono">git add -f</code> 强制纳入仓库追踪。
                          </span>
                          <Button
                            variant="primary"
                            size="sm"
                            busy={gitBusy}
                            onClick={() => void handleGitAction("force_track")}
                          >
                            强制加入 Git 追踪
                          </Button>
                        </>
                      )}
                      {config.repo.gitState === "untracked" && (
                        <>
                          <Status tone="info">Git 可见（待提交）</Status>
                          <span className="hint grow">
                            文件已写入项目目录，可直接随代码提交到仓库。
                          </span>
                          <Button
                            size="sm"
                            busy={gitBusy}
                            onClick={() => void handleGitAction("track")}
                          >
                            暂存到 Git (git add)
                          </Button>
                        </>
                      )}
                      {config.repo.gitState === "absent" && (
                        <>
                          <Status tone={config.repo.wouldBeIgnored ? "warn" : "idle"}>
                            {config.repo.wouldBeIgnored
                              ? "尚未创建 · 路径被 .gitignore 忽略"
                              : "尚未创建"}
                          </Status>
                          <span className="hint grow">
                            {config.repo.wouldBeIgnored
                              ? "当前仓库 .gitignore 忽略了 .avent/；保存时勾选下方选项即可自动执行 git add -f 强制纳入仓库追踪。"
                              : `填写下方内容并保存，将在项目根目录生成 ${config.repo.relPath}。`}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {config.local.trackedInGit ? (
                        <>
                          <Status tone="warn">意外处于 Git 追踪中</Status>
                          <span className="hint grow">
                            本地私有文件不应纳入版本库，建议移出索引并写入{" "}
                            <code className="mono">.git/info/exclude</code>。
                          </span>
                          <Button
                            variant="primary"
                            size="sm"
                            busy={gitBusy}
                            onClick={() => void handleGitAction("untrack")}
                          >
                            移出追踪并强制忽略
                          </Button>
                        </>
                      ) : config.local.excludedInGit ? (
                        <>
                          <Status tone="good">已强制忽略 (.git/info/exclude)</Status>
                          <span className="hint grow">
                            已自动写入本地 <code className="mono">.git/info/exclude</code>，不会修改项目{" "}
                            <code className="mono">.gitignore</code>，也不污染{" "}
                            <code className="mono">git status</code>。
                          </span>
                        </>
                      ) : (
                        <>
                          <Status tone="info">保存时自动强制忽略</Status>
                          <span className="hint grow">
                            保存本地配置时，将自动把{" "}
                            <code className="mono">**/.avent/worktree.local.json</code> 写入{" "}
                            <code className="mono">.git/info/exclude</code>（不改动{" "}
                            <code className="mono">.gitignore</code>）。
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            busy={gitBusy}
                            onClick={() => void handleGitAction("ensure_exclude")}
                          >
                            立即写入忽略规则
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {loading && !config ? (
                <div className="loading-block" style={{ padding: "24px 0" }}>
                  <span className="spinner" />
                  <span>正在读取项目工作树配置文件…</span>
                </div>
              ) : (
                <>
                  <div className="field">
                    <div className="wt-field-head">
                      <label style={{ margin: 0 }}>自定义初始化脚本（支持多行，可选）</label>
                      <span className="hint">
                        保存至 <code className="mono">{savedScope?.relPath ?? (scope === "repo" ? ".avent/worktree.json" : ".avent/worktree.local.json")}</code>
                      </span>
                    </div>
                    <textarea
                      className="editor"
                      style={{ minHeight: 124 }}
                      spellCheck={false}
                      placeholder={WORKTREE_SETUP_PLACEHOLDER}
                      value={activeDraft.setupCommand}
                      onChange={(e) => updateActiveDraft({ setupCommand: e.target.value })}
                    />
                    <div className="hint">
                      每次拉出新工作树后、智能体启动前自动在该工作树目录执行（仓库与本地均有配置时，先执行仓库脚本再执行本地脚本）。可用环境变量：
                      <code className="mono">AVENT_MAIN_WORKSPACE</code>（主工作区路径）、
                      <code className="mono">AVENT_WORKTREE_PATH</code>、
                      <code className="mono">AVENT_WORKTREE_BRANCH</code>。
                    </div>
                  </div>

                  <div className="field">
                    <div className="wt-field-head">
                      <label style={{ margin: 0 }}>附带初始化提示词（可选）</label>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="spark"
                        onClick={() => updateActiveDraft({ initPrompt: WORKTREE_INIT_PROMPT_EXAMPLE })}
                      >
                        填入示例
                      </Button>
                    </div>
                    <textarea
                      className="textarea"
                      style={{ minHeight: 96 }}
                      placeholder={WORKTREE_INIT_PROMPT_EXAMPLE}
                      value={activeDraft.initPrompt}
                      onChange={(e) => updateActiveDraft({ initPrompt: e.target.value })}
                    />
                    <div className="hint">
                      开启「独立工作树」创建任务时，此段内容会自动附带在发给模型的首个输入中，让模型按你的要求完成环境准备（仓库与本地提示词将自动合并生效）。
                    </div>
                  </div>

                  <div
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 10,
                      paddingTop: 4,
                    }}
                  >
                    <div>
                      {showForceTrackCheckbox && (
                        <label
                          className="row"
                          style={{ gap: 6, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={forceTrackOnSave}
                            onChange={(e) => setForceTrackOnSave(e.target.checked)}
                          />
                          <span>
                            保存时自动执行 <code className="mono">git add -f</code> 强制加入仓库追踪
                          </span>
                        </label>
                      )}
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {(activeDraft.setupCommand.trim() || activeDraft.initPrompt.trim()) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => updateActiveDraft({ setupCommand: "", initPrompt: "" })}
                        >
                          清空内容
                        </Button>
                      )}
                      <Button
                        variant="primary"
                        busy={savingConfig}
                        disabled={!activeDirty}
                        onClick={() => void handleSaveConfig()}
                      >
                        {scope === "repo" ? "保存仓库配置" : "保存本地配置"}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Panel 2: Machine-Local Worktree Storage Root */}
          <div className="panel">
            <div className="panel-head">
              <h3>本机存放根目录</h3>
              <span className="sub">与当前电脑磁盘路径相关，仅保存在本机，不写入项目目录</span>
            </div>
            <div className="panel-body col" style={{ gap: 8 }}>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input mono grow"
                  placeholder={
                    defaultWorktreesRoot
                      ? `留空默认：${defaultWorktreesRoot}`
                      : "留空使用系统用户目录下的 .avent/worktrees"
                  }
                  value={wtRoot}
                  onChange={(e) => {
                    setWtRoot(e.target.value);
                    setRootDirty(true);
                  }}
                />
                <Button
                  variant="primary"
                  busy={savingRoot}
                  disabled={!rootDirty}
                  onClick={() => void handleSaveRoot()}
                >
                  保存路径
                </Button>
              </div>
              <div className="hint">
                必须为位于所有 Git 仓库外部的完整绝对路径，防止主仓库扫描到嵌套副本。
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function InstructionsSettings() {
  const { activeWorkspace, toast, t } = useApp();
  const [scope, setScope] = useState<"workspace" | "global">("workspace");
  const [doc, setDoc] = useState<InstructionDoc | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .getInstructions(scope, activeWorkspace?.id)
      .then((res) => {
        setDoc(res.doc);
        setContent(res.doc.content);
        setDirty(false);
      })
      .catch(() => {});
  }, [scope, activeWorkspace?.id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.saveInstructions(scope, content, activeWorkspace?.id);
      setDoc(res.doc);
      setDirty(false);
      toast("已保存项目说明文件", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1>{t("项目说明")}</h1>
      <p className="lead">
        维护长期生效的项目背景、技术栈约定与命令规范（保存在 <code className="mono">AVENT.md</code>
        ），同时自动兼容读取仓库内的 <code className="mono">AGENTS.md</code> 与{" "}
        <code className="mono">CLAUDE.md</code>。
      </p>

      <Tabs
        value={scope}
        tabs={[
          {
            value: "workspace",
            label: `当前工作区 (${activeWorkspace?.name || "默认"})`,
          },
          { value: "global", label: "全局通用说明" },
        ]}
        onChange={setScope}
        className="history-tabs"
      />

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <span className="mono truncate" style={{ fontSize: 12.5 }}>
            {doc?.filePath || "AVENT.md"}
          </span>
          <div className="actions">
            <Button
              variant="primary"
              size="sm"
              busy={saving}
              disabled={!dirty}
              onClick={() => void handleSave()}
            >
              {t("保存")}
            </Button>
          </div>
        </div>
        <div className="panel-body col" style={{ gap: 10 }}>
          {doc?.discoveredFiles && doc.discoveredFiles.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="hint">已自动发现并纳入生效的说明文件：</span>
              {doc.discoveredFiles.map((f) => (
                <Chip key={f.name} tone="good" mono icon="check">
                  {f.name} ({f.size} B)
                </Chip>
              ))}
            </div>
          )}

          <textarea
            className="editor"
            placeholder={
              "# 项目开发说明\n- 构建命令：npm.cmd run build:web\n- 测试命令：npm.cmd test\n- 代码风格与架构约束…"
            }
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
          />
        </div>
      </div>
    </>
  );
}

const THINKING_MODE_OPTIONS: Array<{ value: EndpointThinkingMode; label: string; desc: string }> = [
  { value: "none", label: "不支持思考", desc: "对话区自动隐藏思考强度选项" },
  { value: "toggle", label: "开关思考 (开/关)", desc: "支持开启或关闭扩展思考" },
  { value: "standard", label: "标准档位 (低/中/高)", desc: "支持 Low / Medium / High" },
  { value: "extended", label: "扩展档位 (含极高)", desc: "支持 Low / Medium / High / Extra" },
];

function ProviderSettings() {
  const { providers, setProviders, endpoints, setEndpoints, toast, t } = useApp();
  const [selectedId, setSelectedId] = useState<ProviderId>("agy");
  const [checkingId, setCheckingId] = useState<ProviderId | null>(null);
  const [addingEp, setAddingEp] = useState(false);

  useEffect(() => {
    void api
      .listProviders()
      .then((res) => {
        setProviders(res.providers);
        setEndpoints(res.endpoints);
      })
      .catch(() => {});
  }, []);

  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];

  const handleCheck = async (id: ProviderId) => {
    setCheckingId(id);
    try {
      const res = await api.checkProvider(id);
      setProviders(res.providers);
      toast(res.detail, res.ok ? "good" : "warn");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setCheckingId(null);
    }
  };

  const handleCreateEndpointCard = async () => {
    setAddingEp(true);
    try {
      const res = await api.addEndpoint({
        name: "新兼容端点",
        protocol: "anthropic",
        baseUrl: "",
        models: [],
      });
      setEndpoints(res.endpoints);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setAddingEp(false);
    }
  };

  return (
    <>
      <h1>{t("订阅与模型")}</h1>
      <p className="lead">
        通过标准 Agent Client Protocol (ACP) 实时同步你在各家官方 CLI 中已登录的订阅模型与思考档位；同时支持配置自定义兼容
        API 端点并通过本地 ACP 桥接执行。
      </p>

      <div className="provider-cards">
        {providers.map((p) => (
          <div
            key={p.id}
            className={cx("provider-card", p.id === selected?.id && "on")}
            onClick={() => setSelectedId(p.id)}
          >
            <div className="row" style={{ width: "100%" }}>
              <b>{p.name}</b>
              <span className="grow" />
              <Status tone={p.available ? (p.models.length > 0 ? "good" : "info") : "idle"}>
                {p.available ? (p.models.length > 0 ? "已同步" : "待检测") : "未就绪"}
              </Status>
            </div>
            <div className="d">{p.subscriptionLabel}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <Chip mono>{p.models.length} 个模型</Chip>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-head">
            <Icon name="cpu" size={17} className="accent" />
            <h3>{selected.name}</h3>
            <Chip tone="accent">{selected.subscriptionLabel}</Chip>
            <div className="actions">
              <Button
                size="sm"
                icon="copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(selected.loginCommand);
                  toast(`已复制命令：${selected.loginCommand}`, "good");
                }}
              >
                {t("复制登录命令")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon="refresh"
                busy={checkingId === selected.id}
                onClick={() => void handleCheck(selected.id)}
              >
                {t("重新检测")}
              </Button>
            </div>
          </div>

          <div className="panel-body col" style={{ gap: 12 }}>
            <dl className="kv">
              <dt>连接状态</dt>
              <dd>{selected.statusMessage}</dd>
              <dt>协议驱动</dt>
              <dd className="mono">{selected.adapterLabel}</dd>
              <dt>可执行路径</dt>
              <dd className="mono muted">{selected.binaryPath || "未检测到二进制文件"}</dd>
              <dt>终端登录指令</dt>
              <dd>
                <code className="mono">{selected.loginCommand}</code>
              </dd>
            </dl>

            <div>
              <div className="section-title">
                ACP 实时模型列表（共 {selected.models.length} 个）
              </div>
              {selected.models.length === 0 ? (
                <div className="hint">
                  尚未从该订阅获取到模型列表。请先在终端登录对应 CLI 后点击右上角「重新检测」。
                </div>
              ) : (
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {selected.models.map((m) => {
                    const tlLabel =
                      m.thoughtLevels === undefined
                        ? ""
                        : m.thoughtLevels.length === 0
                          ? " · 无独立思考档位"
                          : ` · ${m.thoughtLevels.map((l) => l.value).join("/")}`;
                    return (
                      <Chip key={m.value} outline mono title={`${m.value}${tlLabel}`}>
                        {m.name}
                        {tlLabel && (
                          <span className="muted" style={{ fontWeight: 400 }}>
                            {tlLabel}
                          </span>
                        )}
                      </Chip>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Inline Editable Compatible API Endpoints */}
      <div className="panel">
        <div className="panel-head">
          <h3>自定义兼容 API 端点</h3>
          <span className="sub">支持随时编辑地址、令牌，以及逐个增删模型与独立配置思考档位</span>
          <div className="actions">
            <Button
              variant="primary"
              size="sm"
              icon="plus"
              busy={addingEp}
              onClick={() => void handleCreateEndpointCard()}
            >
              添加端点
            </Button>
          </div>
        </div>
        <div className="panel-body col" style={{ gap: 14 }}>
          {endpoints.length === 0 ? (
            <div className="empty" style={{ padding: "18px 8px" }}>
              暂未配置兼容 API 端点。点击右上角「添加端点」可接入 Anthropic 或 OpenAI 兼容网关，并自由管理其下的模型列表。
            </div>
          ) : (
            endpoints.map((ep) => <EndpointEditor key={ep.id} endpoint={ep} />)
          )}
        </div>
      </div>
    </>
  );
}

function EndpointEditor({ endpoint }: { endpoint: CompatibleEndpointRecord }) {
  const { setEndpoints, toast } = useApp();
  const [name, setName] = useState(endpoint.name);
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl);
  const [keyInput, setKeyInput] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);

  useEffect(() => {
    setName(endpoint.name);
    setBaseUrl(endpoint.baseUrl);
  }, [endpoint.id, endpoint.name, endpoint.baseUrl]);

  const patchEndpoint = async (
    patch: Parameters<typeof api.updateEndpoint>[1],
    toastMsg?: string
  ) => {
    try {
      const res = await api.updateEndpoint(endpoint.id, patch);
      setEndpoints(res.endpoints);
      if (toastMsg) toast(toastMsg, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleAddModel = (modelIdRaw?: string) => {
    const id = (modelIdRaw ?? newModelId).trim();
    if (!id) return;
    if (endpoint.models.some((m) => m.id === id)) {
      toast(`模型 ${id} 已存在于当前端点`, "warn");
      return;
    }
    const nextModels: CompatibleEndpointModel[] = [
      ...endpoint.models,
      { id, thinkingMode: "none" },
    ];
    if (!modelIdRaw) setNewModelId("");
    void patchEndpoint({ models: nextModels });
  };

  const handleUpdateModelThinking = (modelId: string, thinkingMode: EndpointThinkingMode) => {
    const nextModels = endpoint.models.map((m) =>
      m.id === modelId ? { ...m, thinkingMode } : m
    );
    void patchEndpoint({ models: nextModels });
  };

  const handleRemoveModel = (modelId: string) => {
    const nextModels = endpoint.models.filter((m) => m.id !== modelId);
    void patchEndpoint({ models: nextModels });
  };

  const handleFetchModels = async () => {
    setFetching(true);
    try {
      // Save latest URL if user just typed it before clicking fetch
      if (baseUrl.trim() !== endpoint.baseUrl) {
        await patchEndpoint({ baseUrl: baseUrl.trim() });
      }
      const res = await api.fetchEndpointModels(endpoint.id);
      if (res.ok && res.models.length > 0) {
        setFetchedModels(res.models);
        toast(`从端点发现 ${res.models.length} 个模型，点击下方标签即可加入`, "good");
      } else {
        toast(res.error || "端点未返回可用模型列表", "warn");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "warn");
    } finally {
      setFetching(false);
    }
  };

  const handleDeleteEndpoint = async () => {
    try {
      const res = await api.deleteEndpoint(endpoint.id);
      setEndpoints(res.endpoints);
      toast(`已删除兼容端点：${endpoint.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const unaddedFetched = fetchedModels.filter(
    (id) => !endpoint.models.some((m) => m.id === id)
  );

  return (
    <div className="endpoint-card">
      <div className="endpoint-grid">
        <div className="field">
          <label>端点名称</label>
          <input
            className="input sm"
            placeholder="例如：DeepSeek / OpenRouter / 公司网关"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim() && name.trim() !== endpoint.name) {
                void patchEndpoint({ name: name.trim() });
              }
            }}
          />
        </div>

        <div className="field">
          <label>接口协议（执行桥接）</label>
          <Select<EndpointProtocol>
            size="sm"
            value={endpoint.protocol}
            options={[
              {
                value: "anthropic",
                label: "Anthropic 兼容 (Claude ACP)",
                desc: "通过 claude-agent-acp 调用 /v1/messages",
              },
              {
                value: "openai",
                label: "OpenAI 兼容 (Codex ACP)",
                desc: "通过 codex-acp 调用 OpenAI 兼容网关",
              },
            ]}
            onChange={(protocol) => void patchEndpoint({ protocol })}
          />
        </div>
      </div>

      <div className="endpoint-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="field">
          <label>Base URL</label>
          <input
            className="input sm mono"
            placeholder={
              endpoint.protocol === "anthropic"
                ? "https://api.deepseek.com/anthropic"
                : "https://openrouter.ai/api/v1"
            }
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => {
              if (baseUrl.trim() !== endpoint.baseUrl) {
                void patchEndpoint({ baseUrl: baseUrl.trim() });
              }
            }}
          />
        </div>

        <div className="field">
          <label>
            认证令牌 (API Key) ·{" "}
            <span className="muted" style={{ fontWeight: 400 }}>
              {endpoint.apiKeySet ? `已保存 (${endpoint.apiKeyHint})` : "未设置"}
            </span>
          </label>
          <div className="row" style={{ gap: 6 }}>
            <input
              type="password"
              className="input sm mono grow"
              placeholder={endpoint.apiKeySet ? "输入新令牌以替换…" : "sk-...（本地免鉴权可留空）"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!keyInput.trim()}
              onClick={() => {
                void patchEndpoint({ apiKey: keyInput.trim() }, "已安全保存认证令牌");
                setKeyInput("");
              }}
            >
              保存令牌
            </Button>
            {endpoint.apiKeySet && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void patchEndpoint({ apiKey: "" }, "已清除认证令牌")}
              >
                清除
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Per-Model Editable List */}
      <div className="endpoint-models">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="field-label">模型列表（{endpoint.models.length}）</span>
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            busy={fetching}
            disabled={!baseUrl.trim()}
            title="请求端点的 /models 接口自动发现可用模型"
            onClick={() => void handleFetchModels()}
          >
            从端点拉取模型
          </Button>
        </div>

        {endpoint.models.length === 0 ? (
          <div className="hint">
            尚未添加模型。在下方输入端点接受的模型 ID（例如 <code className="mono">deepseek-reasoner</code>）并回车添加。
          </div>
        ) : (
          endpoint.models.map((m) => (
            <div key={m.id} className="endpoint-model">
              <span className="mono grow truncate" style={{ fontWeight: 600 }} title={m.id}>
                {m.id}
              </span>
              <Select<EndpointThinkingMode>
                size="sm"
                className="w-180"
                icon="bulb"
                value={m.thinkingMode}
                options={THINKING_MODE_OPTIONS}
                onChange={(tm) => handleUpdateModelThinking(m.id, tm)}
              />
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                title="删除此模型"
                onClick={() => handleRemoveModel(m.id)}
              />
            </div>
          ))
        )}

        {unaddedFetched.length > 0 && (
          <div className="endpoint-fetched">
            <span className="hint" style={{ width: "100%" }}>
              端点返回的模型（点击直接加入）：
            </span>
            {unaddedFetched.slice(0, 24).map((mid) => (
              <Chip
                key={mid}
                outline
                mono
                icon="plus"
                onClick={() => handleAddModel(mid)}
              >
                {mid}
              </Chip>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8, marginTop: 2 }}>
          <input
            className="input sm mono grow"
            placeholder="输入要添加的模型 ID（如 deepseek-chat / qwen3-coder）…"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnter(e)) handleAddModel();
            }}
          />
          <Button
            size="sm"
            icon="plus"
            disabled={!newModelId.trim()}
            onClick={() => handleAddModel()}
          >
            添加模型
          </Button>
        </div>
      </div>

      <div className="row" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
        <span className="hint">
          {endpoint.protocol === "anthropic"
            ? "运行时自动注入 ANTHROPIC_BASE_URL 与隔离令牌，绝不占用你的 Claude 订阅额度"
            : "运行时自动注入 OPENAI_BASE_URL 与隔离令牌，绝不占用你的 Codex 订阅额度"}
        </span>
        <span className="grow" />
        <Button
          variant="danger-outline"
          size="sm"
          icon="trash"
          onClick={() => void handleDeleteEndpoint()}
        >
          删除端点
        </Button>
      </div>
    </div>
  );
}

function LanguageSettings() {
  const { prefs, updatePrefs, t } = useApp();
  const options: Array<{
    value: "auto" | "zh-CN" | "en";
    title: string;
    desc: string;
  }> = [
    {
      value: "auto",
      title: "跟随系统 / 浏览器语言 (Auto)",
      desc: "根据当前浏览器环境自动匹配简体中文或英文界面",
    },
    {
      value: "zh-CN",
      title: "简体中文",
      desc: "界面固定显示为简体中文（与智能体的对话语言仍取决于你的输入语言）",
    },
    {
      value: "en",
      title: "English",
      desc: "Display workbench navigation and primary controls in English",
    },
  ];

  return (
    <>
      <h1>{t("语言")}</h1>
      <p className="lead">选择工作台界面显示语言。</p>
      <div>
        {options.map((opt) => (
          <div
            key={opt.value}
            className={cx("option-card", prefs.uiLanguage === opt.value && "on")}
            onClick={() => void updatePrefs({ uiLanguage: opt.value })}
          >
            <div className="grow">
              <b>{opt.title}</b>
              <div className="d">{opt.desc}</div>
            </div>
            {prefs.uiLanguage === opt.value && <Icon name="check" size={16} className="accent" />}
          </div>
        ))}
      </div>
    </>
  );
}
