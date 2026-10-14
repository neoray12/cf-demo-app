'use client';

import { useTranslation } from "react-i18next";
import { AlertCircle, Code2 } from "lucide-react";
import { MarkdownRenderer } from "./markdown-renderer";
import { viewMcpResult } from "@/lib/mcp-result-view";

const box = "rounded-lg border border-border/50 bg-muted/30";

/** Expanded body of an MCP tool call: its arguments and a readable result. */
export function McpResultView({ args, result }: { args?: unknown; result?: unknown }) {
  const { t } = useTranslation();
  const code = args && typeof args === "object" && typeof (args as { code?: unknown }).code === "string"
    ? (args as { code: string }).code
    : null;
  const otherArgs = args && typeof args === "object"
    ? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => k !== "code"))
    : {};
  const view = result != null ? viewMcpResult(result) : null;

  return (
    <div className="mt-1.5 ml-3 space-y-2 text-xs">
      {code && (
        <section>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t("chat.mcpResult.script")}</div>
          <pre className={`${box} p-3 font-mono text-[11px] leading-relaxed overflow-x-auto max-h-[240px] overflow-y-auto`}>{code}</pre>
        </section>
      )}
      {Object.keys(otherArgs).length > 0 && (
        <section>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t("chat.mcpResult.args")}</div>
          <pre className={`${box} p-3 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap break-words`}>{JSON.stringify(otherArgs, null, 2)}</pre>
        </section>
      )}
      {view && (
        <section>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t("chat.mcpResult.result")}
            {view.source && <span className="font-normal text-muted-foreground/60"> · {view.source}</span>}
            {view.kind === "toolList" && <span className="font-normal text-muted-foreground/60"> · {t("chat.mcpResult.toolCount", { count: view.tools.length })}</span>}
          </div>
          {view.kind === "toolList" && (
            <ul className={`${box} divide-y divide-border/50 max-h-[320px] overflow-y-auto`}>
              {view.tools.map((tool) => (
                <li key={tool.name} className="px-3 py-2">
                  <div className="flex items-start gap-1.5">
                    <Code2 className="size-3 mt-0.5 shrink-0 text-primary/70" />
                    <span className="font-mono text-[11px] font-medium [overflow-wrap:anywhere]">{tool.name}</span>
                  </div>
                  {tool.description && <p className="mt-0.5 ml-[18px] text-[11px] text-muted-foreground">{tool.description}</p>}
                  {tool.params.length > 0 && (
                    <div className="mt-1 ml-[18px] flex flex-wrap gap-1">
                      {tool.params.map((p) => (
                        <code key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{p}</code>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {view.kind === "text" && (
            <div className={`${box} px-3 py-2 max-h-[320px] overflow-y-auto text-[13px]`}>
              <MarkdownRenderer content={view.text} isStreaming={false} />
            </div>
          )}
          {view.kind === "error" && (
            <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
              <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
              <span className="font-mono text-[11px] whitespace-pre-wrap break-words">{view.text}</span>
            </div>
          )}
          {view.kind === "records" && (
            <div className={`${box} overflow-hidden`}>
              {view.summary && <div className="px-3 py-2 text-[12px] border-b border-border/50">{view.summary}</div>}
              <div className="max-h-[320px] overflow-auto">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      {view.columns.map((c) => (
                        <th key={c} className="px-2.5 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {view.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((v, j) => (
                          <td key={j} className="px-2.5 py-1.5 align-top whitespace-nowrap max-w-[240px] truncate" title={v}>{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {view.kind === "json" && (
            <pre className={`${box} p-3 font-mono text-[11px] overflow-x-auto max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words`}>{view.text}</pre>
          )}
        </section>
      )}
    </div>
  );
}
