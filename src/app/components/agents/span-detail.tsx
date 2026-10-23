'use client';

import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SpanNode } from "@/lib/agents/trace-tree";
import { secs, spanEnd, spanLabel } from "./trace-utils";

function Json({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-snug font-mono whitespace-pre-wrap break-all">
      {text}
    </pre>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** Details of one waterfall span: summary / detail JSON / tokens. */
export function SpanDetail({ node, now, onClose }: { node: SpanNode; now: number; onClose: () => void }) {
  const { t } = useTranslation();
  const end = spanEnd(node, now);
  const output = node.text || (node.detail as { output?: unknown } | undefined)?.output;
  return (
    <div className="rounded-lg border bg-card p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          {node.kind}
        </Badge>
        <span className="font-medium truncate">{spanLabel(node, t)}</span>
        <span className="text-muted-foreground font-mono truncate">{node.name}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("agents.trace.back")}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <Tabs defaultValue="summary">
        <TabsList className="h-8">
          <TabsTrigger value="summary" className="text-xs px-2">
            {t("agents.trace.summaryTab")}
          </TabsTrigger>
          <TabsTrigger value="detail" className="text-xs px-2">
            {t("agents.trace.detailTab")}
          </TabsTrigger>
          <TabsTrigger value="tokens" className="text-xs px-2">
            {t("agents.trace.tokensTab")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="mt-2">
          <Row label={t("agents.trace.status")}>
            {node.end === null ? (
              <span className="text-primary">{t("agents.trace.running")}</span>
            ) : node.status === "error" ? (
              <span className="text-destructive">error</span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400">ok</span>
            )}
          </Row>
          <Row label={t("agents.trace.start")}>
            <span className="tabular-nums">+{secs(node.start, 2)}</span>
          </Row>
          <Row label={t("agents.trace.duration")}>
            <span className="tabular-nums">{secs(end - node.start, 2)}</span>
          </Row>
          {node.kind === "chat" && node.ttftMs !== undefined && (
            <Row label={t("agents.trace.chatTtft")}>
              <span className="tabular-nums">{secs(node.ttftMs, 2)}</span>
            </Row>
          )}
          <div className="mt-1 text-[10px] font-mono text-muted-foreground/70 break-all">{node.id}</div>
          {node.input !== undefined && (
            <div className="mt-2">
              <div className="mb-1 text-muted-foreground">{t("agents.trace.input")}</div>
              <Json value={node.input} />
            </div>
          )}
          {node.reasoning && (
            <div className="mt-2">
              <div className="mb-1 text-muted-foreground">{t("agents.chat.reasoning")}</div>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] whitespace-pre-wrap break-words">
                {node.reasoning}
              </pre>
            </div>
          )}
          {typeof output === "string" && output && (
            <div className="mt-2">
              <div className="mb-1 text-muted-foreground">{t("agents.trace.output")}</div>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] whitespace-pre-wrap break-words">
                {output}
              </pre>
            </div>
          )}
        </TabsContent>
        <TabsContent value="detail" className="mt-2">
          {node.detail === undefined ? (
            <p className="text-muted-foreground">{t("agents.trace.noDetail")}</p>
          ) : (
            <Json value={node.detail} />
          )}
        </TabsContent>
        <TabsContent value="tokens" className="mt-2">
          {node.usage ? (
            <>
              <Row label={t("agents.trace.inputTokens")}>
                <span className="tabular-nums">{node.usage.input.toLocaleString()}</span>
              </Row>
              <Row label={t("agents.trace.outputTokens")}>
                <span className="tabular-nums">{node.usage.output.toLocaleString()}</span>
              </Row>
            </>
          ) : (
            <p className="text-muted-foreground">{t("agents.trace.noUsage")}</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
