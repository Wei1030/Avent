import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { TaskProviderId, TaskRecord } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { resolveThoughtLevelsForSelection } from "../components/ModelPicker.js";
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
    ready,
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    tasks,
    taskDetails,
    loadTaskDetail,
    providers,
    endpoints,
    prefs,
    statePanelOpen,
    setStatePanelOpen,
    getNewTaskConfig,
    updateNewTaskConfig,
    recordTaskView,
    confirm,
    toast,
    lang,
    t,
  } = useApp();

  const isNewDraft = id === "new";

  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notFound, setNotFound] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNotFound(false);
    setRenamingTitle(false);
    if (id && id !== "new") {
      void loadTaskDetail(id).then((res) => {
        if (!res) setNotFound(true);
      });
    }
  }, [id, loadTaskDetail]);

  const detail = !isNewDraft && id ? taskDetails[id] : undefined;
  const loadedTask = !isNewDraft
    ? detail?.task ?? tasks.find((tk) => tk.id === id)
    : undefined;

  // Sync active workspace & remember last viewed task per workspace
  useEffect(() => {
    if (!isNewDraft && loadedTask) {
      if (loadedTask.workspaceId && loadedTask.workspaceId !== activeWorkspace?.id) {
        setActiveWorkspaceId(loadedTask.workspaceId);
      }
      if (loadedTask.workspaceId) {
        recordTaskView(loadedTask.workspaceId, loadedTask.id);
      }
    } else if (isNewDraft && activeWorkspace?.id) {
      recordTaskView(activeWorkspace.id, "new");
    }
  }, [isNewDraft, loadedTask?.id, loadedTask?.workspaceId, activeWorkspace?.id, setActiveWorkspaceId, recordTaskView]);

  // Auto-scroll transcript when new items stream in
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom || detail?.items.length === 1) {
      el.scrollTop = el.scrollHeight;
    }
  }, [detail?.items]);

  const workspaceId = (!isNewDraft ? loadedTask?.workspaceId : undefined) || activeWorkspace?.id || "";
  const wsObj = workspaces.find((w) => w.id === workspaceId);

  // Resolve virtual TaskRecord for ephemeral `/t/new` draft view
  const draftConfig = getNewTaskConfig(workspaceId);
  const virtualDraftTask = useMemo<TaskRecord>(() => {
    const providerId: TaskProviderId =
      draftConfig.providerId || prefs.defaultProviderId || providers[0]?.id || "agy";

    let modelId = draftConfig.modelId ?? "";
    if (!modelId) {
      if (providerId.startsWith("endpoint:")) {
        const ep = endpoints.find((e) => `endpoint:${e.id}` === providerId);
        modelId =
          (providerId === prefs.defaultProviderId &&
          prefs.defaultModelId &&
          ep?.models.some((m) => m.id === prefs.defaultModelId)
            ? prefs.defaultModelId
            : "") ||
          ep?.models[0]?.id ||
          "";
      } else {
        const prov = providers.find((p) => p.id === providerId);
        modelId =
          (providerId === prefs.defaultProviderId &&
          prefs.defaultModelId &&
          prov?.models.some((m) => m.value === prefs.defaultModelId)
            ? prefs.defaultModelId
            : "") ||
          prov?.defaultModel ||
          prov?.models[0]?.value ||
          "";
      }
    }

    const { levels, defaultLevel } = resolveThoughtLevelsForSelection(
      providers,
      endpoints,
      providerId,
      modelId
    );
    const candidateThought =
      draftConfig.thoughtLevel ??
      (providerId === prefs.defaultProviderId ? prefs.defaultThoughtLevel : "");
    const thoughtLevel =
      levels.length === 0
        ? ""
        : levels.some((l) => l.value === candidateThought)
          ? candidateThought
          : defaultLevel;

    return {
      id: "__new__",
      workspaceId,
      title: t("新任务"),
      titleSource: "auto",
      originalObjective: "",
      objectiveSource: "auto",
      completionCriteria: [],
      steeringDirectives: [],
      tags: [],
      cwd: wsObj?.path || "",
      providerId,
      modelId,
      thoughtLevel,
      permissionMode: draftConfig.permissionMode || prefs.defaultPermissionMode,
      pulseMode: "micro-stretch",
      status: "DRAFT",
      currentVersion: 0,
      pulseCount: 0,
      totalTokens: 0,
      latestState: null,
      createdAt: "",
      updatedAt: "",
    };
  }, [draftConfig, prefs, providers, endpoints, workspaceId, wsObj?.path, t]);

  const currentTask = isNewDraft ? virtualDraftTask : loadedTask;

  // Real persisted tasks in current workspace (never duplicate empty DRAFT rows)
  const wsTasks = useMemo(
    () =>
      tasks.filter(
        (tk) =>
          tk.status !== "DRAFT" && (!workspaceId || tk.workspaceId === workspaceId)
      ),
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

  // If no workspaces exist at all, show the zero-workspace onboarding view
  if (ready && workspaces.length === 0) {
    return <Navigate to="/" replace />;
  }

  // If URL pointed to a deleted/unknown task, fall back cleanly to latest task or new-task draft
  if (!isNewDraft && notFound && !loadedTask) {
    const fallback = wsTasks[0] ? `/t/${wsTasks[0].id}` : "/t/new";
    return <Navigate to={fallback} replace />;
  }

  const handleOpenNewDraft = () => {
    if (!isNewDraft) {
      nav("/t/new");
    }
  };

  const handleSaveTitle = async () => {
    setRenamingTitle(false);
    const trimmed = titleDraft.trim();
    if (isNewDraft || !currentTask || !trimmed || trimmed === currentTask.title) return;
    try {
      await api.updateTask(currentTask.id, { title: trimmed });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleDeleteTask = async (target: TaskRecord) => {
    const isRunning = target.status === "PULSING" || target.status === "WAITING_APPROVAL";
    const ok = await confirm({
      title: "删除任务",
      message: `确定要永久删除任务「${target.title}」吗？`,
      detail: isRunning
        ? "该任务正在运行，确认后将先中止执行，并永久删除其对话记录与状态记忆，此操作无法撤销。"
        : "将永久删除该任务的全部对话记录与状态记忆，此操作无法撤销。",
      confirmLabel: "确认删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTask(target.id);
      toast(`已删除任务：${target.title}`, "good");
      if (target.id === id) {
        const next = wsTasks.find((x) => x.id !== target.id);
        nav(next ? `/t/${next.id}` : "/t/new", { replace: true });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const stDisplay =
    !isNewDraft && currentTask ? taskStatusDisplay(currentTask.status, t) : null;

  const draftKey = isNewDraft
    ? `new:${workspaceId || "default"}`
    : currentTask?.id || "";

  return (
    <div className="session-layout">
      {/* Left Column: Task List for Current Workspace */}
      <aside className="scol">
        <div className="scol-top">
          <Button
            variant="primary"
            icon="plus"
            style={{ width: "100%" }}
            onClick={handleOpenNewDraft}
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
                    className={cx("scol-item", !isNewDraft && tk.id === id && "on")}
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

          {/* Single ephemeral "新任务" entry: visible ONLY while composing a new task; hides automatically when switching away */}
          {isNewDraft && (
            <div className="scol-item on">
              <span className="sdot idle" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t truncate">{t("新任务")}</div>
                <div className="m">草稿</div>
              </div>
            </div>
          )}

          {otherList.map((tk) => {
            const st = taskStatusDisplay(tk.status, t);
            return (
              <div
                key={tk.id}
                className={cx("scol-item", !isNewDraft && tk.id === id && "on")}
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
                    onClick={() => void handleDeleteTask(tk)}
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
                {!isNewDraft && renamingTitle ? (
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
                    {!isNewDraft && (
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
                    )}
                  </>
                )}
                {stDisplay && <Status tone={stDisplay.tone}>{stDisplay.label}</Status>}
              </div>

              {wsObj?.branch && (
                <Chip mono icon="branch">
                  {wsObj.branch}
                </Chip>
              )}

              {!isNewDraft && currentTask.status === "FAILED" && (
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
                  items={isNewDraft ? [] : detail?.items ?? []}
                />
              </div>
            </div>

            <div className="dock">
              <div className="dock-inner">
                {!isNewDraft && detail && detail.approvals.length > 0 && (
                  <ApprovalPanel approvals={detail.approvals} />
                )}
                <Composer
                  key={draftKey}
                  task={currentTask}
                  draftKey={draftKey}
                  isNewDraft={isNewDraft}
                  onDraftConfigChange={(patch) => updateNewTaskConfig(workspaceId, patch)}
                  onCreatedTask={(created) => {
                    if (created.workspaceId) {
                      recordTaskView(created.workspaceId, created.id);
                    }
                    void loadTaskDetail(created.id);
                    nav(`/t/${created.id}`, { replace: true });
                  }}
                />
              </div>
            </div>
          </>
        )}
      </section>

      {/* Right Column: Integrated Semantic State Viewer (状态记忆) */}
      {currentTask && statePanelOpen && (
        <SemanticStatePanel
          task={currentTask}
          states={
            isNewDraft
              ? []
              : detail?.states ?? (currentTask.latestState ? [currentTask.latestState] : [])
          }
          onClose={() => setStatePanelOpen(false)}
        />
      )}
    </div>
  );
}
