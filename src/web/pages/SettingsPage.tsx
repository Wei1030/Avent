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
  ToolCategory,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { ModelPicker, resolveThoughtLevelsForSelection } from "../components/ModelPicker.js";
import { Button, Chip, Seg, Select, Status, Tabs } from "../components/ui.js";
import { cx, isPlainEnter } from "../lib/format.js";

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
              value={prefs.defaultPermissionMode}
              options={[
                { value: "default", label: t("默认询问") },
                { value: "acceptEdits", label: t("自动接受编辑") },
                { value: "bypassPermissions", label: t("全自动执行") },
              ]}
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

const TESTER_CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: "只读工具",
  edit: "文件编辑",
  delete: "文件删除 / 移动",
  shell: "终端命令",
  other: "外部工具",
};

const TESTER_PRESETS: Array<{
  label: string;
  toolKind: "shell" | "edit" | "delete" | "read";
  inputText: string;
}> = [
  { label: "纯只读拼接", toolKind: "shell", inputText: "git status && git diff --stat" },
  { label: "测试+删文件绕过", toolKind: "shell", inputText: "npm.cmd test && rm -r -f src" },
  { label: "重定向写文件", toolKind: "shell", inputText: "git diff > src/hacked.ts" },
  { label: "PowerShell 递归删", toolKind: "shell", inputText: "Remove-Item -Recurse -Force dist" },
  { label: "目录逃逸编辑", toolKind: "edit", inputText: "../../outside-secret.txt" },
  { label: "工作区内删除文件", toolKind: "delete", inputText: "src/old.ts" },
];

function PermissionsSettings() {
  const { activeWorkspace, prefs, toast, t } = useApp();
  const [rules, setRules] = useState<PermissionRuleRecord[]>([]);
  const [behavior, setBehavior] = useState<"allow" | "ask" | "deny">("allow");
  const [scope, setScope] = useState<"workspace" | "global">(() =>
    activeWorkspace ? "workspace" : "global"
  );
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  // Live permission simulator state
  const [testKind, setTestKind] = useState<"shell" | "edit" | "delete" | "read">("shell");
  const [testMode, setTestMode] = useState<PermissionMode>(prefs.defaultPermissionMode);
  const [testInput, setTestInput] = useState("npm.cmd test && rm -r -f src");
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

  const runEvaluate = async (
    nextKind = testKind,
    nextInput = testInput,
    nextMode = testMode
  ) => {
    if (!nextInput.trim()) return;
    setTesting(true);
    try {
      const res = await api.evaluateRule({
        toolKind: nextKind,
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
    if (!pattern.trim()) return;
    try {
      await api.addRule({
        behavior,
        rule: pattern.trim(),
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

  const fillExample = (b: "allow" | "ask" | "deny", expr: string, sampleNote: string) => {
    setBehavior(b);
    setPattern(expr);
    setNote(sampleNote);
  };

  return (
    <>
      <h1>{t("权限")}</h1>
      <p className="lead">
        采用「结构化分类 + 目录边界锁 + Shell 词法拆解（Fail-Closed）」机制。任何无法确定证明为纯只读的命令，默认均需确认或命中显式规则：
      </p>

      <div className="eval-strip">
        <div className="eval-step deny">
          <b>1. 拒绝规则</b>
          <span>任意子命令命中即拦截</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step">
          <b>2. 询问规则</b>
          <span>命中强制弹窗确认</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step deny">
          <b>3. 安全底线</b>
          <span>越界 / 删文件 / 高危强拦</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step">
          <b>4. 拆解校验</b>
          <span>允许规则 & 纯只读逐条过</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step you">
          <b>5. 权限模式</b>
          <span>默认询问 / 自动编辑 / 全自动</span>
        </div>
      </div>

      {/* Rules List & Editor */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>权限规则列表 ({rules.length})</h3>
          <span className="sub">
            {activeWorkspace ? `当前包含全局规则与「${activeWorkspace.name}」工作区规则` : "当前显示全局规则"}
          </span>
        </div>
        <div>
          {rules.length === 0 ? (
            <div className="empty" style={{ padding: "22px 16px" }}>
              暂无自定义权限规则，全部按内置安全底线与任务权限模式判定。
            </div>
          ) : (
            rules.map((r) => (
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
                <code className="mono" style={{ fontWeight: 600 }}>
                  {r.rule}
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
            ))
          )}
        </div>

        <div className="rule-editor">
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <Seg
              value={behavior}
              options={[
                { value: "allow", label: "允许" },
                { value: "ask", label: "询问" },
                { value: "deny", label: "拒绝" },
              ]}
              onChange={setBehavior}
            />
            <Seg
              value={scope}
              options={[
                { value: "workspace", label: "当前工作区", disabled: !activeWorkspace },
                { value: "global", label: "全局" },
              ]}
              onChange={setScope}
            />
            <input
              className="input sm mono grow"
              style={{ minWidth: 220 }}
              placeholder="例如 Bash(npm.cmd run build*) 或 Edit(src/**)"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter(e)) void handleAdd();
              }}
            />
            <input
              className="input sm"
              style={{ width: 170 }}
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
              添加规则
            </Button>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <span className="hint">点击填入示例：</span>
            <button
              type="button"
              className="perm-preset"
              onClick={() => fillExample("allow", "Bash(npm.cmd run build*)", "允许执行项目构建")}
            >
              允许 Bash(npm.cmd run build*)
            </button>
            <button
              type="button"
              className="perm-preset"
              onClick={() => fillExample("allow", "Edit(src/**)", "允许编辑 src 目录代码")}
            >
              允许 Edit(src/**)
            </button>
            <button
              type="button"
              className="perm-preset"
              onClick={() => fillExample("deny", "Bash(rm*)", "禁止终端执行 rm 删除")}
            >
              拒绝 Bash(rm*)
            </button>
            <button
              type="button"
              className="perm-preset"
              onClick={() => fillExample("ask", "Bash(git commit*)", "提交前强制人工确认")}
            >
              询问 Bash(git commit*)
            </button>
          </div>
        </div>
      </div>

      {/* Interactive Command & Rule Simulator */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <Icon name="shield" size={16} className="accent" />
          <h3>命令与规则试算器</h3>
          <span className="sub">输入任意命令或文件路径，实时查看真实拦截引擎的拆解与判定结果</span>
        </div>
        <div className="panel-body col" style={{ gap: 12 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            <Seg
              value={testKind}
              options={[
                { value: "shell", label: "终端命令" },
                { value: "edit", label: "文件编辑" },
                { value: "delete", label: "文件删除" },
                { value: "read", label: "文件读取" },
              ]}
              onChange={(k) => {
                setTestKind(k);
                setTestResult(null);
              }}
            />
            <Seg<PermissionMode>
              value={testMode}
              options={[
                { value: "default", label: "默认询问" },
                { value: "acceptEdits", label: "自动接受编辑" },
                { value: "bypassPermissions", label: "全自动执行" },
              ]}
              onChange={(m) => {
                setTestMode(m);
                if (testInput.trim()) void runEvaluate(testKind, testInput, m);
              }}
            />
          </div>

          <div className="row" style={{ gap: 8 }}>
            <input
              className="input mono grow"
              placeholder={
                testKind === "shell"
                  ? "输入任意 Shell / PowerShell 命令，如 npm.cmd test && rm -r -f src"
                  : "输入相对路径或绝对路径，如 src/index.ts 或 ../../secret.txt"
              }
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter(e)) void runEvaluate();
              }}
            />
            <Button
              variant="primary"
              icon="play"
              busy={testing}
              disabled={!testInput.trim()}
              onClick={() => void runEvaluate()}
            >
              测试判定
            </Button>
          </div>

          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <span className="hint">快捷测试样例：</span>
            {TESTER_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="perm-preset"
                onClick={() => {
                  setTestKind(p.toolKind);
                  setTestInput(p.inputText);
                  void runEvaluate(p.toolKind, p.inputText, testMode);
                }}
              >
                {p.label}
              </button>
            ))}
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
                <b>{testResult.preview.provenance}</b>
                <span className="grow" />
                <Chip>{TESTER_CATEGORY_LABEL[testResult.preview.category]}</Chip>
                {testResult.preview.outsideWorkspace && <Chip tone="crit">越出工作目录</Chip>}
                {testResult.preview.isRisky && <Chip tone="crit">高风险</Chip>}
                {testResult.preview.hazards.hasRedirection && <Chip tone="warn">输出重定向</Chip>}
                {testResult.preview.hazards.hasCommandSub && <Chip tone="warn">命令替换</Chip>}
                {testResult.preview.hazards.hasDynamicEval && <Chip tone="warn">动态求值</Chip>}
                {testResult.preview.hazards.hasPipeToShell && <Chip tone="crit">管道直连脚本</Chip>}
              </div>

              <div className="hint mono">基准工作目录：{testResult.cwd}</div>

              {testResult.preview.reasons.length > 0 && (
                <div className="perm-reasons">
                  {testResult.preview.reasons.map((r, i) => (
                    <div key={i} className="perm-reason-item">
                      <Icon name="info" size={13} className="accent" />
                      <span>{r}</span>
                    </div>
                  ))}
                </div>
              )}

              {testResult.preview.subCommands.length > 0 && (
                <div className="perm-subcmds">
                  <div className="hint" style={{ fontWeight: 600 }}>
                    子命令拆解结果（共 {testResult.preview.subCommands.length} 条）
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
                          ? "纯只读"
                          : seg.classification === "destructive"
                            ? "高危"
                            : "需确认"}
                      </Status>
                      <code className="mono truncate" style={{ maxWidth: "52%" }} title={seg.raw}>
                        {seg.raw}
                      </code>
                      {seg.reasons[0] && (
                        <span className="muted truncate" style={{ fontSize: 11.5 }}>
                          {seg.reasons[0]}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Built-in Guardrails Summary */}
      <div className="panel">
        <div className="panel-head">
          <h3>内置拦截机制与安全底线</h3>
        </div>
        <div className="panel-body perm-guide-grid">
          <div className="perm-guide-item">
            <b>1. 复合命令逐条拆解，防拼接绕过</b>
            <p>
              对 <code className="mono">&&</code>、<code className="mono">;</code>、
              <code className="mono">|</code>、<code className="mono">||</code> 拆分为独立子命令。
              哪怕配置了 <code className="mono">Bash(npm.cmd test*)</code>，如果后面拼接了其他未授权命令或删文件操作，仍会被整体拦截。
            </p>
          </div>
          <div className="perm-guide-item">
            <b>2. 重定向与动态求值禁止走白名单</b>
            <p>
              包含 <code className="mono">&gt;</code> / <code className="mono">&gt;&gt;</code> 写文件重定向、
              <code className="mono">$(...)</code> 命令替换、或 <code className="mono">eval</code> /{" "}
              <code className="mono">iex</code> / <code className="mono">bash -c</code> /{" "}
              <code className="mono">-EncodedCommand</code> 时，不会命中只读白名单或前缀允许规则。
            </p>
          </div>
          <div className="perm-guide-item">
            <b>3. 严苛只读白名单（Fail-Closed）</b>
            <p>
              仅 <code className="mono">git status/diff/log/show</code>、<code className="mono">ls/dir/cat/rg/tsc --noEmit</code> 等明确无副作用命令自动放行；
              其余一切未识别命令（如 <code className="mono">node</code> / <code className="mono">python</code> / <code className="mono">sed</code>）默认按可能修改处理并询问。
            </p>
          </div>
          <div className="perm-guide-item">
            <b>4. 目录边界与删除保护（Worktree 地基）</b>
            <p>
              所有读写、编辑、删除与终端切换目录均做真实路径归一化校验；越出当前任务工作目录的操作以及文件删除操作，即使在「自动接受编辑」或「全自动执行」模式下也强制弹窗确认。
            </p>
          </div>
        </div>
      </div>
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
