'use client';

import { useState, useEffect } from "react";
import { Plug, X, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface McpServer {
  id: string;
  url: string;
}

interface McpConnectionsPanelProps {
  onClose: () => void;
}

const SERVER_LABELS: Record<string, { name: string; description: string }> = {
  "cf-docs": { name: "Cloudflare Docs", description: "Get up to date reference information on Cloudflare" },
  "cf-observability": { name: "Workers Observability", description: "Debug and get insight into your application's logs" },
  "cf-radar": { name: "Radar", description: "Get global Internet traffic insights and trends" },
};

export function McpConnectionsPanel({ onClose }: McpConnectionsPanelProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/mcp/servers")
      .then((r) => r.json())
      .then((data) => setServers(((data as { servers?: McpServer[] }).servers) ?? []))
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col h-full border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Plug className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">MCP Servers</span>
          {servers.length > 0 && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {servers.length}
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

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          MCP server 在後端靜態設定，由 Worker 在每次請求時連線並取得工具。
        </p>

        {loading ? (
          <div className="text-xs text-muted-foreground/50 text-center py-4">載入中…</div>
        ) : servers.length === 0 ? (
          <div className="text-xs text-muted-foreground/50 text-center py-4">尚未設定 MCP server</div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const label = SERVER_LABELS[server.id];
              return (
                <div key={server.id} className="rounded-xl border bg-card p-3 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{label?.name ?? server.id}</span>
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400 font-medium">
                      <span className="size-1.5 rounded-full bg-green-500 shrink-0" />
                      已設定
                    </span>
                  </div>
                  {label?.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{label.description}</p>
                  )}
                  <a
                    href={server.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground font-mono truncate transition-colors"
                  >
                    <ExternalLink className="size-2.5 shrink-0" />
                    {server.url}
                  </a>
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-lg bg-muted/40 p-3 text-[11px] text-muted-foreground/70 space-y-1">
          <p className="font-medium text-muted-foreground">如何新增 MCP server？</p>
          <p>在 <code className="font-mono text-[10px] bg-muted px-1 rounded">wrangler.toml</code> 的 <code className="font-mono text-[10px] bg-muted px-1 rounded">MCP_SERVER_URLS</code> 環境變數中加入 <code className="font-mono text-[10px] bg-muted px-1 rounded">id=url</code> 格式，多個伺服器用逗號分隔。</p>
        </div>
      </div>
    </div>
  );
}
