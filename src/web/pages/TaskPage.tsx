import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Status } from "../components/ui.js";
import { ApprovalPanel } from "../task/ApprovalPanel.js";
import { Composer } from "../task/Composer.js";
import { SemanticStatePanel } from "../task/SemanticStatePanel.js";
import { TranscriptView } from "../task/TranscriptView.js";
import { cx, isPlainEnter, relTime, taskStatusDisplay } from "../lib/format.js";

export function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const {
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    tasks,
    taskDetails,
    loadTaskDetail,
    statePanelOpen,
    setStatePanelOpen,
    toast,
    lang,
    t,
  } = useApp();

  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id) {
      void loadTaskDetail(id);
    }
  }, [id, loadTaskDetail]);

  const detail = id ? taskDetails[id] : undefined;
  const currentTask = detail?.task ?? tasks.find((tk) => tk.id === id);

  // Sync active workspace to match opened task
  useEffect(() => {
    if (currentTask?.workspaceId && currentTask.workspaceId !== activeWorkspace?.id) {
      setActiveWorkspaceId(currentTask.workspaceId);
    }
  }, [currentTask?.workspaceId]);

  // Auto-scroll transcript when new items stream in
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom || detail?.items.length === 1) {
      el.scrollTop = el.scrollHeight;
    }
  }, [detail?.items]);

  const workspaceId = currentTask?.workspaceId || activeWorkspace?.id || "";
  const wsTasks = useMemo(
    () => tasks.filter((tk) => !workspaceId || tk.workspaceId === workspaceId),
    [tasks, workspaceId]
  );

  const runningList = useMemo(
    () =>
      wsTasks.filter(
        (tk) => tk.status === "PULSING" || tk.status === "WAITING_APPROVAL"
      ),
    [wsTasks]
  );

  const otherList = useMemo(
    () =>
      wsTasks.filter(
        (tk) => tk.status !== "PULSING" && tk.status !== "WAITING_APPROVAL"
      ),
    [wsTasks]
  );

  const handleCreateNew = async () => {
    setCreating(true);
    try {
      const res = await api.createTask({ workspaceId, draft: true });
      nav(`/t/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setCreating(false);
    }
  };

  const handleSaveTitle = async () => {
    setRenamingTitle(false);
    const trimmed = titleDraft.trim();
    if (!currentTask || !trimmed || trimmed === currentTask.title) return;
    try {
      await api.updateTask(currentTask.id, { title: trimmed });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleDeleteTask = async (targetId: string) => {
    try {
      await api.deleteTask(targetId);
      if (targetId === id) {
        const next = wsTasks.find((x) => x.id !== targetId);
        nav(next ? `/t/${next.id}` : "/");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleQuickPrompt = async (promptText: string) => {
    if (!currentTask) return;
    try {
      await api.sendMessage(currentTask.id, { text: promptText });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const wsObj = workspaces.find((w) => w.id === workspaceId);
  const stDisplay = currentTask ? taskStatusDisplay(currentTask.status, t) : null;

  return (
    <div className="session-layout">
      {/* Left Column: Task List for Current Workspace */}
      <aside className="scol">
        <div className="scol-top">
          <Button
            variant="primary"
            icon="plus"
            busy={creating}
            style={{ width: "100%" }}
            onClick={() => void handleCreateNew()}
          >
            {t("新建任务")}
          </Button>
        </div>

        <div className="scol-list">
          {runningList.length > 0 && (
            <>
              <h5>
                <span>进行中</span>
                <span className="n">{runningList.length}</span>
              </h5>
              {runningList.map((tk) => {
                const st = taskStatusDisplay(tk.status, t);
                return (
                  <div
                    key={tk.id}
                    className={cx("scol-item", tk.id === id && "on")}
                    onClick={() => nav(`/t/${tk.id}`)}
                  >
                    <span className={cx("sdot", st.dotClass)} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="t truncate">{tk.title}</div>
                      <div className={cx("m", tk.status === "WAITING_APPROVAL" && "warn")}>
                        {st.label}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          <h5>
            <span>任务列表</span>
            <span className="n">{otherList.length}</span>
          </h5>
          {otherList.map((tk) => {
            const st = taskStatusDisplay(tk.status, t);
            return (
              <div
                key={tk.id}
                className={cx("scol-item", tk.id === id && "on")}
                onClick={() => nav(`/t/${tk.id}`)}
              >
                <span className={cx("sdot", st.dotClass)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t truncate">{tk.title}</div>
                  <div className="m">{relTime(tk.updatedAt, lang)}</div>
                </div>
                <div className="scol-acts" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    title={t("删除")}
                    onClick={() => void handleDeleteTask(tk.id)}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="scol-foot">
          <button type="button" className="link-btn" onClick={() => nav("/tasks")}>
            {t("全部任务 →")}
          </button>
        </div>
      </aside>

      {/* Center Column: Conversation Transcript + Approval Dock + Composer */}
      <section className="scenter">
        {!currentTask ? (
          <div className="loading-block">
            <span className="spinner" /> 正在加载任务…
          </div>
        ) : (
          <>
            <header className="shead">
              <div className="title grow">
                {renamingTitle ? (
                  <input
                    autoFocus
                    className="input sm"
                    style={{ maxWidth: 360 }}
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => void handleSaveTitle()}
                    onKeyDown={(e) => {
                      if (isPlainEnter(e)) void handleSaveTitle();
                      if (e.key === "Escape") setRenamingTitle(false);
                    }}
                  />
                ) : (
                  <>
                    <span className="truncate">{currentTask.title}</span>
                    <span
                      className="edit"
                      title={t("重命名")}
                      onClick={() => {
                        setTitleDraft(currentTask.title);
                        setRenamingTitle(true);
                      }}
                    >
                      <Icon name="pencil" size={13} />
                    </span>
                  </>
                )}
                {stDisplay && <Status tone={stDisplay.tone}>{stDisplay.label}</Status>}
              </div>

              {wsObj?.branch && (
                <Chip mono icon="branch">
                  {wsObj.branch}
                </Chip>
              )}

              {currentTask.status === "FAILED" && (
                <Button
                  size="sm"
                  icon="play"
                  onClick={() => void api.resumeTask(currentTask.id)}
                >
                  重试继续
                </Button>
              )}

              <Button
                variant={statePanelOpen ? "soft" : "default"}
                size="sm"
                icon="layers"
                onClick={() => setStatePanelOpen(!statePanelOpen)}
              >
                {t("状态记忆")}
              </Button>
            </header>

            <div ref={transcriptRef} className="transcript">
              <div className="transcript-inner">
                <TranscriptView
                  task={currentTask}
                  items={detail?.items ?? []}
                  onQuickPrompt={(p) => void handleQuickPrompt(p)}
                />
              </div>
            </div>

            <div className="dock">
              <div className="dock-inner">
                {detail && detail.approvals.length > 0 && (
                  <ApprovalPanel approvals={detail.approvals} />
                )}
                <Composer task={currentTask} />
              </div>
            </div>
          </>
        )}
      </section>

      {/* Right Column: Integrated Semantic State Viewer (状态记忆) */}
      {currentTask && statePanelOpen && (
        <SemanticStatePanel
          task={currentTask}
          states={detail?.states ?? (currentTask.latestState ? [currentTask.latestState] : [])}
          onClose={() => setStatePanelOpen(false)}
        />
      )}
    </div>
  );
}
