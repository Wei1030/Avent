const EN_DICT: Record<string, string> = {
  任务: "Tasks",
  MCP: "MCP",
  技能: "Skills",
  用量: "Usage",
  设置: "Settings",
  工作区: "Workspaces",
  添加工作区: "Add Workspace",
  "添加工作区…": "Add Workspace…",
  新建任务: "New Task",
  全部任务: "All Tasks",
  "全部任务 →": "All Tasks →",
  最近任务: "Recent Tasks",
  搜索任务与设置: "Search tasks & settings…",
  等你处理: "Needs Attention",
  暂无待审批操作: "No pending approvals",
  状态记忆: "Task State",
  隐藏状态记忆: "Hide Task State",
  展开状态记忆: "Show Task State",
  任务目标与持久约定: "Objective & Rules",
  当前进展与下一步计划: "Progress & Plan",
  已确认事实与待验证假设: "Verified Facts & Hypotheses",
  文件改动与验证记录: "Changes & Verification",
  已排除方案: "Excluded Approaches",
  "添加持久约定（如：始终使用 npm.cmd）…": "Add persistent rule (e.g. Always use npm.cmd)…",
  添加: "Add",
  执行中: "Running",
  等待审批: "Waiting Approval",
  已完成: "Completed",
  异常中断: "Failed",
  待继续: "Ready",
  就绪: "Idle",
  发送: "Send",
  停止: "Stop",
  排队发送: "Queue",
  默认询问: "Ask by Default",
  自动接受编辑: "Accept Edits",
  全自动执行: "Auto Execute",
  通用: "General",
  权限: "Permissions",
  项目说明: "Instructions",
  订阅与模型: "Subscriptions",
  语言: "Language",
  保存: "Save",
  取消: "Cancel",
  删除: "Delete",
  重命名: "Rename",
  检测连接: "Test Connection",
  重新检测: "Re-check",
  复制登录命令: "Copy Login Command",
};

export function resolveEffectiveLang(pref: "auto" | "zh-CN" | "en"): "zh-CN" | "en" {
  if (pref === "zh-CN" || pref === "en") return pref;
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("en")) {
    return "en";
  }
  return "zh-CN";
}

export function translate(
  lang: "zh-CN" | "en",
  key: string,
  vars?: Record<string, string | number>
): string {
  let out = lang === "en" ? EN_DICT[key] ?? key : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}
