import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AttachmentItem,
  PermissionMode,
  SkillRecord,
  TaskRecord,
  TaskRef,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp, type NewTaskConfig } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { ModelPicker, resolveThoughtLevelsForSelection } from "../components/ModelPicker.js";
import { Button, Chip, Popover, Select } from "../components/ui.js";
import { cx, getPermissionModeOptions, isPlainEnter } from "../lib/format.js";

export function Composer({
  task,
  draftKey,
  isNewDraft = false,
  onDraftConfigChange,
  onCreatedTask,
}: {
  task: TaskRecord;
  draftKey: string;
  isNewDraft?: boolean;
  onDraftConfigChange?: (patch: Partial<NewTaskConfig>) => void;
  onCreatedTask?: (task: TaskRecord) => void;
}) {
  const {
    tasks,
    providers,
    endpoints,
    toast,
    t,
    getComposerDraft,
    setComposerDraft,
    clearComposerDraft,
  } = useApp();

  // Initialized from persistent draft store; TaskPage passes `key={draftKey}` so switching tasks
  // cleanly remounts with the target task's saved unsent text, attachments, and refs.
  const initialDraft = useMemo(() => getComposerDraft(draftKey), [draftKey, getComposerDraft]);
  const [text, setTextState] = useState(initialDraft.text);
  const [attachments, setAttachmentsState] = useState<AttachmentItem[]>(initialDraft.attachments);
  const [refs, setRefsState] = useState<TaskRef[]>(initialDraft.refs);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);

  // Latest values in ref so partial updates always persist the complete draft synchronously
  const latestRef = useRef({ text, attachments, refs });
  latestRef.current = { text, attachments, refs };

  const updateDraft = (patch: Partial<{ text: string; attachments: AttachmentItem[]; refs: TaskRef[] }>) => {
    const next = {
      text: patch.text !== undefined ? patch.text : latestRef.current.text,
      attachments: patch.attachments !== undefined ? patch.attachments : latestRef.current.attachments,
      refs: patch.refs !== undefined ? patch.refs : latestRef.current.refs,
    };
    latestRef.current = next;
    if (patch.text !== undefined) setTextState(patch.text);
    if (patch.attachments !== undefined) setAttachmentsState(patch.attachments);
    if (patch.refs !== undefined) setRefsState(patch.refs);
    setComposerDraft(draftKey, next);
  };

  // Autocomplete palettes (`@` for tasks & files, `/` for skills)
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [wsFiles, setWsFiles] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  const isRunning = !isNewDraft && (task.status === "PULSING" || task.status === "WAITING_APPROVAL");

  useEffect(() => {
    if (!task.workspaceId) return;
    void api
      .listWorkspaceFiles(task.workspaceId, atQuery ?? "")
      .then((res) => setWsFiles(res.files))
      .catch(() => {});
  }, [task.workspaceId, atQuery]);

  useEffect(() => {
    void api
      .listSkills(task.workspaceId)
      .then((res) => setSkills(res.skills))
      .catch(() => {});
  }, [task.workspaceId]);

  const handleTextChange = (val: string) => {
    updateDraft({ text: val });
    const slashM = /^\/([a-z0-9_-]*)$/i.exec(val);
    if (slashM) {
      setSlashQuery(slashM[1]);
      setAtQuery(null);
      return;
    }
    setSlashQuery(null);

    const atM = /(?:^|\s)@([^\s@]*)$/.exec(val);
    if (atM) {
      setAtQuery(atM[1]);
    } else {
      setAtQuery(null);
    }
  };

  const candidateTasks = useMemo(() => {
    const q = (atQuery ?? "").toLowerCase();
    return tasks
      .filter((tk) => tk.id !== task.id && tk.status !== "DRAFT")
      .filter((tk) => !q || tk.title.toLowerCase().includes(q))
      .slice(0, 5);
  }, [tasks, task.id, atQuery]);

  const candidateFiles = useMemo(() => wsFiles.slice(0, 8), [wsFiles]);

  const candidateSkills = useMemo(() => {
    const q = (slashQuery ?? "").toLowerCase();
    return skills.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }, [skills, slashQuery]);

  const insertTaskRef = (target: TaskRecord) => {
    const nextRefs = refs.some((r) => r.taskId === target.id)
      ? refs
      : [...refs, { taskId: target.id, title: target.title }];
    const nextText = latestRef.current.text.replace(/(?:^|\s)@([^\s@]*)$/, (m) =>
      m.startsWith(" ") ? " " : ""
    );
    updateDraft({ text: nextText, refs: nextRefs });
    setAtQuery(null);
    textareaRef.current?.focus();
  };

  const insertFileAttachment = (filePath: string) => {
    const nextAtts = attachments.some((a) => a.path === filePath)
      ? attachments
      : [
          ...attachments,
          {
            id: `${Date.now()}_${filePath}`,
            kind: "file" as const,
            name: filePath.split("/").pop() || filePath,
            path: filePath,
            meta: filePath,
          },
        ];
    const nextText = latestRef.current.text.replace(/(?:^|\s)@([^\s@]*)$/, (m) =>
      m.startsWith(" ") ? " " : ""
    );
    updateDraft({ text: nextText, attachments: nextAtts });
    setAtQuery(null);
    textareaRef.current?.focus();
  };

  const insertSkill = (s: SkillRecord) => {
    updateDraft({ text: `/${s.name} ` });
    setSlashQuery(null);
    textareaRef.current?.focus();
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      if (isNewDraft) {
        const res = await api.createTask({
          workspaceId: task.workspaceId || undefined,
          objective: trimmed,
          providerId: task.providerId,
          modelId: task.modelId,
          thoughtLevel: task.thoughtLevel,
          permissionMode: task.permissionMode,
          attachments,
          refs,
        });
        clearComposerDraft(draftKey);
        setTextState("");
        setAttachmentsState([]);
        setRefsState([]);
        setAtQuery(null);
        setSlashQuery(null);
        onCreatedTask?.(res.task);
        return;
      }

      const res = await api.sendMessage(task.id, {
        text: trimmed,
        attachments,
        refs,
      });
      clearComposerDraft(draftKey);
      setTextState("");
      setAttachmentsState([]);
      setRefsState([]);
      setAtQuery(null);
      setSlashQuery(null);
      if (res.queued) {
        toast("已加入待发队列，当前轮次结束后自动执行", "good");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async () => {
    if (isNewDraft) return;
    try {
      await api.cancelTask(task.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const { levels: activeThoughtLevels, defaultLevel } = useMemo(
    () =>
      resolveThoughtLevelsForSelection(providers, endpoints, task.providerId, task.modelId),
    [providers, endpoints, task.providerId, task.modelId]
  );

  const effectiveThoughtValue = activeThoughtLevels.some((lv) => lv.value === task.thoughtLevel)
    ? task.thoughtLevel
    : defaultLevel;

  return (
    <>
      {!isNewDraft && task.queuedMessages && task.queuedMessages.length > 0 && (
        <div className="queue">
          <div className="queue-head">排队等待发送（{task.queuedMessages.length}）</div>
          {task.queuedMessages.map((q) => (
            <div key={q.id} className="qitem">
              <Icon name="clock" size={14} className="muted" />
              <span className="txt">{q.text}</span>
              <Button
                variant="ghost"
                size="sm"
                icon="x"
                title="取消排队"
                onClick={() => void api.removeQueuedMessage(task.id, q.id)}
              />
            </div>
          ))}
        </div>
      )}

      <div ref={composerRef} className={cx("composer", focused && "focus")}>
        {(refs.length > 0 || attachments.length > 0) && (
          <div className="c-atts">
            {refs.map((r) => (
              <Chip
                key={r.taskId}
                tone="accent"
                icon="link"
                onRemove={() =>
                  updateDraft({ refs: refs.filter((x) => x.taskId !== r.taskId) })
                }
              >
                引用任务：{r.title}
              </Chip>
            ))}
            {attachments.map((a) => (
              <Chip
                key={a.id}
                outline
                mono
                icon="file"
                onRemove={() =>
                  updateDraft({ attachments: attachments.filter((x) => x.id !== a.id) })
                }
              >
                {a.path || a.name}
              </Chip>
            ))}
          </div>
        )}

        <div className="c-row1">
          <button
            ref={plusBtnRef}
            type="button"
            className="btn sm icon-only ghost c-plus"
            title="引用其他任务、文件或插入技能"
            onClick={() => setPlusMenuOpen(!plusMenuOpen)}
          >
            <Icon name="plus" size={16} />
          </button>
          <Popover
            anchor={plusBtnRef.current}
            open={plusMenuOpen}
            onClose={() => setPlusMenuOpen(false)}
            placement="top"
          >
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setPlusMenuOpen(false);
                updateDraft({ text: text ? `${text} @` : "@" });
                setAtQuery("");
                textareaRef.current?.focus();
              }}
            >
              <Icon name="at" size={14} />
              <span className="grow">
                引用其他任务或工作区文件
                <span className="desc">输入 @ 选择历史任务结论或代码文件</span>
              </span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setPlusMenuOpen(false);
                updateDraft({ text: "/" });
                setSlashQuery("");
                textareaRef.current?.focus();
              }}
            >
              <Icon name="spark" size={14} />
              <span className="grow">
                调用技能模板
                <span className="desc">输入 / 选择工作区或全局自定义技能</span>
              </span>
            </button>
          </Popover>

          <textarea
            ref={textareaRef}
            className="c-input"
            rows={2}
            placeholder={
              isNewDraft || task.status === "DRAFT"
                ? "直接发消息聊聊或描述你的任务目标（输入 @ 引用其他任务或文件，输入 / 调用技能，Enter 发送）…"
                : "继续对话或补充要求（输入 @ 引用其他任务结论或文件，Enter 发送）…"
            }
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => handleTextChange(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              if (pasted && pasted.length > 900) {
                e.preventDefault();
                updateDraft({
                  attachments: [
                    ...attachments,
                    {
                      id: `paste_${Date.now()}`,
                      kind: "paste",
                      name: `粘贴片段 (${pasted.split("\n").length} 行)`,
                      meta: `${pasted.length} 字符`,
                      content: pasted,
                    },
                  ],
                });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAtQuery(null);
                setSlashQuery(null);
                return;
              }
              if (isPlainEnter(e)) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
        </div>

        {/* `@` Palette: Tasks + Workspace Files */}
        <Popover
          anchor={composerRef.current}
          open={atQuery !== null}
          onClose={() => setAtQuery(null)}
          placement="top"
          className="palette"
        >
          <div className="ph">
            <span>引用其他任务结论或工作区文件</span>
            <span className="mono">@{atQuery}</span>
          </div>
          {candidateTasks.length > 0 && (
            <>
              <div className="menu-head">其他任务（自动注入其已验证结论）</div>
              {candidateTasks.map((tk) => (
                <div key={tk.id} className="pi" onClick={() => insertTaskRef(tk)}>
                  <Icon name="link" size={14} className="accent" />
                  <span className="n truncate">{tk.title}</span>
                </div>
              ))}
            </>
          )}
          {candidateFiles.length > 0 && (
            <>
              <div className="menu-head">工作区文件</div>
              {candidateFiles.map((fp) => (
                <div key={fp} className="pi" onClick={() => insertFileAttachment(fp)}>
                  <Icon name="file" size={14} className="ink2" />
                  <span className="n truncate">{fp}</span>
                </div>
              ))}
            </>
          )}
          {candidateTasks.length === 0 && candidateFiles.length === 0 && (
            <div className="empty" style={{ padding: 14 }}>
              未找到匹配的任务或文件
            </div>
          )}
        </Popover>

        {/* `/` Palette: Skills */}
        <Popover
          anchor={composerRef.current}
          open={slashQuery !== null}
          onClose={() => setSlashQuery(null)}
          placement="top"
          className="palette"
        >
          <div className="ph">
            <span>技能与快捷指令</span>
            <span className="mono">/{slashQuery}</span>
          </div>
          {candidateSkills.length === 0 ? (
            <div className="empty" style={{ padding: 14 }}>
              无匹配技能（可在左侧「技能」页面新建）
            </div>
          ) : (
            candidateSkills.map((s) => (
              <div key={s.id} className="pi" onClick={() => insertSkill(s)}>
                <Icon name="spark" size={14} className="accent" />
                <span className="n">/{s.name}</span>
                <span className="h grow truncate">{s.description}</span>
              </div>
            ))
          )}
        </Popover>

        {/* Bottom Control Row */}
        <div className="c-row2">
          {providers.length > 0 && (
            <ModelPicker
              providerId={task.providerId}
              modelId={task.modelId}
              thoughtLevel={task.thoughtLevel}
              placement="top"
              borderless
              onSelect={(next) => {
                if (isNewDraft) {
                  onDraftConfigChange?.({
                    providerId: next.providerId,
                    modelId: next.modelId,
                    thoughtLevel: next.thoughtLevel,
                  });
                } else {
                  void api.updateTask(task.id, {
                    providerId: next.providerId,
                    modelId: next.modelId,
                    thoughtLevel: next.thoughtLevel,
                  });
                }
              }}
            />
          )}

          {activeThoughtLevels.length > 0 && (
            <Select
              size="sm"
              borderless
              placement="top"
              icon="bulb"
              value={effectiveThoughtValue}
              options={activeThoughtLevels.map((lv) => ({
                value: lv.value,
                label: `思考：${lv.name}`,
              }))}
              onChange={(thoughtLevel) => {
                if (isNewDraft) {
                  onDraftConfigChange?.({ thoughtLevel });
                } else {
                  void api.updateTask(task.id, { thoughtLevel });
                }
              }}
            />
          )}

          <Select<PermissionMode>
            size="sm"
            borderless
            placement="top"
            icon="shield"
            value={task.permissionMode}
            options={getPermissionModeOptions(t)}
            onChange={(permissionMode) => {
              if (isNewDraft) {
                onDraftConfigChange?.({ permissionMode });
              } else {
                void api.updateTask(task.id, { permissionMode });
              }
            }}
          />

          <div className="c-right">
            {isRunning && (
              <Button
                variant="danger-outline"
                size="sm"
                icon="stop"
                onClick={() => void handleCancel()}
              >
                {t("停止")}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              icon="send"
              busy={sending}
              disabled={!text.trim()}
              onClick={() => void handleSend()}
            >
              {isRunning ? t("排队发送") : t("发送")}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
