import { useEffect, useState } from "react";
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  QuotaWindowBucket,
  UsageReport,
  UsageWindowSummary,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Seg, Select, Status } from "../components/ui.js";
import { cx, fmtTokens, relTime } from "../lib/format.js";

function fmtResetCountdown(iso?: string): { short: string; full?: string } {
  if (!iso) return { short: "" };
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { short: iso };
  const diffMs = ts - Date.now();
  const full = new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (diffMs <= 0) return { short: "即将重置", full };
  const totalMins = Math.max(1, Math.round(diffMs / 60_000));
  if (totalMins < 60) return { short: `${totalMins} 分钟后重置`, full };
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) {
    return { short: mins > 0 ? `${hours} 小时 ${mins} 分后重置` : `${hours} 小时后重置`, full };
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return { short: remH > 0 ? `${days} 天 ${remH} 小时后重置` : `${days} 天后重置`, full };
}

function sourceBadgeLabel(source: ProviderQuotaSnapshot["source"]): string {
  switch (source) {
    case "active_cli":
      return "CLI 实时";
    case "active_sdk":
      return "SDK 实时";
    case "active_acp":
      return "ACP 实时";
    case "passive_event":
      return "运行期捕获";
    default:
      return "未接入";
  }
}

function QuotaBucketBar({ bucket }: { bucket: QuotaWindowBucket }) {
  const tone =
    bucket.status === "rejected" || bucket.usedPercent >= 85
      ? "crit"
      : bucket.status === "allowed_warning" || bucket.usedPercent >= 60
        ? "warn"
        : "normal";
  const reset = fmtResetCountdown(bucket.resetsAt);

  return (
    <div className="quota-bucket">
      <div className="quota-bucket-top">
        <span className="quota-bucket-label">
          <Icon name="clock" size={13} className="muted" />
          <span>{bucket.label}</span>
        </span>
        <span className="quota-bucket-meta">
          <b className={cx(tone === "crit" && "crit", tone === "warn" && "warn")}>
            剩余 {bucket.remainingPercent}%
          </b>
          <span className="muted">（已用 {bucket.usedPercent}%）</span>
          {reset.short && (
            <span className="quota-reset" title={reset.full ? `预计于 ${reset.full} 重置` : undefined}>
              · {reset.short}
            </span>
          )}
          {!reset.short && bucket.description && (
            <span className="quota-reset">· {bucket.description}</span>
          )}
        </span>
      </div>
      <div className={cx("quota-bar", tone)}>
        <div style={{ width: `${Math.max(bucket.usedPercent > 0 ? 2 : 0, bucket.usedPercent)}%` }} />
      </div>
    </div>
  );
}

function RollingWindowCard({
  title,
  subtitle,
  win,
}: {
  title: string;
  subtitle: string;
  win?: UsageWindowSummary;
}) {
  return (
    <div className="rolling-card">
      <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
        <b>{title}</b>
        <span className="hint">{subtitle}</span>
        <span className="grow" />
        <span className="rolling-val">{fmtTokens(win?.totalTokens ?? 0)}</span>
      </div>
      <div className="row" style={{ gap: 10, fontSize: 12, color: "var(--ink-2)" }}>
        <span>
          输入 <b className="mono">{fmtTokens(win?.inputTokens ?? 0)}</b>
        </span>
        <span>·</span>
        <span>
          输出 <b className="mono">{fmtTokens(win?.outputTokens ?? 0)}</b>
        </span>
        <span>·</span>
        <span>{win?.turns ?? 0} 轮执行</span>
      </div>
      {win && win.byProvider.length > 0 ? (
        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 2 }}>
          {win.byProvider.map((p) => (
            <Chip key={p.providerId} outline mono>
              {p.label} · {fmtTokens(p.totalTokens)}
            </Chip>
          ))}
        </div>
      ) : (
        <div className="hint">该窗口内暂无调用记录</div>
      )}
    </div>
  );
}

export function UsagePage() {
  const { workspaces, quotas, setQuotas, toast } = useApp();
  const [range, setRange] = useState<"7d" | "30d" | "all">("7d");
  const [wsFilter, setWsFilter] = useState<string>("all");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingId, setRefreshingId] = useState<ProviderId | null>(null);

  useEffect(() => {
    void api
      .getUsage(range, wsFilter === "all" ? undefined : wsFilter)
      .then((res) => setReport(res.report))
      .catch(() => {});
  }, [range, wsFilter]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getQuotas(false)
      .then((res) => {
        if (cancelled) return;
        setQuotas(res.quotas);
        const needsRefresh = res.quotas.some(
          (q) =>
            q.available &&
            (!q.checkedAt || Date.now() - Date.parse(q.checkedAt) > 60_000)
        );
        if (needsRefresh) {
          setRefreshingAll(true);
          void api
            .getQuotas(true)
            .then((fresh) => {
              if (!cancelled) setQuotas(fresh.quotas);
            })
            .catch(() => {})
            .finally(() => {
              if (!cancelled) setRefreshingAll(false);
            });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setQuotas]);

  const handleRefreshQuotas = async (providerId?: ProviderId) => {
    if (providerId) setRefreshingId(providerId);
    else setRefreshingAll(true);
    try {
      const res = await api.refreshQuotas(providerId);
      setQuotas(res.quotas);
      toast("已刷新订阅实时额度", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setRefreshingAll(false);
      setRefreshingId(null);
    }
  };

  const maxDayTokens = Math.max(
    1000,
    ...(report?.days.map((d) => d.totalTokens) ?? [1000])
  );

  const availableQuotas = quotas.filter((q) => q.available);
  const unavailableQuotas = quotas.filter((q) => !q.available);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>Token 用量与订阅额度</h1>
          <div className="grow" />
          <Select
            size="sm"
            className="w-180"
            icon="folder"
            value={wsFilter}
            options={[
              { value: "all", label: "全部工作区" },
              ...workspaces.map((w) => ({ value: w.id, label: w.name })),
            ]}
            onChange={setWsFilter}
          />
          <Seg
            value={range}
            options={[
              { value: "7d", label: "近 7 天" },
              { value: "30d", label: "近 30 天" },
              { value: "all", label: "全部" },
            ]}
            onChange={setRange}
          />
        </div>
        <p className="page-sub">
          实时查看各订阅的 5 小时与每周额度窗口，以及全服务（含兼容 API 端点）在本地的滑动窗口与历史消耗明细。
        </p>

        {/* Live Subscription Quotas (5h & Weekly) */}
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <Icon name="bolt" size={16} className="accent" />
            <h3>订阅实时额度（5 小时 / 每周）</h3>
            <span className="sub">官方接口直查 + 运行期实时事件捕获（零 Token 消耗）</span>
            <div className="actions">
              <Button
                size="sm"
                icon="refresh"
                busy={refreshingAll}
                onClick={() => void handleRefreshQuotas()}
              >
                刷新额度
              </Button>
            </div>
          </div>

          <div className="panel-body col" style={{ gap: 12 }}>
            {availableQuotas.length === 0 ? (
              <div className="empty" style={{ padding: "18px 8px" }}>
                尚未检测到已就绪的订阅 CLI（agy / claude / codex）。安装并登录后即可查看实时窗口额度。
              </div>
            ) : (
              <div className="quota-grid">
                {availableQuotas.map((q) => (
                  <div key={q.providerId} className="quota-card">
                    <div className="quota-card-head">
                      <b>{q.providerName}</b>
                      {q.planLabel && <Chip tone="accent">{q.planLabel}</Chip>}
                      <Status tone={q.error ? "warn" : q.groups.length > 0 ? "good" : "info"}>
                        {sourceBadgeLabel(q.source)}
                      </Status>
                      <span className="grow" />
                      {q.checkedAt && (
                        <span className="hint" style={{ fontSize: 11 }}>
                          {relTime(q.checkedAt)}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="refresh"
                        busy={refreshingId === q.providerId}
                        title={`刷新 ${q.providerName} 额度`}
                        onClick={() => void handleRefreshQuotas(q.providerId)}
                      />
                    </div>

                    {q.error && (
                      <div className="notice warn" style={{ padding: "6px 10px", fontSize: 12 }}>
                        <Icon name="warning" size={14} />
                        <span>{q.error}</span>
                      </div>
                    )}

                    {q.groups.length > 0 ? (
                      <div className="col" style={{ gap: 12 }}>
                        {q.groups.map((grp) => (
                          <div key={grp.id} className="quota-group">
                            {q.groups.length > 1 && (
                              <div className="quota-group-head">
                                <b>{grp.name}</b>
                                {grp.description && (
                                  <span className="hint truncate" title={grp.description}>
                                    {grp.description.replace(/^Models within this group:\s*/i, "")}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="col" style={{ gap: 8 }}>
                              {grp.buckets.map((b) => (
                                <QuotaBucketBar key={b.id} bucket={b} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="col" style={{ gap: 8 }}>
                        {["5 小时窗口", "每周窗口"].map((lbl) => (
                          <div key={lbl} className="quota-bucket">
                            <div className="quota-bucket-top">
                              <span className="quota-bucket-label">
                                <Icon name="clock" size={13} className="muted" />
                                <span>{lbl}</span>
                              </span>
                              <span className="muted">—</span>
                            </div>
                            <div className="quota-bar">
                              <div style={{ width: "0%" }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {q.extraNote && <div className="hint" style={{ lineHeight: 1.5 }}>{q.extraNote}</div>}
                  </div>
                ))}
              </div>
            )}

            {unavailableQuotas.length > 0 && (
              <div className="hint" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Icon name="info" size={13} className="muted" />
                <span>
                  未就绪订阅：
                  {unavailableQuotas
                    .map((q) => `${q.providerName}${q.extraNote ? `（${q.extraNote}）` : ""}`)
                    .join("；")}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Universal Local Rolling 5h / 7d Consumption */}
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <Icon name="clock" size={15} className="accent" />
            <h3>本地滑动窗口消耗（全服务通用）</h3>
            <span className="sub">
              基于本机实际执行记录按秒统计，涵盖所有订阅与第三方兼容 API 端点
              {wsFilter !== "all" ? "（当前仅统计所选工作区）" : ""}
            </span>
          </div>
          <div className="panel-body">
            <div className="rolling-grid">
              <RollingWindowCard
                title="近 5 小时累计"
                subtitle="对应 5h 短期额度窗口节奏"
                win={report?.rolling5h}
              />
              <RollingWindowCard
                title="近 7 天累计"
                subtitle="对应每周额度窗口节奏"
                win={report?.rolling7d}
              />
            </div>
          </div>
        </div>

        {/* 4 Summary KPI Tiles */}
        <div className="tiles">
          <div className="tile">
            <div className="k">总 Token 消耗</div>
            <div className="v">{fmtTokens(report?.totals.totalTokens ?? 0)}</div>
            <div className="s">含输入提示与模型输出</div>
          </div>
          <div className="tile">
            <div className="k">输入 / 输出分布</div>
            <div className="v">
              {fmtTokens(report?.totals.inputTokens ?? 0)}{" "}
              <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}>
                / {fmtTokens(report?.totals.outputTokens ?? 0)}
              </span>
            </div>
            <div className="s">精简状态摘要输入占比更可控</div>
          </div>
          <div className="tile">
            <div className="k">累计任务数</div>
            <div className="v">{report?.totals.taskCount ?? 0}</div>
            <div className="s">已完成 {report?.totals.completedCount ?? 0} 项任务</div>
          </div>
          <div className="tile">
            <div className="k">累计执行轮次</div>
            <div className="v">{report?.totals.turnCount ?? 0}</div>
            <div className="s">每轮自动清理冗余历史缓存</div>
          </div>
        </div>

        {/* Daily Bar Chart + Model Breakdown */}
        <div className="usage-grid">
          <div className="panel">
            <div className="panel-head">
              <h3>每日用量趋势</h3>
              <div className="actions" style={{ fontSize: 12 }}>
                <span className="row" style={{ gap: 5 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: "var(--accent)",
                      display: "inline-block",
                    }}
                  />
                  输入 Tokens
                </span>
                <span className="row" style={{ gap: 5 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: "var(--s3)",
                      display: "inline-block",
                    }}
                  />
                  输出 Tokens
                </span>
              </div>
            </div>

            <div className="panel-body" style={{ position: "relative" }}>
              {report && (
                <svg
                  viewBox={`0 0 640 210`}
                  style={{ width: "100%", height: 210, display: "block" }}
                >
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                    const y = 175 - ratio * 150;
                    return (
                      <g key={ratio}>
                        <line
                          x1={44}
                          x2={624}
                          y1={y}
                          y2={y}
                          stroke="var(--border)"
                          strokeDasharray={ratio === 0 ? undefined : "3 3"}
                        />
                        <text x={38} y={y + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
                          {fmtTokens(Math.round(maxDayTokens * ratio))}
                        </text>
                      </g>
                    );
                  })}

                  {report.days.map((d, i) => {
                    const slotW = 580 / Math.max(1, report.days.length);
                    const barW = Math.min(28, Math.max(8, slotW * 0.55));
                    const x = 44 + i * slotW + (slotW - barW) / 2;
                    const inH = (d.inputTokens / maxDayTokens) * 150;
                    const outH = (d.outputTokens / maxDayTokens) * 150;
                    return (
                      <g
                        key={d.day}
                        onMouseEnter={() => setHoverIdx(i)}
                        onMouseLeave={() => setHoverIdx(null)}
                        style={{ cursor: "pointer" }}
                      >
                        <rect x={44 + i * slotW} y={15} width={slotW} height={175} fill="transparent" />
                        <rect
                          x={x}
                          y={175 - inH}
                          width={barW}
                          height={Math.max(0, inH)}
                          rx={2}
                          fill="var(--accent)"
                        />
                        <rect
                          x={x}
                          y={175 - inH - outH}
                          width={barW}
                          height={Math.max(0, outH)}
                          rx={2}
                          fill="var(--s3)"
                        />
                        {(report.days.length <= 10 || i % 4 === 0 || i === report.days.length - 1) && (
                          <text
                            x={x + barW / 2}
                            y={194}
                            textAnchor="middle"
                            fontSize={10}
                            fill="var(--muted)"
                          >
                            {d.day.slice(5)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}

              {report && hoverIdx !== null && report.days[hoverIdx] && (
                <div
                  style={{
                    position: "absolute",
                    top: 12,
                    right: 16,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "var(--shadow)",
                    padding: "6px 10px",
                    fontSize: 12,
                  }}
                >
                  <b>{report.days[hoverIdx].day}</b> · 总计{" "}
                  {fmtTokens(report.days[hoverIdx].totalTokens)} tokens（输入{" "}
                  {fmtTokens(report.days[hoverIdx].inputTokens)} / 输出{" "}
                  {fmtTokens(report.days[hoverIdx].outputTokens)}）
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>按订阅与模型统计</h3>
            </div>
            <div className="panel-body">
              {!report || report.byModel.length === 0 ? (
                <div className="empty" style={{ padding: "24px 8px" }}>
                  尚无模型调用记录
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th className="num">轮次</th>
                      <th className="num">总计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byModel.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <div className="mono" style={{ fontWeight: 600 }}>
                            {row.label}
                          </div>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {row.subLabel}
                          </div>
                        </td>
                        <td className="num">{row.turns}</td>
                        <td className="num">{fmtTokens(row.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* By Workspace Table */}
        <div className="panel">
          <div className="panel-head">
            <h3>按工作区明细</h3>
          </div>
          <div className="panel-body">
            {!report || report.byWorkspace.length === 0 ? (
              <div className="empty" style={{ padding: "18px 8px" }}>
                暂无工作区消耗记录
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>工作区</th>
                    <th className="num">涉及任务</th>
                    <th className="num">执行轮次</th>
                    <th className="num">输入 Tokens</th>
                    <th className="num">输出 Tokens</th>
                    <th className="num">合计</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byWorkspace.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <b>{row.label}</b>
                        {row.subLabel && (
                          <div className="mono muted" style={{ fontSize: 11 }}>
                            {row.subLabel}
                          </div>
                        )}
                      </td>
                      <td className="num">{row.tasks}</td>
                      <td className="num">{row.turns}</td>
                      <td className="num">{fmtTokens(row.inputTokens)}</td>
                      <td className="num">{fmtTokens(row.outputTokens)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {fmtTokens(row.totalTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
