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
  ProviderQuotaSnapshot,
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

export interface TaskScrollState {
  atBottom: boolean;
  scrollTop: number;
  loadedCount: number;
  anchorBlockKey?: string;
  anchorOffset?: number;
  updatedAt: number;
}

export const INITIAL_TRANSCRIPT_PAGE_SIZE = 60;
export const OLDER_TRANSCRIPT_PAGE_SIZE = 60;
const MAX_RESTORE_ITEMS_LIMIT = 400;
const MAX_STORED_SCROLL_TASKS = 80;

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
const SCROLL_STATES_STORAGE_KEY = "avent.taskScrollStates";

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
  quotas: ProviderQuotaSnapshot[];
  setQuotas: (list: ProviderQuotaSnapshot[]) => void;
  prefs: AppPreferences;
  lang: "zh-CN" | "en";
  t: (key: string, vars?: Record<string, string | number>) => string;
  taskDetails: Record<string, TaskDetailResponse>;
  loadTaskDetail: (
    taskId: string,
    opts?: { force?: boolean; limit?: number }
  ) => Promise<TaskDetailResponse | null>;
  loadOlderTaskItems: (
    taskId: string
  ) => Promise<{ addedCount: number; hasMore: boolean }>;
  // Per-task transcript scroll position memory
  getTaskScrollState: (taskId: string) => TaskScrollState | null;
  saveTaskScrollState: (taskId: string, state: TaskScrollState) => void;
  clearTaskScrollState: (taskId: string) => void;
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
  contextNetTokenLimit: 14000,
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
  const [quotas, setQuotas] = useState<ProviderQuotaSnapshot[]>([]);
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULT_PREFS);
  const [taskDetails, setTaskDetails] = useState<Record<string, TaskDetailResponse>>({});
  const taskDetailsRef = useRef<Record<string, TaskDetailResponse>>({});
  taskDetailsRef.current = taskDetails;
  const inflightDetailRef = useRef<Map<string, Promise<TaskDetailResponse | null>>>(new Map());
  const inflightOlderRef = useRef<Set<string>>(new Set());

  const scrollStatesRef = useRef<Record<string, TaskScrollState>>(
    safeReadJson<Record<string, TaskScrollState>>(SCROLL_STATES_STORAGE_KEY, {})
  );
  const scrollSaveTimerRef = useRef<number | null>(null);

  const flushScrollStates = useCallback(() => {
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    const entries = Object.entries(scrollStatesRef.current);
    if (entries.length > MAX_STORED_SCROLL_TASKS) {
      entries.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0));
      scrollStatesRef.current = Object.fromEntries(entries.slice(0, MAX_STORED_SCROLL_TASKS));
    }
    safeWriteJson(SCROLL_STATES_STORAGE_KEY, scrollStatesRef.current);
  }, []);

  useEffect(() => {
    const onHide = () => flushScrollStates();
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("pagehide", onHide);
      flushScrollStates();
    };
  }, [flushScrollStates]);

  const getTaskScrollState = useCallback((taskId: string): TaskScrollState | null => {
    if (!taskId) return null;
    return scrollStatesRef.current[taskId] ?? null;
  }, []);

  const saveTaskScrollState = useCallback(
    (taskId: string, state: TaskScrollState) => {
      if (!taskId) return;
      scrollStatesRef.current[taskId] = state;
      if (scrollSaveTimerRef.current === null) {
        scrollSaveTimerRef.current = window.setTimeout(() => {
          flushScrollStates();
        }, 160);
      }
    },
    [flushScrollStates]
  );

  const clearTaskScrollState = useCallback(
    (taskId: string) => {
      if (!taskId || !(taskId in scrollStatesRef.current)) return;
      delete scrollStatesRef.current[taskId];
      flushScrollStates();
    },
    [flushScrollStates]
  );
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

  const loadTaskDetail = useCallback(
    async (taskId: string, opts?: { force?: boolean; limit?: number }) => {
      if (!taskId) return null;
      const cached = taskDetailsRef.current[taskId];
      if (cached && !opts?.force) {
        return cached;
      }
      const existingReq = inflightDetailRef.current.get(taskId);
      if (existingReq && !opts?.force) {
        return existingReq;
      }

      const savedScroll = scrollStatesRef.current[taskId];
      const desiredLimit =
        opts?.limit && opts.limit > 0
          ? opts.limit
          : cached && cached.items.length > INITIAL_TRANSCRIPT_PAGE_SIZE
            ? Math.min(MAX_RESTORE_ITEMS_LIMIT, cached.items.length)
            : savedScroll && !savedScroll.atBottom && savedScroll.loadedCount > INITIAL_TRANSCRIPT_PAGE_SIZE
              ? Math.min(MAX_RESTORE_ITEMS_LIMIT, savedScroll.loadedCount)
              : INITIAL_TRANSCRIPT_PAGE_SIZE;

      let reqPromise: Promise<TaskDetailResponse | null> | null = null;
      reqPromise = (async (): Promise<TaskDetailResponse | null> => {
        try {
          const detail = await api.getTaskDetail(taskId, { limit: desiredLimit });
          setTaskDetails((prev) => {
            const next = { ...prev, [taskId]: detail };
            taskDetailsRef.current = next;
            return next;
          });
          setTasks((prev) => {
            const exists = prev.some((t) => t.id === taskId);
            return exists
              ? prev.map((t) => (t.id === taskId ? detail.task : t))
              : [detail.task, ...prev];
          });
          return detail;
        } catch {
          return null;
        } finally {
          if (inflightDetailRef.current.get(taskId) === reqPromise) {
            inflightDetailRef.current.delete(taskId);
          }
        }
      })();

      inflightDetailRef.current.set(taskId, reqPromise);
      return reqPromise;
    },
    []
  );

  const loadOlderTaskItems = useCallback(
    async (taskId: string): Promise<{ addedCount: number; hasMore: boolean }> => {
      if (!taskId || inflightOlderRef.current.has(taskId)) {
        return { addedCount: 0, hasMore: Boolean(taskDetailsRef.current[taskId]?.itemsMeta?.hasMore) };
      }
      const cur = taskDetailsRef.current[taskId];
      if (!cur || !cur.itemsMeta?.hasMore || cur.itemsMeta.oldestSeq === null) {
        return { addedCount: 0, hasMore: false };
      }

      inflightOlderRef.current.add(taskId);
      try {
        const page = await api.getTaskItemsPage(taskId, {
          beforeSeq: cur.itemsMeta.oldestSeq,
          limit: OLDER_TRANSCRIPT_PAGE_SIZE,
        });
        let addedCount = 0;
        setTaskDetails((prev) => {
          const latest = prev[taskId];
          if (!latest) return prev;
          const existingIds = new Set(latest.items.map((it) => it.id));
          const uniqueOlder = page.items.filter((it) => !existingIds.has(it.id));
          addedCount = uniqueOlder.length;
          const mergedItems = uniqueOlder.length > 0 ? [...uniqueOlder, ...latest.items] : latest.items;
          const nextDetail: TaskDetailResponse = {
            ...latest,
            items: mergedItems,
            itemsMeta: {
              totalCount: Math.max(page.totalCount, mergedItems.length),
              hasMore: page.hasMore,
              oldestSeq: page.oldestSeq ?? latest.itemsMeta?.oldestSeq ?? null,
            },
          };
          const next = { ...prev, [taskId]: nextDetail };
          taskDetailsRef.current = next;
          return next;
        });
        return { addedCount, hasMore: page.hasMore };
      } catch {
        return { addedCount: 0, hasMore: Boolean(taskDetailsRef.current[taskId]?.itemsMeta?.hasMore) };
      } finally {
        inflightOlderRef.current.delete(taskId);
      }
    },
    []
  );

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

        case "quotas_updated":
          setQuotas(ev.quotas);
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
          clearTaskScrollState(ev.taskId);
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
            const nextMeta = cur.itemsMeta
              ? {
                  ...cur.itemsMeta,
                  totalCount:
                    idx >= 0
                      ? cur.itemsMeta.totalCount
                      : Math.max(cur.itemsMeta.totalCount + 1, nextItems.length),
                }
              : undefined;
            const next = {
              ...prev,
              [ev.taskId]: { ...cur, items: nextItems, itemsMeta: nextMeta },
            };
            taskDetailsRef.current = next;
            return next;
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
  }, [setWorkspaces, clearComposerDraft, clearTaskScrollState]);

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
      quotas,
      setQuotas,
      prefs,
      lang,
      t,
      taskDetails,
      loadTaskDetail,
      loadOlderTaskItems,
      getTaskScrollState,
      saveTaskScrollState,
      clearTaskScrollState,
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
      quotas,
      setQuotas,
      prefs,
      lang,
      t,
      taskDetails,
      loadTaskDetail,
      loadOlderTaskItems,
      getTaskScrollState,
      saveTaskScrollState,
      clearTaskScrollState,
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
