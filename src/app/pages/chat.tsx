import { useRef, useEffect, useState, useCallback } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/ai-react";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import { ModelSelector } from "../components/chat/model-selector";
import { ErrorDialog, type ChatErrorState } from "../components/chat/error-dialog";
import { McpConnectionsPanel } from "../components/chat/mcp-panel";
import { AI_MODELS, DEFAULT_MODEL_ID } from "@/lib/types";
import { Square, SquarePen, Copy, Check, Plug, Search as SearchIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UIMessage, ReasoningUIPart, TextUIPart, UIMessagePart } from "ai";
import type { ChatAgent } from "@/worker/agent";

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

function extractReasoning(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is ReasoningUIPart => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

function extractText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is TextUIPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  state: string;
}

function extractToolCalls(msg: UIMessage): ToolCallInfo[] {
  return msg.parts
    .filter((p: UIMessagePart<any, any>) =>
      p.type.startsWith("tool-") || p.type === "dynamic-tool"
    )
    .map((p: any) => ({
      toolCallId: p.toolCallId as string,
      toolName: p.type === "dynamic-tool" ? (p.toolName as string) : (p.type as string).slice(5),
      state: (p.state as string) ?? "input",
    }));
}

const TOOL_LABELS: Record<string, string> = {
  searchKnowledge: "搜尋知識庫",
};

function ToolBadge({ toolName, state }: { toolName: string; state: string }) {
  const label = TOOL_LABELS[toolName] ?? toolName;
  const isDone = state === "output" || state === "output-error";
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
  const [errorDialog, setErrorDialog] = useState<{ open: boolean; error: ChatErrorState | null }>({
    open: false,
    error: null,
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [input, setInput] = useState("");

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  const agent = useAgent<ChatAgent>({ agent: "chat-agent", name: "default" });

  const currentModelRef = useRef(selectedModel);
  currentModelRef.current = selectedModel;

  const { messages, sendMessage: agentSendMessage, status, stop, clearHistory } = useAgentChat({
    agent,
    body: () => {
      const model = AI_MODELS.find((m) => m.id === currentModelRef.current);
      const modelId =
        model?.workersAiModel ?? model?.providerModelId ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      return { model: modelId, provider: model?.provider ?? "workers-ai" };
    },
    onError: (err) => {
      console.error("[Chat] Agent error:", err);
      setErrorDialog({
        open: true,
        error: {
          errorType: "general",
          message: err.message || "發生未知錯誤",
          rayId: null,
          gatewayLogId: null,
          statusCode: null,
          gatewayCode: null,
          userIp: null,
        },
      });
    },
  });

  const isLoading = status === "streaming" || status === "submitted";

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

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || isLoading) return;
      isNearBottomRef.current = true;
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      agentSendMessage({ text });
    },
    [isLoading, agentSendMessage]
  );

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (input.trim()) {
        const text = input;
        setInput("");
        sendMessage(text);
      }
    }
  };

  const handleNewChat = useCallback(() => {
    if (isLoading) stop();
    clearHistory();
    setInput("");
    textareaRef.current?.focus();
  }, [isLoading, stop, clearHistory]);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const hasMessages = visibleMessages.length > 0;

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

  const lastAssistantMsg = [...visibleMessages].reverse().find((m) => m.role === "assistant");
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
                        onClick={() => sendMessage(s.desc)}
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
                          onClick={() => sendMessage(s.desc)}
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
                {visibleMessages.map((msg) => {
                  const isStreamingThis = isStreamingLast && msg.id === lastAssistantMsg?.id;
                  const reasoning = extractReasoning(msg);
                  const textContent = extractText(msg);

                  return (
                    <div key={msg.id}>
                      {msg.role === "user" ? (
                        <div className="flex justify-end gap-1 items-start group">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-1.5">
                            <CopyButton text={textContent} />
                          </div>
                          <div className="bg-muted rounded-3xl px-4 py-2.5 md:px-5 md:py-3 max-w-[85%]">
                            <p className="text-sm whitespace-pre-wrap break-words">
                              {extractText(msg)}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="group/msg">
                          {(() => {
                            const toolCalls = extractToolCalls(msg);
                            return toolCalls.length > 0 ? (
                              <div className="flex flex-wrap gap-1.5 mb-2">
                                {toolCalls.map((tc) => (
                                  <ToolBadge key={tc.toolCallId} toolName={tc.toolName} state={tc.state} />
                                ))}
                              </div>
                            ) : null;
                          })()}
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
                    onClick={stop}
                    className="size-8 rounded-full bg-foreground text-background flex items-center justify-center hover:bg-foreground/80 transition-colors"
                  >
                    <Square className="size-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { if (input.trim()) { const t = input; setInput(""); sendMessage(t); } }}
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
