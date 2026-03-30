import { useRef, useEffect, useState, useCallback } from "react";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import { ModelSelector } from "../components/chat/model-selector";
import { ErrorDialog, type ChatErrorState } from "../components/chat/error-dialog";
import { McpConnectionsPanel } from "../components/chat/mcp-panel";
import { AI_MODELS, DEFAULT_MODEL_ID } from "@/lib/types";
import { Square, SquarePen, Copy, Check, Plug, Search as SearchIcon, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ToolCallInfo {
  id: string;
  name: string;
  status: "calling" | "done";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallInfo[];
}

let _id = 0;
function genId() { return `msg-${++_id}-${Date.now()}`; }

function extractRayId(html: string): string | null {
  const m =
    html.match(/Cloudflare Ray ID[:\s]*<[^>]+>([a-f0-9]{16,})<\/[^>]+>/i) ||
    html.match(/Cloudflare Ray ID[:\s]*([a-f0-9]{16,})/i) ||
    html.match(/Ray ID[:\s]*([a-f0-9]{16,})/i);
  return m?.[1] ?? null;
}

function extractUserIp(html: string): string | null {
  const m =
    html.match(/id=["']cf-footer-ip["'][^>]*>([\d.:a-fA-F]+)<\/span>/i) ||
    html.match(/Your IP[:\s]*([\d.:a-fA-F]+)/i);
  return m?.[1] ?? null;
}

function parseClientHttpError(status: number, body: string): import("../components/chat/error-dialog").ChatErrorState {
  const isCfFirewall =
    status === 403 &&
    (body.includes("Sorry, you have been blocked") ||
      body.includes("Cloudflare Ray ID") ||
      body.includes("Firewall for AI") ||
      body.includes("security service"));
  if (isCfFirewall) {
    return {
      errorType: "firewall",
      message: "您的請求被 Cloudflare Firewall for AI 安全防護攔截",
      rayId: extractRayId(body),
      gatewayLogId: null,
      statusCode: status,
      gatewayCode: null,
      userIp: extractUserIp(body),
    };
  }
  // AI Gateway JSON format: { success: false, error: [{code, message}] }
  const jsonStart = body.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(body.slice(jsonStart)) as {
        success?: boolean;
        error?: Array<{ code?: number | string; message?: string }>;
      };
      if (parsed.success === false && Array.isArray(parsed.error) && parsed.error[0]?.message) {
        const code = parsed.error[0].code;
        const codeNum = code ? Number(code) : NaN;
        const errorType = !isNaN(codeNum) && codeNum === 2016 ? "firewall" :
          !isNaN(codeNum) && codeNum === 2029 ? "dlp" : "gateway";
        return {
          errorType,
          message: parsed.error[0].message,
          rayId: null,
          gatewayLogId: null,
          statusCode: status,
          gatewayCode: code ? String(code) : null,
          userIp: null,
        };
      }
    } catch { /* ignore */ }
  }
  return {
    errorType: "general",
    message: `HTTP ${status}`,
    rayId: null,
    gatewayLogId: null,
    statusCode: status,
    gatewayCode: null,
    userIp: null,
  };
}

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

const TOOL_LABELS: Record<string, string> = {
  searchKnowledge: "搜尋知識庫",
};

function friendlyToolName(rawName: string): string {
  if (TOOL_LABELS[rawName]) return TOOL_LABELS[rawName];
  // MCP tools often have format like "tool_abc123_actual_name"
  const mcpMatch = rawName.match(/^tool_[a-zA-Z0-9]+_(.+)$/);
  if (mcpMatch?.[1]) return mcpMatch[1].replace(/_/g, " ");
  return rawName.replace(/_/g, " ");
}

function ToolBadge({ toolName, state }: { toolName: string; state: "calling" | "done" }) {
  const label = friendlyToolName(toolName);
  const isDone = state === "done";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full transition-opacity ${
        isDone
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 opacity-70"
          : "bg-amber-200 text-amber-800 dark:bg-amber-800/60 dark:text-amber-200 animate-pulse"
      }`}
    >
      <SearchIcon className="size-3 shrink-0" />
      {label}
    </span>
  );
}

export function ChatPage() {
  const { t } = useTranslation();
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [errorDialog, setErrorDialog] = useState<{ open: boolean; error: ChatErrorState | null }>({
    open: false,
    error: null,
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [input, setInput] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const aiModel = AI_MODELS.find((m) => m.id === selectedModel);
  const modelId = aiModel?.workersAiModel ?? aiModel?.providerModelId ?? "@cf/openai/gpt-oss-120b";
  const provider = aiModel?.provider ?? "workers-ai";

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

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

  const doSend = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    isNearBottomRef.current = true;
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const userMsg: ChatMessage = { id: genId(), role: "user", content: text.trim() };
    const assistantId = genId();
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", toolCalls: [], reasoning: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const apiMessages = [...messagesRef.current, userMsg]
      .filter((m): m is ChatMessage => m.role === "user" || (m.role === "assistant" && !!(m.content || m.toolCalls?.length)))
      .map((m) => ({ role: m.role, content: m.content }));

    let accContent = "";
    let accReasoning = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStreaming = () => {
      flushTimer = null;
      const c = accContent;
      const r = accReasoning;
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: c, reasoning: r || m.reasoning } : m));
    };
    const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flushStreaming, 50); };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, model: modelId, provider, toolsEnabled }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        setErrorDialog({ open: true, error: parseClientHttpError(res.status, errText) });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          switch (event.type) {
            case "text-delta":
              accContent += event.text as string;
              scheduleFlush();
              break;
            case "reasoning-delta":
              accReasoning += event.text as string;
              scheduleFlush();
              break;
            case "tool-call-start":
              setMessages((prev) => prev.map((m) => m.id === assistantId ? {
                ...m,
                toolCalls: [...(m.toolCalls || []), { id: event.toolCallId as string, name: event.toolName as string, status: "calling" as const }],
              } : m));
              break;
            case "tool-result":
              setMessages((prev) => prev.map((m) => m.id === assistantId ? {
                ...m,
                toolCalls: (m.toolCalls || []).map((tc) => tc.id === event.toolCallId ? { ...tc, status: "done" as const } : tc),
              } : m));
              break;
            case "error": {
              const errEvent = event as { type: string; errorType?: string; message?: string; rayId?: string; gatewayLogId?: string; statusCode?: number; gatewayCode?: string; userIp?: string };
              setErrorDialog({ open: true, error: {
                errorType: (errEvent.errorType as "firewall" | "gateway" | "dlp" | "general") || "general",
                message: errEvent.message || "發生錯誤",
                rayId: errEvent.rayId || null,
                gatewayLogId: errEvent.gatewayLogId || null,
                statusCode: errEvent.statusCode || null,
                gatewayCode: errEvent.gatewayCode || null,
                userIp: errEvent.userIp || null,
              }});
              break;
            }
          }
        } catch { /* skip malformed */ }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);

      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushStreaming();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorDialog({ open: true, error: { errorType: "general", message: (err as Error).message || "發生錯誤", rayId: null, gatewayLogId: null, statusCode: null, gatewayCode: null, userIp: null } });
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [isLoading, modelId, provider, toolsEnabled]);

  const handleStop = useCallback(() => { abortRef.current?.abort(); }, []);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (input.trim()) { const text = input; setInput(""); doSend(text); }
    }
  };

  const handleNewChat = useCallback(() => {
    if (isLoading) abortRef.current?.abort();
    setMessages([]);
    setInput("");
    textareaRef.current?.focus();
  }, [isLoading]);

  const hasMessages = messages.length > 0;

  const suggestions = [
    { title: t("chat.suggestions.workers.title"), desc: t("chat.suggestions.workers.prompt") },
    { title: t("chat.suggestions.aiGateway.title"), desc: t("chat.suggestions.aiGateway.prompt") },
    { title: t("chat.suggestions.r2.title"), desc: t("chat.suggestions.r2.prompt") },
  ];

  const safetySuggestions = [
    { title: t("chat.safetySuggestions.bully.title"), desc: t("chat.safetySuggestions.bully.prompt") },
    { title: t("chat.safetySuggestions.hate.title"), desc: t("chat.safetySuggestions.hate.prompt") },
    { title: t("chat.safetySuggestions.violence.title"), desc: t("chat.safetySuggestions.violence.prompt") },
    { title: t("chat.safetySuggestions.pii.title"), desc: t("chat.safetySuggestions.pii.prompt") },
    { title: t("chat.safetySuggestions.injection1.title"), desc: t("chat.safetySuggestions.injection1.prompt") },
    { title: t("chat.safetySuggestions.injection2.title"), desc: t("chat.safetySuggestions.injection2.prompt") },
  ];

  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
  const isStreamingLast = isLoading && lastAssistantMsg != null;

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
              className={`inline-flex items-center gap-1.5 h-8 px-2 rounded-lg transition-colors ${
                toolsEnabled
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
              title={toolsEnabled ? "工具已啟用 (AI Search / MCP)" : "啟用工具 (AI Search / MCP)"}
            >
              <Zap className="size-4" />
            </button>
            <button
              onClick={() => setShowMcpPanel((v) => !v)}
              className={`inline-flex items-center gap-1.5 h-8 px-2 rounded-lg transition-colors ${
                showMcpPanel
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
              title="MCP Connections"
            >
              <Plug className="size-4" />
            </button>
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
                        onClick={() => doSend(s.desc)}
                        className="text-left rounded-2xl border border-border/60 px-4 py-3.5 hover:bg-muted/50 active:bg-muted/70 transition-colors"
                      >
                        <div className="text-sm font-medium">{s.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.desc}</div>
                      </button>
                    ))}
                  </div>
                  <div className="pt-2">
                    <p className="text-xs font-medium text-muted-foreground/70 mb-2">{t("chat.safetyLabel")}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {safetySuggestions.map((s) => (
                        <button
                          key={s.title}
                          onClick={() => doSend(s.desc)}
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
                  const isStreamingThis = isStreamingLast && msg.id === lastAssistantMsg?.id;
                  const textContent = msg.content;
                  const reasoning = msg.reasoning || "";
                  const toolCalls = msg.toolCalls || [];

                  return (
                    <div key={msg.id}>
                      {msg.role === "user" ? (
                        <div className="flex justify-end gap-1 items-start group">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-1.5">
                            <CopyButton text={textContent} />
                          </div>
                          <div className="bg-muted rounded-3xl px-4 py-2.5 md:px-5 md:py-3 max-w-[85%]">
                            <p className="text-sm whitespace-pre-wrap break-words">{textContent}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="group/msg">
                          {toolCalls.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {toolCalls.map((tc) => (
                                <ToolBadge key={tc.id} toolName={tc.name} state={tc.status} />
                              ))}
                            </div>
                          )}
                          {textContent || reasoning ? (
                            <>
                              <MarkdownRenderer
                                content={textContent}
                                reasoning={reasoning}
                                isStreaming={isStreamingThis}
                              />
                              {!isStreamingThis && textContent && (
                                <div className="mt-1 opacity-60 md:opacity-0 md:group-hover/msg:opacity-100 transition-opacity">
                                  <CopyButton text={textContent} />
                                </div>
                              )}
                            </>
                          ) : isLoading ? (
                            <div className="flex items-center gap-1.5 py-1">
                              <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                              <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                              <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                            </div>
                          ) : null}
                        </div>
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
            <div className="relative rounded-3xl border bg-muted/30 focus-within:border-foreground/20 transition-colors">
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
                    onClick={() => { if (input.trim()) { const text = input; setInput(""); doSend(text); } }}
                    disabled={!input.trim()}
                    className="h-8 px-4 rounded-full bg-foreground text-background text-xs font-medium flex items-center justify-center disabled:bg-muted-foreground/30 disabled:text-muted-foreground/50 transition-colors hover:bg-foreground/80"
                  >
                    {t("chat.send")}
                  </button>
                )}
              </div>
            </div>
            <p className="text-center text-[11px] text-muted-foreground/60 mt-2">{t("chat.footer")}</p>
          </div>
        </div>
      </div>

      {/* ── MCP Panel ── */}
      {showMcpPanel && (
        <div className="w-72 shrink-0 hidden md:flex flex-col">
          <McpConnectionsPanel onClose={() => setShowMcpPanel(false)} />
        </div>
      )}

      <ErrorDialog
        open={errorDialog.open}
        onClose={() => setErrorDialog({ open: false, error: null })}
        error={errorDialog.error}
      />
    </div>
  );
}
