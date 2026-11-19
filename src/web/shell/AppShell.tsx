import { useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Popover, Select } from "../components/ui.js";
import { cx, relTime, taskStatusDisplay } from "../lib/format.js";
import { FolderPickerModal } from "./FolderPickerModal.js";
import { FilePreviewModal } from "./FilePreviewModal.js";

export function AppShell() {
  const {
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    tasks,
    approvals,
    providers,
    prefs,
    lang,
    t,
    updatePrefs,
    setFolderPickerOpen,
    toasts,
    dismissToast,
  } = useApp();

  const nav = useNavigate();
  const loc = useLocation();

  const [searchQ, setSearchQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const [inboxOpen, setInboxOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);

  const [langOpen, setLangOpen] = useState(false);
  const langBtnRef = useRef<HTMLButtonElement>(null);

  const defaultProvider =
    providers.find((p) => p.id === prefs.defaultProviderId) ?? providers[0];

  const runningTasksCount = tasks.filter(
    (tk) => tk.status === "PULSING" || tk.status === "WAITING_APPROVAL"
  ).length;

  const isTasksActive =
    loc.pathname === "/" || loc.pathname === "/tasks" || loc.pathname.startsWith("/t/");

  // Filtered global search results
  const qLower = searchQ.trim().toLowerCase();
  const matchingTasks = qLower
    ? tasks
        .filter(
          (tk) =>
            tk.title.toLowerCase().includes(qLower) ||
            tk.originalObjective.toLowerCase().includes(qLower)
        )
        .slice(0, 6)
    : tasks.slice(0, 5);

  const quickNavItems = [
    { label: "订阅与模型设置", desc: "配置 Google AI Ultra / Claude / Codex", path: "/settings/provider" },
    { label: "权限与安全规则", desc: "配置工具允许 / 询问 / 拒绝规则", path: "/settings/permissions" },
    { label: "MCP 扩展服务", desc: "管理全局与工作区 MCP 工具源", path: "/mcp" },
    { label: "技能与快捷指令", desc: "管理 / 指令模板", path: "/skills" },
    { label: "Token 用量统计", desc: "查看各工作区与模型用量", path: "/usage" },
  ].filter(
    (item) =>
      !qLower ||
      item.label.toLowerCase().includes(qLower) ||
      item.desc.toLowerCase().includes(qLower)
  );

  return (
    <div className="app">
      {/* Top Bar */}
      <header className="topbar">
        <div className="brand" onClick={() => nav("/")}>
          <span className="logo">
            <Icon name="bolt" size={15} strokeWidth={2.2} />
          </span>
          <span>Avent</span>
        </div>

        {workspaces.length > 0 && (
          <Select
            className="ws-switch"
            size="sm"
            icon="folder"
            value={activeWorkspace?.id ?? ""}
            options={workspaces.map((w) => ({
              value: w.id,
              label: w.name,
              desc: w.path,
              right: w.branch ? w.branch : undefined,
            }))}
            onChange={(id) => {
              setActiveWorkspaceId(id);
            }}
            footer={
              <button
                type="button"
                className="menu-item"
                onClick={() => setFolderPickerOpen(true)}
              >
                <Icon name="plus" size={14} />
                <span>{t("添加工作区…")}</span>
              </button>
            }
          />
        )}

        <div ref={searchWrapRef} className="top-search">
          <div className="input-wrap">
            <Icon name="search" size={14} />
            <input
              className="input sm"
              placeholder={t("搜索任务与设置")}
              value={searchQ}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setSearchQ(e.target.value);
                setSearchOpen(true);
              }}
            />
          </div>
          <Popover
            anchor={searchWrapRef.current}
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            className="search-results"
          >
            {matchingTasks.length > 0 && (
              <>
                <div className="menu-head">{t("任务")}</div>
                {matchingTasks.map((tk) => {
                  const st = taskStatusDisplay(tk.status, t);
                  return (
                    <button
                      key={tk.id}
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        setSearchOpen(false);
                        nav(`/t/${tk.id}`);
                      }}
                    >
                      <Icon name="task" size={14} className="ink2" />
                      <span className="grow truncate">{tk.title}</span>
                      <span className="right">{st.label}</span>
                    </button>
                  );
                })}
              </>
            )}
            {quickNavItems.length > 0 && (
              <>
                <div className="menu-sep" />
                <div className="menu-head">快捷导航</div>
                {quickNavItems.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setSearchOpen(false);
                      nav(item.path);
                    }}
                  >
                    <Icon name="gear" size={14} className="ink2" />
                    <span className="grow">
                      {item.label}
                      <span className="desc">{item.desc}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </Popover>
        </div>

        <div className="spacer" />

        {/* Language Switcher */}
        <button
          ref={langBtnRef}
          type="button"
          className="lang-btn"
          title={t("语言")}
          onClick={() => setLangOpen(!langOpen)}
        >
          <Icon name="globe" size={15} />
          <span>{lang === "en" ? "EN" : "中"}</span>
        </button>
        <Popover
          anchor={langBtnRef.current}
          open={langOpen}
          onClose={() => setLangOpen(false)}
          align="right"
        >
          {[
            { v: "auto" as const, l: "跟随浏览器 (Auto)" },
            { v: "zh-CN" as const, l: "简体中文" },
            { v: "en" as const, l: "English" },
          ].map((opt) => (
            <button
              key={opt.v}
              type="button"
              className={cx("menu-item", prefs.uiLanguage === opt.v && "on")}
              onClick={() => {
                void updatePrefs({ uiLanguage: opt.v });
                setLangOpen(false);
              }}
            >
              <span className="grow">{opt.l}</span>
              {prefs.uiLanguage === opt.v && <Icon name="check" size={14} />}
            </button>
          ))}
        </Popover>

        {/* Approvals Inbox */}
        <button
          ref={bellRef}
          type="button"
          className="top-icon"
          title={t("等你处理")}
          onClick={() => setInboxOpen(!inboxOpen)}
        >
          <Icon name="bell" size={17} />
          {approvals.length > 0 && <span className="badge">{approvals.length}</span>}
        </button>
        <Popover
          anchor={bellRef.current}
          open={inboxOpen}
          onClose={() => setInboxOpen(false)}
          align="right"
          className="inbox"
        >
          <h4>
            <Icon name="bell" size={15} />
            {t("等你处理")}
            {approvals.length > 0 && <Chip tone="warn">{approvals.length}</Chip>}
          </h4>
          {approvals.length === 0 ? (
            <div className="empty" style={{ padding: "20px 12px" }}>
              {t("暂无待审批操作")}
            </div>
          ) : (
            approvals.map((ap) => (
              <div
                key={ap.id}
                className="inbox-item"
                onClick={() => {
                  setInboxOpen(false);
                  nav(`/t/${ap.taskId}`);
                }}
              >
                <Icon name="warning" size={16} className="warn" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t truncate">{ap.taskTitle}</div>
                  <div className="d truncate">
                    {ap.toolName} · {ap.detail}
                  </div>
                  <div className="w">{relTime(ap.createdAt, lang)} · 点击前往确认</div>
                </div>
              </div>
            ))
          )}
        </Popover>

        {/* Subscription Status Pill */}
        {defaultProvider && (
          <div
            className="account"
            onClick={() => nav("/settings/provider")}
            title="点击管理多厂商订阅与模型服务"
          >
            <span
              className="avatar"
              style={{
                background: defaultProvider.available ? "var(--accent)" : "var(--muted)",
              }}
            >
              {defaultProvider.shortName.slice(0, 1)}
            </span>
            <div className="lines">
              <b>{defaultProvider.shortName}</b>
              <span className="muted">{defaultProvider.subscriptionLabel}</span>
            </div>
          </div>
        )}
      </header>

      {/* 5-Module Left NavRail: 任务 · MCP · 技能 · 用量 · 设置 */}
      <nav className="navrail">
        <button
          type="button"
          className={cx(isTasksActive && "active")}
          onClick={() => nav("/")}
        >
          <Icon name="task" size={19} />
          <span>{t("任务")}</span>
          {runningTasksCount > 0 && <span className="badge">{runningTasksCount}</span>}
        </button>

        <NavLink to="/mcp" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="plug" size={19} />
          <span>{t("MCP")}</span>
        </NavLink>

        <NavLink to="/skills" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="spark" size={19} />
          <span>{t("技能")}</span>
        </NavLink>

        <NavLink to="/usage" className={({ isActive }) => cx(isActive && "active")}>
          <Icon name="chart" size={19} />
          <span>{t("用量")}</span>
        </NavLink>

        <div className="bottom">
          <NavLink to="/settings" className={({ isActive }) => cx(isActive && "active")}>
            <Icon name="gear" size={19} />
            <span>{t("设置")}</span>
          </NavLink>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="main">
        <Outlet />
      </main>

      {/* Global Modals & Toasts */}
      <FolderPickerModal />
      <FilePreviewModal />

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((item) => (
            <div key={item.id} className={cx("toast", item.tone)}>
              <Icon
                name={
                  item.tone === "good" ? "check" : item.tone === "crit" ? "x" : "warning"
                }
                size={15}
              />
              <span>{item.text}</span>
              <button type="button" onClick={() => dismissToast(item.id)}>
                关闭
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
