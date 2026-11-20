import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Status } from "../components/ui.js";
import { cx, fmtTokens, relTime, taskStatusDisplay } from "../lib/format.js";

export function HomePage() {
  const {
    ready,
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    setWorkspaces,
    tasks,
    setFolderPickerOpen,
    resolveWorkspaceTaskRoute,
    confirm,
    confirmWithOption,
    toast,
    lang,
    t,
  } = useApp();
  const nav = useNavigate();

  const handleRemoveWs = async (wsId: string, name: string) => {
    const ok = await confirm({
      title: "移除工作区",
      message: `确定要从 Avent 列表中移除工作区「${name}」吗？`,
      detail:
        "此操作仅从列表移除，不会移动或删除本地磁盘上的任何文件；之后重新添加该文件夹即可自动恢复历史任务。",
      confirmLabel: "确认移除",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.deleteWorkspace(wsId);
      setWorkspaces(res.workspaces);
      toast(`已移除工作区：${name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleDeleteTask = async (tk: (typeof tasks)[number]) => {
    const isRunning = tk.status === "PULSING" || tk.status === "WAITING_APPROVAL";
    const hasActiveWt = Boolean(tk.worktreePath && !tk.worktreeRemoved);
    const { ok, checked } = await confirmWithOption({
      title: "删除任务",
      message: `确定要永久删除任务「${tk.title}」吗？`,
      detail: `${
        isRunning
          ? "该任务正在运行，确认后将先中止执行，并永久删除其对话记录与状态记忆，此操作无法撤销。"
          : "将永久删除该任务的全部对话记录与状态记忆，此操作无法撤销。"
      }${hasActiveWt ? `\n\n该任务绑定了独立工作树分支 ${tk.worktreeBranch || ""}。` : ""}`,
      confirmLabel: "确认删除",
      danger: true,
      checkbox: hasActiveWt
        ? {
            label: `同时清理独立工作树目录与分支 (${tk.worktreeBranch || ""})`,
            defaultChecked: Boolean(tk.worktreeMergedAt),
          }
        : undefined,
    });
    if (!ok) return;
    try {
      await api.deleteTask(tk.id, { cleanupWorktree: hasActiveWt && checked });
      toast(`已删除任务：${tk.title}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const recentTasks = tasks.filter((tk) => tk.status !== "DRAFT").slice(0, 10);

  if (!ready) {
    return (
      <div className="page">
        <div className="loading-block">
          <span className="spinner" /> 正在加载工作区…
        </div>
      </div>
    );
  }

  // Dedicated zero-workspace onboarding state
  if (workspaces.length === 0) {
    return (
      <div className="page">
        <div className="ws-empty">
          <div className="ws-empty-icon">
            <Icon name="folder" size={26} />
          </div>
          <h2>还没有添加任何工作区</h2>
          <p>
            选择一个本地代码库或项目文件夹作为工作区，Avent
            即可在该目录下结合多厂商订阅模型与结构化「状态记忆」持续协助你完成分析、开发与验证。
          </p>
          <div className="ws-empty-actions">
            <Button
              variant="primary"
              size="lg"
              icon="folder"
              onClick={() => setFolderPickerOpen(true)}
            >
              添加第一个工作区
            </Button>
          </div>
          <div className="ws-empty-note">
            添加或移除工作区仅影响 Avent 的项目列表，不会移动或删除本地磁盘上的任何文件。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>{t("工作区")}</h1>
          <div className="grow" />
          <Button variant="primary" icon="folder" onClick={() => setFolderPickerOpen(true)}>
            {t("添加工作区")}
          </Button>
        </div>
        <p className="page-sub">
          选择一个项目工作区进入对话，智能体会结合各家订阅模型与结构化状态记忆持续推进任务。
        </p>

        {/* Workspace Cards Grid */}
        <div className="ws-grid">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className={cx("ws-card", activeWorkspace?.id === ws.id && "active")}
              onClick={() => {
                setActiveWorkspaceId(ws.id);
                nav(resolveWorkspaceTaskRoute(ws.id));
              }}
            >
              <button
                type="button"
                className="ws-remove"
                title="从列表移除此工作区（不删除本地文件）"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemoveWs(ws.id, ws.name);
                }}
              >
                <Icon name="x" size={14} />
              </button>

              <div className="ws-card-head">
                <div className="ws-icon">
                  <Icon name="folder" size={19} />
                </div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b className="truncate">{ws.name}</b>
                  <span className="mono muted truncate" title={ws.path}>
                    {ws.path}
                  </span>
                </div>
              </div>

              <div className="ws-card-chips">
                {ws.branch && (
                  <Chip mono icon="branch">
                    {ws.branch}
                  </Chip>
                )}
                {ws.gitClean !== undefined && (
                  <Chip tone={ws.gitClean ? "good" : "warn"}>
                    {ws.gitClean ? "工作树干净" : "有未提交修改"}
                  </Chip>
                )}
                {(ws.runningCount ?? 0) > 0 && (
                  <Chip tone="accent">{ws.runningCount} 项执行中</Chip>
                )}
              </div>

              <div className="ws-card-foot muted">
                <span>{ws.taskCount ?? 0} 个任务</span>
                <span className="accent" style={{ fontSize: 12 }}>
                  进入工作区 →
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Recent Tasks */}
        <div className="section-head">
          <h2>{t("最近任务")}</h2>
          <span className="muted">{tasks.filter((x) => x.status !== "DRAFT").length} 项</span>
          <div className="grow" />
          <button type="button" className="link-btn" onClick={() => nav("/tasks")}>
            {t("全部任务 →")}
          </button>
        </div>

        {recentTasks.length === 0 ? (
          <div className="panel">
            <div className="empty">
              <b>还没有进行过任务</b>
              点击上方任意工作区即可开始你的第一个任务。
            </div>
          </div>
        ) : (
          <div className="slist">
            <div className="slist-head">
              <span>任务名称</span>
              <span>工作区</span>
              <span>模型 / 订阅</span>
              <span>Token 用量</span>
              <span>最近更新</span>
              <span />
            </div>
            {recentTasks.map((tk) => {
              const st = taskStatusDisplay(tk.status, t);
              const wsName =
                workspaces.find((w) => w.id === tk.workspaceId)?.name || "默认工作区";
              return (
                <div key={tk.id} className="srow" onClick={() => nav(`/t/${tk.id}`)}>
                  <div className="srow-title">
                    <span className={cx("sdot", st.dotClass)} style={{ marginTop: 0 }} />
                    <span className="truncate">{tk.title}</span>
                    <Status tone={st.tone}>{st.label}</Status>
                  </div>
                  <div className="srow-ws truncate">{wsName}</div>
                  <div className="mono muted truncate" style={{ fontSize: 12 }}>
                    {tk.modelId || "—"}
                  </div>
                  <div className="mono muted" style={{ fontSize: 12 }}>
                    {tk.totalTokens > 0 ? fmtTokens(tk.totalTokens) : "—"}
                  </div>
                  <div className="srow-time">{relTime(tk.updatedAt, lang)}</div>
                  <div className="srow-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      title={t("删除")}
                      onClick={() => void handleDeleteTask(tk)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
