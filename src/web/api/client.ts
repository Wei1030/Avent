import type {
  AppPreferences,
  ApprovalDecisionPayload,
  ApprovalRequest,
  AttachmentItem,
  CompatibleEndpointModel,
  CompatibleEndpointRecord,
  EndpointProtocol,
  InstructionDoc,
  McpServerRecord,
  PermissionEvaluationPreview,
  PermissionMode,
  PermissionRuleRecord,
  ProviderId,
  ProviderStatusInfo,
  SkillRecord,
  TaskDetailResponse,
  TaskProviderId,
  TaskRecord,
  TaskRef,
  UsageReport,
  WorkspaceRecord,
  WorkspaceWorktreeConfig,
  WorktreeConfigScope,
  WorktreeLiveStatus,
  WorktreeMergeResult,
} from "../../shared/types.js";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  bootstrap: () =>
    req<{
      workspaces: WorkspaceRecord[];
      tasks: TaskRecord[];
      approvals: ApprovalRequest[];
      providers: ProviderStatusInfo[];
      endpoints: CompatibleEndpointRecord[];
      prefs: AppPreferences;
      defaultCwd: string;
      defaultWorktreesRoot?: string;
    }>("/api/bootstrap"),

  listWorkspaces: () => req<{ workspaces: WorkspaceRecord[] }>("/api/workspaces"),
  addWorkspace: (path: string, name?: string) =>
    req<{ workspace: WorkspaceRecord; workspaces: WorkspaceRecord[] }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path, name }),
    }),
  updateWorkspace: (
    id: string,
    patch: {
      pinned?: boolean;
      name?: string;
      worktreeRoot?: string;
      worktreeSetupCommand?: string;
      worktreeInitPrompt?: string;
    }
  ) =>
    req<{ workspace: WorkspaceRecord; workspaces: WorkspaceRecord[] }>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteWorkspace: (id: string) =>
    req<{ ok: boolean; workspaces: WorkspaceRecord[] }>(`/api/workspaces/${id}`, {
      method: "DELETE",
    }),

  getWorktreeConfig: (workspaceId: string) =>
    req<{ config: WorkspaceWorktreeConfig }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/worktree-config`
    ),
  saveWorktreeConfig: (
    workspaceId: string,
    body: {
      scope: WorktreeConfigScope;
      setupCommand: string;
      initPrompt: string;
      forceTrackRepo?: boolean;
    }
  ) =>
    req<{
      config: WorkspaceWorktreeConfig;
      forceTracked: boolean;
      workspaces: WorkspaceRecord[];
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/worktree-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  worktreeConfigGitAction: (
    workspaceId: string,
    body: {
      scope: WorktreeConfigScope;
      action: "track" | "force_track" | "untrack" | "ensure_exclude";
    }
  ) =>
    req<{ config: WorkspaceWorktreeConfig; workspaces: WorkspaceRecord[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/worktree-config/git`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),

  browseFs: (path = "") =>
    req<{
      currentPath: string;
      parentPath: string | null;
      roots: Array<{ name: string; path: string }>;
      homePath: string;
      directories: Array<{ name: string; path: string }>;
    }>(`/api/fs/browse?path=${encodeURIComponent(path)}`),

  listWorkspaceFiles: (wsId: string, q = "", taskId?: string) =>
    req<{ files: string[] }>(
      `/api/workspaces/${encodeURIComponent(wsId)}/files?q=${encodeURIComponent(q)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`
    ),

  readWorkspaceFile: (wsId: string, filePath: string, taskId?: string) =>
    req<{ path: string; totalLines: number; content: string; truncated: boolean }>(
      `/api/workspaces/${encodeURIComponent(wsId)}/file-content?path=${encodeURIComponent(filePath)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`
    ),

  listTasks: (workspaceId?: string) =>
    req<{ tasks: TaskRecord[] }>(
      workspaceId ? `/api/tasks?workspaceId=${encodeURIComponent(workspaceId)}` : "/api/tasks"
    ),

  createTask: (body: {
    workspaceId?: string;
    title?: string;
    objective?: string;
    cwd?: string;
    providerId?: TaskProviderId;
    modelId?: string;
    thoughtLevel?: string;
    permissionMode?: PermissionMode;
    draft?: boolean;
    useWorktree?: boolean;
    attachments?: AttachmentItem[];
    refs?: TaskRef[];
  }) =>
    req<{ task: TaskRecord }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getTaskDetail: (id: string) => req<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(id)}`),

  updateTask: (
    id: string,
    patch: {
      title?: string;
      originalObjective?: string;
      tags?: string[];
      permissionMode?: PermissionMode;
      providerId?: TaskProviderId;
      modelId?: string;
      thoughtLevel?: string;
    }
  ) =>
    req<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  sendMessage: (
    id: string,
    payload: {
      text: string;
      attachments?: AttachmentItem[];
      refs?: TaskRef[];
      interruptCurrent?: boolean;
    }
  ) =>
    req<{ task: TaskRecord; queued: boolean }>(`/api/tasks/${encodeURIComponent(id)}/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  addDirective: (taskId: string, directive: string) =>
    req<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(taskId)}/steering`, {
      method: "POST",
      body: JSON.stringify({ directive }),
    }),

  removeDirective: (taskId: string, directiveId: string) =>
    req<{ task: TaskRecord }>(
      `/api/tasks/${encodeURIComponent(taskId)}/steering/${encodeURIComponent(directiveId)}`,
      { method: "DELETE" }
    ),

  removeQueuedMessage: (taskId: string, queueId: string) =>
    req<{ ok: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/queue/${encodeURIComponent(queueId)}`,
      { method: "DELETE" }
    ),

  cancelTask: (id: string) =>
    req<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),

  resumeTask: (id: string) =>
    req<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: "POST" }),

  deleteTask: (id: string, opts?: { cleanupWorktree?: boolean }) =>
    req<{ ok: boolean }>(
      `/api/tasks/${encodeURIComponent(id)}${opts?.cleanupWorktree ? "?cleanupWorktree=true" : ""}`,
      { method: "DELETE" }
    ),

  getTaskWorktree: (id: string) =>
    req<{ status: WorktreeLiveStatus | null }>(`/api/tasks/${encodeURIComponent(id)}/worktree`),

  mergeTaskWorktree: (id: string, body?: { autoCommit?: boolean; commitMessage?: string }) =>
    req<{ result: WorktreeMergeResult }>(`/api/tasks/${encodeURIComponent(id)}/worktree/merge`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  abortWorktreeRebase: (id: string) =>
    req<{ status: WorktreeLiveStatus }>(
      `/api/tasks/${encodeURIComponent(id)}/worktree/abort-rebase`,
      { method: "POST" }
    ),

  removeTaskWorktree: (id: string, deleteBranch = true) =>
    req<{ ok: boolean; removedDir?: boolean; deletedBranch?: boolean; warning?: string; task: TaskRecord }>(
      `/api/tasks/${encodeURIComponent(id)}/worktree?deleteBranch=${deleteBranch ? "true" : "false"}`,
      { method: "DELETE" }
    ),

  decideApproval: (approvalId: string, payload: ApprovalDecisionPayload) =>
    req<{ ok: boolean }>(`/api/approvals/${encodeURIComponent(approvalId)}/decide`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listMcp: (workspaceId?: string) =>
    req<{ servers: McpServerRecord[] }>(
      workspaceId ? `/api/mcp?workspaceId=${encodeURIComponent(workspaceId)}` : "/api/mcp"
    ),

  saveMcp: (body: {
    id?: string;
    name: string;
    scope: "global" | "workspace";
    workspaceId?: string;
    transport: "stdio" | "http" | "sse";
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }) =>
    req<{ server: McpServerRecord }>("/api/mcp", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  toggleMcp: (id: string, enabled: boolean) =>
    req<{ server: McpServerRecord }>(`/api/mcp/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),

  testMcp: (id: string, workspaceId?: string) =>
    req<{ ok: boolean; server: McpServerRecord; errorMessage?: string }>(
      `/api/mcp/${encodeURIComponent(id)}/test${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
      { method: "POST" }
    ),

  deleteMcp: (id: string) =>
    req<{ ok: boolean }>(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listSkills: (workspaceId?: string) =>
    req<{ skills: SkillRecord[] }>(
      workspaceId ? `/api/skills?workspaceId=${encodeURIComponent(workspaceId)}` : "/api/skills"
    ),

  saveSkill: (body: {
    name: string;
    description: string;
    argumentHint?: string;
    scope: "global" | "workspace";
    workspaceId?: string;
    body: string;
  }) =>
    req<{ skill: SkillRecord }>("/api/skills", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteSkill: (id: string) =>
    req<{ ok: boolean }>(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getInstructions: (scope: "global" | "workspace", workspaceId?: string) =>
    req<{ doc: InstructionDoc }>(
      `/api/instructions?scope=${scope}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`
    ),

  saveInstructions: (scope: "global" | "workspace", content: string, workspaceId?: string) =>
    req<{ doc: InstructionDoc }>("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ scope, content, workspaceId }),
    }),

  getUsage: (range: "7d" | "30d" | "all", workspaceId?: string) =>
    req<{ report: UsageReport }>(
      `/api/usage?range=${range}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`
    ),

  listRules: (workspaceId?: string) =>
    req<{ rules: PermissionRuleRecord[] }>(
      workspaceId ? `/api/rules?workspaceId=${encodeURIComponent(workspaceId)}` : "/api/rules"
    ),

  addRule: (body: {
    behavior: "allow" | "ask" | "deny";
    rule: string;
    scope: "global" | "workspace";
    workspaceId?: string;
    note?: string;
  }) =>
    req<{ rule: PermissionRuleRecord }>("/api/rules", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteRule: (id: string) =>
    req<{ ok: boolean }>(`/api/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  evaluateRule: (body: {
    toolKind: "shell" | "edit" | "delete" | "read" | "other";
    inputText: string;
    mode?: PermissionMode;
    workspaceId?: string;
  }) =>
    req<{ preview: PermissionEvaluationPreview; cwd: string }>("/api/rules/evaluate", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listProviders: () =>
    req<{
      providers: ProviderStatusInfo[];
      endpoints: CompatibleEndpointRecord[];
      defaultCwd: string;
    }>("/api/providers"),

  checkProvider: (id: ProviderId) =>
    req<{ ok: boolean; status: ProviderStatusInfo; detail: string; providers: ProviderStatusInfo[] }>(
      `/api/providers/${encodeURIComponent(id)}/check`,
      { method: "POST" }
    ),

  savePrefs: (patch: Partial<AppPreferences>) =>
    req<{ prefs: AppPreferences }>("/api/prefs", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  addEndpoint: (body?: {
    name?: string;
    protocol?: EndpointProtocol;
    baseUrl?: string;
    apiKey?: string;
    models?: CompatibleEndpointModel[];
  }) =>
    req<{ endpoint: CompatibleEndpointRecord; endpoints: CompatibleEndpointRecord[] }>(
      "/api/endpoints",
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }
    ),

  updateEndpoint: (
    id: string,
    patch: {
      name?: string;
      protocol?: EndpointProtocol;
      baseUrl?: string;
      apiKey?: string | null;
      models?: CompatibleEndpointModel[];
      enabled?: boolean;
    }
  ) =>
    req<{ endpoint: CompatibleEndpointRecord; endpoints: CompatibleEndpointRecord[] }>(
      `/api/endpoints/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    ),

  fetchEndpointModels: (id: string) =>
    req<{ ok: boolean; models: string[]; error?: string }>(
      `/api/endpoints/${encodeURIComponent(id)}/fetch-models`,
      { method: "POST" }
    ),

  deleteEndpoint: (id: string) =>
    req<{ ok: boolean; endpoints: CompatibleEndpointRecord[] }>(
      `/api/endpoints/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
};
