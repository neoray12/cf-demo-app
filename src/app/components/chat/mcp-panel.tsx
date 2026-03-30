import { useState, useEffect, useCallback } from "react";
import { Plug, Plug2, ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Plus, X, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const AGENT_BASE = "/agents/chat-agent/default";

const PRESET_SERVERS = [
  {
    id: "cf-docs",
    name: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    description: "Get up to date reference information on Cloudflare",
  },
  {
    id: "cf-observability",
    name: "Workers Observability",
    url: "https://observability.mcp.cloudflare.com/mcp",
    description: "Debug and get insight into your application's logs",
  },
  {
    id: "cf-radar",
    name: "Radar",
    url: "https://radar.mcp.cloudflare.com/mcp",
    description: "Get global Internet traffic insights and trends",
  },
];

type ConnectionStatus = "idle" | "connecting" | "connected" | "error" | "authenticating";

interface ServerState {
  serverId?: string;
  status: ConnectionStatus;
  tools: string[];
  error?: string;
}

interface McpConnectionsPanelProps {
  onClose: () => void;
}

export function McpConnectionsPanel({ onClose }: McpConnectionsPanelProps) {
  const [serverStates, setServerStates] = useState<Record<string, ServerState>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [customConnecting, setCustomConnecting] = useState(false);

  const refreshServers = useCallback(async () => {
    try {
      const res = await fetch(`${AGENT_BASE}/mcp/servers`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        servers: Array<{
          id: string;
          serverName: string;
          url?: string;
          state: string;
          tools?: Array<{ name: string }>;
        }>;
      };
      const next: Record<string, ServerState> = {};
      for (const s of data.servers ?? []) {
        const key = s.serverName ?? s.id;
        next[key] = {
          serverId: s.id,
          status: s.state === "ready" ? "connected" : s.state === "authenticating" ? "authenticating" : "connecting",
          tools: s.tools?.map((t) => t.name) ?? [],
        };
      }
      setServerStates((prev) => {
        const merged: Record<string, ServerState> = { ...prev };
        for (const key of Object.keys(next)) {
          merged[key] = next[key] as ServerState;
        }
        for (const key of Object.keys(prev)) {
          const existing = prev[key];
          if (!next[key] && existing && existing.status === "connected") {
            merged[key] = { ...existing, status: "idle", serverId: undefined, tools: existing.tools ?? [] };
          }
        }
        return merged;
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshServers();
  }, [refreshServers]);

  const connectServer = useCallback(
    async (name: string, url: string) => {
      setServerStates((prev) => ({
        ...prev,
        [name]: { status: "connecting", tools: [], serverId: prev[name]?.serverId ?? undefined },
      }));

      try {
        const res = await fetch(`${AGENT_BASE}/mcp/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, serverUrl: url }),
        });
        const data = (await res.json()) as {
          state?: string;
          authUrl?: string;
          id?: string;
          error?: string;
          message?: string;
        };

        if (data.state === "authenticating" && data.authUrl) {
          setServerStates((prev) => ({
            ...prev,
            [name]: { tools: prev[name]?.tools ?? [], ...prev[name], status: "authenticating", serverId: data.id },
          }));

          const popup = window.open(data.authUrl, "_blank", "width=600,height=700,noopener");

          const onMsg = (e: MessageEvent) => {
            if (e.data === "mcp-auth-done") {
              window.removeEventListener("message", onMsg);
              popup?.close();
              setTimeout(() => refreshServers(), 1000);
            }
          };
          window.addEventListener("message", onMsg);

          const pollTimer = setInterval(async () => {
            if (popup?.closed) {
              clearInterval(pollTimer);
              window.removeEventListener("message", onMsg);
              await refreshServers();
            }
          }, 1000);
        } else if (data.state === "ready") {
          setServerStates((prev) => ({
            ...prev,
            [name]: { status: "connected", tools: [], serverId: data.id },
          }));
          setTimeout(() => refreshServers(), 500);
        } else {
          setServerStates((prev) => ({
            ...prev,
            [name]: { status: "error", tools: [], error: data.message || data.error || "Connection failed" },
          }));
        }
      } catch (err) {
        setServerStates((prev) => ({
          ...prev,
          [name]: { status: "error", tools: [], error: (err as Error).message },
        }));
      }
    },
    [refreshServers]
  );

  const disconnectServer = useCallback(async (name: string) => {
    const serverId = serverStates[name]?.serverId;
    if (!serverId) {
      setServerStates((prev) => ({ ...prev, [name]: { status: "idle", tools: [] } }));
      return;
    }
    try {
      await fetch(`${AGENT_BASE}/mcp/disconnect/${encodeURIComponent(serverId)}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    setServerStates((prev) => ({ ...prev, [name]: { status: "idle", tools: [] } }));
  }, [serverStates]);

  const handleCustomConnect = useCallback(async () => {
    const url = customUrl.trim();
    const name = customName.trim() || url.split("/").at(-2) || "Custom";
    if (!url) return;
    setCustomConnecting(true);
    await connectServer(name, url);
    setCustomConnecting(false);
    setCustomUrl("");
    setCustomName("");
    setIsAddingCustom(false);
  }, [customUrl, customName, connectServer]);

  const totalConnected = Object.values(serverStates).filter((s) => s.status === "connected").length;
  const allTools = Object.values(serverStates)
    .filter((s) => s.status === "connected")
    .flatMap((s) => s.tools);

  return (
    <div className="flex flex-col h-full border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Plug className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">MCP Connections</span>
          {totalConnected > 0 && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {totalConnected}
            </Badge>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Installed presets */}
        <div>
          <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-2">
            Cloudflare Servers
          </p>
          <div className="space-y-2">
            {PRESET_SERVERS.map((server) => {
              const state = serverStates[server.id] ?? { status: "idle", tools: [] };
              const isConnected = state.status === "connected";
              const isConnecting = state.status === "connecting" || state.status === "authenticating";
              const hasTools = state.tools.length > 0;
              const toolsExpanded = expandedTools[server.id] ?? false;

              return (
                <div
                  key={server.id}
                  className="rounded-xl border bg-card p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusDot status={state.status} />
                        <span className="text-sm font-medium truncate">{server.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {server.description}
                      </p>
                    </div>
                    <ToggleButton
                      status={state.status}
                      onConnect={() => connectServer(server.id, server.url)}
                      onDisconnect={() => disconnectServer(server.id)}
                    />
                  </div>

                  {state.status === "authenticating" && (
                    <p className="text-[11px] text-amber-500">
                      正在等待 OAuth 驗證，請在彈出視窗中完成登入…
                    </p>
                  )}
                  {state.status === "error" && (
                    <p className="text-[11px] text-destructive line-clamp-2">{state.error}</p>
                  )}

                  {isConnected && hasTools && (
                    <button
                      onClick={() => setExpandedTools((p) => ({ ...p, [server.id]: !toolsExpanded }))}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {toolsExpanded ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                      {state.tools.length} 個工具
                    </button>
                  )}
                  {isConnected && toolsExpanded && (
                    <div className="flex flex-wrap gap-1">
                      {state.tools.map((t) => (
                        <Badge key={t} variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Custom server */}
        <div>
          <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-2">
            自訂伺服器
          </p>
          {!isAddingCustom ? (
            <button
              onClick={() => setIsAddingCustom(true)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg border border-dashed w-full px-3 py-2 justify-center"
            >
              <Plus className="size-3.5" />
              新增 MCP 伺服器
            </button>
          ) : (
            <div className="rounded-xl border bg-card p-3 space-y-2">
              <input
                type="text"
                placeholder="名稱（選填）"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="w-full text-sm bg-transparent border-b border-border/50 pb-1 focus:outline-none focus:border-foreground/30 placeholder:text-muted-foreground/50"
              />
              <input
                type="url"
                placeholder="https://your-mcp-server.com/mcp"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCustomConnect();
                  if (e.key === "Escape") setIsAddingCustom(false);
                }}
                className="w-full text-sm bg-transparent border-b border-border/50 pb-1 focus:outline-none focus:border-foreground/30 placeholder:text-muted-foreground/50 font-mono"
              />
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={handleCustomConnect}
                  disabled={!customUrl.trim() || customConnecting}
                  className="h-7 text-xs"
                >
                  {customConnecting ? <Loader2 className="size-3 animate-spin" /> : "連接"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setIsAddingCustom(false); setCustomUrl(""); setCustomName(""); }}
                  className="h-7 text-xs"
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Active tools summary */}
        {allTools.length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-2 flex items-center gap-1">
              <Wrench className="size-3" />
              Active Tools ({allTools.length})
            </p>
            <div className="flex flex-wrap gap-1">
              {allTools.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px] h-4 px-1.5 font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  if (status === "connected") return <span className="size-1.5 rounded-full bg-green-500 shrink-0 mt-0.5" />;
  if (status === "connecting" || status === "authenticating")
    return <Loader2 className="size-3 animate-spin text-amber-500 shrink-0" />;
  if (status === "error") return <span className="size-1.5 rounded-full bg-destructive shrink-0 mt-0.5" />;
  return <span className="size-1.5 rounded-full bg-muted-foreground/30 shrink-0 mt-0.5" />;
}

function ToggleButton({
  status,
  onConnect,
  onDisconnect,
}: {
  status: ConnectionStatus;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (status === "connected") {
    return (
      <button
        onClick={onDisconnect}
        className="shrink-0 size-5 rounded-full bg-green-500/20 flex items-center justify-center hover:bg-destructive/20 group transition-colors"
        title="中斷連線"
      >
        <CheckCircle2 className="size-3 text-green-500 group-hover:hidden" />
        <XCircle className="size-3 text-destructive hidden group-hover:block" />
      </button>
    );
  }
  if (status === "connecting" || status === "authenticating") {
    return (
      <div className="shrink-0 size-5 flex items-center justify-center">
        <Loader2 className="size-3 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <button
      onClick={onConnect}
      className="shrink-0 size-5 rounded-full bg-muted/60 flex items-center justify-center hover:bg-primary/20 transition-colors"
      title="連接"
    >
      <Plug2 className="size-3 text-muted-foreground" />
    </button>
  );
}
