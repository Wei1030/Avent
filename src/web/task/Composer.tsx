import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AttachmentItem,
  PermissionMode,
  ProviderId,
  SkillRecord,
  TaskProviderId,
  TaskRecord,
  TaskRef,
  ThoughtLevelOption,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Popover, Select } from "../components/ui.js";
import { cx, isPlainEnter } from "../lib/format.js";

function summarizeThoughtBadge(levels: ThoughtLevelOption[] | undefined): string | null {
  if (!levels) return null;
  if (levels.length === 0) return "自动思考";
  const vals = levels.map((l) => l.value);
  if (vals.includes("xhigh")) return "支持 Extra";
  return `${levels.length} 档思考`;
}

export function Composer({ task }: { task: TaskRecord }) {
  const { tasks, providers, endpoints, setProviders, toast, t } = useApp();
  const nav = useNavigate();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [refs, setRefs] = useState<TaskRef[]>([]);
  const [sending, setSending] = useState(false);

  // Two-column model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState<string>(task.providerId);
  const [modelSearch, setModelSearch] = useState("");
  const [probingProviderId, setProbingProviderId] = useState<ProviderId | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    setActiveSourceId(task.providerId);
  }, [task.providerId, modelPickerOpen]);

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

  // Current selected provider / endpoint & model metadata
  const currentEndpoint = task.providerId.startsWith("endpoint:")
    ? endpoints.find((ep) => `endpoint:${ep.id}` === task.providerId)
    : undefined;
  const currentProvider = !currentEndpoint
    ? providers.find((p) => p.id === task.providerId) ?? providers[0]
    : undefined;
  const currentModelMeta = currentProvider?.models.find((m) => m.value === task.modelId);

  const currentModelButtonLabel = currentEndpoint
    ? `${currentEndpoint.name} · ${task.modelId}`
    : `${currentProvider?.shortName || task.providerId} · ${currentModelMeta?.name || task.modelId}`;

  // Dynamic per-model thought levels (empty array `[]` hides the selector cleanly!)
  const activeThoughtLevels: ThoughtLevelOption[] = useMemo(() => {
    if (currentEndpoint) return [];
    if (!currentProvider) return [];
    if (currentModelMeta && currentModelMeta.thoughtLevels !== undefined) {
      return currentModelMeta.thoughtLevels;
    }
    return currentProvider.thoughtLevels;
  }, [currentEndpoint, currentProvider, currentModelMeta]);

  const effectiveThoughtValue = useMemo(() => {
    if (activeThoughtLevels.length === 0) return "";
    if (activeThoughtLevels.some((lv) => lv.value === task.thoughtLevel)) {
      return task.thoughtLevel;
    }
    return (
      currentModelMeta?.defaultThoughtLevel ||
      currentProvider?.defaultThoughtLevel ||
      activeThoughtLevels[0].value
    );
  }, [activeThoughtLevels, task.thoughtLevel, currentModelMeta, currentProvider]);

  // Left column sources in the 2-column model picker
  const selectedLeftProvider = providers.find((p) => p.id === activeSourceId);
  const selectedLeftEndpoint = endpoints.find((ep) => `endpoint:${ep.id}` === activeSourceId);

  const filteredRightModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (selectedLeftProvider) {
      return selectedLeftProvider.models.filter(
        (m) => !q || m.name.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)
      );
    }
    if (selectedLeftEndpoint) {
      return selectedLeftEndpoint.models
        .filter((m) => !q || m.toLowerCase().includes(q))
        .map((m) => ({ value: m, name: m, thoughtLevels: [] as ThoughtLevelOption[] }));
    }
    return [];
  }, [selectedLeftProvider, selectedLeftEndpoint, modelSearch]);

  const handleSelectModel = (providerId: TaskProviderId, modelId: string) => {
    const prov = providers.find((p) => p.id === providerId);
    const meta = prov?.models.find((m) => m.value === modelId);
    const levels = meta?.thoughtLevels !== undefined ? meta.thoughtLevels : prov?.thoughtLevels ?? [];
    let nextThought = task.thoughtLevel;
    if (levels.length === 0) {
      nextThought = "";
    } else if (!levels.some((lv) => lv.value === nextThought)) {
      nextThought = meta?.defaultThoughtLevel || prov?.defaultThoughtLevel || levels[0].value;
    }

    void api.updateTask(task.id, {
      providerId,
      modelId,
      thoughtLevel: nextThought,
    });
    setModelPickerOpen(false);
    setModelSearch("");
  };

  const handleRefreshProvider = async (pid: ProviderId) => {
    setProbingProviderId(pid);
    try {
      const res = await api.checkProvider(pid);
      setProviders(res.providers);
      toast(res.detail, res.ok ? "good" : "warn");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setProbingProviderId(null);
    }
  };

  return (
    <>
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
                setModelPickerOpen(false);
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
          {/* Two-Column Model Picker Button & Popover */}
          {providers.length > 0 && (
            <>
              <button
                ref={modelBtnRef}
                type="button"
                className="select-btn sm borderless"
                style={{ maxWidth: 230 }}
                onClick={() => setModelPickerOpen(!modelPickerOpen)}
              >
                <Icon name="cpu" size={14} className="ink2" />
                <span className="label">{currentModelButtonLabel}</span>
                <Icon name="chevDown" size={13} className="muted" />
              </button>

              <Popover
                anchor={modelBtnRef.current}
                open={modelPickerOpen}
                onClose={() => {
                  setModelPickerOpen(false);
                  setModelSearch("");
                }}
                placement="top"
                className="model-picker"
              >
                <div className="mp-grid">
                  {/* Left Column: Providers (agy / claude / codex) & Compatible Endpoints */}
                  <div className="mp-left">
                    <div className="mp-sec">官方订阅</div>
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={cx("mp-source", activeSourceId === p.id && "on")}
                        onMouseEnter={() => {
                          setActiveSourceId(p.id);
                          setModelSearch("");
                        }}
                        onClick={() => {
                          setActiveSourceId(p.id);
                          setModelSearch("");
                        }}
                      >
                        <span className={cx("mp-dot", p.available && "ok")} />
                        <span className="truncate">{p.shortName}</span>
                        <span className="cnt">{p.models.length}</span>
                      </button>
                    ))}

                    {endpoints.length > 0 && (
                      <>
                        <div className="mp-sec">兼容端点</div>
                        {endpoints.map((ep) => {
                          const key = `endpoint:${ep.id}`;
                          return (
                            <button
                              key={ep.id}
                              type="button"
                              className={cx("mp-source", activeSourceId === key && "on")}
                              onMouseEnter={() => {
                                setActiveSourceId(key);
                                setModelSearch("");
                              }}
                              onClick={() => {
                                setActiveSourceId(key);
                                setModelSearch("");
                              }}
                            >
                              <span className="mp-dot ep" />
                              <span className="truncate">{ep.name}</span>
                              <span className="cnt">{ep.models.length}</span>
                            </button>
                          );
                        })}
                      </>
                    )}

                    <div className="mp-left-foot">
                      <button
                        type="button"
                        className="mp-source"
                        style={{ color: "var(--muted)", fontSize: 12 }}
                        onClick={() => {
                          setModelPickerOpen(false);
                          nav("/settings/provider");
                        }}
                      >
                        <Icon name="plus" size={13} />
                        <span className="truncate">管理订阅与端点…</span>
                      </button>
                    </div>
                  </div>

                  {/* Right Column: Models for Selected Provider / Endpoint */}
                  <div className="mp-right">
                    <div className="mp-rhead">
                      <div className="meta">
                        <b className="truncate">
                          {selectedLeftProvider?.name || selectedLeftEndpoint?.name || "模型列表"}
                        </b>
                        <span className="truncate">
                          {selectedLeftProvider
                            ? selectedLeftProvider.subscriptionLabel
                            : selectedLeftEndpoint?.baseUrl}
                        </span>
                      </div>
                      {selectedLeftProvider && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="refresh"
                          title="实时同步该订阅下的最新模型与思考强度"
                          busy={probingProviderId === selectedLeftProvider.id}
                          onClick={() => void handleRefreshProvider(selectedLeftProvider.id)}
                        />
                      )}
                    </div>

                    {(selectedLeftProvider?.models.length ??
                      selectedLeftEndpoint?.models.length ??
                      0) >= 6 && (
                      <div className="mp-search">
                        <input
                          className="input sm"
                          placeholder="筛选模型…"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                        />
                      </div>
                    )}

                    <div className="mp-list">
                      {filteredRightModels.length === 0 ? (
                        <div className="empty" style={{ padding: 20 }}>
                          无匹配模型
                        </div>
                      ) : (
                        filteredRightModels.map((m) => {
                          const targetProv = (selectedLeftProvider?.id ||
                            `endpoint:${selectedLeftEndpoint?.id}`) as TaskProviderId;
                          const isSelected =
                            task.providerId === targetProv && task.modelId === m.value;
                          const badge = summarizeThoughtBadge(m.thoughtLevels);
                          return (
                            <button
                              key={m.value}
                              type="button"
                              className={cx("mp-model", isSelected && "on")}
                              onClick={() => handleSelectModel(targetProv, m.value)}
                            >
                              <div className="grow" style={{ minWidth: 0 }}>
                                <span className="mn truncate">{m.name}</span>
                                {m.name !== m.value && (
                                  <span className="ms truncate">{m.value}</span>
                                )}
                              </div>
                              {badge && <span className="mt">{badge}</span>}
                              {isSelected && <Icon name="check" size={14} />}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </Popover>
            </>
          )}

          {/* Dynamic Per-Model Thinking Level Selector (auto-hidden if model has no thought levels) */}
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
