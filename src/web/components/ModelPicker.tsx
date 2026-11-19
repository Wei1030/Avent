import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  thinkingModeToLevels,
  type CompatibleEndpointRecord,
  type ProviderId,
  type ProviderStatusInfo,
  type TaskProviderId,
  type ThoughtLevelOption,
} from "../../shared/types.js";
import { api } from "../api/client.js";
import { useApp } from "../store/app-context.js";
import { Icon } from "./Icon.js";
import { Button, Popover } from "./ui.js";
import { cx } from "../lib/format.js";

export function resolveThoughtLevelsForSelection(
  providers: ProviderStatusInfo[],
  endpoints: CompatibleEndpointRecord[],
  providerId: TaskProviderId,
  modelId: string
): { levels: ThoughtLevelOption[]; defaultLevel: string } {
  if (providerId.startsWith("endpoint:")) {
    const ep = endpoints.find((e) => `endpoint:${e.id}` === providerId);
    const m = ep?.models.find((x) => x.id === modelId);
    const levels = thinkingModeToLevels(m?.thinkingMode ?? "none");
    return {
      levels,
      defaultLevel: levels.length > 0 ? levels[levels.length - 1].value : "",
    };
  }

  const prov = providers.find((p) => p.id === providerId);
  if (!prov) return { levels: [], defaultLevel: "" };
  const m = prov.models.find((x) => x.value === modelId);
  const levels = m?.thoughtLevels !== undefined ? m.thoughtLevels : prov.thoughtLevels;
  const defaultLevel =
    levels.length === 0
      ? ""
      : m?.defaultThoughtLevel || prov.defaultThoughtLevel || levels[0].value;
  return { levels, defaultLevel };
}

function summarizeThoughtBadge(levels: ThoughtLevelOption[] | undefined): string | null {
  if (!levels) return null;
  if (levels.length === 0) return "自动思考";
  const vals = levels.map((l) => l.value);
  if (vals.includes("off") && levels.length === 2) return "开关思考";
  if (vals.includes("xhigh")) return "支持 Extra";
  if (vals.includes("max")) return "支持 Max";
  return `${levels.length} 档思考`;
}

export function ModelPicker({
  providerId,
  modelId,
  thoughtLevel = "",
  onSelect,
  placement = "top",
  align = "left",
  borderless = true,
  maxWidth = 240,
}: {
  providerId: TaskProviderId;
  modelId: string;
  thoughtLevel?: string;
  onSelect: (next: {
    providerId: TaskProviderId;
    modelId: string;
    thoughtLevel: string;
  }) => void;
  placement?: "top" | "bottom";
  align?: "left" | "right";
  borderless?: boolean;
  maxWidth?: number;
}) {
  const { providers, endpoints, setProviders, toast } = useApp();
  const nav = useNavigate();

  const [open, setOpen] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState<string>(providerId || "agy");
  const [search, setSearch] = useState("");
  const [probingId, setProbingId] = useState<ProviderId | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setActiveSourceId(providerId || providers[0]?.id || "agy");
  }, [providerId, open]);

  const currentEndpoint = providerId.startsWith("endpoint:")
    ? endpoints.find((ep) => `endpoint:${ep.id}` === providerId)
    : undefined;
  const currentProvider = !currentEndpoint
    ? providers.find((p) => p.id === providerId)
    : undefined;
  const currentModelMeta = currentProvider?.models.find((m) => m.value === modelId);
  const currentEpModel = currentEndpoint?.models.find((m) => m.id === modelId);

  const buttonLabel = currentEndpoint
    ? `${currentEndpoint.name} · ${currentEpModel?.name || modelId || "未选模型"}`
    : `${currentProvider?.shortName || providerId} · ${
        currentModelMeta?.name || modelId || "未选模型"
      }`;

  const selectedLeftProvider = providers.find((p) => p.id === activeSourceId);
  const selectedLeftEndpoint = endpoints.find((ep) => `endpoint:${ep.id}` === activeSourceId);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (selectedLeftProvider) {
      return selectedLeftProvider.models
        .filter((m) => !q || m.name.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
        .map((m) => ({
          value: m.value,
          name: m.name,
          thoughtLevels: m.thoughtLevels,
        }));
    }
    if (selectedLeftEndpoint) {
      return selectedLeftEndpoint.models
        .filter(
          (m) =>
            !q ||
            m.id.toLowerCase().includes(q) ||
            (m.name && m.name.toLowerCase().includes(q))
        )
        .map((m) => ({
          value: m.id,
          name: m.name || m.id,
          thoughtLevels: thinkingModeToLevels(m.thinkingMode),
        }));
    }
    return [];
  }, [selectedLeftProvider, selectedLeftEndpoint, search]);

  const totalModelsInRight =
    selectedLeftProvider?.models.length ?? selectedLeftEndpoint?.models.length ?? 0;

  const handlePick = (targetProv: TaskProviderId, targetModel: string) => {
    const { levels, defaultLevel } = resolveThoughtLevelsForSelection(
      providers,
      endpoints,
      targetProv,
      targetModel
    );
    let nextThought = thoughtLevel;
    if (levels.length === 0) {
      nextThought = "";
    } else if (!levels.some((lv) => lv.value === nextThought)) {
      nextThought = defaultLevel;
    }

    onSelect({
      providerId: targetProv,
      modelId: targetModel,
      thoughtLevel: nextThought,
    });
    setOpen(false);
    setSearch("");
  };

  const handleRefresh = async (pid: ProviderId) => {
    setProbingId(pid);
    try {
      const res = await api.checkProvider(pid);
      setProviders(res.providers);
      toast(res.detail, res.ok ? "good" : "warn");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "crit");
    } finally {
      setProbingId(null);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={cx("select-btn sm", borderless && "borderless")}
        style={{ width: "auto", maxWidth }}
        onClick={() => setOpen(!open)}
      >
        <Icon name="cpu" size={14} className="ink2" />
        <span className="label">{buttonLabel}</span>
        <Icon name="chevDown" size={13} className="muted" />
      </button>

      <Popover
        anchor={btnRef.current}
        open={open}
        onClose={() => {
          setOpen(false);
          setSearch("");
        }}
        align={align}
        placement={placement}
        className="model-picker"
      >
        <div className="mp-grid">
          {/* Left Column: Official ACP Providers + Compatible Endpoints */}
          <div className="mp-left">
            <div className="mp-sec">官方订阅</div>
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cx("mp-source", activeSourceId === p.id && "on")}
                onMouseEnter={() => {
                  setActiveSourceId(p.id);
                  setSearch("");
                }}
                onClick={() => {
                  setActiveSourceId(p.id);
                  setSearch("");
                }}
              >
                <span className={cx("mp-dot", p.available && p.models.length > 0 && "ok")} />
                <span className="truncate">{p.shortName}</span>
                <span className="cnt">{p.models.length}</span>
              </button>
            ))}

            {endpoints.length > 0 && (
              <>
                <div className="mp-sec">兼容端点</div>
                {endpoints.map((ep) => {
                  const key = `endpoint:${ep.id}`;
                  return (
                    <button
                      key={ep.id}
                      type="button"
                      className={cx("mp-source", activeSourceId === key && "on")}
                      onMouseEnter={() => {
                        setActiveSourceId(key);
                        setSearch("");
                      }}
                      onClick={() => {
                        setActiveSourceId(key);
                        setSearch("");
                      }}
                    >
                      <span className="mp-dot ep" />
                      <span className="truncate">{ep.name}</span>
                      <span className="cnt">{ep.models.length}</span>
                    </button>
                  );
                })}
              </>
            )}

            <div className="mp-left-foot">
              <button
                type="button"
                className="mp-source"
                style={{ color: "var(--muted)", fontSize: 12 }}
                onClick={() => {
                  setOpen(false);
                  nav("/settings/provider");
                }}
              >
                <Icon name="plus" size={13} />
                <span className="truncate">管理订阅与端点…</span>
              </button>
            </div>
          </div>

          {/* Right Column: Expanded Models for Selected Source */}
          <div className="mp-right">
            <div className="mp-rhead">
              <div className="meta">
                <b className="truncate">
                  {selectedLeftProvider?.name || selectedLeftEndpoint?.name || "模型列表"}
                </b>
                <span className="truncate">
                  {selectedLeftProvider
                    ? selectedLeftProvider.subscriptionLabel
                    : selectedLeftEndpoint
                      ? `${selectedLeftEndpoint.protocol === "openai" ? "OpenAI 兼容" : "Anthropic 兼容"} · ${selectedLeftEndpoint.baseUrl || "未填写地址"}`
                      : ""}
                </span>
              </div>
              {selectedLeftProvider && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="refresh"
                  title="通过 ACP 实时探测同步最新模型与思考强度"
                  busy={probingId === selectedLeftProvider.id}
                  onClick={() => void handleRefresh(selectedLeftProvider.id)}
                />
              )}
            </div>

            {totalModelsInRight >= 6 && (
              <div className="mp-search">
                <input
                  className="input sm"
                  placeholder="筛选模型…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            )}

            <div className="mp-list">
              {filteredModels.length === 0 ? (
                <div className="empty" style={{ padding: "28px 14px" }}>
                  {totalModelsInRight === 0 ? (
                    selectedLeftProvider ? (
                      <>
                        <b>尚未同步模型列表</b>
                        请确认本地已登录 CLI，再点右上角刷新按钮通过 ACP 实时获取。
                      </>
                    ) : (
                      <>
                        <b>该端点尚未添加模型</b>
                        请前往「设置 → 订阅与模型」为此端点添加模型。
                      </>
                    )
                  ) : (
                    "无匹配模型"
                  )}
                </div>
              ) : (
                filteredModels.map((m) => {
                  const targetProv = (selectedLeftProvider?.id ||
                    `endpoint:${selectedLeftEndpoint?.id}`) as TaskProviderId;
                  const isSelected = providerId === targetProv && modelId === m.value;
                  const badge = summarizeThoughtBadge(m.thoughtLevels);
                  return (
                    <button
                      key={m.value}
                      type="button"
                      className={cx("mp-model", isSelected && "on")}
                      onClick={() => handlePick(targetProv, m.value)}
                    >
                      <div className="grow" style={{ minWidth: 0 }}>
                        <span className="mn truncate">{m.name}</span>
                        {m.name !== m.value && <span className="ms truncate">{m.value}</span>}
                      </div>
                      {badge && <span className="mt">{badge}</span>}
                      {isSelected && <Icon name="check" size={14} />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </Popover>
    </>
  );
}
