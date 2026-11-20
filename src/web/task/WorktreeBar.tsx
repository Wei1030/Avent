import { useCallback, useEffect, useState } from "react";
import type { TaskRecord, WorktreeLiveStatus } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Status } from "../components/ui.js";

export function WorktreeBar({ task }: { task: TaskRecord }) {
  const { confirmWithOption, toast } = useApp();
  const [status, setStatus] = useState<WorktreeLiveStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [sendingResolve, setSendingResolve] = useState(false);
  const [blockedMainMsg, setBlockedMainMsg] = useState<string | null>(null);

  const isRunning = task.status === "PULSING" || task.status === "WAITING_APPROVAL";
  const baseBranch = status?.baseBranch || task.worktreeBaseBranch || "main";
  const branch = status?.branch || task.worktreeBranch || "";

  const refresh = useCallback(async () => {
    if (!task.worktreePath || task.worktreeRemoved) return;
    setLoading(true);
    try {
      const res = await api.getTaskWorktree(task.id);
      setStatus(res.status);
    } catch {
      // ignore transient errors
    } finally {
      setLoading(false);
    }
  }, [task.id, task.worktreePath, task.worktreeRemoved]);

  useEffect(() => {
    setBlockedMainMsg(null);
    void refresh();
  }, [refresh, task.status, task.updatedAt, task.worktreeMergedAt]);

  if (!task.worktreePath || task.worktreeRemoved) return null;

  const hasChangesToMerge =
    Boolean(status?.exists) &&
    !status?.rebasing &&
    ((status?.ahead ?? 0) > 0 || (status?.dirtyFiles.length ?? 0) > 0);

  const handleMerge = async () => {
    if (isRunning) {
      toast("任务正在运行中，请等待本轮结束后再合回", "warn");
      return;
    }
    setMerging(true);
    setBlockedMainMsg(null);
    try {
      const res = await api.mergeTaskWorktree(task.id, {
        autoCommit: true,
        commitMessage: task.title && task.title !== "新任务" ? task.title : undefined,
      });
      setStatus(res.result.status);
      if (res.result.outcome === "merged") {
        toast(res.result.message, "good");
      } else if (res.result.outcome === "nothing_to_merge") {
        toast(res.result.message, "good");
      } else if (res.result.outcome === "blocked_dirty_main") {
        setBlockedMainMsg(res.result.message);
        toast("工作树 Rebase 已完成，但主工作区有未提交改动", "warn");
      } else if (res.result.outcome === "conflict") {
        toast("工作树内 Rebase 发生冲突（主目录未受影响），可让智能体就地解决", "warn");
      } else {
        toast(res.result.message, "crit");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setMerging(false);
    }
  };

  const handleAbortRebase = async () => {
    setAborting(true);
    try {
      const res = await api.abortWorktreeRebase(task.id);
      setStatus(res.status);
      toast("已中止 Rebase 并恢复工作树状态", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setAborting(false);
    }
  };

  const handleAskAgentResolve = async () => {
    const files = status?.conflictFiles ?? [];
    const fileListText = files.length > 0 ? files.join("、") : "存在冲突的文件";
    setSendingResolve(true);
    try {
      await api.sendMessage(task.id, {
        text: `当前独立工作树分支 (${branch}) 向 ${baseBranch} 执行 rebase 时在以下文件产生冲突：${fileListText}。\n请在你当前工作树目录中查看冲突标记，结合双方改动正确解决冲突，执行 git add 与 git rebase --continue 完成变基，并验证项目代码无误。`,
      });
      toast("已指示智能体在工作树内就地解决冲突", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSendingResolve(false);
    }
  };

  const handleRemove = async () => {
    const unmerged = (status?.ahead ?? 0) > 0 || (status?.dirtyFiles.length ?? 0) > 0;
    const { ok, checked } = await confirmWithOption({
      title: "清理独立工作树",
      message: `确定要清理此任务对应的独立工作树（${branch}）吗？`,
      detail: unmerged
        ? `警告：该工作树目前还有 ${status?.ahead ?? 0} 个未合回提交、${status?.dirtyFiles.length ?? 0} 处未提交改动。清理目录不会影响主工作区，也不会删除任务对话记录。`
        : "工作树目录将被移除，任务对话记录与状态记忆会完整保留。",
      confirmLabel: "确认清理",
      danger: true,
      checkbox: {
        label: `同时删除临时分支 ${branch}`,
        defaultChecked: !unmerged,
      },
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const res = await api.removeTaskWorktree(task.id, checked);
      if (res.warning) {
        toast(res.warning, "warn");
      } else {
        toast("已清理独立工作树", "good");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="wt-bar-wrap">
      <div className="wt-bar">
        <div className="row" style={{ gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          <Chip tone="accent" mono icon="branch" title={task.worktreePath}>
            {branch}
          </Chip>
          <span className="muted" style={{ fontSize: 11.5 }}>
            基于 <code className="mono">{baseBranch}</code>
          </span>

          {status && !status.exists && <Status tone="warn">目录已移除</Status>}
          {status?.exists && status.rebasing && <Status tone="crit">Rebase 冲突中</Status>}
          {status?.exists && !status.rebasing && status.merged && (
            <Status tone="good">已合回 {baseBranch}</Status>
          )}
          {status?.exists && status.ahead > 0 && (
            <Chip tone="good">+{status.ahead} 提交</Chip>
          )}
          {status?.exists && status.behind > 0 && (
            <Chip tone="warn">落后 {status.behind}</Chip>
          )}
          {status?.exists && status.dirtyFiles.length > 0 && (
            <Chip tone="warn">{status.dirtyFiles.length} 处未提交</Chip>
          )}
          {status?.exists &&
            !status.rebasing &&
            !status.merged &&
            status.ahead === 0 &&
            status.dirtyFiles.length === 0 && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                暂无新改动
              </span>
            )}
        </div>

        <div className="grow" />

        <div className="row" style={{ gap: 6, flex: "none" }}>
          {status?.exists && !status.rebasing && hasChangesToMerge && (
            <Button
              variant="primary"
              size="sm"
              icon="branch"
              busy={merging}
              disabled={isRunning}
              title={`在工作树内先 Rebase 到 ${baseBranch}，再以 Fast-Forward 安全合回主分支`}
              onClick={() => void handleMerge()}
            >
              一键合回 {baseBranch}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            busy={loading}
            title="刷新工作树 Git 状态"
            onClick={() => void refresh()}
          />
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            busy={removing}
            disabled={isRunning}
            title="清理工作树目录"
            onClick={() => void handleRemove()}
          >
            清理
          </Button>
        </div>
      </div>

      {/* Conflict banner: conflicts stay strictly inside the worktree! */}
      {status?.rebasing && (
        <div className="wt-alert crit">
          <Icon name="warning" size={15} />
          <div className="grow" style={{ minWidth: 0 }}>
            <b>工作树内 Rebase 冲突（主目录完全不受影响）</b>
            <div className="hint" style={{ color: "inherit", opacity: 0.9 }}>
              {status.conflictFiles.length > 0
                ? `冲突文件：${status.conflictFiles.join("、")}`
                : "请解决冲突后执行 git rebase --continue，或中止此次 Rebase。"}
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            busy={sendingResolve}
            disabled={isRunning}
            onClick={() => void handleAskAgentResolve()}
          >
            让智能体解决冲突
          </Button>
          <Button
            variant="danger-outline"
            size="sm"
            busy={aborting}
            disabled={isRunning}
            onClick={() => void handleAbortRebase()}
          >
            中止 Rebase
          </Button>
        </div>
      )}

      {/* Dirty main workspace warning after successful in-worktree rebase */}
      {blockedMainMsg && !status?.rebasing && (
        <div className="wt-alert warn">
          <Icon name="warning" size={15} />
          <div className="grow">{blockedMainMsg}</div>
          <Button size="sm" busy={merging} disabled={isRunning} onClick={() => void handleMerge()}>
            重试合回
          </Button>
        </div>
      )}
    </div>
  );
}
