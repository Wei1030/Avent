import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  AppPreferences,
  ApprovalRequest,
  CompatibleEndpointRecord,
  LiveStreamEvent,
  ProviderStatusInfo,
  TaskDetailResponse,
  TaskRecord,
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
  pointer: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
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
  refreshBootstrap: () => Promise<void>;
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
  openFilePreview: (workspaceId: string, pointer: string) => void;
  closeFilePreview: () => void;
  statePanelOpen: boolean;
  setStatePanelOpen: (open: boolean) => void;
}

const DEFAULT_PREFS: AppPreferences = {
  uiLanguage: "auto",
  defaultProviderId: "agy",
  defaultModelId: "",
  defaultThoughtLevel: "",
  defaultPermissionMode: "acceptEdits",
  desktopNotifications: true,
};

const AppCtx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
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
  const [statePanelOpen, setStatePanelOpenState] = useState<boolean>(
    () => localStorage.getItem("avent.statePanelOpen") !== "false"
  );

  const setStatePanelOpen = useCallback((open: boolean) => {
    setStatePanelOpenState(open);
    localStorage.setItem("avent.statePanelOpen", String(open));
  }, []);

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveWsState(id);
    if (id) localStorage.setItem("avent.activeWs", id);
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
      setActiveWsState((cur) => {
        if (cur && data.workspaces.some((w) => w.id === cur)) return cur;
        return data.workspaces[0]?.id ?? "";
      });
    } finally {
      setReady(true);
    }
  }, []);

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

  const openFilePreview = useCallback((workspaceId: string, pointer: string) => {
    const parsed = parseSourcePointer(pointer);
    setFilePreview({
      workspaceId,
      pointer,
      filePath: parsed.filePath,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
    });
  }, []);

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
  }, []);

  const lang = useMemo(() => resolveEffectiveLang(prefs.uiLanguage), [prefs.uiLanguage]);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang]
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, activeWorkspaceId]
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
      toast,
      dismissToast,
      toasts,
      folderPickerOpen,
      filePreview,
      openFilePreview,
      closeFilePreview,
      statePanelOpen,
      setStatePanelOpen,
    ]
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
