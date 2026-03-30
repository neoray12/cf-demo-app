import { useRef, useEffect, useState, useCallback } from "react";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import { ModelSelector } from "../components/chat/model-selector";
import { ErrorDialog, type ChatErrorState } from "../components/chat/error-dialog";
import { AI_MODELS, DEFAULT_MODEL_ID } from "@/lib/types";
import { Square, SquarePen, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

let msgCounter = 0;
function genId() {
  return `msg-${Date.now()}-${++msgCounter}`;
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

export function ChatPage() {
  const { t } = useTranslation();
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorDialog, setErrorDialog] = useState<{ open: boolean; error: ChatErrorState | null }>({ open: false, error: null });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  const streamingMsgIdRef = useRef<string | null>(null);
  const isNearBottomRef = useRef(true);
  messagesRef.current = messages;

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

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: ChatMessage = { id: genId(), role: "user", content: text.trim() };
    const assistantMsgId = genId();
    const assistantMsg: ChatMessage = { id: assistantMsgId, role: "assistant", content: "", reasoning: "" };

    // Snapshot BEFORE setState to prevent messagesRef.current from being
    // updated with userMsg before apiMessages is built (avoids duplicate user messages).
    const apiMessages = [...messagesRef.current, userMsg]
      .filter((m) => !(m.role === "assistant" && (!m.content || m.content.startsWith("❌"))))
      .map((m) => ({ role: m.role, content: m.content }));

    streamingMsgIdRef.current = assistantMsgId;
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setIsLoading(true);
    isNearBottomRef.current = true;
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    const controller = new AbortController();
    abortRef.current = controller;
    const fetchTimeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const model = AI_MODELS.find((m) => m.id === selectedModel);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          provider: model?.provider || "workers-ai",
          model: model?.workersAiModel ?? model?.providerModelId ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        }),
        signal: controller.signal,
      });

      clearTimeout(fetchTimeout);

      if (!res.ok) {
        const errText = await res.text();
        setMessages((prev) =>
          prev.map((m) => m.id === assistantMsgId ? { ...m, content: `❌ Error ${res.status}: ${errText}` } : m)
        );
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let accContent = "";
      let accReasoning = "";
      let gotContent = false;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          switch (event.type) {
            case "text-delta":
              gotContent = true;
              accContent += event.text as string;
              setMessages((prev) =>
                prev.map((m) => m.id === assistantMsgId ? { ...m, content: accContent } : m)
              );
              break;
            case "reasoning-delta":
              gotContent = true;
              accReasoning += event.text as string;
              setMessages((prev) =>
                prev.map((m) => m.id === assistantMsgId ? { ...m, reasoning: accReasoning } : m)
              );
              break;
            case "error": {
              console.error("[Chat] Stream error:", event);
              const errState: ChatErrorState = {
                errorType: (event.errorType as ChatErrorState["errorType"]) || "general",
                message: (event.message as string) || "Unknown error",
                rayId: (event.rayId as string | null) ?? null,
                gatewayLogId: (event.gatewayLogId as string | null) ?? null,
                statusCode: (event.statusCode as number | null) ?? null,
                gatewayCode: (event.gatewayCode as string | null) ?? null,
              };
              setMessages((prev) =>
                prev.map((m) => m.id === assistantMsgId ? { ...m, content: accContent } : m)
              );
              setErrorDialog({ open: true, error: errState });
              break;
            }
          }
        } catch {
          // skip malformed lines
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          processLine(line);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);

      setMessages((prev) =>
        prev.map((m) => m.id === assistantMsgId ? { ...m, content: accContent, reasoning: accReasoning } : m)
      );

      if (!gotContent) {
        setMessages((prev) =>
          prev.map((m) => m.id === assistantMsgId && !m.content
            ? { ...m, content: "❌ 無法取得回應，請再試一次。" }
            : m)
        );
      }
    } catch (err) {
      clearTimeout(fetchTimeout);
      if ((err as Error).name === "AbortError") {
        setMessages((prev) => {
          const msg = prev.find((m) => m.id === assistantMsgId);
          if (msg && !msg.content) return prev.filter((m) => m.id !== assistantMsgId);
          return prev;
        });
      } else {
        console.error("[Chat] Fetch error:", err);
        setMessages((prev) =>
          prev.map((m) => m.id === assistantMsgId
            ? { ...m, content: m.content || `❌ ${(err as Error).message || "發生錯誤"}` }
            : m)
        );
      }
    } finally {
      setIsLoading(false);
      streamingMsgIdRef.current = null;
      abortRef.current = null;
    }
  }, [isLoading, selectedModel]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleNewChat = useCallback(() => {
    if (isLoading) abortRef.current?.abort();
    setMessages([]);
    setIsLoading(false);
    streamingMsgIdRef.current = null;
    abortRef.current = null;
    textareaRef.current?.focus();
  }, [isLoading]);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (input.trim()) sendMessage(input);
    }
  };

  const hasMessages = messages.length > 0;

  const suggestions = [
    {
      title: t("chat.suggestions.workers.title"),
      desc: t("chat.suggestions.workers.prompt"),
    },
    {
      title: t("chat.suggestions.aiGateway.title"),
      desc: t("chat.suggestions.aiGateway.prompt"),
    },
    {
      title: t("chat.suggestions.r2.title"),
      desc: t("chat.suggestions.r2.prompt"),
    },
  ];

  const safetySuggestions = [
    { title: t("chat.safetySuggestions.bully.title"), desc: t("chat.safetySuggestions.bully.prompt") },
    { title: t("chat.safetySuggestions.hate.title"), desc: t("chat.safetySuggestions.hate.prompt") },
    { title: t("chat.safetySuggestions.violence.title"), desc: t("chat.safetySuggestions.violence.prompt") },
    { title: t("chat.safetySuggestions.pii.title"), desc: t("chat.safetySuggestions.pii.prompt") },
    { title: t("chat.safetySuggestions.injection1.title"), desc: t("chat.safetySuggestions.injection1.prompt") },
    { title: t("chat.safetySuggestions.injection2.title"), desc: t("chat.safetySuggestions.injection2.prompt") },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* ── Header: model selector + new chat ── */}
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
              {messages.map((msg) => {
                const isStreamingThis = streamingMsgIdRef.current === msg.id && isLoading;
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
                      <div className="group/msg">
                        {(msg.content || msg.reasoning) ? (
                          <>
                            <MarkdownRenderer content={msg.content} reasoning={msg.reasoning} isStreaming={isStreamingThis} />
                            {!isStreamingThis && msg.content && (
                              <div className="mt-1 opacity-60 md:opacity-0 md:group-hover/msg:opacity-100 transition-opacity">
                                <CopyButton text={msg.content} />
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
                  onClick={handleStop}
                  className="size-8 rounded-full bg-foreground text-background flex items-center justify-center hover:bg-foreground/80 transition-colors"
                >
                  <Square className="size-3" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { if (input.trim()) sendMessage(input); }}
                  disabled={!input.trim()}
                  className="h-8 px-4 rounded-full bg-foreground text-background text-xs font-medium flex items-center justify-center disabled:bg-muted-foreground/30 disabled:text-muted-foreground/50 transition-colors hover:bg-foreground/80"
                >
                  {t("chat.send")}
                </button>
              )}
            </div>
          </div>
          <p className="text-center text-[11px] text-muted-foreground/60 mt-2">
            {t("chat.footer")}
          </p>
        </div>
      </div>

      <ErrorDialog
        open={errorDialog.open}
        onClose={() => setErrorDialog({ open: false, error: null })}
        error={errorDialog.error}
      />
    </div>
  );
}
