'use client';

import { useState, useEffect, useCallback, useRef } from "react";
import { Plug, X, ExternalLink, LogIn, LogOut, RefreshCw, Wrench, Loader2, Check, AlertCircle, ChevronDown, ChevronRight, Code2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// Per-server custom icons
const SERVER_ICONS: Record<string, React.ReactNode> = {
  'sap': (
    <img src="/sap-logo.png" alt="SAP" className="h-6 w-auto object-contain" />
  ),
  'salesforce': (
    <img src="/salesforce.svg" alt="Salesforce" className="h-6 w-auto object-contain" />
  ),
};

interface McpServer {
  id: string;
  url: string;
  name: string;
  description: string;
  authType: "none" | "oauth";
  connected: boolean;
}

interface McpToolParam {
  type?: string;
  description?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, McpToolParam>;
    required?: string[];
  };
  serverId: string;
  serverName: string;
}

interface McpConnectionsPanelProps {
  onClose: () => void;
  connectedServers: string[];
  onServersChange: (serverIds: string[]) => void;
}

// ── Tool detail components ──

function ToolDetailCard({ tool }: { tool: McpTool }) {
  const [expanded, setExpanded] = useState(false);
  const props = tool.inputSchema?.properties || {};
  const required = tool.inputSchema?.required || [];
  const paramKeys = Object.keys(props);

  return (
    <div className="rounded-lg border border-border/50 bg-background">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-muted/40 transition-colors rounded-lg"
      >
        <Code2 className="size-3 mt-0.5 shrink-0 text-primary/70" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-foreground truncate">{tool.name}</span>
            {paramKeys.length > 0 && (
              <span className="text-[9px] text-muted-foreground/50 shrink-0">
                {paramKeys.length} 參數
              </span>
            )}
          </div>
          {tool.description && (
            <p className="text-[10px] text-muted-foreground/70 line-clamp-1 mt-0.5">{tool.description}</p>
          )}
        </div>
        <ChevronRight className={`size-3 mt-0.5 shrink-0 text-muted-foreground/40 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2">
          {/* Full description */}
          {tool.description && (
            <p className="text-[10px] text-muted-foreground/80 leading-relaxed pl-5">
              {tool.description}
            </p>
          )}

          {/* Parameters */}
          {paramKeys.length > 0 ? (
            <div className="pl-5 space-y-1">
              <p className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider">參數</p>
              {paramKeys.map((key) => {
                const param = props[key];
                const isRequired = required.includes(key);
                return (
                  <div key={key} className="flex items-start gap-1.5 text-[10px]">
                    <code className="font-mono text-primary/80 shrink-0">{key}</code>
                    {isRequired && (
                      <span className="text-[8px] text-amber-600 dark:text-amber-400 font-semibold shrink-0">必填</span>
                    )}
                    {param?.type && (
                      <span className="text-[9px] text-muted-foreground/40 font-mono shrink-0">{param.type}</span>
                    )}
                    {param?.description && (
                      <span className="text-muted-foreground/60 truncate">— {param.description}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground/50 pl-5">無需參數</p>
          )}
        </div>
      )}
    </div>
  );
}

function ToolListExpander({ tools }: { tools: McpTool[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
        <Wrench className="size-2.5" />
        <span>{tools.length} 個工具可用</span>
      </button>

      {expanded && (
        <div className="space-y-1 ml-1">
          {tools.map((tool) => (
            <ToolDetailCard key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main panel ──

export function McpConnectionsPanel({ onClose, connectedServers, onServersChange }: McpConnectionsPanelProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [authenticatingId, setAuthenticatingId] = useState<string | null>(null);
  const [serverTools, setServerTools] = useState<Record<string, McpTool[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const popupPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/servers");
      const data = await res.json() as { servers?: McpServer[] };
      setServers(data.servers ?? []);
    } catch {
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchServers(); }, [fetchServers]);

  // Listen for OAuth callback postMessage
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'mcp-auth-callback') {
        const { success, serverId, error } = event.data as { success: boolean; serverId?: string; error?: string };
        setAuthenticatingId(null);
        if (success && serverId) {
          // Refresh server list to pick up new auth status
          fetchServers();
          // Auto-connect after successful auth
          handleConnect(serverId);
        } else if (error) {
          setErrors((prev) => ({ ...prev, [authenticatingId || '']: error }));
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [authenticatingId, fetchServers]);

  const handleAuthenticate = async (serverId: string) => {
    setAuthenticatingId(serverId);
    setErrors((prev) => { const next = { ...prev }; delete next[serverId]; return next; });

    try {
      const res = await fetch("/api/mcp/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      const data = await res.json() as { authUrl?: string; error?: string };

      if (!res.ok || !data.authUrl) {
        setErrors((prev) => ({ ...prev, [serverId]: data.error || '無法啟動認證流程' }));
        setAuthenticatingId(null);
        return;
      }

      // Open popup for OAuth
      const popup = window.open(data.authUrl, 'mcp-auth', 'width=600,height=700,popup=yes');
      if (!popup) {
        setErrors((prev) => ({ ...prev, [serverId]: '無法開啟認證視窗，請允許彈出視窗' }));
        setAuthenticatingId(null);
        return;
      }

      // Poll for popup closure — auto-connect when user closes/completes auth
      if (popupPollRef.current) clearInterval(popupPollRef.current);
      popupPollRef.current = setInterval(() => {
        if (popup.closed) {
          if (popupPollRef.current) clearInterval(popupPollRef.current);
          popupPollRef.current = null;
          setAuthenticatingId(null);
          // Try to connect with skipAuth=true to avoid infinite re-auth loop
          handleConnect(serverId, true);
        }
      }, 800);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [serverId]: `認證失敗: ${(err as Error).message}` }));
      setAuthenticatingId(null);
    }
  };

  const handleConnect = async (serverId: string, skipAuth = false) => {
    setConnectingId(serverId);
    setErrors((prev) => { const next = { ...prev }; delete next[serverId]; return next; });

    try {
      const res = await fetch("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      const data = await res.json() as { connected?: boolean; tools?: McpTool[]; error?: string; requiresAuth?: boolean };

      if (data.requiresAuth) {
        if (!skipAuth) {
          handleAuthenticate(serverId);
        } else {
          // Called from popup-close poll: don't reopen popup, just show error
          setErrors((prev) => ({ ...prev, [serverId]: '認證未完成，請重新認證' }));
        }
        return;
      }

      if (!res.ok || !data.connected) {
        setErrors((prev) => ({ ...prev, [serverId]: data.error || '連線失敗' }));
        return;
      }

      // Store tools and update connected list
      setServerTools((prev) => ({ ...prev, [serverId]: data.tools || [] }));
      if (!connectedServers.includes(serverId)) {
        onServersChange([...connectedServers, serverId]);
      }
      fetchServers();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [serverId]: `連線失敗: ${(err as Error).message}` }));
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async (serverId: string) => {
    onServersChange(connectedServers.filter((id) => id !== serverId));
    setServerTools((prev) => { const next = { ...prev }; delete next[serverId]; return next; });
    // Clean up KV tokens on server side
    try {
      await fetch("/api/mcp/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
    } catch { /* best effort */ }
    fetchServers();
  };

  const isConnected = (id: string) => connectedServers.includes(id);
  const totalTools = Object.values(serverTools).flat().length;

  return (
    <div className="flex flex-col h-full border-l bg-background">
      {/* Header */}
      <div className="px-4 py-3 border-b shrink-0 space-y-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Plug className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">MCP Servers</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
        {(connectedServers.length > 0 || totalTools > 0) && (
          <p className="text-[11px] text-muted-foreground/70 pl-6">
            {connectedServers.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-green-500" />
                {connectedServers.length} 已連線
              </span>
            )}
            {connectedServers.length > 0 && totalTools > 0 && (
              <span className="mx-1.5 text-border">·</span>
            )}
            {totalTools > 0 && (
              <span className="inline-flex items-center gap-1">
                <Wrench className="size-2.5" />
                {totalTools} 個工具
              </span>
            )}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          連接 MCP server 以啟用額外的 AI 工具。需要 OAuth 認證的 server 會在首次連線時引導你完成授權。
        </p>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground/50" />
            <span className="text-xs text-muted-foreground/50">載入中…</span>
          </div>
        ) : servers.length === 0 ? (
          <div className="text-xs text-muted-foreground/50 text-center py-4">尚未設定 MCP server</div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const connected = isConnected(server.id);
              const tools = serverTools[server.id] || [];
              const isAuthenticating = authenticatingId === server.id;
              const isConnecting = connectingId === server.id;
              const error = errors[server.id];

              return (
                <div key={server.id} className="rounded-xl border bg-card p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {SERVER_ICONS[server.id] ? (
                        <span className="shrink-0 flex items-center">{SERVER_ICONS[server.id]}</span>
                      ) : (
                        <span className="text-sm font-medium truncate">{server.name}</span>
                      )}
                      {server.authType === "oauth" && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px] shrink-0">OAuth</Badge>
                      )}
                    </div>
                    {connected ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400 font-medium shrink-0">
                        <Check className="size-3" />
                        已連線
                      </span>
                    ) : server.connected && server.authType === "oauth" ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 dark:text-blue-400 font-medium shrink-0">
                        已認證
                      </span>
                    ) : null}
                  </div>

                  {server.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{server.description}</p>
                  )}

                  {/* Expandable tool list */}
                  {connected && tools.length > 0 && (
                    <ToolListExpander tools={tools} />
                  )}

                  {/* Error display */}
                  {error && (
                    <div className="flex items-start gap-1.5 text-[11px] text-destructive bg-destructive/10 rounded-lg px-2 py-1.5">
                      <AlertCircle className="size-3 shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-1.5">
                    {connected ? (
                      <>
                        <button
                          onClick={() => handleConnect(server.id)}
                          disabled={isConnecting}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border/60 hover:bg-muted/60 transition-colors text-muted-foreground disabled:opacity-50"
                        >
                          <RefreshCw className={`size-3 ${isConnecting ? 'animate-spin' : ''}`} />
                          重新整理
                        </button>
                        <button
                          onClick={() => handleDisconnect(server.id)}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border/60 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors text-muted-foreground"
                        >
                          <LogOut className="size-3" />
                          斷開
                        </button>
                      </>
                    ) : server.authType === "oauth" && !server.connected ? (
                      <>
                        <button
                          onClick={() => handleAuthenticate(server.id)}
                          disabled={isAuthenticating}
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                        >
                          {isAuthenticating ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <LogIn className="size-3" />
                          )}
                          {isAuthenticating ? '認證中…' : '認證'}
                        </button>
                        {isAuthenticating && (
                          <button
                            onClick={() => {
                              if (popupPollRef.current) clearInterval(popupPollRef.current);
                              popupPollRef.current = null;
                              setAuthenticatingId(null);
                              handleConnect(server.id, true);
                            }}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border/60 hover:bg-muted/60 transition-colors text-muted-foreground"
                          >
                            <Check className="size-3" />
                            完成
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => handleConnect(server.id)}
                        disabled={isConnecting}
                        className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        {isConnecting ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Plug className="size-3" />
                        )}
                        {isConnecting ? '連線中…' : '連接'}
                      </button>
                    )}

                    <a
                      href={server.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      title={server.url}
                    >
                      <ExternalLink className="size-2.5" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-lg bg-muted/40 p-3 text-[11px] text-muted-foreground/70 space-y-1">
          <p className="font-medium text-muted-foreground">如何新增 MCP server？</p>
          <p>在 <code className="font-mono text-[10px] bg-muted px-1 rounded">wrangler.toml</code> 的 <code className="font-mono text-[10px] bg-muted px-1 rounded">MCP_SERVER_URLS</code> 環境變數中加入 <code className="font-mono text-[10px] bg-muted px-1 rounded">id=url</code>（公開）或 <code className="font-mono text-[10px] bg-muted px-1 rounded">id=url:oauth</code>（需認證）格式，多個伺服器用逗號分隔。</p>
        </div>
      </div>
    </div>
  );
}
