import { useEffect, useRef, useState } from "react";
import type { SemanticState, TaskRecord } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Modal, Status } from "../components/ui.js";
import { Markdown } from "../components/Markdown.js";
import { cx, isPlainEnter, relTime } from "../lib/format.js";

function fmtClock(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export function SemanticStatePanel({
  task,
  states,
  onClose,
}: {
  task: TaskRecord;
  states: SemanticState[];
  onClose: () => void;
}) {
  const { openFilePreview, toast, lang, t } = useApp();
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("avent.statePanelWidth"));
    return saved >= 280 && saved <= 560 ? saved : 360;
  });
  const [dragging, setDragging] = useState(false);
  const [directiveDraft, setDirectiveDraft] = useState("");
  const [addingRule, setAddingRule] = useState(false);
  const [editingObjective, setEditingObjective] = useState(false);
  const [objectiveDraft, setObjectiveDraft] = useState("");
  const [savingObjective, setSavingObjective] = useState(false);

  // Dedicated History Modal (only shown when user clicks the subtle clock icon)
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVer, setHistoryVer] = useState<number | null>(null);
  const histDetailRef = useRef<HTMLDivElement>(null);

  const isNewDraft = task.id === "__new__";

  useEffect(() => {
    setEditingObjective(false);
    setHistoryOpen(false);
    setHistoryVer(null);
  }, [task.id]);

  useEffect(() => {
    if (histDetailRef.current) {
      histDetailRef.current.scrollTop = 0;
    }
  }, [historyVer, historyOpen]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(560, Math.max(280, window.innerWidth - e.clientX));
      setWidth(next);
      localStorage.setItem("avent.statePanelWidth", String(next));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const latestState: SemanticState | null = states[states.length - 1] ?? task.latestState;

  const reversedStates = [...states].reverse();
  const selectedHistoryState =
    reversedStates.find((s) => s.version === historyVer) ?? reversedStates[0] ?? null;

  const handleAddDirective = async () => {
    const txt = directiveDraft.trim();
    if (!txt) return;
    setAddingRule(true);
    try {
      await api.addDirective(task.id, txt);
      setDirectiveDraft("");
      toast("已添加持久约定，后续执行将自动遵循", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setAddingRule(false);
    }
  };

  const handleRemoveDirective = async (directiveId: string) => {
    try {
      await api.removeDirective(task.id, directiveId);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleSaveObjective = async () => {
    setSavingObjective(true);
    try {
      await api.updateTask(task.id, { originalObjective: objectiveDraft.trim() });
      setEditingObjective(false);
      toast(objectiveDraft.trim() ? "已更新任务目标" : "已重置任务目标为待明确", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSavingObjective(false);
    }
  };

  return (
    <>
      <aside className={cx("sstate-wrap", dragging && "dragging")} style={{ width }}>
        <div className="sstate-resize" onMouseDown={() => setDragging(true)} />
        <div className="sstate-panel">
          <div className="sstate-head">
            <Icon name="layers" size={16} className="accent" />
            <b>{t("状态记忆")}</b>
            <span className="grow" />
            {latestState && (
              <span className="muted" style={{ fontSize: 11 }}>
                {relTime(latestState.createdAt, lang)}
              </span>
            )}
            {states.length >= 2 && (
              <Button
                variant="ghost"
                size="sm"
                icon="clock"
                title={`查看历史状态记录（共 ${states.length} 次更新）`}
                onClick={() => {
                  setHistoryVer(states[states.length - 1].version);
                  setHistoryOpen(true);
                }}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              icon="panelRight"
              title={t("隐藏状态记忆")}
              onClick={onClose}
            />
          </div>

          <div className="sstate-body">
            {/* 1. Objective & Persistent Directives */}
            <section className="sstate-card">
              <div className="sstate-card-title">
                <Icon name="pin" size={13} className="accent" />
                <span>{t("任务目标与持久约定")}</span>
                {!task.originalObjective && <Status tone="warn">待明确</Status>}
                {task.steeringDirectives.length > 0 && (
                  <span className="count">{task.steeringDirectives.length} 条约定</span>
                )}
                {!isNewDraft && !editingObjective && (
                  <button
                    type="button"
                    className="btn ghost sm icon-only"
                    style={{
                      width: 22,
                      height: 22,
                      marginLeft: task.steeringDirectives.length > 0 ? 4 : "auto",
                    }}
                    title="手动编辑任务目标"
                    onClick={() => {
                      setObjectiveDraft(task.originalObjective);
                      setEditingObjective(true);
                    }}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                )}
              </div>

              {!isNewDraft && editingObjective ? (
                <div className="col" style={{ gap: 6 }}>
                  <textarea
                    autoFocus
                    className="textarea"
                    style={{ minHeight: 68, fontSize: 12.5 }}
                    placeholder="输入明确的任务目标（留空保存将恢复为待明确状态）…"
                    value={objectiveDraft}
                    onChange={(e) => setObjectiveDraft(e.target.value)}
                  />
                  <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <Button size="sm" onClick={() => setEditingObjective(false)}>
                      {t("取消")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      busy={savingObjective}
                      onClick={() => void handleSaveObjective()}
                    >
                      {t("保存")}
                    </Button>
                  </div>
                </div>
              ) : task.originalObjective ? (
                <div className="sstate-objective">{task.originalObjective}</div>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>
                  {isNewDraft
                    ? "发送第一条消息后，智能体会自动归纳任务目标，并支持随时手动编辑目标或添加持久约定。"
                    : "尚未明确具体目标。在左侧说明你的需求后，智能体会自动归纳并更新目标；也可以随时点击右上角铅笔手动设定。"}
                </div>
              )}

              {task.steeringDirectives.length > 0 && (
                <div className="col" style={{ gap: 5 }}>
                  {task.steeringDirectives.map((d) => (
                    <div
                      key={d.id}
                      className={cx("sstate-directive", d.source === "model" && "model")}
                      title={
                        d.source === "model"
                          ? "由智能体从对话中自动识别为长期约定（点击右侧 × 可随时删除）"
                          : "你手动添加的持久约定"
                      }
                    >
                      <Icon
                        name={d.source === "model" ? "spark" : "shield"}
                        size={13}
                        className={d.source === "model" ? "accent" : undefined}
                      />
                      <span className="grow">{d.directive}</span>
                      <button
                        type="button"
                        className="del-btn"
                        title="移除此约定"
                        onClick={() => void handleRemoveDirective(d.id)}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {!isNewDraft && (
                <div className="row" style={{ marginTop: 2 }}>
                  <input
                    className="input sm"
                    placeholder={t("添加持久约定（如：始终使用 npm.cmd）…")}
                    value={directiveDraft}
                    onChange={(e) => setDirectiveDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (isPlainEnter(e)) void handleAddDirective();
                    }}
                  />
                  <Button
                    size="sm"
                    busy={addingRule}
                    disabled={!directiveDraft.trim()}
                    onClick={() => void handleAddDirective()}
                  >
                    {t("添加")}
                  </Button>
                </div>
              )}
            </section>

            {!latestState ? (
              <section className="sstate-card">
                <div className="empty" style={{ padding: "18px 8px" }}>
                  <b>尚未生成状态记忆</b>
                  任务执行过程中，关键进展、已确认的代码事实、修改验证记录与已排除的方案都会自动沉淀到这里。
                </div>
              </section>
            ) : (
              <StateDetailCards
                state={latestState}
                workspaceId={task.workspaceId}
                onOpenFile={(wsId, ptr) => openFilePreview(wsId, ptr, task.id)}
                t={t}
              />
            )}
          </div>
        </div>
      </aside>

      {/* Dedicated Modal for Viewing Historical State Snapshots */}
      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        className="hist-modal"
        title="状态演进历史"
        subtitle={`共记录 ${states.length} 个阶段快照，点击左侧时间节点可回看当时沉淀的事实、计划与结论`}
        footer={<Button onClick={() => setHistoryOpen(false)}>关闭</Button>}
      >
        <div className="hist-grid">
          <div className="hist-list">
            {reversedStates.map((st, idx) => (
              <button
                key={st.version}
                type="button"
                className={cx("hist-row", selectedHistoryState?.version === st.version && "on")}
                onClick={() => setHistoryVer(st.version)}
              >
                <div className="row" style={{ width: "100%" }}>
                  <b>{idx === 0 ? "最新状态" : `第 ${st.version} 次更新`}</b>
                  <span className="grow" />
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {fmtClock(st.createdAt)}
                  </span>
                </div>
                <div className="hist-pv truncate">{st.deliverableSummary}</div>
                <div className="row" style={{ gap: 6, marginTop: 2 }}>
                  <Status
                    tone={
                      st.status === "COMPLETED"
                        ? "good"
                        : st.status === "CONTINUE"
                          ? "info"
                          : "idle"
                    }
                  >
                    {st.status === "COMPLETED"
                      ? "已达成"
                      : st.status === "CONTINUE"
                        ? "推进中"
                        : "待反馈"}
                  </Status>
                  {st.establishedFacts.length > 0 && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {st.establishedFacts.length} 条事实
                    </span>
                  )}
                  {st.appliedChanges.length > 0 && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {st.appliedChanges.length} 处改动
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>

          <div ref={histDetailRef} className="hist-detail">
            {selectedHistoryState && (
              <>
                <section className="sstate-card">
                  <div className="sstate-card-title">
                    <Icon name="chat" size={13} className="accent" />
                    <span>阶段小结</span>
                    <span className="count">{relTime(selectedHistoryState.createdAt, lang)}</span>
                  </div>
                  <Markdown text={selectedHistoryState.deliverableSummary} />
                </section>
                <StateDetailCards
                  state={selectedHistoryState}
                  workspaceId={task.workspaceId}
                  onOpenFile={(wsId, ptr) => {
                    setHistoryOpen(false);
                    openFilePreview(wsId, ptr, task.id);
                  }}
                  t={t}
                />
              </>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

function StateDetailCards({
  state,
  workspaceId,
  onOpenFile,
  t,
}: {
  state: SemanticState;
  workspaceId: string;
  onOpenFile: (wsId: string, pointer: string) => void;
  t: (k: string) => string;
}) {
  return (
    <>
      {/* Progress & Remaining Plan */}
      <section className="sstate-card">
        <div className="sstate-card-title">
          <Icon name="list" size={13} className="accent" />
          <span>{t("当前进展与下一步计划")}</span>
          <span className="count">
            {state.status === "COMPLETED"
              ? "已达成"
              : state.status === "CONTINUE"
                ? "推进中"
                : "待反馈"}
          </span>
        </div>

        {state.immediateNextAction && state.status === "CONTINUE" && (
          <div className="sstate-next">
            <b>下一步行动：</b>
            {state.immediateNextAction}
          </div>
        )}

        {state.remainingPlan.length > 0 ? (
          <div className="col" style={{ gap: 6 }}>
            {state.remainingPlan.map((step, i) => (
              <div key={i} className="plan-item">
                <span className={cx("plan-dot", i === 0 && "active")} />
                <span>{step}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            {state.status === "COMPLETED"
              ? "全部计划项均已完成。"
              : "当前无待办子步骤，可随时在左侧对话继续追问或下达新指令。"}
          </div>
        )}
      </section>

      {/* Verified Facts & Open Hypotheses */}
      {(state.establishedFacts.length > 0 || state.openHypotheses.length > 0) && (
        <section className="sstate-card">
          <div className="sstate-card-title">
            <Icon name="check" size={13} className="accent" />
            <span>{t("已确认事实与待验证假设")}</span>
            <span className="count">{state.establishedFacts.length}</span>
          </div>

          {state.establishedFacts.map((f, i) => {
            const pointers = f.sourcePointer
              ? f.sourcePointer
                  .split(/,\s*/)
                  .map((p) => p.trim())
                  .filter(Boolean)
              : [];
            return (
              <div key={i} className="sstate-fact">
                <div>{f.fact}</div>
                {pointers.length > 0 && (
                  <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                    {pointers.map((ptr, j) => (
                      <Chip
                        key={j}
                        mono
                        outline
                        icon="file"
                        title={`点击查看源码：${ptr}`}
                        onClick={() => onOpenFile(workspaceId, ptr)}
                      >
                        <span className="truncate" style={{ maxWidth: 260 }}>
                          {ptr}
                        </span>
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {state.openHypotheses.length > 0 && (
            <div className="col" style={{ gap: 4, marginTop: 4 }}>
              <div className="hint" style={{ fontWeight: 600 }}>
                待验证假设
              </div>
              {state.openHypotheses.map((h, i) => (
                <div
                  key={i}
                  className="row"
                  style={{
                    alignItems: "flex-start",
                    fontSize: 12,
                    color: "var(--warn-ink)",
                    background: "var(--warn-soft)",
                    padding: "5px 8px",
                    borderRadius: 6,
                  }}
                >
                  <Icon name="bulb" size={13} />
                  <span>{h}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Changes & Verification */}
      {(state.appliedChanges.length > 0 || state.verificationChecks.length > 0) && (
        <section className="sstate-card">
          <div className="sstate-card-title">
            <Icon name="file" size={13} className="accent" />
            <span>{t("文件改动与验证记录")}</span>
            <span className="count">{state.appliedChanges.length} 个文件</span>
          </div>

          {state.appliedChanges.map((chg, i) => (
            <div key={i} className="sstate-fact">
              <div className="row">
                <Chip
                  mono
                  tone={chg.verified ? "good" : "warn"}
                  onClick={() => onOpenFile(workspaceId, chg.filePath)}
                >
                  {chg.filePath}
                </Chip>
                <Status tone={chg.verified ? "good" : "warn"}>
                  {chg.verified ? "已验证" : "待验证"}
                </Status>
              </div>
              <div className="ink2" style={{ fontSize: 12 }}>
                {chg.summary}
              </div>
            </div>
          ))}

          {state.verificationChecks.map((vc, i) => (
            <div
              key={i}
              className="row"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 12,
              }}
            >
              <Status
                tone={
                  vc.outcome === "PASS"
                    ? "good"
                    : vc.outcome === "FAIL"
                      ? "crit"
                      : "warn"
                }
              >
                {vc.outcome}
              </Status>
              <span className="mono truncate grow" title={vc.command}>
                {vc.command}
              </span>
            </div>
          ))}
        </section>
      )}

      {/* Excluded Dead-Ends */}
      {state.deadEnds.length > 0 && (
        <section className="sstate-card">
          <div className="sstate-card-title">
            <Icon name="warning" size={13} style={{ color: "var(--crit)" }} />
            <span>{t("已排除方案")}</span>
            <span className="count">{state.deadEnds.length}</span>
          </div>
          {state.deadEnds.map((de, i) => (
            <div key={i} className="sstate-dead">
              <b>× {de.approach}</b>
              <span className="ink2">{de.reasonFailed}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
