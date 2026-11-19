import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Modal } from "../components/ui.js";
import { cx, isPlainEnter } from "../lib/format.js";

export function FolderPickerModal() {
  const { folderPickerOpen, setFolderPickerOpen, setWorkspaces, setActiveWorkspaceId, toast, t } =
    useApp();
  const [currentPath, setCurrentPath] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [roots, setRoots] = useState<Array<{ name: string; path: string }>>([]);
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const browse = async (target: string) => {
    setLoading(true);
    try {
      const res = await api.browseFs(target);
      setCurrentPath(res.currentPath);
      setManualInput(res.currentPath);
      setParentPath(res.parentPath);
      setRoots(res.roots);
      setDirs(res.directories);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "warn");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (folderPickerOpen) {
      void browse("");
    }
  }, [folderPickerOpen]);

  const handleConfirm = async () => {
    const chosen = manualInput.trim() || currentPath.trim();
    if (!chosen) return;
    setSubmitting(true);
    try {
      const res = await api.addWorkspace(chosen);
      setWorkspaces(res.workspaces);
      setActiveWorkspaceId(res.workspace.id);
      setFolderPickerOpen(false);
      toast(`已添加工作区：${res.workspace.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={folderPickerOpen}
      onClose={() => setFolderPickerOpen(false)}
      title={t("添加工作区")}
      subtitle="选择一个本地代码库或项目文件夹作为任务工作目录"
      footer={
        <>
          <Button onClick={() => setFolderPickerOpen(false)}>{t("取消")}</Button>
          <Button
            variant="primary"
            busy={submitting}
            disabled={!manualInput.trim() && !currentPath.trim()}
            onClick={() => void handleConfirm()}
          >
            添加此文件夹
          </Button>
        </>
      }
    >
      <div className="field">
        <label>文件夹路径</label>
        <div className="row">
          <input
            className="input mono"
            placeholder="例如 D:\src\my-project"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnter(e)) void browse(manualInput.trim());
            }}
          />
          <Button onClick={() => void browse(manualInput.trim())}>跳转</Button>
        </div>
      </div>

      {roots.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {roots.map((r) => (
            <Button
              key={r.path}
              size="sm"
              variant={currentPath.toLowerCase().startsWith(r.path.toLowerCase()) ? "soft" : "default"}
              onClick={() => void browse(r.path)}
            >
              {r.name}
            </Button>
          ))}
          {parentPath !== null && (
            <Button size="sm" icon="chevUp" onClick={() => void browse(parentPath)}>
              上级目录
            </Button>
          )}
        </div>
      )}

      <div className="folder-tree">
        {loading ? (
          <div className="loading-block">
            <span className="spinner" /> 正在读取目录…
          </div>
        ) : dirs.length === 0 ? (
          <div className="empty">当前目录下没有子文件夹</div>
        ) : (
          dirs.map((d) => (
            <div
              key={d.path}
              className={cx("folder-row", manualInput === d.path && "sel")}
              onClick={() => setManualInput(d.path)}
              onDoubleClick={() => void browse(d.path)}
            >
              <Icon name="folder" size={15} className="accent" />
              <span className="grow truncate">{d.name}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                双击进入
              </span>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
