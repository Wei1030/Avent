import { memo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TaskRecord, TranscriptItem } from "../../shared/types.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Chip, UserAvatar } from "../components/ui.js";
import { Markdown } from "../components/Markdown.js";
import { cx, fmtDuration, fmtTokens } from "../lib/format.js";

const TOOL_ICON: Record<string, string> = {
  Bash: "terminal",
  Read: "file",
  Write: "file",
  Edit: "pencil",
  Grep: "search",
  Glob: "search",
};

type StepItem = Extract<TranscriptItem, { kind: "thinking" | "tool" }>;

function isStep(it: TranscriptItem): it is StepItem {
  return it.kind === "thinking" || it.kind === "tool";
}

function groupBlocks(items: TranscriptItem[]): Array<TranscriptItem | StepItem[]> {
  const out: Array<TranscriptItem | StepItem[]> = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (!isStep(it)) {
      out.push(it);
    } else if (Array.isArray(last)) {
      last.push(it);
    } else {
      out.push([it]);
    }
  }
  return out;
}

export function TranscriptView({
  task,
  items,
}: {
  task: TaskRecord;
  items: TranscriptItem[];
}) {
  const nav = useNavigate();
  const { openFilePreview } = useApp();

  if (items.length === 0 && task.status === "DRAFT") {
    return (
      <div className="draft-empty">
        <div className="hero-icon">
          <Icon name="bolt" size={22} />
        </div>
        <h2>开始一项新任务</h2>
        <div className="ink2">
          直接输入你的想法或需求。Avent 会在后台自动维护结构化的「状态记忆」，在长链路多步骤任务中始终保持上下文清晰与准确。
        </div>
      </div>
    );
  }

  const blocks = groupBlocks(items);
  const isLiveRunning = task.status === "PULSING" || task.status === "WAITING_APPROVAL";

  return (
    <>
      {blocks.map((blk, idx) => {
        if (Array.isArray(blk)) {
          return (
            <StepsGroup
              key={`steps_${blk[0].id}`}
              steps={blk}
              workspaceId={task.workspaceId}
              live={isLiveRunning && idx === blocks.length - 1}
            />
          );
        }

        switch (blk.kind) {
          case "user":
            return (
              <div key={blk.id} className="umsg">
                <UserAvatar size={12} />
                <div className="text">{blk.text}</div>
                {(blk.refs.length > 0 || blk.attachments.length > 0) && (
                  <div className="atts">
                    {blk.refs.map((r) => (
                      <Chip
                        key={r.taskId}
                        icon="link"
                        onClick={() => nav(`/t/${r.taskId}`)}
                        title="点击跳转到被引用的任务"
                      >
                        任务：{r.title}
                      </Chip>
                    ))}
                    {blk.attachments.map((a) => (
                      <Chip
                        key={a.id}
                        mono
                        icon="file"
                        onClick={
                          a.path
                            ? () => openFilePreview(task.workspaceId, a.path!)
                            : undefined
                        }
                      >
                        {a.path || a.name}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            );

          case "text":
            return (
              <div key={blk.id} className="atext">
                <Markdown text={blk.text} />
                {blk.streaming && <span className="caret" />}
                {blk.aborted && <span className="aborted-tag">（已停止）</span>}
              </div>
            );

          case "footer":
            return (
              <div key={blk.id} className="footer-line">
                {blk.stopReason === "interrupted" ? (
                  <>
                    <Icon name="stop" size={11} />第 {blk.turn} 轮 · 已停止
                  </>
                ) : (
                  <>
                    第 {blk.turn} 轮 · {fmtDuration(blk.seconds)}
                    {blk.toolCalls > 0 ? ` · ${blk.toolCalls} 次工具调用` : ""} ·{" "}
                    {fmtTokens(blk.tokens)} tokens
                  </>
                )}
              </div>
            );

          case "notice":
            return (
              <div key={blk.id} className={cx("notice", blk.tone)}>
                <Icon
                  name={
                    blk.tone === "good" ? "check" : blk.tone === "warn" ? "warning" : "info"
                  }
                  size={15}
                />
                <span>{blk.text}</span>
              </div>
            );

          default:
            return null;
        }
      })}

      {isLiveRunning && items.length > 0 && items[items.length - 1].kind === "user" && (
        <div className="row accent" style={{ fontSize: 12.5, padding: "4px 2px" }}>
          <span className="spinner" />
          <span>正在连接执行引擎并分析任务…</span>
        </div>
      )}
    </>
  );
}

const StepsGroup = memo(function StepsGroup({
  steps,
  workspaceId,
  live,
}: {
  steps: StepItem[];
  workspaceId: string;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thoughts = steps.filter((s) => s.kind === "thinking");
  const tools = steps.filter(
    (s): s is Extract<StepItem, { kind: "tool" }> => s.kind === "tool"
  );
  const uniqueToolNames = [...new Set(tools.map((t) => t.tool))];
  const hasWaiting = tools.some((t) => t.status === "waiting");
  const failedCount = tools.filter((t) => t.status === "error" || t.status === "denied").length;
  const activeTool = [...tools].reverse().find((t) => t.status === "running");
  const lastStep = steps[steps.length - 1];

  const liveActivity = !live
    ? ""
    : lastStep?.kind === "thinking" && lastStep.streaming
      ? "正在思考…"
      : activeTool
        ? `${activeTool.tool} ${activeTool.detail}`
        : "";

  const countSummary = [
    thoughts.length > 0 ? `思考 ${thoughts.length} 次` : "",
    tools.length > 0 ? `工具调用 ${tools.length} 次` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="steps">
      <div className="steps-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevDown" : "chevRight"} size={14} />
        <span className="counts">{countSummary}</span>
        {uniqueToolNames.slice(0, 4).map((name) => (
          <Chip key={name} mono>
            {name}
          </Chip>
        ))}
        {hasWaiting && <Chip tone="warn">等待确认</Chip>}
        {failedCount > 0 && <Chip tone="crit">{failedCount} 项未执行</Chip>}
        {liveActivity && (
          <span className="now">
            <span className="spinner" />
            {liveActivity}
          </span>
        )}
      </div>

      {(open || hasWaiting) && (
        <div className="steps-body">
          {steps.map((st) =>
            st.kind === "thinking" ? (
              <ThinkingBlock key={st.id} item={st} />
            ) : (
              <ToolCardView key={st.id} tool={st} workspaceId={workspaceId} />
            )
          )}
        </div>
      )}
    </div>
  );
});

function ThinkingBlock({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "thinking" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <div className="thinking-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevDown" : "chevRight"} size={13} />
        <Icon name="bulb" size={13} />
        <b>{item.streaming ? "思考中…" : `思考 · ${item.seconds} 秒`}</b>
        {!open && <span className="pv">{item.text}</span>}
      </div>
      {open && <div className="thinking-body">{item.text}</div>}
    </div>
  );
}

function ToolCardView({
  tool,
  workspaceId,
}: {
  tool: Extract<TranscriptItem, { kind: "tool" }>;
  workspaceId: string;
}) {
  const { openFilePreview } = useApp();
  const hasBody = Boolean(tool.output || tool.denialMessage);
  const [open, setOpen] = useState(tool.output?.type === "diff");

  return (
    <div
      className={cx(
        "tcard",
        tool.status === "waiting" && "waiting",
        tool.status === "denied" && "denied"
      )}
    >
      <div className="thead" onClick={() => hasBody && setOpen(!open)}>
        <Icon name={TOOL_ICON[tool.tool] ?? "plug"} size={14} className="ink2" />
        <span className="name">{tool.tool}</span>
        <span
          className={cx("detail", Boolean(tool.filePath) && "link")}
          onClick={
            tool.filePath
              ? (e) => {
                  e.stopPropagation();
                  openFilePreview(workspaceId, tool.filePath!);
                }
              : undefined
          }
        >
          {tool.detail}
        </span>
        {tool.provenance && <Chip>{tool.provenance}</Chip>}
        {tool.status === "running" ? (
          <span className="spinner" />
        ) : tool.status === "ok" ? (
          <Icon name="check" size={14} className="st-ok" strokeWidth={2.2} />
        ) : tool.status === "waiting" ? (
          <Icon name="warning" size={14} className="st-waiting" />
        ) : (
          <Icon name="x" size={14} className="st-denied" strokeWidth={2.2} />
        )}
        {hasBody && <Icon name={open ? "chevUp" : "chevDown"} size={13} className="muted" />}
      </div>

      {open && hasBody && (
        <div className="tbody">
          {tool.output?.type === "diff" && (
            <div className="diff">
              {tool.output.lines.map((ln, idx) => (
                <div
                  key={idx}
                  className={
                    ln.startsWith("@@")
                      ? "hunk"
                      : ln.startsWith("+")
                        ? "add"
                        : ln.startsWith("-")
                          ? "del"
                          : ""
                  }
                >
                  {ln}
                </div>
              ))}
            </div>
          )}
          {tool.output?.type === "text" && (
            <pre className="code-block">{tool.output.text}</pre>
          )}
          {tool.output?.type === "code" && (
            <pre className="code-block">{tool.output.lines.join("\n")}</pre>
          )}
          {tool.denialMessage && <div className="denial">拒绝原因：{tool.denialMessage}</div>}
        </div>
      )}
    </div>
  );
}
