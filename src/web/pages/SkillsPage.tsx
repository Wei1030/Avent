import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SkillRecord } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Modal, Seg } from "../components/ui.js";
import { cx } from "../lib/format.js";

export function SkillsPage() {
  const { activeWorkspace, toast, t } = useApp();
  const nav = useNavigate();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [editorText, setEditorText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newScope, setNewScope] = useState<"workspace" | "global">("workspace");
  const [newBody, setNewBody] = useState("");

  const load = async () => {
    const res = await api.listSkills(activeWorkspace?.id);
    setSkills(res.skills);
    setSelectedId((cur) => {
      const target =
        res.skills.find((s) => s.id === cur) ?? res.skills[0];
      if (target) {
        setEditorText(target.content);
        setDirty(false);
      }
      return target?.id ?? "";
    });
  };

  useEffect(() => {
    void load();
  }, [activeWorkspace?.id]);

  const selected = skills.find((s) => s.id === selectedId) ?? skills[0];

  const handleSelect = (s: SkillRecord) => {
    setSelectedId(s.id);
    setEditorText(s.content);
    setDirty(false);
  };

  const handleSaveExisting = async () => {
    if (!selected || !selected.editable) return;
    setSaving(true);
    try {
      const res = await api.saveSkill({
        name: selected.name,
        description: selected.description,
        scope: selected.scope === "global" ? "global" : "workspace",
        workspaceId: selected.workspaceId || activeWorkspace?.id,
        body: editorText,
      });
      await load();
      setSelectedId(res.skill.id);
      setDirty(false);
      toast(`已保存技能 /${res.skill.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSaving(false);
    }
  };

  const handleCreateSkill = async () => {
    if (!newName.trim() || !newBody.trim()) return;
    setSaving(true);
    try {
      const res = await api.saveSkill({
        name: newName,
        description: newDesc || newName,
        scope: newScope,
        workspaceId: newScope === "workspace" ? activeWorkspace?.id : undefined,
        body: newBody,
      });
      setCreateOpen(false);
      setNewName("");
      setNewDesc("");
      setNewBody("");
      await load();
      setSelectedId(res.skill.id);
      setEditorText(res.skill.content);
      toast(`已创建技能 /${res.skill.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: SkillRecord) => {
    try {
      await api.deleteSkill(s.id);
      await load();
      toast(`已删除技能 /${s.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleRunInNewTask = async (s: SkillRecord) => {
    try {
      const res = await api.createTask({
        workspaceId: activeWorkspace?.id,
        title: `执行 /${s.name}`,
        objective: `/${s.name}`,
      });
      nav(`/t/${res.task.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>技能与快捷指令</h1>
          <Chip>{skills.length}</Chip>
          <div className="grow" />
          <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            新建技能
          </Button>
        </div>
        <p className="page-sub">
          将常用的工程检查流、代码规范或排查步骤封装为 Markdown 技能模板，在任意任务输入框输入{" "}
          <code className="mono">/技能名</code> 即可一键调用。
        </p>

        <div className="ext-layout">
          {/* Left Skill List */}
          <div className="ext-list">
            <h5>内置技能</h5>
            {skills
              .filter((s) => s.scope === "builtin")
              .map((s) => (
                <div
                  key={s.id}
                  className={cx("ext-item", s.id === selected?.id && "on")}
                  onClick={() => handleSelect(s)}
                >
                  <div className="top">
                    <Icon name="spark" size={14} className="accent" />
                    <b className="mono">/{s.name}</b>
                  </div>
                  <div className="sub truncate">{s.description}</div>
                </div>
              ))}

            <h5>自定义技能</h5>
            {skills.filter((s) => s.scope !== "builtin").length === 0 ? (
              <div className="empty" style={{ padding: "18px 10px" }}>
                暂无自定义技能，点击右上角「新建技能」创建
              </div>
            ) : (
              skills
                .filter((s) => s.scope !== "builtin")
                .map((s) => (
                  <div
                    key={s.id}
                    className={cx("ext-item", s.id === selected?.id && "on")}
                    onClick={() => handleSelect(s)}
                  >
                    <div className="top">
                      <Icon name="spark" size={14} className="ink2" />
                      <b className="mono">/{s.name}</b>
                      <span className="grow" />
                      <Chip>{s.scope === "global" ? "全局" : "工作区"}</Chip>
                    </div>
                    <div className="sub truncate">{s.description}</div>
                  </div>
                ))
            )}
          </div>

          {/* Right Skill Detail & Editor */}
          {selected && (
            <div className="ext-detail">
              <div className="panel">
                <div className="panel-head">
                  <Icon name="spark" size={17} className="accent" />
                  <h3 className="mono">/{selected.name}</h3>
                  <Chip>
                    {selected.scope === "builtin"
                      ? "内置只读"
                      : selected.scope === "global"
                        ? "全局技能"
                        : "当前工作区"}
                  </Chip>
                  <div className="actions">
                    <Button
                      size="sm"
                      icon="play"
                      onClick={() => void handleRunInNewTask(selected)}
                    >
                      发起新任务执行
                    </Button>
                    {selected.editable && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          busy={saving}
                          disabled={!dirty}
                          onClick={() => void handleSaveExisting()}
                        >
                          {t("保存")}
                        </Button>
                        <Button
                          variant="danger-outline"
                          size="sm"
                          icon="trash"
                          onClick={() => void handleDelete(selected)}
                        >
                          {t("删除")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="panel-body col" style={{ gap: 10 }}>
                  <div className="ink2">{selected.description}</div>
                  {selected.filePath && (
                    <div className="hint mono">文件路径：{selected.filePath}</div>
                  )}
                  <textarea
                    className="editor"
                    readOnly={!selected.editable}
                    value={editorText}
                    onChange={(e) => {
                      setEditorText(e.target.value);
                      setDirty(true);
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Skill Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建自定义技能"
        subtitle="保存为本地 Markdown 文件，支持在任务输入框通过 / 快速展开"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>{t("取消")}</Button>
            <Button
              variant="primary"
              busy={saving}
              disabled={!newName.trim() || !newBody.trim()}
              onClick={() => void handleCreateSkill()}
            >
              创建技能
            </Button>
          </>
        }
      >
        <div className="row" style={{ gap: 16 }}>
          <div className="field grow">
            <label>指令名称 (仅限英文、数字与连字符)</label>
            <input
              className="input mono"
              placeholder="例如 pre-commit-check"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>保存位置</label>
            <Seg
              value={newScope}
              options={[
                { value: "workspace", label: "当前工作区 (.avent/skills)" },
                { value: "global", label: "全局通用" },
              ]}
              onChange={setNewScope}
            />
          </div>
        </div>

        <div className="field">
          <label>简短描述</label>
          <input
            className="input"
            placeholder="例如：提交代码前检查类型、单测与未清理的调试语句"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
        </div>

        <div className="field">
          <label>技能提示词正文 (Markdown)</label>
          <textarea
            className="editor"
            style={{ minHeight: 180 }}
            placeholder="编写智能体在调用该技能时应遵循的具体步骤与验收标准…"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
