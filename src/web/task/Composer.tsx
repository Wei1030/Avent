import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AttachmentItem,
  PermissionMode,
  ProviderId,
  SkillRecord,
  TaskRecord,
  TaskRef,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Popover, Select } from "../components/ui.js";
import { cx, isPlainEnter } from "../lib/format.js";

export function Composer({ task }: { task: TaskRecord }) {
  const { tasks, providers, toast, t } = useApp();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [refs, setRefs] = useState<TaskRef[]>([]);
  const [sending, setSending] = useState(false);

  // Autocomplete palettes (`@` for tasks & files, `/` for skills)
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [wsFiles, setWsFiles] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  const isRunning = task.status === "PULSING" || task.status === "WAITING_APPROVAL";

  // Load workspace files & skills when workspace changes
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
    setText(val);
    // Detect leading `/query`
    const slashM = /^\/([a-z0-9_-]*)$/i.exec(val);
    if (slashM) {
      setSlashQuery(slashM[1]);
      setAtQuery(null);
      return;
    }
    setSlashQuery(null);

    // Detect trailing `@query`
    const atM = /(?:^|\s)@([^\s@]*)$/.exec(val);
    if (atM) {
      setAtQuery(atM[1]);
    } else {
      setAtQuery(null);
    }
  };

  // Other tasks available for `@任务` reference
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
    if (!refs.some((r) => r.taskId === target.id)) {
      setRefs((prev) => [...prev, { taskId: target.id, title: target.title }]);
    }
    setText((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, (m) => (m.startsWith(" ") ? " " : "")));
    setAtQuery(null);
    textareaRef.current?.focus();
  };

  const insertFileAttachment = (filePath: string) => {
    if (!attachments.some((a) => a.path === filePath)) {
      setAttachments((prev) => [
        ...prev,
        {
          id: `${Date.now()}_${filePath}`,
          kind: "file",
          name: filePath.split("/").pop() || filePath,
          path: filePath,
          meta: filePath,
        },
      ]);
    }
    setText((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, (m) => (m.startsWith(" ") ? " " : "")));
    setAtQuery(null);
    textareaRef.current?.focus();
  };

  const insertSkill = (s: SkillRecord) => {
    setText(`/${s.name} `);
    setSlashQuery(null);
    textareaRef.current?.focus();
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await api.sendMessage(task.id, {
        text: trimmed,
        attachments,
        refs,
      });
      setText("");
      setAttachments([]);
      setRefs([]);
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
    try {
      await api.cancelTask(task.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  // Build combined Provider + Model options
  const modelOptions = useMemo(() => {
    const out: Array<{
      value: string;
      label: string;
      desc?: string;
      right?: string;
      disabled?: boolean;
    }> = [];
    for (const p of providers) {
      for (const m of p.models) {
        out.push({
          value: `${p.id}::${m.value}`,
          label: `${p.shortName} · ${m.name}`,
          desc: p.subscriptionLabel,
          right: p.available ? "可用" : "未登录",
        });
      }
    }
    return out;
  }, [providers]);

  const currentProvider = providers.find((p) => p.id === task.providerId) ?? providers[0];
  const currentCombinedModel = `${task.providerId}::${task.modelId}`;

  return (
    <>
      {/* Queued Follow-ups */}
      {task.queuedMessages && task.queuedMessages.length > 0 && (
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
                onRemove={() => setRefs((prev) => prev.filter((x) => x.taskId !== r.taskId))}
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
                onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
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
                setText((prev) => (prev ? `${prev} @` : "@"));
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
                setText("/");
                setSlashQuery("");
                textareaRef.current?.focus();
              }}
            >
              <Icon name="spark" size={14} />
              <span className="grow">
                调用技能模板
                <span className="desc">输入 / 选择验证、改动总结或自定义技能</span>
              </span>
            </button>
          </Popover>

          <textarea
            ref={textareaRef}
            className="c-input"
            rows={2}
            placeholder={
              task.status === "DRAFT"
                ? "描述你想完成的任务目标（输入 @ 可引用其他任务或文件，输入 / 调用技能，Enter 发送）…"
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
                setAttachments((prev) => [
                  ...prev,
                  {
                    id: `paste_${Date.now()}`,
                    kind: "paste",
                    name: `粘贴片段 (${pasted.split("\n").length} 行)`,
                    meta: `${pasted.length} 字符`,
                    content: pasted,
                  },
                ]);
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
                  <span className="h grow" style={{ textAlign: "right" }}>
                    v{tk.currentVersion}
                  </span>
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
          {modelOptions.length > 0 && (
            <Select
              size="sm"
              borderless
              placement="top"
              icon="cpu"
              value={currentCombinedModel}
              options={modelOptions}
              onChange={(combined) => {
                const [pid, mid] = combined.split("::") as [ProviderId, string];
                void api.updateTask(task.id, { providerId: pid, modelId: mid });
              }}
            />
          )}

          {currentProvider && currentProvider.thoughtLevels.length > 0 && (
            <Select
              size="sm"
              borderless
              placement="top"
              icon="bulb"
              value={task.thoughtLevel}
              options={currentProvider.thoughtLevels.map((lv) => ({
                value: lv.value,
                label: `思考：${lv.name}`,
              }))}
              onChange={(thoughtLevel) => {
                void api.updateTask(task.id, { thoughtLevel });
              }}
            />
          )}

          <Select<PermissionMode>
            size="sm"
            borderless
            placement="top"
            icon="shield"
            value={task.permissionMode}
            options={[
              {
                value: "default",
                label: t("默认询问"),
                desc: "只读自动放行，修改文件与执行命令前需确认",
              },
              {
                value: "acceptEdits",
                label: t("自动接受编辑"),
                desc: "自动允许读写代码文件，非常规命令仍会询问",
              },
              {
                value: "bypassPermissions",
                label: t("全自动执行"),
                desc: "除高危拦截规则外自动执行所有工具",
              },
            ]}
            onChange={(permissionMode) => {
              void api.updateTask(task.id, { permissionMode });
            }}
          />

          <div className="c-right">
            {isRunning && (
              <Button variant="danger-outline" size="sm" icon="stop" onClick={() => void handleCancel()}>
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
