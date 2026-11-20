import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AppPreferences,
  ApprovalRequest,
  AttachmentItem,
  CompatibleEndpointRecord,
  LiveStreamEvent,
  PermissionMode,
  ProviderStatusInfo,
  TaskDetailResponse,
  TaskProviderId,
  TaskRecord,
  TaskRef,
  WorkspaceRecord,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { parseSourcePointer } from "../lib/format.js";
import { resolveEffectiveLang, translate } from "../lib/i18n.js";

export interface ToastItem {
  id: string;
  text: string;
  tone: "good" | "warn" | "crit";
}

export interface FilePreviewTarget {
  workspaceId: string;
  taskId?: string;
  pointer: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface ComposerDraft {
  text: string;
  attachments: AttachmentItem[];
  refs: TaskRef[];
}

export interface NewTaskConfig {
  providerId?: TaskProviderId;
  modelId?: string;
  thoughtLevel?: string;
  permissionMode?: PermissionMode;
  useWorktree?: boolean;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  checkbox?: {
    label: string;
    defaultChecked?: boolean;
  };
}

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  refs: [],
};

const DRAFTS_STORAGE_KEY = "avent.composerDrafts";
const LAST_TASK_STORAGE_KEY = "avent.lastTaskView";
const NEW_TASK_CFG_STORAGE_KEY = "avent.newTaskConfig";

function safeReadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // Ignore storage quota / private mode failures
  }
}

interface AppContextValue {
  ready: boolean;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string;
  activeWorkspace: WorkspaceRecord | null;
  setActiveWorkspaceId: (id: string) => void;
  tasks: TaskRecord[];
  approvals: ApprovalRequest[];
  providers: ProviderStatusInfo[];
  endpoints: CompatibleEndpointRecord[];
  prefs: AppPreferences;
  lang: "zh-CN" | "en";
  t: (key: string, vars?: Record<string, string | number>) => string;
  taskDetails: Record<string, TaskDetailResponse>;
  loadTaskDetail: (taskId: string) => Promise<TaskDetailResponse | null>;
  refreshBootstrap: () => Promise<{ workspaces: WorkspaceRecord[]; tasks: TaskRecord[] } | null>;
  updatePrefs: (patch: Partial<AppPreferences>) => Promise<void>;
  setProviders: (list: ProviderStatusInfo[]) => void;
  setEndpoints: (list: CompatibleEndpointRecord[]) => void;
  setWorkspaces: (list: WorkspaceRecord[]) => void;
  toast: (text: string, tone?: ToastItem["tone"]) => void;
  dismissToast: (id: string) => void;
  toasts: ToastItem[];
  folderPickerOpen: boolean;
  setFolderPickerOpen: (open: boolean) => void;
  filePreview: FilePreviewTarget | null;
  openFilePreview: (workspaceId: string, pointer: string, taskId?: string) => void;
  closeFilePreview: () => void;
  statePanelOpen: boolean;
  setStatePanelOpen: (open: boolean) => void;
  defaultWorktreesRoot: string;
  // Persistent per-task & new-task composer drafts
  getComposerDraft: (key: string) => ComposerDraft;
  setComposerDraft: (key: string, draft: ComposerDraft) => void;
  clearComposerDraft: (key: string) => void;
  // Per-workspace new-task model/thought/permission overrides
  getNewTaskConfig: (workspaceId: string) => NewTaskConfig;
  updateNewTaskConfig: (workspaceId: string, patch: Partial<NewTaskConfig>) => void;
  // Per-workspace last selected task view (taskId | "new")
  lastTaskViewByWs: Record<string, string>;
  recordTaskView: (workspaceId: string, view: string) => void;
  resolveWorkspaceTaskRoute: (workspaceId?: string, overrideTasks?: TaskRecord[]) => string;
  // In-app confirmation modal
  confirmState: ConfirmOptions | null;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmWithOption: (options: ConfirmOptions) => Promise<{ ok: boolean; checked: boolean }>;
  resolveConfirm: (accepted: boolean, checked?: boolean) => void;
}

const DEFAULT_PREFS: AppPreferences = {
  uiLanguage: "auto",
  defaultProviderId: "agy",
  defaultModelId: "",
  defaultThoughtLevel: "",
  defaultPermissionMode: "bypassPermissions",
  desktopNotifications: true,
};

const AppCtx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [workspaces, setWorkspacesState] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWsState] = useState<string>(
    () => localStorage.getItem("avent.activeWs") || ""
  );
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [providers, setProviders] = useState<ProviderStatusInfo[]>([]);
  const [endpoints, setEndpoints] = useState<CompatibleEndpointRecord[]>([]);
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULT_PREFS);
  const [taskDetails, setTaskDetails] = useState<Record<string, TaskDetailResponse>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [filePreview, setFilePreview] = useState<FilePreviewTarget | null>(null);
  const [defaultWorktreesRoot, setDefaultWorktreesRoot] = useState("");
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null);
  const confirmResolverRef = useRef<((res: { ok: boolean; checked: boolean }) => void) | null>(null);
  const [statePanelOpen, setStatePanelOpenState] = useState<boolean>(
    () => localStorage.getItem("avent.statePanelOpen") !== "false"
  );

  const confirmWithOption = useCallback(
    (options: ConfirmOptions): Promise<{ ok: boolean; checked: boolean }> => {
      if (confirmResolverRef.current) {
        confirmResolverRef.current({ ok: false, checked: false });
        confirmResolverRef.current = null;
      }
      setConfirmState(options);
      return new Promise<{ ok: boolean; checked: boolean }>((resolve) => {
        confirmResolverRef.current = resolve;
      });
    },
    []
  );

  const confirm = useCallback(
    async (options: ConfirmOptions): Promise<boolean> => {
      const res = await confirmWithOption(options);
      return res.ok;
    },
    [confirmWithOption]
  );

  const resolveConfirm = useCallback((accepted: boolean, checked = false) => {
    const fn = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    fn?.({ ok: accepted, checked });
  }, []);

  // Ref-backed composer drafts (zero app-wide re-renders while typing, always synchronously persisted)
  const draftsRef = useRef<Record<string, ComposerDraft>>(
    safeReadJson<Record<string, ComposerDraft>>(DRAFTS_STORAGE_KEY, {})
  );

  const [newTaskConfigByWs, setNewTaskConfigByWs] = useState<Record<string, NewTaskConfig>>(() =>
    safeReadJson<Record<string, NewTaskConfig>>(NEW_TASK_CFG_STORAGE_KEY, {})
  );

  const [lastTaskViewByWs, setLastTaskViewByWs] = useState<Record<string, string>>(() =>
    safeReadJson<Record<string, string>>(LAST_TASK_STORAGE_KEY, {})
  );

  const setWorkspaces = useCallback((list: WorkspaceRecord[]) => {
    setWorkspacesState(list);
    setActiveWsState((cur) => {
      if (cur && list.some((w) => w.id === cur)) return cur;
      const next = list[0]?.id ?? "";
      if (next) localStorage.setItem("avent.activeWs", next);
      else localStorage.removeItem("avent.activeWs");
      return next;
    });
  }, []);

  const setStatePanelOpen = useCallback((open: boolean) => {
    setStatePanelOpenState(open);
    localStorage.setItem("avent.statePanelOpen", String(open));
  }, []);

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveWsState(id);
    if (id) localStorage.setItem("avent.activeWs", id);
    else localStorage.removeItem("avent.activeWs");
  }, []);

  const getComposerDraft = useCallback((key: string): ComposerDraft => {
    const found = draftsRef.current[key];
    if (!found) return EMPTY_DRAFT;
    return {
      text: typeof found.text === "string" ? found.text : "",
      attachments: Array.isArray(found.attachments) ? found.attachments : [],
      refs: Array.isArray(found.refs) ? found.refs : [],
    };
  }, []);

  const setComposerDraft = useCallback((key: string, draft: ComposerDraft) => {
    if (!key) return;
    const isEmpty =
      !draft.text && draft.attachments.length === 0 && draft.refs.length === 0;
    if (isEmpty) {
      if (key in draftsRef.current) {
        delete draftsRef.current[key];
        safeWriteJson(DRAFTS_STORAGE_KEY, draftsRef.current);
      }
      return;
    }
    draftsRef.current[key] = draft;
    safeWriteJson(DRAFTS_STORAGE_KEY, draftsRef.current);
  }, []);

  const clearComposerDraft = useCallback((key: string) => {
    if (!key || !(key in draftsRef.current)) return;
    delete draftsRef.current[key];
    safeWriteJson(DRAFTS_STORAGE_KEY, draftsRef.current);
  }, []);

  const getNewTaskConfig = useCallback(
    (workspaceId: string): NewTaskConfig => {
      return newTaskConfigByWs[workspaceId || "default"] ?? {};
    },
    [newTaskConfigByWs]
  );

  const updateNewTaskConfig = useCallback(
    (workspaceId: string, patch: Partial<NewTaskConfig>) => {
      const wsKey = workspaceId || "default";
      setNewTaskConfigByWs((prev) => {
        const next = {
          ...prev,
          [wsKey]: {
            ...(prev[wsKey] ?? {}),
            ...patch,
          },
        };
        safeWriteJson(NEW_TASK_CFG_STORAGE_KEY, next);
        return next;
      });
    },
    []
  );

  const recordTaskView = useCallback((workspaceId: string, view: string) => {
    if (!workspaceId || !view) return;
    setLastTaskViewByWs((prev) => {
      if (prev[workspaceId] === view) return prev;
      const next = { ...prev, [workspaceId]: view };
      safeWriteJson(LAST_TASK_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const toast = useCallback((text: string, tone: ToastItem["tone"] = "good") => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3600);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const refreshBootstrap = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setWorkspaces(data.workspaces);
      setTasks(data.tasks);
      setApprovals(data.approvals);
      setProviders(data.providers);
      setEndpoints(data.endpoints ?? []);
      setPrefs(data.prefs);
      if (data.defaultWorktreesRoot) {
        setDefaultWorktreesRoot(data.defaultWorktreesRoot);
      }
      return { workspaces: data.workspaces, tasks: data.tasks };
    } catch {
      return null;
    } finally {
      setReady(true);
    }
  }, [setWorkspaces]);

  const loadTaskDetail = useCallback(async (taskId: string) => {
    try {
      const detail = await api.getTaskDetail(taskId);
      setTaskDetails((prev) => ({ ...prev, [taskId]: detail }));
      setTasks((prev) => {
        const exists = prev.some((t) => t.id === taskId);
        return exists
          ? prev.map((t) => (t.id === taskId ? detail.task : t))
          : [detail.task, ...prev];
      });
      return detail;
    } catch {
      return null;
    }
  }, []);

  const updatePrefs = useCallback(async (patch: Partial<AppPreferences>) => {
    const res = await api.savePrefs(patch);
    setPrefs(res.prefs);
  }, []);

  const openFilePreview = useCallback(
    (workspaceId: string, pointer: string, taskId?: string) => {
      const parsed = parseSourcePointer(pointer);
      setFilePreview({
        workspaceId,
        taskId,
        pointer,
        filePath: parsed.filePath,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
      });
    },
    []
  );

  const closeFilePreview = useCallback(() => setFilePreview(null), []);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  // Connect real-time SSE stream
  useEffect(() => {
    const es = new EventSource("/api/stream");

    const onAvent = (raw: MessageEvent) => {
      let ev: LiveStreamEvent;
      try {
        ev = JSON.parse(raw.data) as LiveStreamEvent;
      } catch {
        return;
      }

      switch (ev.type) {
        case "workspace_updated":
          setWorkspaces(ev.workspaces);
          break;

        case "providers_updated":
          setProviders(ev.providers);
          break;

        case "endpoints_updated":
          setEndpoints(ev.endpoints);
          break;

        case "task_updated": {
          setTasks((prev) => {
            const exists = prev.some((x) => x.id === ev.task.id);
            const next = exists
              ? prev.map((x) => (x.id === ev.task.id ? ev.task : x))
              : [ev.task, ...prev];
            return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          });
          setTaskDetails((prev) => {
            const cur = prev[ev.task.id];
            return cur ? { ...prev, [ev.task.id]: { ...cur, task: ev.task } } : prev;
          });
          break;
        }

        case "task_deleted": {
          setTasks((prev) => prev.filter((x) => x.id !== ev.taskId));
          setApprovals((prev) => prev.filter((a) => a.taskId !== ev.taskId));
          setTaskDetails((prev) => {
            const copy = { ...prev };
            delete copy[ev.taskId];
            return copy;
          });
          clearComposerDraft(ev.taskId);
          setLastTaskViewByWs((prev) => {
            let changed = false;
            const copy = { ...prev };
            for (const [wsId, v] of Object.entries(copy)) {
              if (v === ev.taskId) {
                delete copy[wsId];
                changed = true;
              }
            }
            if (changed) safeWriteJson(LAST_TASK_STORAGE_KEY, copy);
            return changed ? copy : prev;
          });
          break;
        }

        case "item_upserted": {
          setTaskDetails((prev) => {
            const cur = prev[ev.taskId];
            if (!cur) return prev;
            const idx = cur.items.findIndex((it) => it.id === ev.item.id);
            const nextItems =
              idx >= 0
                ? cur.items.map((it, i) => (i === idx ? ev.item : it))
                : [...cur.items, ev.item];
            return { ...prev, [ev.taskId]: { ...cur, items: nextItems } };
          });
          break;
        }

        case "state_committed": {
          setTaskDetails((prev) => {
            const cur = prev[ev.taskId];
            if (!cur) return prev;
            const exists = cur.states.some((s) => s.version === ev.state.version);
            const nextStates = exists
              ? cur.states.map((s) => (s.version === ev.state.version ? ev.state : s))
              : [...cur.states, ev.state];
            return { ...prev, [ev.taskId]: { ...cur, states: nextStates } };
          });
          break;
        }

        case "approval_requested": {
          setApprovals((prev) => [
            ...prev.filter((a) => a.id !== ev.approval.id),
            ev.approval,
          ]);
          setTaskDetails((prev) => {
            const cur = prev[ev.approval.taskId];
            if (!cur) return prev;
            return {
              ...prev,
              [ev.approval.taskId]: {
                ...cur,
                approvals: [
                  ...cur.approvals.filter((a) => a.id !== ev.approval.id),
                  ev.approval,
                ],
              },
            };
          });
          break;
        }

        case "approval_resolved": {
          setApprovals((prev) => prev.filter((a) => a.id !== ev.approvalId));
          setTaskDetails((prev) => {
            const cur = prev[ev.taskId];
            if (!cur) return prev;
            return {
              ...prev,
              [ev.taskId]: {
                ...cur,
                approvals: cur.approvals.filter((a) => a.id !== ev.approvalId),
              },
            };
          });
          break;
        }

        default:
          break;
      }
    };

    es.addEventListener("avent", onAvent as EventListener);
    return () => {
      es.removeEventListener("avent", onAvent as EventListener);
      es.close();
    };
  }, [setWorkspaces, clearComposerDraft]);

  const lang = useMemo(() => resolveEffectiveLang(prefs.uiLanguage), [prefs.uiLanguage]);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang]
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, activeWorkspaceId]
  );

  const resolveWorkspaceTaskRoute = useCallback(
    (workspaceId?: string, overrideTasks?: TaskRecord[]): string => {
      const wsId = workspaceId || activeWorkspace?.id || workspaces[0]?.id || "";
      if (!wsId) return "/";
      const pool = overrideTasks ?? tasks;
      const wsRealTasks = pool.filter(
        (tk) => tk.workspaceId === wsId && tk.status !== "DRAFT"
      );
      const last = lastTaskViewByWs[wsId];
      if (last === "new") return "/t/new";
      if (last && wsRealTasks.some((tk) => tk.id === last)) {
        return `/t/${last}`;
      }
      if (wsRealTasks.length > 0) {
        return `/t/${wsRealTasks[0].id}`;
      }
      return "/t/new";
    },
    [activeWorkspace?.id, workspaces, tasks, lastTaskViewByWs]
  );

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      workspaces,
      activeWorkspaceId: activeWorkspace?.id ?? "",
      activeWorkspace,
      setActiveWorkspaceId,
      tasks,
      approvals,
      providers,
      endpoints,
      prefs,
      lang,
      t,
      taskDetails,
      loadTaskDetail,
      refreshBootstrap,
      updatePrefs,
      setProviders,
      setEndpoints,
      setWorkspaces,
      toast,
      dismissToast,
      toasts,
      folderPickerOpen,
      setFolderPickerOpen,
      filePreview,
      openFilePreview,
      closeFilePreview,
      statePanelOpen,
      setStatePanelOpen,
      defaultWorktreesRoot,
      getComposerDraft,
      setComposerDraft,
      clearComposerDraft,
      getNewTaskConfig,
      updateNewTaskConfig,
      lastTaskViewByWs,
      recordTaskView,
      resolveWorkspaceTaskRoute,
      confirmState,
      confirm,
      confirmWithOption,
      resolveConfirm,
    }),
    [
      ready,
      workspaces,
      activeWorkspace,
      setActiveWorkspaceId,
      tasks,
      approvals,
      providers,
      endpoints,
      prefs,
      lang,
      t,
      taskDetails,
      loadTaskDetail,
      refreshBootstrap,
      updatePrefs,
      setWorkspaces,
      toast,
      dismissToast,
      toasts,
      folderPickerOpen,
      filePreview,
      openFilePreview,
      closeFilePreview,
      statePanelOpen,
      setStatePanelOpen,
      defaultWorktreesRoot,
      getComposerDraft,
      setComposerDraft,
      clearComposerDraft,
      getNewTaskConfig,
      updateNewTaskConfig,
      lastTaskViewByWs,
      recordTaskView,
      resolveWorkspaceTaskRoute,
      confirmState,
      confirm,
      confirmWithOption,
      resolveConfirm,
    ]
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
