'use client';

import { useRef, useEffect, useState, useCallback, useDeferredValue } from "react";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import { ModelSelector } from "../components/chat/model-selector";
import { ErrorDialog, type ChatErrorState } from "../components/chat/error-dialog";
import { McpConnectionsPanel } from "../components/chat/mcp-panel";
import { McpIcon } from "../components/icons/mcp-icon";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useIsMobile } from "@/hooks/use-mobile";
import { AI_MODELS, DEFAULT_MODEL_ID } from "@/lib/types";
import { Square, SquarePen, Copy, Check, Zap, RotateCcw, Wrench, ChevronRight, Brain, Bug, ThumbsUp, ThumbsDown, Volume2, VolumeX, Globe, ExternalLink, Terminal, Paperclip, X, FileSpreadsheet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SandboxInfoBar, PopMap, type SandboxTelemetry } from "../components/chat/sandbox-telemetry";

// ── Types ──
interface ToolCallInfo {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "calling" | "done";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallInfo[];
}

interface DebugInfo {
  startedAt: number;
  firstTokenMs: number | null;
  totalMs: number | null;
  requestMessages: { role: string; content: string }[];
  streamEvents: string[];
  toolCallNames: string[];
}

// ── Constants ──

// Matches the worker's MAX_UPLOAD_BYTES / ALLOWED_UPLOAD_EXTENSIONS — checked
// client-side too so a too-large or wrong-type file never leaves the browser.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_ATTACHMENT_EXTENSIONS = [".csv", ".xlsx"];

// i18n key maps (not raw labels) — the maps themselves live outside any
// component, so lookups resolve through `t` at call time rather than baking
// in one language.
const TOOL_KEYS: Record<string, string> = {
  searchKnowledge: "chat.tool.searchKnowledge",
  executeCode: "chat.tool.executeCode",
  createWebPreview: "chat.tool.createWebPreview",
};

const SOURCE_KEYS: Record<string, string> = {
  searchKnowledge: "chat.tool.sourceSearchKnowledge",
  executeCode: "chat.tool.sourceExecuteCode",
  createWebPreview: "chat.tool.sourceCreateWebPreview",
};

// MCP server display names — product/proper nouns, same in every locale.
const MCP_SERVER_LABELS: Record<string, string> = {
  "cf-docs": "Cloudflare Docs",
  "cf-observability": "Workers Observability",
  "cf-radar": "Radar",
};

// MCP tool display name keys
const MCP_TOOL_KEYS: Record<string, string> = {
  search_cloudflare_documentation: "chat.tool.mcpToolSearchDocs",
  migrate_pages_to_workers_guide: "chat.tool.mcpToolMigratePages",
};

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function parseMcpToolName(rawName: string, t: TFunc): { isMcp: boolean; serverId: string; serverLabel: string; toolName: string; toolLabel: string } | null {
  const match = rawName.match(/^tool_([a-zA-Z0-9-]+)_(.+)$/);
  if (!match) return null;
  // Both capture groups are mandatory in this pattern (no `?`), so they're
  // always present when match succeeds — TS just can't infer that.
  const serverId = match[1]!;
  const toolName = match[2]!;
  return {
    isMcp: true,
    serverId,
    serverLabel: MCP_SERVER_LABELS[serverId] || serverId,
    toolName,
    toolLabel: MCP_TOOL_KEYS[toolName] ? t(MCP_TOOL_KEYS[toolName]) : toolName.replace(/_/g, " "),
  };
}

function friendlyToolName(rawName: string, t: TFunc): string {
  if (TOOL_KEYS[rawName]) return t(TOOL_KEYS[rawName]);
  const mcp = parseMcpToolName(rawName, t);
  if (mcp) return mcp.toolLabel;
  return rawName.replace(/_/g, " ");
}

let msgCounter = 0;
function genId() { return `msg-${Date.now()}-${++msgCounter}`; }

// ── Helper components ──

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/60 transition-colors"
      title="複製"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function MessageActions({ text, onRetry, showRetry }: { text: string; onRetry: () => void; showRetry: boolean }) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSpeak = () => {
    if (speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const plainText = text.replace(/[#*`>\-|]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\n+/g, " ").trim();
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.lang = /[\u4e00-\u9fff]/.test(plainText) ? "zh-TW" : "en-US";
    utterance.rate = 1.1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  const btnClass = "p-1 rounded-md text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/60 transition-colors";
  const activeClass = "p-1 rounded-md text-foreground hover:bg-muted/60 transition-colors";

  return (
    <div className="flex items-center gap-0.5">
      <button onClick={handleCopy} className={btnClass} title="Copy">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {showRetry && (
        <button onClick={onRetry} className={btnClass} title="重試">
          <RotateCcw className="size-3.5" />
        </button>
      )}
      <button onClick={handleSpeak} className={speaking ? activeClass : btnClass} title={speaking ? "停止" : "朗讀"}>
        {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </button>
      <button onClick={() => setFeedback((p) => (p === "up" ? null : "up"))} className={feedback === "up" ? activeClass : btnClass} title="Good">
        <ThumbsUp className="size-3.5" />
      </button>
      <button onClick={() => setFeedback((p) => (p === "down" ? null : "down"))} className={feedback === "down" ? activeClass : btnClass} title="Bad">
        <ThumbsDown className="size-3.5" />
      </button>
    </div>
  );
}

// ── Sandbox tool displays ──

interface CodeExecutionOutputItem {
  text?: string | null;
  image?: string | null;
}

interface CodeExecutionResult {
  code?: string;
  success?: boolean;
  stdout?: string;
  stderr?: string;
  results?: CodeExecutionOutputItem[];
  error?: string | null;
  sandbox?: SandboxTelemetry | null;
  edgeColo?: string | null;
}

function CodeExecutionDisplay({ toolCall }: { toolCall: ToolCallInfo }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const isCalling = toolCall.status === "calling";
  const result = (toolCall.result ?? {}) as CodeExecutionResult;
  const code = result.code ?? (toolCall.args as { code?: string } | undefined)?.code ?? "";
  const textResults = (result.results ?? []).map((r) => r.text).filter((t): t is string => Boolean(t));
  const imageResults = (result.results ?? []).map((r) => r.image).filter((i): i is string => Boolean(i));
  const output = [result.stdout, ...textResults].filter(Boolean).join("\n").trim();
  const errorText = [result.error, result.stderr].filter(Boolean).join("\n").trim();

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`inline-flex items-center gap-1.5 text-xs rounded-lg px-3 py-1.5 transition-colors cursor-pointer ${
          isCalling
            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
            : "bg-muted hover:bg-muted/80 text-muted-foreground"
        }`}
      >
        <Terminal className="size-3 shrink-0" />
        <span>{isCalling ? t("chat.tool.runningCode") : t("chat.tool.executeCode")}</span>
        {isCalling ? (
          <span className="size-3 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
        ) : (
          <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
      </button>
      {expanded && code && (
        <div className="mt-1.5 ml-3 rounded-lg overflow-hidden border border-zinc-700/50">
          <div className="flex items-center justify-between bg-zinc-800 text-zinc-300 text-xs px-4 py-1.5">
            <span className="font-mono">python</span>
            <CopyButton text={code} />
          </div>
          <pre className="bg-zinc-900 text-zinc-100 p-4 overflow-x-auto text-[13px] leading-relaxed max-h-[300px] overflow-y-auto">
            <code>{code}</code>
          </pre>
          {!isCalling && (output || errorText) && (
            <div className="border-t border-zinc-700/50">
              {output && (
                <pre className="bg-zinc-950 text-emerald-300 px-4 py-3 overflow-x-auto text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                  {output}
                </pre>
              )}
              {errorText && (
                <pre className="bg-zinc-950 text-red-400 px-4 py-3 overflow-x-auto text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                  {errorText}
                </pre>
              )}
              {imageResults.map((src, i) => (
                <div key={i} className="bg-zinc-950 p-3">
                  <img src={src} alt={`Chart ${i + 1}`} className="max-w-full rounded" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {expanded && !isCalling && result.sandbox && (
        <>
          <SandboxInfoBar sandbox={result.sandbox} />
          <PopMap edgeColo={result.edgeColo} sandboxColo={result.sandbox.colo} />
        </>
      )}
    </div>
  );
}

interface WebPreviewResult {
  url?: string;
  title?: string;
  fileCount?: number;
  note?: string;
  error?: string;
  sandbox?: SandboxTelemetry | null;
  edgeColo?: string | null;
}

function WebPreviewDisplay({ toolCall }: { toolCall: ToolCallInfo }) {
  const { t } = useTranslation();
  const [showInline, setShowInline] = useState(false);
  const isCalling = toolCall.status === "calling";
  const result = (toolCall.result ?? {}) as WebPreviewResult;

  if (isCalling) {
    return (
      <div className="my-2">
        <span className="inline-flex items-center gap-1.5 text-xs rounded-lg px-3 py-1.5 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
          <Globe className="size-3 shrink-0" />
          <span>{t("chat.tool.creatingPreview")}</span>
          <span className="size-3 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
        </span>
      </div>
    );
  }

  if (result.error || !result.url) {
    return (
      <div className="my-2">
        <span className="inline-flex items-center gap-1.5 text-xs rounded-lg px-3 py-1.5 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400">
          <Globe className="size-3 shrink-0" />
          <span>{t("chat.tool.previewFailed", { error: result.error || t("chat.tool.previewUrlMissing") })}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="my-2 ml-0 max-w-md">
      <div className="rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center size-8 rounded-md bg-primary/10 text-primary shrink-0">
            <Globe className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{result.title || "Web Preview"}</div>
            <div className="text-xs text-muted-foreground truncate">{result.url}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2.5">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <ExternalLink className="size-3" />
            {t("chat.tool.openPreview")}
          </a>
          <button
            onClick={() => setShowInline(!showInline)}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-muted hover:bg-muted/80 text-muted-foreground transition-colors cursor-pointer"
          >
            {showInline ? t("chat.tool.collapse") : t("chat.tool.showInline")}
          </button>
        </div>
        {result.note && <div className="text-[11px] text-muted-foreground/70 mt-2">{result.note}</div>}
      </div>
      {showInline && (
        <iframe
          src={result.url}
          sandbox="allow-scripts"
          className="mt-2 w-full h-[400px] rounded-lg border bg-white"
          title={result.title || "Web Preview"}
        />
      )}
      {result.sandbox && (
        <>
          <SandboxInfoBar sandbox={result.sandbox} />
          <PopMap edgeColo={result.edgeColo} sandboxColo={result.sandbox.colo} />
        </>
      )}
    </div>
  );
}

// ── Tool Call Display ──

function ToolCallDisplay({ toolCall }: { toolCall: ToolCallInfo }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const mcp = parseMcpToolName(toolCall.name, t);

  if (toolCall.name === "executeCode") return <CodeExecutionDisplay toolCall={toolCall} />;
  if (toolCall.name === "createWebPreview") return <WebPreviewDisplay toolCall={toolCall} />;
  const label = friendlyToolName(toolCall.name, t);
  const isCalling = toolCall.status === "calling";

  return (
    <div className="my-2">
      <button
        onClick={() => !isCalling && setExpanded(!expanded)}
        className={`inline-flex items-center gap-1.5 text-xs rounded-lg transition-colors ${
          isCalling
            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 px-3 py-1.5"
            : "bg-muted hover:bg-muted/80 text-muted-foreground cursor-pointer px-3 py-1.5"
        }`}
      >
        {mcp ? (
          <>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-semibold shrink-0">
              MCP
            </span>
            <span className="text-muted-foreground/50 mx-0.5">{mcp.serverLabel}</span>
            <span className="font-medium">{isCalling ? `${label}...` : label}</span>
          </>
        ) : (
          <>
            <Wrench className="size-3 shrink-0" />
            <span>{isCalling ? `${label}...` : label}</span>
          </>
        )}
        {isCalling && (
          <span className="size-3 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
        )}
        {!isCalling && (
          <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
      </button>
      {expanded && toolCall.result != null && (
        <div className="mt-1.5 ml-3 p-3 rounded-lg bg-muted/50 text-xs font-mono overflow-x-auto max-h-[200px] md:max-h-[300px] overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words">
            {typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(toolCall.result as Record<string, unknown>, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Reasoning Display ──

function ReasoningDisplay({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-muted/60 text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <Brain className="size-3" />
        <span>{t("chat.tool.reasoning")}</span>
        <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="mt-1.5 ml-3 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground/70 leading-relaxed max-h-[200px] md:max-h-[300px] overflow-y-auto whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

// ── Sources Display ──

function SourcesDisplay({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const { t } = useTranslation();
  const sources = [...new Set(
    toolCalls
      .filter((tc) => tc.status === "done")
      .map((tc) => {
        const sourceKey = SOURCE_KEYS[tc.name];
        if (sourceKey) return t(sourceKey);
        const mcp = parseMcpToolName(tc.name, t);
        if (mcp) return `MCP: ${mcp.serverLabel}`;
        return friendlyToolName(tc.name, t);
      })
  )];
  if (!sources.length) return null;

  return (
    <div className="flex items-center gap-2 mt-3 flex-wrap">
      {sources.map((source) => (
        <span
          key={source}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400 border border-blue-200/50 dark:border-blue-800/30"
        >
          <span className="size-1.5 rounded-full bg-blue-500" />
          {source}
        </span>
      ))}
    </div>
  );
}

// ── Assistant Message (with deferred markdown + retry) ──

function AssistantMessage({
  message,
  isStreaming,
  isLastAssistant,
  isLoading,
  onRetry,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  isLastAssistant: boolean;
  isLoading: boolean;
  onRetry: () => void;
}) {
  const deferredContent = useDeferredValue(message.content);
  const renderedContent = isStreaming ? deferredContent : message.content;
  const isError = renderedContent.startsWith("❌");
  const showLoading = isStreaming && !message.content;

  return (
    <div className="max-w-full">
      {/* Reasoning */}
      {message.reasoning && <ReasoningDisplay text={message.reasoning} />}

      {/* Tool calls */}
      {message.toolCalls?.map((tc) => (
        <ToolCallDisplay key={tc.id} toolCall={tc} />
      ))}

      {/* Content with Markdown */}
      {renderedContent ? (
        <div className="group/msg relative">
          {isError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <span>{renderedContent}</span>
              {isLastAssistant && !isLoading && (
                <button
                  onClick={onRetry}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-border/60 hover:bg-muted/60 transition-colors text-muted-foreground"
                >
                  <RotateCcw className="size-3" />
                  <span>重試</span>
                </button>
              )}
            </div>
          ) : (
            <>
              <MarkdownRenderer content={renderedContent} isStreaming={isStreaming} />
              {!isStreaming && (
                <div className="mt-1 opacity-60 md:opacity-0 md:group-hover/msg:opacity-100 transition-opacity">
                  <MessageActions text={message.content} onRetry={onRetry} showRetry={isLastAssistant && !isLoading} />
                </div>
              )}
            </>
          )}
        </div>
      ) : showLoading ? (
        <div className="flex items-center gap-1.5 py-1">
          <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
          <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
          <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
        </div>
      ) : null}

      {/* Sources from tool calls */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <SourcesDisplay toolCalls={message.toolCalls} />
      )}
    </div>
  );
}

// ── Debug Panel ──

function DebugPanel({
  open, onClose, model, messages, debugInfo,
}: {
  open: boolean; onClose: () => void;
  model: string;
  messages: ChatMessage[]; debugInfo: DebugInfo | null;
}) {
  const [tab, setTab] = useState<"ctx" | "req" | "events" | "prompt">("ctx");
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const fetchPrompt = async () => {
    setPromptLoading(true);
    try {
      const res = await fetch("/api/debug/system-prompt");
      const data = await res.json() as Record<string, unknown>;
      setSystemPrompt(String(data.content ?? JSON.stringify(data)));
    } catch {
      setSystemPrompt("(fetch error)");
    } finally {
      setPromptLoading(false);
    }
  };

  if (!open) return null;

  const tabBtn = (t: string, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t as "ctx" | "req" | "events" | "prompt")}
      className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
        tab === t ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
      }`}
    >{label}</button>
  );

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-amber-400/50 bg-background/95 backdrop-blur shadow-2xl"
      style={{ height: "40vh", maxHeight: "400px" }}
    >
      <div className="flex items-center justify-between px-3 h-9 border-b border-border/50 bg-amber-50/30 dark:bg-amber-950/20 shrink-0">
        <div className="flex items-center gap-2">
          <Bug className="size-3 text-amber-500" />
          <span className="text-[11px] font-mono font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Dev Panel</span>
          <div className="flex items-center gap-0.5 ml-1 border border-border/50 rounded-md overflow-hidden">
            {tabBtn("ctx", "ctx")}
            {tabBtn("req", "request")}
            {tabBtn("events", "events")}
            {tabBtn("prompt", "prompt")}
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-[11px] px-2 h-6 rounded hover:bg-muted/60">✕ close</button>
      </div>

      <div className="overflow-y-auto font-mono text-[11px]" style={{ height: "calc(100% - 36px)" }}>
        {tab === "ctx" && (
          <div className="p-3 grid grid-cols-2 gap-2">
            <div className="p-2 rounded bg-muted/40 border border-border/30 space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Session</div>
              <div>model: {model}</div>
              <div>msgs: {messages.length}</div>
            </div>
            <div className="p-2 rounded bg-muted/40 border border-border/30 space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Last Request</div>
              {debugInfo ? (
                <>
                  <div>at: {new Date(debugInfo.startedAt).toLocaleTimeString()}</div>
                  <div>ttft: {debugInfo.firstTokenMs != null ? `${debugInfo.firstTokenMs}ms` : "—"}</div>
                  <div>total: {debugInfo.totalMs != null ? `${debugInfo.totalMs}ms` : "—"}</div>
                  <div className="text-[10px] text-muted-foreground/80 break-all">
                    tools: {debugInfo.toolCallNames.join(", ") || "none"}
                  </div>
                </>
              ) : <div className="text-muted-foreground">no request yet</div>}
            </div>
          </div>
        )}

        {tab === "req" && (
          <div className="p-3">
            {debugInfo ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-muted-foreground">{debugInfo.requestMessages.length} messages sent</span>
                  <button
                    onClick={() => copy(JSON.stringify(debugInfo.requestMessages, null, 2), "req")}
                    className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted"
                  >
                    {copied === "req" ? "✓ copied" : "copy JSON"}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words leading-relaxed text-foreground/80">
                  {JSON.stringify(debugInfo.requestMessages, null, 2)}
                </pre>
              </>
            ) : <div className="p-1 text-muted-foreground">No request yet</div>}
          </div>
        )}

        {tab === "events" && (
          <div className="p-3">
            {debugInfo ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-muted-foreground">{debugInfo.streamEvents.length} events</span>
                  <button
                    onClick={() => copy(debugInfo.streamEvents.join("\n"), "events")}
                    className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted"
                  >
                    {copied === "events" ? "✓ copied" : "copy all"}
                  </button>
                </div>
                <div className="space-y-px">
                  {debugInfo.streamEvents.map((ev, i) => {
                    let color = "text-foreground/70";
                    try {
                      const p = JSON.parse(ev) as { type?: string };
                      if (p.type === "text-delta" || p.type === "reasoning-delta") color = "text-green-600 dark:text-green-400";
                      if (p.type === "tool-call-start" || p.type === "tool-result") color = "text-blue-600 dark:text-blue-400";
                      if (p.type === "error") color = "text-red-600 dark:text-red-400";
                      if (p.type === "finish" || p.type === "done") color = "text-muted-foreground/50";
                    } catch { /* noop */ }
                    return (
                      <div key={i} className={`py-px border-b border-border/20 leading-tight truncate ${color}`} title={ev}>
                        {ev}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : <div className="p-1 text-muted-foreground">No events yet</div>}
          </div>
        )}

        {tab === "prompt" && (
          <div className="p-3">
            <div className="flex items-center gap-3 mb-3">
              <button
                onClick={fetchPrompt}
                disabled={promptLoading}
                className="text-[11px] px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-50"
              >
                {promptLoading ? "Loading…" : "Fetch System Prompt"}
              </button>
            </div>
            {systemPrompt && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-muted-foreground">{systemPrompt.length} chars</span>
                  <button
                    onClick={() => copy(systemPrompt, "prompt")}
                    className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted"
                  >
                    {copied === "prompt" ? "✓ copied" : "copy"}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words leading-relaxed text-foreground/80">{systemPrompt}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ──
export function ChatPage() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [errorDialog, setErrorDialog] = useState<{ open: boolean; error: ChatErrorState | null }>({
    open: false,
    error: null,
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [connectedMcpServers, setConnectedMcpServers] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [pendingAttachment, setPendingAttachment] = useState<{ name: string; contentBase64: string; size: number } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const streamingMsgIdRef = useRef<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  // Debug state (dev-only)
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);

  // Keep messagesRef in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Smart auto-scroll
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Scroll to bottom when streaming ends
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    if (prevIsLoadingRef.current && !isLoading) {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    }
    prevIsLoadingRef.current = isLoading;
  }, [isLoading]);

  // ── Stream NDJSON from /api/chat ──
  const streamChat = useCallback(async (allMessages: ChatMessage[], attachments?: Array<{ name: string; contentBase64: string }>) => {
    const aiModel = AI_MODELS.find((m) => m.id === selectedModel);
    const modelId = aiModel?.workersAiModel ?? aiModel?.providerModelId ?? "@cf/openai/gpt-oss-120b";
    const provider = aiModel?.provider ?? "workers-ai";

    const controller = new AbortController();
    abortRef.current = controller;

    // Add assistant placeholder
    const assistantMsgId = genId();
    streamingMsgIdRef.current = assistantMsgId;
    const assistantMsg: ChatMessage = { id: assistantMsgId, role: "assistant", content: "", reasoning: "", toolCalls: [] };

    setMessages((prev) => [...prev, assistantMsg]);
    setIsLoading(true);

    // Debug tracking
    const debugStart = Date.now();
    let debugFirstToken: number | null = null;
    const debugEvents: string[] = [];
    const debugToolNames: string[] = [];
    const debugReqMsgs = allMessages.map((m) => ({ role: m.role, content: m.content }));

    // doFetch: single streaming fetch attempt, returns flags
    const doFetch = async (): Promise<{ gotTextContent: boolean; gotError: boolean; hasToolResults: boolean }> => {
      let gotTextContent = false;
      let gotError = false;
      let hasToolResults = false;

      let userName: string | undefined;
      let userEmail: string | undefined;
      try {
        const raw = localStorage.getItem("cf-demo-user");
        if (raw) { const u = JSON.parse(raw); userName = u.name; userEmail = u.email; }
      } catch {}

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: debugReqMsgs,
          model: modelId,
          provider,
          toolsEnabled,
          mcpServers: connectedMcpServers,
          userName,
          userEmail,
          attachments,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "Unknown error");
        // Detect Cloudflare Firewall for AI HTML block page
        if (errorText.includes("<!DOCTYPE html") && (/you have been blocked/i.test(errorText) || /cf-error-details/i.test(errorText))) {
          const rayMatch = errorText.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/);
          const ipMatch = errorText.match(/id="cf-footer-ip">([^<]+)</);
          gotError = true;
          setErrorDialog({
            open: true,
            error: {
              errorType: "firewall",
              message: "您的請求已被 Cloudflare Firewall for AI 攔截。",
              rayId: rayMatch?.[1] || null,
              gatewayLogId: null,
              statusCode: res.status,
              gatewayCode: null,
              userIp: ipMatch?.[1] || null,
            },
          });
          return { gotTextContent, gotError, hasToolResults };
        }
        throw new Error(`HTTP ${res.status}: ${errorText.substring(0, 300)}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let accText = "";
      let accReasoning = "";
      let toolCalls: ToolCallInfo[] = [];

      // 50ms batched flush
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushUpdate = () => {
        flushTimer = null;
        const t = accText;
        const r = accReasoning;
        const tc = [...toolCalls];
        setMessages((prev) =>
          prev.map((m) => m.id === assistantMsgId ? { ...m, content: t, reasoning: r, toolCalls: tc } : m)
        );
      };
      const scheduleFlush = () => {
        if (!flushTimer) flushTimer = setTimeout(flushUpdate, 50);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            debugEvents.push(line);
            try {
              const event = JSON.parse(line);
              switch (event.type) {
                case "text-delta":
                  if (!debugFirstToken) debugFirstToken = Date.now() - debugStart;
                  gotTextContent = true;
                  accText += event.text;
                  scheduleFlush();
                  break;
                case "reasoning-delta":
                  if (!debugFirstToken) debugFirstToken = Date.now() - debugStart;
                  accReasoning += event.text;
                  scheduleFlush();
                  break;
                case "tool-call-start":
                  toolCalls = [...toolCalls, { id: event.toolCallId, name: event.toolName, status: "calling" }];
                  debugToolNames.push(event.toolName);
                  scheduleFlush();
                  break;
                case "tool-call":
                  toolCalls = toolCalls.map((tc) =>
                    tc.id === event.toolCallId ? { ...tc, args: event.args } : tc
                  );
                  scheduleFlush();
                  break;
                case "tool-result":
                  hasToolResults = true;
                  toolCalls = toolCalls.map((tc) =>
                    tc.id === event.toolCallId ? { ...tc, status: "done" as const, result: event.result } : tc
                  );
                  scheduleFlush();
                  break;
                case "error":
                  gotError = true;
                  setErrorDialog({
                    open: true,
                    error: {
                      errorType: event.errorType || "general",
                      message: event.message || "發生錯誤",
                      rayId: event.rayId || null,
                      gatewayLogId: event.gatewayLogId || null,
                      statusCode: event.statusCode || null,
                      gatewayCode: event.gatewayCode || null,
                      userIp: event.userIp || null,
                    },
                  });
                  break;
                case "finish":
                case "done":
                  break;
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } finally {
        // Final flush — clear timer and do immediate update
        if (flushTimer) clearTimeout(flushTimer);
        flushUpdate();
      }

      return { gotTextContent, gotError, hasToolResults };
    };

    try {
      // First attempt
      let { gotTextContent, gotError, hasToolResults } = await doFetch();

      // Client-side retry: if server returned no text and no error, retry once
      if (!gotTextContent && !gotError && !controller.signal.aborted) {
        console.warn("[Chat] No text content received, retrying...");
        // Reset assistant message for retry
        setMessages((prev) =>
          prev.map((m) => m.id === assistantMsgId ? { ...m, content: "", toolCalls: [], reasoning: "" } : m)
        );
        ({ gotTextContent, gotError } = await doFetch());
      }

      // Smart abort: if aborted but we have tool results without text, show fallback
      if (controller.signal.aborted && hasToolResults && !gotTextContent) {
        setMessages((prev) =>
          prev.map((m) => m.id === assistantMsgId
            ? { ...m, content: "⚠️ 已停止。工具查詢已完成但回覆被中斷。" }
            : m
          )
        );
      }
      // If aborted with no content at all, remove empty assistant message
      if (controller.signal.aborted && !gotTextContent && !hasToolResults) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
      }
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        // Smart abort: check if we had partial content
        const lastMsg = messagesRef.current.find((m) => m.id === assistantMsgId);
        if (lastMsg && !lastMsg.content && lastMsg.toolCalls?.some((tc) => tc.status === "done")) {
          setMessages((prev) =>
            prev.map((m) => m.id === assistantMsgId
              ? { ...m, content: "⚠️ 已停止。工具查詢已完成但回覆被中斷。" }
              : m
            )
          );
        } else if (lastMsg && !lastMsg.content && !lastMsg.reasoning) {
          setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
        }
        return;
      }
      console.error("[Chat] Stream error:", err);
      const errMsg = (err as Error).message || "發生錯誤";
      // Detect Firewall HTML in error message (fallback)
      const isFirewallHtml = errMsg.includes("<!DOCTYPE html") && (/you have been blocked/i.test(errMsg) || /cf-error-details/i.test(errMsg));
      if (isFirewallHtml) {
        const rayMatch = errMsg.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/);
        const ipMatch = errMsg.match(/id="cf-footer-ip">([^<]+)</);
        setErrorDialog({
          open: true,
          error: {
            errorType: "firewall",
            message: "您的請求已被 Cloudflare Firewall for AI 攔截。",
            rayId: rayMatch?.[1] || null,
            gatewayLogId: null,
            statusCode: null,
            gatewayCode: null,
            userIp: ipMatch?.[1] || null,
          },
        });
      } else {
        setErrorDialog({
          open: true,
          error: {
            errorType: "general",
            message: errMsg.substring(0, 500),
            rayId: null,
            gatewayLogId: null,
            statusCode: null,
            gatewayCode: null,
            userIp: null,
          },
        });
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
      streamingMsgIdRef.current = null;
      // Update debug info
      setDebugInfo({
        startedAt: debugStart,
        firstTokenMs: debugFirstToken,
        totalMs: Date.now() - debugStart,
        requestMessages: debugReqMsgs,
        streamEvents: debugEvents,
        toolCallNames: debugToolNames,
      });
    }
  }, [selectedModel, toolsEnabled, connectedMcpServers]);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    isNearBottomRef.current = true;
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setInput("");
    const attachment = pendingAttachment;
    setPendingAttachment(null);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    const displayText = attachment ? `${text.trim()}\n\n📎 ${attachment.name}` : text.trim();
    const userMsg: ChatMessage = { id: genId(), role: "user", content: displayText };
    // Use messagesRef to avoid stale closure
    const allMessages = [...messagesRef.current, userMsg];
    setMessages(allMessages);
    await streamChat(allMessages, attachment ? [{ name: attachment.name, contentBase64: attachment.contentBase64 }] : undefined);
  }, [isLoading, streamChat, pendingAttachment]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  const handleRetry = useCallback(async () => {
    // Remove last assistant message and re-send
    const current = messagesRef.current;
    const withoutLast = current.filter((_, i) => {
      if (i === current.length - 1 && current[i]?.role === "assistant") return false;
      return true;
    });
    setMessages(withoutLast);
    await streamChat(withoutLast);
  }, [streamChat]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    setAttachmentError(null);
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext)) {
      setAttachmentError(t("chat.attachment.unsupportedType"));
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError(t("chat.attachment.tooLarge"));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // readAsDataURL yields "data:<mime>;base64,<data>" — keep just the payload
      const contentBase64 = result.slice(result.indexOf(",") + 1);
      setPendingAttachment({ name: file.name, contentBase64, size: file.size });
    };
    reader.onerror = () => setAttachmentError(t("chat.attachment.readError"));
    reader.readAsDataURL(file);
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (input.trim()) handleSend(input);
    }
  };

  const handleNewChat = useCallback(() => {
    if (isLoading) handleStop();
    setMessages([]);
    setInput("");
    textareaRef.current?.focus();
  }, [isLoading, handleStop]);

  const hasMessages = messages.length > 0;

  const suggestions = [
    { title: t("chat.suggestions.workers.title"), desc: t("chat.suggestions.workers.prompt") },
    { title: t("chat.suggestions.aiGateway.title"), desc: t("chat.suggestions.aiGateway.prompt") },
    { title: t("chat.suggestions.r2.title"), desc: t("chat.suggestions.r2.prompt") },
  ];

  const sandboxSuggestions = [
    { title: t("chat.sandboxSuggestions.factorial.title"), desc: t("chat.sandboxSuggestions.factorial.prompt"), icon: Terminal },
    { title: t("chat.sandboxSuggestions.fibonacci.title"), desc: t("chat.sandboxSuggestions.fibonacci.prompt"), icon: Terminal },
    { title: t("chat.sandboxSuggestions.countdown.title"), desc: t("chat.sandboxSuggestions.countdown.prompt"), icon: Globe },
  ];

  // Sandbox demo prompts need tools enabled to actually invoke executeCode /
  // createWebPreview — otherwise clicking one just gets a plain-text answer
  // with no sandbox involved, which defeats the point of the suggestion.
  const handleSandboxSuggestion = (desc: string) => {
    if (!toolsEnabled) setToolsEnabled(true);
    handleSend(desc);
  };

  const safetySuggestions = [
    { title: t("chat.safetySuggestions.bully.title"), desc: t("chat.safetySuggestions.bully.prompt") },
    { title: t("chat.safetySuggestions.hate.title"), desc: t("chat.safetySuggestions.hate.prompt") },
    { title: t("chat.safetySuggestions.violence.title"), desc: t("chat.safetySuggestions.violence.prompt") },
    { title: t("chat.safetySuggestions.pii.title"), desc: t("chat.safetySuggestions.pii.prompt") },
    { title: t("chat.safetySuggestions.injection1.title"), desc: t("chat.safetySuggestions.injection1.prompt") },
    { title: t("chat.safetySuggestions.injection2.title"), desc: t("chat.safetySuggestions.injection2.prompt") },
  ];

  const lastAssistantIdx = messages.length - 1;
  const lastAssistantMsg = messages[lastAssistantIdx]?.role === "assistant" ? messages[lastAssistantIdx] : undefined;
  const isDev = process.env.NODE_ENV === "development";

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Chat area ── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* ── Header ── */}
        <div className="flex shrink-0 py-2.5 px-3 md:px-4">
          <div className="max-w-3xl mx-auto w-full flex items-center justify-center gap-1 relative">
            {hasMessages && (
              <button
                onClick={handleNewChat}
                className="inline-flex items-center gap-1.5 h-8 px-2 text-muted-foreground rounded-lg hover:bg-muted/60 transition-colors"
                title={t("chat.clearHistory")}
              >
                <SquarePen className="size-4" />
              </button>
            )}
            <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />
            <button
              onClick={() => setToolsEnabled((v) => !v)}
              className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                toolsEnabled
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
              title={toolsEnabled ? "工具已啟用 (AI Search / MCP)" : "啟用工具 (AI Search / MCP)"}
            >
              <Zap className="size-3.5" />
              <span className="hidden md:inline">工具</span>
            </button>
            <button
              onClick={() => setShowMcpPanel((v) => !v)}
              className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                showMcpPanel
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
              title="MCP Connections"
            >
              <McpIcon className="size-3.5" />
              <span className="hidden md:inline">MCP</span>
              {connectedMcpServers.length > 0 && (
                <span className="size-4 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 text-[10px] flex items-center justify-center">{connectedMcpServers.length}</span>
              )}
            </button>
            {isDev && (
              <button
                onClick={() => setDebugOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 h-8 px-2 rounded-lg transition-colors ${
                  debugOpen
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
                title="Dev Debug Panel"
              >
                <Bug className="size-4" />
              </button>
            )}
          </div>
        </div>

        {/* ── Messages ── */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-3 md:px-4">
            {!hasMessages ? (
              <div className="flex flex-col justify-center min-h-[calc(100vh-16rem)]">
                <div className="space-y-6">
                  <div>
                    <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{t("chat.title")}</h1>
                    <p className="text-base text-muted-foreground mt-1">{t("chat.description")}</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {suggestions.map((s) => (
                      <button
                        key={s.title}
                        onClick={() => handleSend(s.desc)}
                        className="text-left rounded-2xl border border-border/60 px-4 py-3.5 hover:bg-muted/50 active:bg-muted/70 transition-colors"
                      >
                        <div className="text-sm font-medium">{s.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.desc}</div>
                      </button>
                    ))}
                  </div>
                  <div className="pt-2">
                    <p className="text-xs font-medium text-muted-foreground/70 mb-2">{t("chat.sandboxLabel")}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {sandboxSuggestions.map((s) => (
                        <button
                          key={s.title}
                          onClick={() => handleSandboxSuggestion(s.desc)}
                          className="text-left rounded-2xl border border-sky-300/40 dark:border-sky-800/40 px-4 py-3.5 hover:bg-sky-50/50 dark:hover:bg-sky-950/20 active:bg-sky-50 dark:active:bg-sky-950/30 transition-colors"
                        >
                          <div className="flex items-center gap-1.5 text-sm font-medium">
                            <s.icon className="size-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
                            {s.title}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="pt-2">
                    <p className="text-xs font-medium text-muted-foreground/70 mb-2">{t("chat.safetyLabel")}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {safetySuggestions.map((s) => (
                        <button
                          key={s.title}
                          onClick={() => handleSend(s.desc)}
                          className="text-left rounded-2xl border border-destructive/30 px-4 py-3.5 hover:bg-destructive/5 active:bg-destructive/10 transition-colors"
                        >
                          <div className="text-sm font-medium text-destructive">{s.title}</div>
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 space-y-6">
                {messages.map((msg) => {
                  const isStreamingThis = isLoading && msg.role === "assistant" && msg.id === streamingMsgIdRef.current;
                  const isLast = msg.id === lastAssistantMsg?.id;

                  return (
                    <div key={msg.id}>
                      {msg.role === "user" ? (
                        <div className="flex justify-end gap-1 items-start group">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-1.5">
                            <CopyButton text={msg.content} />
                          </div>
                          <div className="bg-muted rounded-3xl px-4 py-2.5 md:px-5 md:py-3 max-w-[85%]">
                            <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                          </div>
                        </div>
                      ) : (
                        <AssistantMessage
                          message={msg}
                          isStreaming={isStreamingThis}
                          isLastAssistant={isLast}
                          isLoading={isLoading}
                          onRetry={handleRetry}
                        />
                      )}
                    </div>
                  );
                })}
                {/* Loading indicator when waiting for first assistant response */}
                {isLoading && (!lastAssistantMsg || messages[messages.length - 1]?.role === "user") && (
                  <div className="flex items-center gap-1.5 py-1">
                    <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* ── Input area ── */}
        <div className="pt-2 px-3 md:px-4 pb-4 shrink-0">
          <div className="max-w-3xl mx-auto">
            <input
              ref={fileInputRef}
              type="file"
              accept={ALLOWED_ATTACHMENT_EXTENSIONS.join(",")}
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="relative rounded-3xl border bg-muted/30 focus-within:border-foreground/20 transition-colors">
              {pendingAttachment && (
                <div className="flex items-center gap-1.5 px-4 md:px-5 pt-3">
                  <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
                    <FileSpreadsheet className="size-3.5 shrink-0" />
                    <span className="max-w-[200px] truncate">{pendingAttachment.name}</span>
                    <span className="text-muted-foreground/60">({(pendingAttachment.size / 1024).toFixed(0)} KB)</span>
                    <button
                      type="button"
                      onClick={() => setPendingAttachment(null)}
                      className="ml-0.5 hover:text-foreground transition-colors cursor-pointer"
                      title={t("chat.attachment.remove")}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.placeholder")}
                rows={1}
                className="w-full resize-none bg-transparent px-4 md:px-5 pt-3.5 pb-12 text-sm placeholder:text-muted-foreground/70 focus:outline-none min-h-[52px] max-h-[200px]"
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                title={t("chat.attachment.attach")}
                className="absolute bottom-2.5 left-3 size-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center transition-colors disabled:opacity-40 cursor-pointer"
              >
                <Paperclip className="size-4" />
              </button>
              <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-2">
                {isLoading ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="size-8 rounded-full bg-foreground text-background flex items-center justify-center hover:bg-foreground/80 transition-colors"
                  >
                    <Square className="size-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { if (input.trim()) handleSend(input); }}
                    disabled={!input.trim()}
                    className="h-8 px-4 rounded-full bg-foreground text-background text-xs font-medium flex items-center justify-center disabled:bg-muted-foreground/30 disabled:text-muted-foreground/50 transition-colors hover:bg-foreground/80"
                  >
                    {t("chat.send")}
                  </button>
                )}
              </div>
            </div>
            {attachmentError && (
              <p className="text-center text-[11px] text-destructive mt-1.5">{attachmentError}</p>
            )}
            <p className="text-center text-[11px] text-muted-foreground/60 mt-2">{t("chat.footer")}</p>
          </div>
        </div>
      </div>

      {/* ── MCP Panel: Desktop sidebar ── */}
      {showMcpPanel && !isMobile && (
        <div className="w-72 shrink-0 flex flex-col">
          <McpConnectionsPanel
            onClose={() => setShowMcpPanel(false)}
            connectedServers={connectedMcpServers}
            onServersChange={setConnectedMcpServers}
          />
        </div>
      )}

      {/* ── MCP Panel: Mobile sheet ── */}
      {isMobile && (
        <Sheet open={showMcpPanel} onOpenChange={setShowMcpPanel}>
          <SheetContent side="right" className="p-0 w-[85%] sm:max-w-sm [&>button]:hidden">
            <VisuallyHidden><SheetTitle>MCP Servers</SheetTitle></VisuallyHidden>
            <McpConnectionsPanel
              onClose={() => setShowMcpPanel(false)}
              connectedServers={connectedMcpServers}
              onServersChange={setConnectedMcpServers}
            />
          </SheetContent>
        </Sheet>
      )}

      <ErrorDialog
        open={errorDialog.open}
        onClose={() => setErrorDialog({ open: false, error: null })}
        error={errorDialog.error}
      />

      {/* ── Dev Debug Panel ── */}
      {isDev && (
        <DebugPanel
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
          model={selectedModel}
          messages={messages}
          debugInfo={debugInfo}
        />
      )}
    </div>
  );
}
