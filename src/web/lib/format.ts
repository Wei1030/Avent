import type { KeyboardEvent } from "react";
import type { TaskStatus } from "../../shared/types.js";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Guard Enter handlers so CJK IME composition Enter never prematurely submits forms!
 */
export function isPlainEnter(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (e.nativeEvent.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) {
    return false;
  }
  return true;
}

export function fmtTokens(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

export function relTime(iso: string, lang: "zh-CN" | "en" = "zh-CN"): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (lang === "en") {
    if (sec < 45) return "Just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }
  if (sec < 45) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

export function taskStatusDisplay(
  status: TaskStatus,
  t: (k: string) => string
): {
  label: string;
  tone: "good" | "warn" | "crit" | "info" | "idle";
  dotClass: "running" | "requires_action" | "good" | "crit" | "idle";
} {
  switch (status) {
    case "PULSING":
      return { label: t("执行中"), tone: "info", dotClass: "running" };
    case "WAITING_APPROVAL":
      return { label: t("等待审批"), tone: "warn", dotClass: "requires_action" };
    case "COMPLETED":
      return { label: t("已完成"), tone: "good", dotClass: "good" };
    case "FAILED":
      return { label: t("异常中断"), tone: "crit", dotClass: "crit" };
    case "WAITING_HUMAN":
      return { label: t("待继续"), tone: "idle", dotClass: "idle" };
    case "DRAFT":
      return { label: t("新任务"), tone: "idle", dotClass: "idle" };
    default:
      return { label: t("就绪"), tone: "idle", dotClass: "idle" };
  }
}

export function parseSourcePointer(pointer: string): {
  filePath: string;
  startLine?: number;
  endLine?: number;
} {
  const trimmed = pointer.trim();
  const hashMatch = /^([^#:]+)#L(\d+)(?:-L?(\d+))?$/i.exec(trimmed);
  if (hashMatch) {
    return {
      filePath: hashMatch[1],
      startLine: Number(hashMatch[2]),
      endLine: hashMatch[3] ? Number(hashMatch[3]) : Number(hashMatch[2]),
    };
  }
  const colonMatch = /^([^#:]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (colonMatch) {
    return {
      filePath: colonMatch[1],
      startLine: Number(colonMatch[2]),
      endLine: colonMatch[3] ? Number(colonMatch[3]) : Number(colonMatch[2]),
    };
  }
  return { filePath: trimmed };
}
