export type ProviderId = "agy" | "claude" | "codex";

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
  branch?: string;
  gitClean?: boolean;
  taskCount?: number;
  runningCount?: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface SteeringDirective {
  id: string;
  timestamp: string;
  directive: string;
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
  providerId: ProviderId;
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

export interface ApprovalRequest {
  id: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  toolCallId: string;
  toolName: string;
  detail: string;
  rawInput?: unknown;
  risky: boolean;
  suggestedRule: string;
  createdAt: string;
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
  originalObjective: string;
  completionCriteria: string[];
  steeringDirectives: SteeringDirective[];
  tags: string[];
  cwd: string;
  providerId: ProviderId;
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
  providerId: ProviderId;
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

export interface ProviderModelOption {
  value: string;
  name: string;
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
  thoughtLevels: ProviderModelOption[];
  defaultThoughtLevel: string;
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

export interface CompatibleEndpointRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string;
  models: string[];
  enabled: boolean;
  createdAt: string;
}

export interface AppPreferences {
  uiLanguage: "auto" | "zh-CN" | "en";
  defaultProviderId: ProviderId;
  defaultPermissionMode: PermissionMode;
  autoVerifyEdits: boolean;
  desktopNotifications: boolean;
  maxAutoContinues: number;
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
  days: UsageDayBucket[];
  byWorkspace: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
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
