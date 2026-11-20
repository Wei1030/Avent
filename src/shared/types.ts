export type ProviderId = "agy" | "claude" | "codex";

/**
 * Task execution provider identifier: either one of the built-in ACP subscription
 * providers or a user-configured compatible endpoint (`endpoint:<id>`).
 */
export type TaskProviderId = ProviderId | `endpoint:${string}`;

export type PulseMode = "micro-stretch" | "sac";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export type TaskStatus =
  | "DRAFT"
  | "IDLE"
  | "PULSING"
  | "WAITING_APPROVAL"
  | "WAITING_HUMAN"
  | "COMPLETED"
  | "FAILED";

export type SemanticStatus = "CONTINUE" | "WAITING_HUMAN" | "COMPLETED" | "FAILED";

export interface WorkspaceRecord {
  id: string;
  name: string;
  path: string;
  pinned: boolean;
  isGitRepo?: boolean;
  branch?: string;
  gitClean?: boolean;
  worktreeRoot?: string;
  hasWorktreeInitConfig?: boolean;
  /** @deprecated Legacy DB columns kept read-only for fallback; configs now live in .avent/worktree*.json */
  worktreeSetupCommand?: string;
  /** @deprecated Legacy DB columns kept read-only for fallback; configs now live in .avent/worktree*.json */
  worktreeInitPrompt?: string;
  taskCount?: number;
  runningCount?: number;
  createdAt: string;
  lastActiveAt: string;
}

export type WorktreeConfigScope = "repo" | "local";

export type WorktreeRepoGitState = "tracked" | "untracked" | "ignored" | "absent" | "no_git";

export interface WorkspaceWorktreeConfig {
  workspaceId: string;
  isGitRepo: boolean;
  worktreeRoot: string;
  repo: {
    relPath: string;
    absPath: string;
    exists: boolean;
    gitState: WorktreeRepoGitState;
    wouldBeIgnored: boolean;
    setupCommand: string;
    initPrompt: string;
  };
  local: {
    relPath: string;
    absPath: string;
    exists: boolean;
    excludedInGit: boolean;
    trackedInGit: boolean;
    setupCommand: string;
    initPrompt: string;
  };
}

export interface WorktreeLiveStatus {
  exists: boolean;
  path: string;
  branch: string;
  baseBranch: string;
  ahead: number;
  behind: number;
  dirtyFiles: string[];
  rebasing: boolean;
  conflictFiles: string[];
  merged: boolean;
  mergedAt?: string;
  mainBranch?: string;
  mainDirtyCount?: number;
}

export interface WorktreeMergeResult {
  ok: boolean;
  outcome: "merged" | "nothing_to_merge" | "conflict" | "blocked_dirty_main" | "error";
  message: string;
  conflictFiles?: string[];
  mainDirtyFiles?: string[];
  status: WorktreeLiveStatus;
}

export interface SteeringDirective {
  id: string;
  timestamp: string;
  directive: string;
  source?: "user" | "model";
}

export interface EstablishedFact {
  fact: string;
  sourcePointer: string;
}

export interface AppliedChange {
  filePath: string;
  summary: string;
  verified: boolean;
}

export interface VerificationCheck {
  command: string;
  outcome: "PASS" | "FAIL" | "PARTIAL" | "N/A";
  keyOutputOrPointer: string;
}

export interface DeadEnd {
  approach: string;
  reasonFailed: string;
}

/**
 * Semantic State Space Model (SSSM) payload (arXiv:2611.05306v1).
 * Maintained automatically across short-context execution rounds and displayed
 * in the Task page's right-hand "状态记忆" (Task State) panel.
 */
export interface SemanticState {
  version: number;
  pulseNumber: number;
  providerId: TaskProviderId;
  modelId: string;
  createdAt: string;
  status: SemanticStatus;
  deliverableSummary: string;
  establishedFacts: EstablishedFact[];
  openHypotheses: string[];
  appliedChanges: AppliedChange[];
  verificationChecks: VerificationCheck[];
  deadEnds: DeadEnd[];
  remainingPlan: string[];
  immediateNextAction: string;
  humanQuestion?: string;
}

/**
 * Payload submitted by the model via `avent_commit_state` (or `<avent_state>` fallback).
 * Includes optional model-determined taskTitle, taskObjective, and auto-extracted newDirectives.
 */
export type SemanticStateCommitDraft = Omit<
  SemanticState,
  "version" | "pulseNumber" | "providerId" | "modelId" | "createdAt"
> & {
  taskTitle?: string;
  taskObjective?: string;
  newDirectives?: string[];
};

export interface TaskRef {
  taskId: string;
  title: string;
}

export interface AttachmentItem {
  id: string;
  kind: "file" | "image" | "paste";
  name: string;
  path?: string;
  meta: string;
  content?: string;
}

export type TranscriptToolOutput =
  | { type: "text"; text: string }
  | { type: "code"; lines: string[]; lang?: string }
  | { type: "diff"; lines: string[]; filePath?: string };

export type TranscriptItem =
  | {
      id: string;
      kind: "user";
      text: string;
      attachments: AttachmentItem[];
      refs: TaskRef[];
      createdAt: string;
    }
  | {
      id: string;
      kind: "thinking";
      text: string;
      seconds: number;
      streaming?: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      tool: string;
      detail: string;
      filePath?: string;
      status: "running" | "waiting" | "ok" | "error" | "denied";
      provenance?: string;
      denialMessage?: string;
      output?: TranscriptToolOutput;
      createdAt: string;
    }
  | {
      id: string;
      kind: "text";
      text: string;
      streaming?: boolean;
      aborted?: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: "footer";
      turn: number;
      seconds: number;
      toolCalls: number;
      tokens: number;
      stateVersion?: number;
      stopReason: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "notice";
      tone: "good" | "info" | "warn";
      text: string;
      createdAt: string;
    };

export type ToolCategory = "read" | "edit" | "delete" | "shell" | "other";

export interface ShellSubCommandPreview {
  raw: string;
  executable: string;
  classification: "read_only" | "write_or_unknown" | "destructive";
  reasons: string[];
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  toolCallId: string;
  toolName: string;
  category?: ToolCategory;
  detail: string;
  rawInput?: unknown;
  risky: boolean;
  outsideWorkspace?: boolean;
  reasons?: string[];
  subCommands?: ShellSubCommandPreview[];
  suggestedRule: string;
  createdAt: string;
}

export interface PermissionEvaluationPreview {
  action: "allow" | "ask" | "deny";
  provenance: string;
  toolName: string;
  category: ToolCategory;
  isReadOnly: boolean;
  isRisky: boolean;
  outsideWorkspace: boolean;
  reasons: string[];
  suggestedRule: string;
  hazards: {
    hasCompound: boolean;
    hasRedirection: boolean;
    hasCommandSub: boolean;
    hasDynamicEval: boolean;
    hasPipeToShell: boolean;
  };
  subCommands: ShellSubCommandPreview[];
}

export interface ApprovalDecisionPayload {
  decision: "allow_once" | "allow_always" | "deny";
  rulePattern?: string;
  ruleScope?: "workspace" | "global";
  denialMessage?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: AttachmentItem[];
  refs: TaskRef[];
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  title: string;
  titleSource: "auto" | "user";
  originalObjective: string;
  objectiveSource: "auto" | "user";
  completionCriteria: string[];
  steeringDirectives: SteeringDirective[];
  tags: string[];
  cwd: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  worktreeBaseCommit?: string;
  worktreeMergedAt?: string;
  worktreeRemoved?: boolean;
  providerId: TaskProviderId;
  modelId: string;
  thoughtLevel: string;
  permissionMode: PermissionMode;
  pulseMode: PulseMode;
  status: TaskStatus;
  currentVersion: number;
  pulseCount: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
  latestState: SemanticState | null;
  pendingApprovalCount?: number;
  queuedMessages?: QueuedMessage[];
}

export type AventEventType =
  | "TASK_CREATED"
  | "USER_MESSAGE"
  | "STEERING_ADDED"
  | "PULSE_CONTINUE"
  | "PROVIDER_SWITCHED";

export interface AventEvent {
  id: string;
  taskId: string;
  type: AventEventType;
  payload: string;
  createdAt: string;
}

export interface PulseTraceEntry {
  timestamp: string;
  kind: "thought" | "text" | "tool" | "permission" | "system" | "usage";
  summary: string;
}

export interface PulseRecord {
  id: string;
  taskId: string;
  pulseNumber: number;
  providerId: TaskProviderId;
  modelId: string;
  status: "RUNNING" | "COMMITTED" | "FAILED" | "CANCELLED";
  actionCount: number;
  maxActions: number;
  baselineTokens: number;
  netTokens: number;
  netTokenLimit: number;
  peakTotalTokens: number;
  sessionClosed: boolean;
  resultStateVersion: number | null;
  deliverableSummary: string;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  traces?: PulseTraceEntry[];
}

export interface ThoughtLevelOption {
  value: string;
  name: string;
}

export interface ProviderModelOption {
  value: string;
  name: string;
  /** Per-model thought levels discovered from ACP.
   *  `undefined` = use provider default; `[]` = model has no independent thought-level selector. */
  thoughtLevels?: ThoughtLevelOption[];
  defaultThoughtLevel?: string;
}

export interface PersistedProviderCapabilities {
  providerId: ProviderId;
  tierName?: string;
  models: ProviderModelOption[];
  defaultModel?: string;
  thoughtLevels?: ThoughtLevelOption[];
  defaultThoughtLevel?: string;
  probedAt: string;
}

export interface ProviderStatusInfo {
  id: ProviderId;
  name: string;
  shortName: string;
  subscriptionLabel: string;
  adapterLabel: string;
  available: boolean;
  verified: boolean;
  tierName?: string;
  binaryPath?: string;
  loginCommand: string;
  statusMessage: string;
  models: ProviderModelOption[];
  defaultModel: string;
  thoughtLevels: ThoughtLevelOption[];
  defaultThoughtLevel: string;
  lastProbedAt?: string;
}

export interface McpToolSummary {
  name: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface McpServerRecord {
  id: string;
  name: string;
  scope: "global" | "workspace";
  workspaceId?: string;
  transport: "stdio" | "http" | "sse";
  enabled: boolean;
  builtIn?: boolean;
  fromFile?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  status: "ready" | "idle" | "disabled" | "error";
  errorMessage?: string;
  tools: McpToolSummary[];
  updatedAt: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  scope: "builtin" | "global" | "workspace";
  workspaceId?: string;
  argumentHint?: string;
  filePath?: string;
  content: string;
  editable: boolean;
  updatedAt: string;
}

export interface PermissionRuleRecord {
  id: string;
  behavior: "allow" | "ask" | "deny";
  rule: string;
  scope: "global" | "workspace";
  workspaceId?: string;
  note?: string;
  createdAt: string;
}

export type EndpointProtocol = "anthropic" | "openai";

export type EndpointThinkingMode = "none" | "toggle" | "standard" | "extended";

export interface CompatibleEndpointModel {
  id: string;
  name?: string;
  thinkingMode: EndpointThinkingMode;
}

export interface CompatibleEndpointRecord {
  id: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyHint: string;
  models: CompatibleEndpointModel[];
  enabled: boolean;
  createdAt: string;
}

export function thinkingModeToLevels(mode: EndpointThinkingMode): ThoughtLevelOption[] {
  switch (mode) {
    case "toggle":
      return [
        { value: "off", name: "关闭 (Off)" },
        { value: "high", name: "开启 (On)" },
      ];
    case "standard":
      return [
        { value: "low", name: "低 (Low)" },
        { value: "medium", name: "中 (Medium)" },
        { value: "high", name: "高 (High)" },
      ];
    case "extended":
      return [
        { value: "low", name: "低 (Low)" },
        { value: "medium", name: "中 (Medium)" },
        { value: "high", name: "高 (High)" },
        { value: "xhigh", name: "极高 (Extra)" },
      ];
    default:
      return [];
  }
}

export interface AppPreferences {
  uiLanguage: "auto" | "zh-CN" | "en";
  defaultProviderId: TaskProviderId;
  defaultModelId: string;
  defaultThoughtLevel: string;
  defaultPermissionMode: PermissionMode;
  desktopNotifications: boolean;
}

export interface InstructionDoc {
  scope: "global" | "workspace";
  workspaceId?: string;
  filePath: string;
  exists: boolean;
  content: string;
  discoveredFiles?: Array<{ name: string; path: string; size: number }>;
}

export interface UsageDayBucket {
  day: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byProvider: Record<string, number>;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  subLabel?: string;
  tasks: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageWindowProviderItem {
  providerId: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

export interface UsageWindowSummary {
  hours: number;
  since: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  byProvider: UsageWindowProviderItem[];
}

export interface UsageReport {
  range: "7d" | "30d" | "all";
  totals: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    taskCount: number;
    completedCount: number;
    turnCount: number;
  };
  rolling5h: UsageWindowSummary;
  rolling7d: UsageWindowSummary;
  days: UsageDayBucket[];
  byWorkspace: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
}

export interface QuotaWindowBucket {
  id: string;
  label: string;
  window: "5h" | "weekly" | "other";
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: string;
  status?: "allowed" | "allowed_warning" | "rejected";
  description?: string;
}

export interface QuotaPoolGroup {
  id: string;
  name: string;
  description?: string;
  buckets: QuotaWindowBucket[];
}

export interface ProviderQuotaSnapshot {
  providerId: ProviderId;
  providerName: string;
  available: boolean;
  planLabel?: string;
  source: "active_cli" | "active_sdk" | "active_acp" | "passive_event" | "unavailable";
  checkedAt?: string;
  groups: QuotaPoolGroup[];
  extraNote?: string;
  error?: string;
}

export interface TaskDetailResponse {
  task: TaskRecord;
  items: TranscriptItem[];
  states: SemanticState[];
  events: AventEvent[];
  pulses: PulseRecord[];
  approvals: ApprovalRequest[];
}

export type LiveStreamEvent =
  | { type: "workspace_updated"; workspaces: WorkspaceRecord[] }
  | { type: "providers_updated"; providers: ProviderStatusInfo[] }
  | { type: "endpoints_updated"; endpoints: CompatibleEndpointRecord[] }
  | { type: "quotas_updated"; quotas: ProviderQuotaSnapshot[] }
  | { type: "task_updated"; task: TaskRecord }
  | { type: "task_deleted"; taskId: string }
  | { type: "item_upserted"; taskId: string; item: TranscriptItem }
  | { type: "approval_requested"; approval: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string; taskId: string }
  | { type: "event_added"; taskId: string; event: AventEvent }
  | { type: "pulse_started"; taskId: string; pulse: PulseRecord }
  | {
      type: "pulse_telemetry";
      taskId: string;
      pulseId: string;
      actionCount: number;
      maxActions: number;
      baselineTokens: number;
      netTokens: number;
      netTokenLimit: number;
      peakTotalTokens: number;
    }
  | { type: "pulse_trace"; taskId: string; pulseId: string; entry: PulseTraceEntry }
  | { type: "state_committed"; taskId: string; state: SemanticState }
  | { type: "pulse_finished"; taskId: string; pulse: PulseRecord };
