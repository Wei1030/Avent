import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Select, Status } from "../components/ui.js";
import { cx, fmtTokens, isPlainEnter, relTime, taskStatusDisplay } from "../lib/format.js";

export function TasksListPage() {
  const { workspaces, activeWorkspace, tasks, toast, lang, t } = useApp();
  const nav = useNavigate();

  const [q, setQ] = useState("");
  const [wsFilter, setWsFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const qLower = q.trim().toLowerCase();
    return tasks.filter((tk) => {
      if (wsFilter !== "all" && tk.workspaceId !== wsFilter) return false;
      if (statusFilter === "running") {
        if (tk.status !== "PULSING" && tk.status !== "WAITING_APPROVAL") return false;
      } else if (statusFilter === "completed") {
        if (tk.status !== "COMPLETED") return false;
      } else if (statusFilter === "active") {
        if (tk.status === "COMPLETED" || tk.status === "DRAFT") return false;
      }
      if (
        qLower &&
        !tk.title.toLowerCase().includes(qLower) &&
        !tk.originalObjective.toLowerCase().includes(qLower)
      ) {
        return false;
      }
      return true;
    });
  }, [tasks, wsFilter, statusFilter, q]);

  const handleNewTask = async () => {
    setCreating(true);
    try {
      const targetWs = wsFilter !== "all" ? wsFilter : activeWorkspace?.id;
      const res = await api.createTask({ workspaceId: targetWs, draft: true });
      nav(`/t/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setCreating(false);
    }
  };

  const commitRename = async (id: string) => {
    const trimmed = editTitle.trim();
    setEditingId(null);
    if (!trimmed) return;
    try {
      await api.updateTask(id, { title: trimmed });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>{t("全部任务")}</h1>
          <Chip>{filtered.length}</Chip>
          <div className="grow" />
          <Button
            variant="primary"
            icon="plus"
            busy={creating}
            onClick={() => void handleNewTask()}
          >
            {t("新建任务")}
          </Button>
        </div>
        <p className="page-sub">查看、检索和管理所有工作区下的任务及其状态记忆版本。</p>

        <div className="filter-row">
          <div className="input-wrap" style={{ width: 280 }}>
            <Icon name="search" size={14} />
            <input
              className="input sm"
              placeholder="按标题或任务目标搜索…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <Select
            size="sm"
            className="w-180"
            icon="folder"
            value={wsFilter}
            options={[
              { value: "all", label: "全部工作区" },
              ...workspaces.map((w) => ({ value: w.id, label: w.name })),
            ]}
            onChange={setWsFilter}
          />

          <Select
            size="sm"
            className="w-180"
            icon="list"
            value={statusFilter}
            options={[
              { value: "all", label: "全部状态" },
              { value: "running", label: "执行中 / 待审批" },
              { value: "active", label: "待继续推进" },
              { value: "completed", label: "已完成" },
            ]}
            onChange={setStatusFilter}
          />
        </div>

        {filtered.length === 0 ? (
          <div className="panel">
            <div className="empty">
              <b>没有符合筛选条件的任务</b>
              试试清空筛选条件，或点击右上角「新建任务」。
            </div>
          </div>
        ) : (
          <div className="slist">
            <div className="slist-head">
              <span>任务名称</span>
              <span>工作区</span>
              <span>模型</span>
              <span>状态记忆 / 用量</span>
              <span>更新时间</span>
              <span />
            </div>

            {filtered.map((tk) => {
              const st = taskStatusDisplay(tk.status, t);
              const wsName =
                workspaces.find((w) => w.id === tk.workspaceId)?.name || "默认工作区";
              return (
                <div key={tk.id} className="srow" onClick={() => nav(`/t/${tk.id}`)}>
                  <div className="srow-title" onClick={(e) => editingId === tk.id && e.stopPropagation()}>
                    <span className={cx("sdot", st.dotClass)} style={{ marginTop: 0 }} />
                    {editingId === tk.id ? (
                      <input
                        autoFocus
                        className="input sm"
                        style={{ maxWidth: 320 }}
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => void commitRename(tk.id)}
                        onKeyDown={(e) => {
                          if (isPlainEnter(e)) void commitRename(tk.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <span className="truncate">{tk.title}</span>
                        <Status tone={st.tone}>{st.label}</Status>
                      </>
                    )}
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
                      icon="pencil"
                      title={t("重命名")}
                      onClick={() => {
                        setEditingId(tk.id);
                        setEditTitle(tk.title);
                      }}
                    />
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
