import { useEffect, useState } from "react";
import type { SemanticState, TaskRecord } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Status } from "../components/ui.js";
import { Markdown } from "../components/Markdown.js";
import { cx, isPlainEnter, relTime } from "../lib/format.js";

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
  const [selectedVer, setSelectedVer] = useState<number | "latest">("latest");
  const [directiveDraft, setDirectiveDraft] = useState("");
  const [addingRule, setAddingRule] = useState(false);

  // Reset to latest whenever a new state version arrives
  useEffect(() => {
    setSelectedVer("latest");
  }, [task.id, states.length]);

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

  const activeState: SemanticState | null =
    selectedVer === "latest"
      ? states[states.length - 1] ?? task.latestState
      : states.find((s) => s.version === selectedVer) ?? task.latestState;

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

  return (
    <aside className={cx("sstate-wrap", dragging && "dragging")} style={{ width }}>
      <div className="sstate-resize" onMouseDown={() => setDragging(true)} />
      <div className="sstate-panel">
        <div className="sstate-head">
          <Icon name="layers" size={16} className="accent" />
          <b>{t("状态记忆")}</b>
          {activeState && (
            <Chip tone="accent" mono>
              v{activeState.version}
            </Chip>
          )}
          <span className="grow" />
          {activeState && (
            <span className="muted" style={{ fontSize: 11 }}>
              {relTime(activeState.createdAt, lang)}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="panelRight"
            title={t("隐藏状态记忆")}
            onClick={onClose}
          />
        </div>

        {states.length > 1 && (
          <div className="sstate-versions">
            <button
              type="button"
              className={cx("sstate-vpill", selectedVer === "latest" && "on")}
              onClick={() => setSelectedVer("latest")}
            >
              最新 (v{states[states.length - 1].version})
            </button>
            {[...states]
              .reverse()
              .slice(1)
              .map((s) => (
                <button
                  key={s.version}
                  type="button"
                  className={cx("sstate-vpill", selectedVer === s.version && "on")}
                  onClick={() => setSelectedVer(s.version)}
                >
                  v{s.version}
                </button>
              ))}
          </div>
        )}

        <div className="sstate-body">
          {/* 1. Objective & Persistent Directives */}
          <section className="sstate-card">
            <div className="sstate-card-title">
              <Icon name="pin" size={13} className="accent" />
              <span>{t("任务目标与持久约定")}</span>
              {task.steeringDirectives.length > 0 && (
                <span className="count">{task.steeringDirectives.length} 条约定</span>
              )}
            </div>

            {task.originalObjective ? (
              <div className="sstate-objective">{task.originalObjective}</div>
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>
                发送第一条消息后，这里将锁定本任务的核心目标与持久约束。
              </div>
            )}

            {task.steeringDirectives.length > 0 && (
              <div className="col" style={{ gap: 5 }}>
                {task.steeringDirectives.map((d) => (
                  <div key={d.id} className="sstate-directive">
                    <Icon name="shield" size={13} />
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
          </section>

          {!activeState ? (
            <section className="sstate-card">
              <div className="empty" style={{ padding: "18px 8px" }}>
                <b>尚未生成状态快照</b>
                任务执行过程中，关键进展、已确认的代码事实、修改验证记录与已排除的死胡同都会自动沉淀到这里。
              </div>
            </section>
          ) : (
            <>
              {/* 2. Progress & Remaining Plan */}
              <section className="sstate-card">
                <div className="sstate-card-title">
                  <Icon name="list" size={13} className="accent" />
                  <span>{t("当前进展与下一步计划")}</span>
                  <span className="count">
                    {activeState.status === "COMPLETED"
                      ? "已达成"
                      : activeState.status === "CONTINUE"
                        ? "推进中"
                        : "待反馈"}
                  </span>
                </div>

                {activeState.immediateNextAction && activeState.status === "CONTINUE" && (
                  <div className="sstate-next">
                    <b>下一步行动：</b>
                    {activeState.immediateNextAction}
                  </div>
                )}

                {activeState.remainingPlan.length > 0 ? (
                  <div className="col" style={{ gap: 6 }}>
                    {activeState.remainingPlan.map((step, i) => (
                      <div key={i} className="plan-item">
                        <span className={cx("plan-dot", i === 0 && "active")} />
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {activeState.status === "COMPLETED"
                      ? "全部计划项均已完成。"
                      : "当前无待办子步骤，可随时在左侧对话继续追问或下达新指令。"}
                  </div>
                )}
              </section>

              {/* 3. Verified Facts & Open Hypotheses */}
              {(activeState.establishedFacts.length > 0 ||
                activeState.openHypotheses.length > 0) && (
                <section className="sstate-card">
                  <div className="sstate-card-title">
                    <Icon name="check" size={13} className="accent" />
                    <span>{t("已确认事实与待验证假设")}</span>
                    <span className="count">{activeState.establishedFacts.length}</span>
                  </div>

                  {activeState.establishedFacts.map((f, i) => {
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
                                onClick={() => openFilePreview(task.workspaceId, ptr)}
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

                  {activeState.openHypotheses.length > 0 && (
                    <div className="col" style={{ gap: 4, marginTop: 4 }}>
                      <div className="hint" style={{ fontWeight: 600 }}>
                        待验证假设
                      </div>
                      {activeState.openHypotheses.map((h, i) => (
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

              {/* 4. Changes & Verification */}
              {(activeState.appliedChanges.length > 0 ||
                activeState.verificationChecks.length > 0) && (
                <section className="sstate-card">
                  <div className="sstate-card-title">
                    <Icon name="file" size={13} className="accent" />
                    <span>{t("文件改动与验证记录")}</span>
                    <span className="count">{activeState.appliedChanges.length} 个文件</span>
                  </div>

                  {activeState.appliedChanges.map((chg, i) => (
                    <div key={i} className="sstate-fact">
                      <div className="row">
                        <Chip
                          mono
                          tone={chg.verified ? "good" : "warn"}
                          onClick={() => openFilePreview(task.workspaceId, chg.filePath)}
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

                  {activeState.verificationChecks.map((vc, i) => (
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

              {/* 5. Excluded Approaches (Dead-Ends) */}
              {activeState.deadEnds.length > 0 && (
                <section className="sstate-card">
                  <div className="sstate-card-title">
                    <Icon name="warning" size={13} style={{ color: "var(--crit)" }} />
                    <span>{t("已排除方案")}</span>
                    <span className="count">{activeState.deadEnds.length}</span>
                  </div>
                  {activeState.deadEnds.map((de, i) => (
                    <div key={i} className="sstate-dead">
                      <b>× {de.approach}</b>
                      <span className="ink2">{de.reasonFailed}</span>
                    </div>
                  ))}
                </section>
              )}

              {/* Historical Snapshot Summary Preview when viewing older v1..vN */}
              {selectedVer !== "latest" && activeState.deliverableSummary && (
                <section className="sstate-card">
                  <div className="sstate-card-title">
                    <Icon name="clock" size={13} />
                    <span>v{activeState.version} 阶段结论存档</span>
                  </div>
                  <Markdown text={activeState.deliverableSummary} />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
