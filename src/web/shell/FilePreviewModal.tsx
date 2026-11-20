import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Button, Chip, Modal } from "../components/ui.js";
import { cx } from "../lib/format.js";

export function FilePreviewModal() {
  const { filePreview, closeFilePreview } = useApp();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    path: string;
    totalLines: number;
    content: string;
    truncated: boolean;
  } | null>(null);
  const markRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filePreview) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .readWorkspaceFile(filePreview.workspaceId, filePreview.filePath, filePreview.taskId)
      .then((res) => {
        setData(res);
        setTimeout(() => {
          markRef.current?.scrollIntoView({ block: "center" });
        }, 50);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [filePreview]);

  if (!filePreview) return null;

  const lines = data ? data.content.split("\n") : [];
  const startL = filePreview.startLine ?? 0;
  const endL = filePreview.endLine ?? startL;

  return (
    <Modal
      open={Boolean(filePreview)}
      onClose={closeFilePreview}
      wide
      title={
        <span className="row">
          <span className="mono">{data?.path || filePreview.filePath}</span>
          {startL > 0 && (
            <Chip tone="accent" mono>
              L{startL}
              {endL > startL ? `-L${endL}` : ""}
            </Chip>
          )}
        </span>
      }
      subtitle={data ? `共 ${data.totalLines} 行${data.truncated ? "（仅展示前 800 行）" : ""}` : undefined}
      footer={<Button onClick={closeFilePreview}>关闭</Button>}
    >
      {loading ? (
        <div className="loading-block">
          <span className="spinner" /> 正在加载文件内容…
        </div>
      ) : error ? (
        <div className="notice warn">{error}</div>
      ) : (
        <div className="file-view">
          {lines.map((line, idx) => {
            const lineNum = idx + 1;
            const isMarked = startL > 0 && lineNum >= startL && lineNum <= endL;
            return (
              <div
                key={lineNum}
                ref={isMarked && lineNum === startL ? markRef : undefined}
                className={cx("fl", isMarked && "mark")}
              >
                <span className="ln">{lineNum}</span>
                <span className="lc">{line || " "}</span>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
