import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Status } from "../components/ui.js";
import { cx, fmtTokens, relTime, taskStatusDisplay } from "../lib/format.js";

export function HomePage() {
  const {
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    setWorkspaces,
    tasks,
    setFolderPickerOpen,
    toast,
    lang,
    t,
  } = useApp();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);

  const startNewTask = async (workspaceId?: string) => {
    setCreating(true);
    try {
      const wsId = workspaceId || activeWorkspace?.id;
      if (wsId) setActiveWorkspaceId(wsId);
      const res = await api.createTask({ workspaceId: wsId, draft: true });
      nav(`/t/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setCreating(false);
    }
  };

  const handleRemoveWs = async (wsId: string, name: string) => {
    try {
      const res = await api.deleteWorkspace(wsId);
      setWorkspaces(res.workspaces);
      toast(`已移除工作区：${name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const recentTasks = tasks.filter((tk) => tk.status !== "DRAFT").slice(0, 10);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>{t("工作区")}</h1>
          <div className="grow" />
          <Button icon="folder" onClick={() => setFolderPickerOpen(true)}>
            {t("添加工作区")}
          </Button>
          <Button
            variant="primary"
            icon="plus"
            busy={creating}
            onClick={() => void startNewTask()}
          >
            {t("新建任务")}
          </Button>
        </div>
        <p className="page-sub">
          选择一个项目工作区发起任务，智能体会结合各家订阅模型与结构化状态记忆持续推进并完成验证。
        </p>

        {/* Workspace Cards Grid */}
        <div className="ws-grid">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className={cx("ws-card", activeWorkspace?.id === ws.id && "active")}
              onClick={() => {
                setActiveWorkspaceId(ws.id);
                const latestInWs = tasks.find((tk) => tk.workspaceId === ws.id);
                if (latestInWs) {
                  nav(`/t/${latestInWs.id}`);
                } else {
                  void startNewTask(ws.id);
                }
              }}
            >
              {workspaces.length > 1 && (
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
              )}

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
                <button
                  type="button"
                  className="link-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void startNewTask(ws.id);
                  }}
                >
                  + 在此新建任务
                </button>
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
              点击右上角「新建任务」开始你的第一个任务。
            </div>
          </div>
        ) : (
          <div className="slist">
            <div className="slist-head">
              <span>任务名称</span>
              <span>工作区</span>
              <span>模型 / 订阅</span>
              <span>状态记忆</span>
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
                    {tk.modelId}
                  </div>
                  <div>
                    {tk.currentVersion > 0 ? (
                      <Chip tone="accent" mono>
                        v{tk.currentVersion}
                      </Chip>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {tk.totalTokens > 0 && (
                      <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>
                        {fmtTokens(tk.totalTokens)}
                      </span>
                    )}
                  </div>
                  <div className="srow-time">{relTime(tk.updatedAt, lang)}</div>
                  <div className="srow-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      title={t("删除")}
                      onClick={() => void api.deleteTask(tk.id)}
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
