import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { TaskProviderId, TaskRecord } from "../../shared/types.js";
import { api } from "../api/client.js";
import { INITIAL_TRANSCRIPT_PAGE_SIZE, useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { resolveThoughtLevelsForSelection } from "../components/ModelPicker.js";
import { Button, Chip, Status } from "../components/ui.js";
import { ApprovalPanel } from "../task/ApprovalPanel.js";
import { Composer } from "../task/Composer.js";
import { SemanticStatePanel } from "../task/SemanticStatePanel.js";
import { TranscriptView } from "../task/TranscriptView.js";
import { WorktreeBar } from "../task/WorktreeBar.js";
import { cx, isPlainEnter, relTime, taskStatusDisplay } from "../lib/format.js";

const BOTTOM_STICKY_THRESHOLD = 32;
const TOP_LOAD_MORE_THRESHOLD = 120;
const JUMP_BOTTOM_SHOW_THRESHOLD = 240;

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
    loadOlderTaskItems,
    getTaskScrollState,
    saveTaskScrollState,
    providers,
    endpoints,
    prefs,
    statePanelOpen,
    setStatePanelOpen,
    getNewTaskConfig,
    updateNewTaskConfig,
    recordTaskView,
    confirmWithOption,
    toast,
    lang,
    t,
  } = useApp();

  const isNewDraft = id === "new";

  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptInnerRef = useRef<HTMLDivElement>(null);
  const isStickyBottomRef = useRef(true);
  const restoredForTaskRef = useRef<string | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticRafRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const pendingPrependRef = useRef<{
    taskId: string;
    prevScrollHeight: number;
    prevScrollTop: number;
  } | null>(null);

  const detail = !isNewDraft && id ? taskDetails[id] : undefined;
  const loadedTask = !isNewDraft
    ? detail?.task ?? tasks.find((tk) => tk.id === id)
    : undefined;

  const setScrollTopProgrammatic = useCallback((el: HTMLDivElement, top: number) => {
    programmaticScrollRef.current = true;
    el.scrollTop = top;
    if (programmaticRafRef.current !== null) {
      cancelAnimationFrame(programmaticRafRef.current);
    }
    programmaticRafRef.current = requestAnimationFrame(() => {
      programmaticRafRef.current = null;
      programmaticScrollRef.current = false;
    });
  }, []);

  const markUserScrollIntent = useCallback(() => {
    if (programmaticRafRef.current !== null) {
      cancelAnimationFrame(programmaticRafRef.current);
      programmaticRafRef.current = null;
    }
    programmaticScrollRef.current = false;
  }, []);

  const captureAndSaveScroll = useCallback(
    (taskId: string, loadedCount: number) => {
      const el = transcriptRef.current;
      if (!el || !taskId) return;
      const distFromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      const atBottom = distFromBottom <= BOTTOM_STICKY_THRESHOLD;
      let anchorBlockKey: string | undefined;
      let anchorOffset: number | undefined;
      if (!atBottom) {
        const containerRect = el.getBoundingClientRect();
        const blocks = el.querySelectorAll<HTMLElement>("[data-block-key]");
        for (const blk of blocks) {
          const r = blk.getBoundingClientRect();
          if (r.bottom > containerRect.top + 4) {
            anchorBlockKey = blk.dataset.blockKey;
            anchorOffset = containerRect.top - r.top;
            break;
          }
        }
      }
      saveTaskScrollState(taskId, {
        atBottom,
        scrollTop: el.scrollTop,
        loadedCount,
        anchorBlockKey,
        anchorOffset,
        updatedAt: Date.now(),
      });
    },
    [saveTaskScrollState]
  );

  useEffect(() => {
    return () => {
      if (programmaticRafRef.current !== null) {
        cancelAnimationFrame(programmaticRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setNotFound(false);
    setRenamingTitle(false);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    pendingPrependRef.current = null;
    if (isNewDraft || !id) {
      restoredForTaskRef.current = null;
      isStickyBottomRef.current = true;
      setShowJumpToBottom(false);
      return;
    }
    if (restoredForTaskRef.current !== id) {
      const saved = getTaskScrollState(id);
      isStickyBottomRef.current = !saved || saved.atBottom;
      setShowJumpToBottom(false);
    }
    void loadTaskDetail(id).then((res) => {
      if (!res) setNotFound(true);
    });
  }, [id, isNewDraft, loadTaskDetail, getTaskScrollState]);

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

  const handleLoadOlder = useCallback(async () => {
    if (isNewDraft || !id || loadingOlderRef.current) return;
    if (!detail?.itemsMeta?.hasMore) return;
    const el = transcriptRef.current;
    if (!el) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    pendingPrependRef.current = {
      taskId: id,
      prevScrollHeight: el.scrollHeight,
      prevScrollTop: el.scrollTop,
    };
    try {
      const res = await loadOlderTaskItems(id);
      if (res.addedCount === 0) {
        pendingPrependRef.current = null;
      }
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [isNewDraft, id, detail?.itemsMeta?.hasMore, loadOlderTaskItems]);

  const scrollToBottomNow = useCallback(() => {
    const el = transcriptRef.current;
    isStickyBottomRef.current = true;
    setShowJumpToBottom(false);
    if (el) {
      setScrollTopProgrammatic(el, el.scrollHeight);
      if (!isNewDraft && id) {
        captureAndSaveScroll(id, detail?.items.length ?? 0);
      }
    }
  }, [isNewDraft, id, detail?.items.length, setScrollTopProgrammatic, captureAndSaveScroll]);

  // Synchronously handle: (1) prepend scroll compensation, (2) per-task scroll restoration, (3) sticky auto-scroll
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (isNewDraft || !id || !detail || !el) return;

    // 1. Compensate scrollTop when older history items are prepended above the viewport
    if (pendingPrependRef.current && pendingPrependRef.current.taskId === id) {
      const { prevScrollHeight, prevScrollTop } = pendingPrependRef.current;
      if (el.scrollHeight !== prevScrollHeight) {
        const delta = el.scrollHeight - prevScrollHeight;
        pendingPrependRef.current = null;
        setScrollTopProgrammatic(el, Math.max(0, prevScrollTop + delta));
        captureAndSaveScroll(id, detail.items.length);
        return;
      }
    }

    // 2. Restore saved scroll position when opening/switching to this task
    if (restoredForTaskRef.current !== id) {
      const saved = getTaskScrollState(id);
      if (!saved || saved.atBottom) {
        isStickyBottomRef.current = true;
        setShowJumpToBottom(false);
        setScrollTopProgrammatic(el, el.scrollHeight);
      } else {
        isStickyBottomRef.current = false;
        let targetTop: number | null = null;
        if (saved.anchorBlockKey) {
          const escaped =
            typeof CSS !== "undefined" && typeof CSS.escape === "function"
              ? CSS.escape(saved.anchorBlockKey)
              : saved.anchorBlockKey.replace(/"/g, '\\"');
          const anchorEl = el.querySelector<HTMLElement>(`[data-block-key="${escaped}"]`);
          if (anchorEl) {
            const containerRect = el.getBoundingClientRect();
            const rect = anchorEl.getBoundingClientRect();
            targetTop = Math.max(
              0,
              el.scrollTop + (rect.top - containerRect.top) + (saved.anchorOffset ?? 0)
            );
          }
        }
        if (targetTop === null) {
          targetTop = Math.min(
            Math.max(0, saved.scrollTop),
            Math.max(0, el.scrollHeight - el.clientHeight)
          );
        }
        setScrollTopProgrammatic(el, targetTop);
        const dist = el.scrollHeight - targetTop - el.clientHeight;
        setShowJumpToBottom(dist > JUMP_BOTTOM_SHOW_THRESHOLD);
      }
      restoredForTaskRef.current = id;
      return;
    }

    // 3. Stick to bottom when new items / streaming chunks arrive, ONLY if user is already at bottom
    if (isStickyBottomRef.current) {
      setScrollTopProgrammatic(el, el.scrollHeight);
    }
  }, [isNewDraft, id, detail, getTaskScrollState, setScrollTopProgrammatic, captureAndSaveScroll]);

  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el || isNewDraft || !id) return;
    if (restoredForTaskRef.current !== id || pendingPrependRef.current) return;
    if (programmaticScrollRef.current) return;

    const distFromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    const nowAtBottom = distFromBottom <= BOTTOM_STICKY_THRESHOLD;
    isStickyBottomRef.current = nowAtBottom;
    setShowJumpToBottom(!nowAtBottom && distFromBottom > JUMP_BOTTOM_SHOW_THRESHOLD);
    captureAndSaveScroll(id, detail?.items.length ?? 0);

    if (
      el.scrollTop <= TOP_LOAD_MORE_THRESHOLD &&
      detail?.itemsMeta?.hasMore &&
      !loadingOlderRef.current
    ) {
      void handleLoadOlder();
    }
  }, [isNewDraft, id, detail?.items.length, detail?.itemsMeta?.hasMore, captureAndSaveScroll, handleLoadOlder]);

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
  const hasCurrentTask = Boolean(currentTask);

  // Keep transcript pinned to bottom on streaming text growth / dock resize when user is at bottom
  useEffect(() => {
    const el = transcriptRef.current;
    const inner = transcriptInnerRef.current;
    if (isNewDraft || !id || !hasCurrentTask || !el || !inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => {
      if (
        restoredForTaskRef.current === id &&
        isStickyBottomRef.current &&
        !pendingPrependRef.current
      ) {
        setScrollTopProgrammatic(el, el.scrollHeight);
      }
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isNewDraft, id, hasCurrentTask, setScrollTopProgrammatic]);

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
    const hasActiveWt = Boolean(target.worktreePath && !target.worktreeRemoved);
    const baseDetail = isRunning
      ? "该任务正在运行，确认后将先中止执行，并永久删除其对话记录与状态记忆，此操作无法撤销。"
      : "将永久删除该任务的全部对话记录与状态记忆，此操作无法撤销。";
    const wtDetail = hasActiveWt
      ? `\n\n该任务绑定了独立工作树分支 ${target.worktreeBranch || ""}${target.worktreeMergedAt ? "（已合回主分支）" : "（若尚未合回，勾选清理将一并删除未合并分支）"}。`
      : "";

    const { ok, checked } = await confirmWithOption({
      title: "删除任务",
      message: `确定要永久删除任务「${target.title}」吗？`,
      detail: `${baseDetail}${wtDetail}`,
      confirmLabel: "确认删除",
      danger: true,
      checkbox: hasActiveWt
        ? {
            label: `同时清理独立工作树目录与分支 (${target.worktreeBranch || ""})`,
            defaultChecked: Boolean(target.worktreeMergedAt),
          }
        : undefined,
    });
    if (!ok) return;
    try {
      await api.deleteTask(target.id, { cleanupWorktree: hasActiveWt && checked });
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
                      <div className={cx("m row", tk.status === "WAITING_APPROVAL" && "warn")} style={{ gap: 4 }}>
                        <span>{st.label}</span>
                        {tk.worktreeBranch && !tk.worktreeRemoved && (
                          <Icon name="branch" size={11} className="accent" />
                        )}
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
                  <div className="m row" style={{ gap: 4 }}>
                    <span>{relTime(tk.updatedAt, lang)}</span>
                    {tk.worktreeBranch && !tk.worktreeRemoved && (
                      <span
                        className="accent mono truncate"
                        style={{ fontSize: 10.5 }}
                        title={`独立工作树分支：${tk.worktreeBranch}`}
                      >
                        · {tk.worktreeBranch.replace(/^avent\//, "")}
                      </span>
                    )}
                  </div>
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

              {wsObj?.branch && (!currentTask.worktreePath || currentTask.worktreeRemoved) && (
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

            {!isNewDraft && <WorktreeBar task={currentTask} />}

            <div className="transcript-wrap">
              <div
                key={isNewDraft ? "new" : id || "none"}
                ref={transcriptRef}
                className="transcript"
                onScroll={handleTranscriptScroll}
                onWheel={markUserScrollIntent}
                onTouchStart={markUserScrollIntent}
                onPointerDown={markUserScrollIntent}
              >
                <div ref={transcriptInnerRef} className="transcript-inner">
                  {!isNewDraft && detail?.itemsMeta && (
                    detail.itemsMeta.hasMore ? (
                      <div className="history-loader">
                        {loadingOlder ? (
                          <span className="row" style={{ gap: 6 }}>
                            <span className="spinner" />
                            <span>正在加载更早的历史记录…</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="history-loader-btn"
                            onClick={() => void handleLoadOlder()}
                          >
                            上滑或点击加载更早记录（已显示 {detail.items.length} /{" "}
                            {detail.itemsMeta.totalCount} 条）
                          </button>
                        )}
                      </div>
                    ) : detail.itemsMeta.totalCount > INITIAL_TRANSCRIPT_PAGE_SIZE ? (
                      <div className="history-loader done">
                        已加载全部 {detail.itemsMeta.totalCount} 条历史记录
                      </div>
                    ) : null
                  )}
                  {!isNewDraft && !detail ? (
                    <div className="loading-block">
                      <span className="spinner" /> 正在加载对话记录…
                    </div>
                  ) : (
                    <TranscriptView
                      task={currentTask}
                      items={isNewDraft ? [] : detail?.items ?? []}
                    />
                  )}
                </div>
              </div>

              {!isNewDraft && showJumpToBottom && (
                <button
                  type="button"
                  className="jump-bottom-btn"
                  onClick={scrollToBottomNow}
                  title="回到底部并恢复自动滚动"
                >
                  <Icon name="chevDown" size={14} />
                  <span>回到底部</span>
                </button>
              )}
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
                  useWorktree={Boolean(draftConfig.useWorktree && wsObj?.isGitRepo)}
                  onDraftConfigChange={(patch) => updateNewTaskConfig(workspaceId, patch)}
                  onMessageSent={scrollToBottomNow}
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
