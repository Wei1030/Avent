import { useEffect, useState } from "react";
import type { ApprovalRequest } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Check, Chip } from "../components/ui.js";
import { cx } from "../lib/format.js";

export function ApprovalPanel({ approvals }: { approvals: ApprovalRequest[] }) {
  const { toast } = useApp();
  const current = approvals[0];
  const [rememberRule, setRememberRule] = useState(false);
  const [rulePattern, setRulePattern] = useState("");
  const [denialReason, setDenialReason] = useState("");
  const [showDenyInput, setShowDenyInput] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (current) {
      setRememberRule(false);
      setRulePattern(current.suggestedRule);
      setDenialReason("");
      setShowDenyInput(false);
    }
  }, [current?.id]);

  if (!current) return null;

  const submit = async (decision: "allow_once" | "allow_always" | "deny") => {
    setBusy(true);
    try {
      await api.decideApproval(current.id, {
        decision,
        rulePattern: decision === "allow_always" ? rulePattern : undefined,
        ruleScope: "workspace",
        denialMessage: decision === "deny" ? denialReason : undefined,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx("dpanel approval", current.risky && "risky")}>
      <div className="dpanel-head">
        <Icon name={current.risky ? "warning" : "shield"} size={17} />
        <b>{current.risky ? "高风险操作需要你确认" : "请求执行工具操作"}</b>
        <Chip mono>{current.toolName}</Chip>
        {approvals.length > 1 && <Chip tone="warn">还有 {approvals.length - 1} 项待确认</Chip>}
      </div>

      <div className="dpanel-body">
        <pre className="code-block">{current.detail || JSON.stringify(current.rawInput, null, 2)}</pre>

        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <Check on={rememberRule} onChange={setRememberRule}>
            在本工作区记住此允许规则：
          </Check>
          {rememberRule && (
            <input
              className="input sm mono"
              style={{ maxWidth: 280 }}
              value={rulePattern}
              onChange={(e) => setRulePattern(e.target.value)}
            />
          )}
        </div>

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
          onClick={() => void submit(rememberRule ? "allow_always" : "allow_once")}
        >
          {rememberRule ? "允许并记住规则" : "允许这一次"}
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
        <span className="hint">可在「设置 → 权限」中随时管理自动放行规则</span>
      </div>
    </div>
  );
}
