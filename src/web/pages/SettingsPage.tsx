import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type {
  CompatibleEndpointRecord,
  InstructionDoc,
  PermissionMode,
  PermissionRuleRecord,
  ProviderId,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Modal, Seg, Select, Status, Tabs, Toggle } from "../components/ui.js";
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
  const { prefs, providers, updatePrefs, toast, t } = useApp();

  return (
    <>
      <h1>{t("通用")}</h1>
      <p className="lead">配置新建任务的默认订阅驱动、默认权限行为与自动验证策略。</p>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>新任务默认配置</h3>
        </div>
        <div className="panel-body col" style={{ gap: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>默认订阅服务</b>
              <div className="hint">新建任务时优先选用的智能体订阅</div>
            </div>
            <Select<ProviderId>
              size="sm"
              className="w-220"
              icon="cpu"
              value={prefs.defaultProviderId}
              options={providers.map((p) => ({
                value: p.id,
                label: `${p.shortName} (${p.subscriptionLabel})`,
              }))}
              onChange={(v) => {
                void updatePrefs({ defaultProviderId: v });
                toast("已更新默认订阅服务", "good");
              }}
            />
          </div>

          <div className="row" style={{ justifyContent: "space-between" }}>
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

      <div className="panel">
        <div className="panel-head">
          <h3>自动化与质量守护</h3>
        </div>
        <div className="panel-body col" style={{ gap: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>修改文件后强制要求验证</b>
              <div className="hint">
                当智能体修改了代码文件却尚未运行构建或测试命令时，阻止其直接将任务标记为已完成
              </div>
            </div>
            <Toggle
              on={prefs.autoVerifyEdits}
              onChange={(next) => void updatePrefs({ autoVerifyEdits: next })}
            />
          </div>

          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>单次指令最大连续推进轮数</b>
              <div className="hint">防止无人值守复杂任务无限循环，到达上限后自动暂停等待确认</div>
            </div>
            <input
              type="number"
              min={1}
              max={30}
              className="input sm mono"
              style={{ width: 80, textAlign: "center" }}
              value={prefs.maxAutoContinues}
              onChange={(e) => {
                const val = Math.min(30, Math.max(1, Number(e.target.value) || 10));
                void updatePrefs({ maxAutoContinues: val });
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function PermissionsSettings() {
  const { activeWorkspace, toast, t } = useApp();
  const [rules, setRules] = useState<PermissionRuleRecord[]>([]);
  const [behavior, setBehavior] = useState<"allow" | "ask" | "deny">("allow");
  const [scope, setScope] = useState<"workspace" | "global">("workspace");
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    const res = await api.listRules(activeWorkspace?.id);
    setRules(res.rules);
  };

  useEffect(() => {
    void load();
  }, [activeWorkspace?.id]);

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
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  return (
    <>
      <h1>{t("权限")}</h1>
      <p className="lead">
        控制智能体执行命令行、修改文件或调用外部工具时的审批行为。规则按以下优先级从左到右依次判定：
      </p>

      <div className="eval-strip">
        <div className="eval-step deny">
          <b>1. 拒绝规则</b>
          <span>命中立即拦截</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step">
          <b>2. 询问规则</b>
          <span>强制弹窗确认</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step">
          <b>3. 允许规则</b>
          <span>命中自动放行</span>
        </div>
        <Icon name="chevRight" size={14} className="muted" />
        <div className="eval-step you">
          <b>4. 任务权限模式</b>
          <span>默认询问 / 自动编辑</span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>权限规则列表 ({rules.length})</h3>
        </div>
        <div>
          {rules.map((r) => (
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
                onClick={async () => {
                  await api.deleteRule(r.id);
                  await load();
                }}
              />
            </div>
          ))}
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
                { value: "workspace", label: "当前工作区" },
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
            <Button variant="primary" size="sm" disabled={!pattern.trim()} onClick={() => void handleAdd()}>
              添加规则
            </Button>
          </div>
          <div className="hint">
            语法示例：<code className="mono">Bash(npm.cmd test*)</code>、
            <code className="mono">Edit(src/**)</code>、<code className="mono">Write(*.md)</code>、
            <code className="mono">Bash(rm -rf *)</code>
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

function ProviderSettings() {
  const { providers, setProviders, prefs, updatePrefs, toast, t } = useApp();
  const [selectedId, setSelectedId] = useState<ProviderId>(prefs.defaultProviderId || "agy");
  const [checkingId, setCheckingId] = useState<ProviderId | null>(null);
  const [endpoints, setEndpoints] = useState<CompatibleEndpointRecord[]>([]);
  const [epModalOpen, setEpModalOpen] = useState(false);
  const [epName, setEpName] = useState("");
  const [epUrl, setEpUrl] = useState("");
  const [epKey, setEpKey] = useState("");
  const [epModels, setEpModels] = useState("");

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

  const handleAddEndpoint = async () => {
    if (!epName.trim() || !epUrl.trim()) return;
    try {
      const models = epModels
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      const res = await api.addEndpoint({
        name: epName,
        baseUrl: epUrl,
        apiKey: epKey,
        models: models.length > 0 ? models : ["default"],
      });
      setEndpoints((prev) => [res.endpoint, ...prev]);
      setEpModalOpen(false);
      setEpName("");
      setEpUrl("");
      setEpKey("");
      setEpModels("");
      toast(`已添加兼容端点：${res.endpoint.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  return (
    <>
      <h1>{t("订阅与模型")}</h1>
      <p className="lead">
        通过标准 Agent Client Protocol (ACP) 直接复用你在各家官方 CLI 中已登录的个人/团队订阅额度，Avent
        不保存也不触碰你的原始账号凭据。
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
              <Status tone={p.available ? "good" : "idle"}>
                {p.available ? (p.verified ? "已验证" : "已安装") : "未就绪"}
              </Status>
            </div>
            <div className="d">{p.subscriptionLabel}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <Chip mono>{p.models.length} 个模型</Chip>
              {prefs.defaultProviderId === p.id && <Chip tone="accent">默认</Chip>}
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
              {prefs.defaultProviderId !== selected.id && (
                <Button
                  size="sm"
                  onClick={() => {
                    void updatePrefs({ defaultProviderId: selected.id });
                    toast(`已将 ${selected.shortName} 设为默认订阅`, "good");
                  }}
                >
                  设为默认
                </Button>
              )}
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
              <div className="section-title">支持切换的模型</div>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {selected.models.map((m) => (
                  <Chip key={m.value} outline mono>
                    {m.name} ({m.value})
                  </Chip>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compatible API Endpoints */}
      <div className="panel">
        <div className="panel-head">
          <h3>自定义兼容 API 端点</h3>
          <span className="sub">可选配置企业网关或自建兼容服务</span>
          <div className="actions">
            <Button size="sm" icon="plus" onClick={() => setEpModalOpen(true)}>
              添加端点
            </Button>
          </div>
        </div>
        <div className="panel-body">
          {endpoints.length === 0 ? (
            <div className="empty" style={{ padding: "14px 8px" }}>
              暂未配置自定义兼容端点（日常直接使用上方官方订阅驱动即可）
            </div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {endpoints.map((ep) => (
                <div
                  key={ep.id}
                  className="row"
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 12px",
                  }}
                >
                  <div>
                    <b>{ep.name}</b>
                    <div className="mono muted" style={{ fontSize: 11.5 }}>
                      {ep.baseUrl} · Key: {ep.apiKeyHint}
                    </div>
                  </div>
                  <span className="grow" />
                  {ep.models.map((m) => (
                    <Chip key={m} mono>
                      {m}
                    </Chip>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    onClick={async () => {
                      await api.deleteEndpoint(ep.id);
                      setEndpoints((prev) => prev.filter((x) => x.id !== ep.id));
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={epModalOpen}
        onClose={() => setEpModalOpen(false)}
        title="添加自定义兼容端点"
        footer={
          <>
            <Button onClick={() => setEpModalOpen(false)}>{t("取消")}</Button>
            <Button
              variant="primary"
              disabled={!epName.trim() || !epUrl.trim()}
              onClick={() => void handleAddEndpoint()}
            >
              {t("保存")}
            </Button>
          </>
        }
      >
        <div className="field">
          <label>端点名称</label>
          <input
            className="input"
            placeholder="例如：内部网关 / OpenRouter"
            value={epName}
            onChange={(e) => setEpName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            className="input mono"
            placeholder="https://api.example.com/v1"
            value={epUrl}
            onChange={(e) => setEpUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label>API Key (仅脱敏存储提示)</label>
          <input
            type="password"
            className="input mono"
            placeholder="sk-..."
            value={epKey}
            onChange={(e) => setEpKey(e.target.value)}
          />
        </div>
        <div className="field">
          <label>模型列表 (逗号分隔)</label>
          <input
            className="input mono"
            placeholder="claude-sonnet-4-5, deepseek-v3"
            value={epModels}
            onChange={(e) => setEpModels(e.target.value)}
          />
        </div>
      </Modal>
    </>
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
