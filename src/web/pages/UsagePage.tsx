import { useEffect, useState } from "react";
import type { UsageReport } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Seg, Select } from "../components/ui.js";
import { fmtTokens } from "../lib/format.js";

export function UsagePage() {
  const { workspaces } = useApp();
  const [range, setRange] = useState<"7d" | "30d" | "all">("7d");
  const [wsFilter, setWsFilter] = useState<string>("all");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    void api
      .getUsage(range, wsFilter === "all" ? undefined : wsFilter)
      .then((res) => setReport(res.report))
      .catch(() => {});
  }, [range, wsFilter]);

  const maxDayTokens = Math.max(
    1000,
    ...(report?.days.map((d) => d.totalTokens) ?? [1000])
  );

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>Token 用量统计</h1>
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
          追踪各工作区与各家订阅模型的实际上下文消耗。得益于短上下文重置与按需读取机制，任务长链路执行不会产生指数级历史堆积。
        </p>

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
