import { useEffect, useState } from "react";
import type { ApprovalRequest, ToolCategory } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Check, Chip, Seg, Status } from "../components/ui.js";
import { cx } from "../lib/format.js";

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: "只读工具",
  edit: "文件编辑",
  delete: "文件删除 / 移动",
  shell: "终端命令",
  other: "外部工具",
};

export function ApprovalPanel({ approvals }: { approvals: ApprovalRequest[] }) {
  const { toast } = useApp();
  const current = approvals[0];
  const [rememberRule, setRememberRule] = useState(false);
  const [rulePattern, setRulePattern] = useState("");
  const [ruleScope, setRuleScope] = useState<"workspace" | "global">("workspace");
  const [denialReason, setDenialReason] = useState("");
  const [showDenyInput, setShowDenyInput] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (current) {
      setRememberRule(false);
      setRulePattern(current.suggestedRule || "");
      setRuleScope("workspace");
      setDenialReason("");
      setShowDenyInput(false);
    }
  }, [current?.id]);

  if (!current) return null;

  const isHighAlert = Boolean(current.risky || current.outsideWorkspace);
  const canRemember = Boolean(!isHighAlert && current.suggestedRule);

  const submit = async (decision: "allow_once" | "allow_always" | "deny") => {
    setBusy(true);
    try {
      await api.decideApproval(current.id, {
        decision,
        rulePattern: decision === "allow_always" ? rulePattern.trim() : undefined,
        ruleScope: decision === "allow_always" ? ruleScope : undefined,
        denialMessage: decision === "deny" ? denialReason : undefined,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx("dpanel approval", isHighAlert && "risky")}>
      <div className="dpanel-head">
        <Icon name={isHighAlert ? "warning" : "shield"} size={17} />
        <b>
          {current.outsideWorkspace
            ? "越出工作目录操作需要你确认"
            : current.risky
              ? "高风险操作需要你确认"
              : "请求执行工具操作"}
        </b>
        <Chip mono>{current.toolName}</Chip>
        {current.category && <Chip>{CATEGORY_LABEL[current.category]}</Chip>}
        {current.outsideWorkspace && <Chip tone="crit">越出工作目录</Chip>}
        {current.risky && <Chip tone="crit">高风险</Chip>}
        {approvals.length > 1 && <Chip tone="warn">还有 {approvals.length - 1} 项待确认</Chip>}
      </div>

      <div className="dpanel-body">
        <pre className="code-block">
          {current.detail || JSON.stringify(current.rawInput, null, 2)}
        </pre>

        {/* Clear explanation of why Avent intercepted this operation */}
        {current.reasons && current.reasons.length > 0 && (
          <div className="perm-reasons">
            {current.reasons.map((reason, idx) => (
              <div key={idx} className="perm-reason-item">
                <Icon
                  name={isHighAlert ? "warning" : "info"}
                  size={13}
                  className={isHighAlert ? undefined : "accent"}
                />
                <span>{reason}</span>
              </div>
            ))}
          </div>
        )}

        {/* Compound shell breakdown so chained commands are immediately transparent */}
        {current.subCommands && current.subCommands.length > 1 && (
          <div className="perm-subcmds">
            <div className="hint" style={{ fontWeight: 600 }}>
              复合命令拆解（共 {current.subCommands.length} 条子命令，逐条校验）
            </div>
            {current.subCommands.map((seg, i) => (
              <div key={i} className="perm-subcmd-row">
                <Status
                  tone={
                    seg.classification === "read_only"
                      ? "good"
                      : seg.classification === "destructive"
                        ? "crit"
                        : "warn"
                  }
                >
                  {seg.classification === "read_only"
                    ? "纯只读"
                    : seg.classification === "destructive"
                      ? "高危"
                      : "需确认"}
                </Status>
                <code className="mono truncate grow" title={seg.raw}>
                  {seg.raw}
                </code>
              </div>
            ))}
          </div>
        )}

        {canRemember ? (
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            <Check on={rememberRule} onChange={setRememberRule}>
              记住此允许规则：
            </Check>
            {rememberRule && (
              <>
                <input
                  className="input sm mono"
                  style={{ maxWidth: 260 }}
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value)}
                />
                <Seg
                  value={ruleScope}
                  options={[
                    { value: "workspace", label: "当前工作区" },
                    { value: "global", label: "全局" },
                  ]}
                  onChange={setRuleScope}
                />
              </>
            )}
          </div>
        ) : (
          <div className="hint">
            高危、越界或包含重定向 / 动态执行的命令不支持一键记住为自动放行，仅支持单次确认。
          </div>
        )}

        {showDenyInput && (
          <input
            className="input sm"
            placeholder="可选：告诉智能体为什么拒绝，或改用什么方式…"
            value={denialReason}
            onChange={(e) => setDenialReason(e.target.value)}
          />
        )}
      </div>

      <div className="dpanel-foot">
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          disabled={rememberRule && !rulePattern.trim()}
          onClick={() => void submit(canRemember && rememberRule ? "allow_always" : "allow_once")}
        >
          {canRemember && rememberRule ? "允许并记住规则" : "允许这一次"}
        </Button>
        {!showDenyInput ? (
          <Button
            variant="danger-outline"
            size="sm"
            disabled={busy}
            onClick={() => setShowDenyInput(true)}
          >
            拒绝…
          </Button>
        ) : (
          <Button
            variant="danger"
            size="sm"
            busy={busy}
            onClick={() => void submit("deny")}
          >
            确认拒绝
          </Button>
        )}
        <span className="grow" />
        <span className="hint">可在「设置 → 权限」测试与管理规则</span>
      </div>
    </div>
  );
}
