import { useEffect, useState } from "react";
import type { McpServerRecord } from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "../components/Icon.js";
import { Button, Chip, Modal, Seg, Status, Toggle } from "../components/ui.js";
import { cx } from "../lib/format.js";

export function McpPage() {
  const { activeWorkspace, toast, t } = useApp();
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Add modal form state
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "workspace">("workspace");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const res = await api.listMcp(activeWorkspace?.id);
    setServers(res.servers);
    setSelectedId((cur) =>
      cur && res.servers.some((s) => s.id === cur) ? cur : res.servers[0]?.id ?? ""
    );
  };

  useEffect(() => {
    void load();
  }, [activeWorkspace?.id]);

  const selected = servers.find((s) => s.id === selectedId) ?? servers[0];

  const handleTest = async (srv: McpServerRecord) => {
    setTestingId(srv.id);
    try {
      const res = await api.testMcp(srv.id, activeWorkspace?.id);
      setServers((prev) => prev.map((x) => (x.id === srv.id ? res.server : x)));
      if (res.ok) {
        toast(`连接成功，已读取 ${res.server.tools.length} 个工具`, "good");
      } else {
        toast(`连接未通过：${res.errorMessage || "未知错误"}`, "warn");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (srv: McpServerRecord, next: boolean) => {
    try {
      const res = await api.toggleMcp(srv.id, next);
      setServers((prev) => prev.map((x) => (x.id === srv.id ? res.server : x)));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleDelete = async (srv: McpServerRecord) => {
    try {
      await api.deleteMcp(srv.id);
      await load();
      toast(`已移除 MCP 服务：${srv.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const args = argsText
        .split(/\s+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const res = await api.saveMcp({
        name: name.trim(),
        scope,
        workspaceId: scope === "workspace" ? activeWorkspace?.id : undefined,
        transport,
        command: transport === "stdio" ? command.trim() : undefined,
        args: transport === "stdio" ? args : undefined,
        url: transport !== "stdio" ? url.trim() : undefined,
      });
      setAddOpen(false);
      setName("");
      setArgsText("");
      setUrl("");
      await load();
      setSelectedId(res.server.id);
      toast(`已添加 MCP 服务：${res.server.name}`, "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-title">
          <h1>MCP 服务扩展</h1>
          <Chip>{servers.length}</Chip>
          <div className="grow" />
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            添加 MCP 服务
          </Button>
        </div>
        <p className="page-sub">
          管理接入任务的 Model Context Protocol 工具源。已启用的本地 stdio 服务及项目根目录{" "}
          <code className="mono">.mcp.json</code> 会自动挂载到任务执行环境。
        </p>

        <div className="ext-layout">
          {/* Left Server List */}
          <div className="ext-list">
            <h5>内置核心服务</h5>
            {servers
              .filter((s) => s.builtIn)
              .map((s) => (
                <div
                  key={s.id}
                  className={cx("ext-item", s.id === selected?.id && "on")}
                  onClick={() => setSelectedId(s.id)}
                >
                  <div className="top">
                    <Icon name="plug" size={14} className="accent" />
                    <b>{s.name}</b>
                    <span className="grow" />
                    <Status tone="good">常驻就绪</Status>
                  </div>
                  <div className="sub">状态记忆与按需分段读取 · {s.tools.length} 个工具</div>
                </div>
              ))}

            <h5>全局与工作区扩展</h5>
            {servers.filter((s) => !s.builtIn).length === 0 ? (
              <div className="empty" style={{ padding: "18px 10px" }}>
                尚未配置外部 MCP 服务
              </div>
            ) : (
              servers
                .filter((s) => !s.builtIn)
                .map((s) => (
                  <div
                    key={s.id}
                    className={cx("ext-item", s.id === selected?.id && "on")}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <div className="top">
                      <Icon name="plug" size={14} className="ink2" />
                      <b className="truncate">{s.name}</b>
                      <span className="grow" />
                      <Status
                        tone={
                          !s.enabled
                            ? "idle"
                            : s.status === "ready"
                              ? "good"
                              : s.status === "error"
                                ? "crit"
                                : "info"
                        }
                      >
                        {!s.enabled
                          ? "已停用"
                          : s.status === "ready"
                            ? "已连接"
                            : s.status === "error"
                              ? "异常"
                              : "待检测"}
                      </Status>
                    </div>
                    <div className="sub">
                      <span>{s.scope === "global" ? "全局" : "当前工作区"}</span>
                      <span>·</span>
                      <span className="mono">{s.transport}</span>
                      {s.fromFile && <Chip mono>{s.fromFile}</Chip>}
                    </div>
                  </div>
                ))
            )}
          </div>

          {/* Right Server Detail */}
          {selected && (
            <div className="ext-detail">
              <div className="panel">
                <div className="panel-head">
                  <Icon name="plug" size={17} className="accent" />
                  <h3 className="mono">{selected.name}</h3>
                  <Chip>{selected.builtIn ? "系统内置" : selected.scope === "global" ? "全局生效" : "工作区专属"}</Chip>
                  <Chip mono>{selected.transport}</Chip>
                  <div className="actions">
                    {!selected.builtIn && !selected.fromFile && (
                      <Toggle
                        on={selected.enabled}
                        onChange={(next) => void handleToggle(selected, next)}
                        label={selected.enabled ? "已启用" : "已停用"}
                      />
                    )}
                    <Button
                      size="sm"
                      icon="refresh"
                      busy={testingId === selected.id}
                      onClick={() => void handleTest(selected)}
                    >
                      {t("检测连接")}
                    </Button>
                    {!selected.builtIn && !selected.fromFile && (
                      <Button
                        variant="danger-outline"
                        size="sm"
                        icon="trash"
                        onClick={() => void handleDelete(selected)}
                      >
                        {t("删除")}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="panel-body col" style={{ gap: 12 }}>
                  <dl className="kv">
                    {selected.transport === "stdio" ? (
                      <>
                        <dt>启动命令</dt>
                        <dd className="mono">
                          {selected.command} {(selected.args ?? []).join(" ")}
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt>服务地址</dt>
                        <dd className="mono">{selected.url}</dd>
                      </>
                    )}
                    <dt>当前状态</dt>
                    <dd>
                      {selected.errorMessage ? (
                        <span style={{ color: "var(--crit)" }}>{selected.errorMessage}</span>
                      ) : selected.builtIn ? (
                        "内置状态记忆与按需文件检索服务已就绪"
                      ) : (
                        "点击右上角「检测连接」可发起实时握手并刷新工具清单"
                      )}
                    </dd>
                  </dl>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3>提供的工具 ({selected.tools.length})</h3>
                </div>
                <div className="panel-body">
                  {selected.tools.length === 0 ? (
                    <div className="empty" style={{ padding: "16px 8px" }}>
                      暂无工具列表，请点击上方「检测连接」握手获取。
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>工具名称</th>
                          <th>特性</th>
                          <th>说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.tools.map((tl) => (
                          <tr key={tl.name}>
                            <td className="mono" style={{ fontWeight: 600 }}>
                              {tl.name}
                            </td>
                            <td>
                              {tl.readOnly ? (
                                <Chip tone="good">只读</Chip>
                              ) : tl.destructive ? (
                                <Chip tone="crit">高风险</Chip>
                              ) : (
                                <Chip>读写</Chip>
                              )}
                            </td>
                            <td className="ink2">{tl.description || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add MCP Server Modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="添加 MCP 服务"
        subtitle="配置本地命令行 (stdio) 或远端 HTTP / SSE 工具服务"
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>{t("取消")}</Button>
            <Button
              variant="primary"
              busy={saving}
              disabled={!name.trim()}
              onClick={() => void handleCreate()}
            >
              {t("保存")}
            </Button>
          </>
        }
      >
        <div className="row" style={{ gap: 16 }}>
          <div className="field grow">
            <label>服务标识名称</label>
            <input
              className="input mono"
              placeholder="例如 filesystem 或 github"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>生效范围</label>
            <Seg
              value={scope}
              options={[
                { value: "workspace", label: `当前工作区 (${activeWorkspace?.name || "默认"})` },
                { value: "global", label: "全局所有工作区" },
              ]}
              onChange={setScope}
            />
          </div>
        </div>

        <div className="field">
          <label>传输协议</label>
          <Seg
            value={transport}
            options={[
              { value: "stdio", label: "本地进程 (stdio)" },
              { value: "http", label: "Streamable HTTP" },
              { value: "sse", label: "SSE" },
            ]}
            onChange={setTransport}
          />
        </div>

        {transport === "stdio" ? (
          <>
            <div className="field">
              <label>可执行命令 (Command)</label>
              <input
                className="input mono"
                placeholder="例如 npx.cmd 或 node"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div className="field">
              <label>启动参数 (以空格分隔)</label>
              <input
                className="input mono"
                placeholder="例如 -y @modelcontextprotocol/server-memory"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div className="field">
            <label>服务地址 (URL)</label>
            <input
              className="input mono"
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
