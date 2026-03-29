import { useState, useRef, useEffect, useCallback } from "react";
import { useAgent } from "agents/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownRenderer } from "../components/chat/markdown-renderer";
import { ModelSelector } from "../components/chat/model-selector";
import { AI_MODELS, DEFAULT_MODEL_ID } from "@/lib/types";
import {
  Send,
  Square,
  Bot,
  User,
  Loader2,
  Sparkles,
  Copy,
  Check,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
}

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      createdAt: new Date(),
    };

    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: new Date(),
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsLoading(true);

    const model = AI_MODELS.find((m) => m.id === selectedModel);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch("/agents/chat-agent/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: trimmed },
          ],
          model: model?.workersAiModel || "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          accumulated += chunk;

          // Parse streaming data
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("0:")) {
              // Text delta
              try {
                const text = JSON.parse(line.slice(2));
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.role === "assistant") {
                    last.content += text;
                  }
                  return updated;
                });
              } catch {
                // skip parse errors
              }
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === "assistant" && !last.content) {
          last.content = `Error: ${(err as Error).message}`;
        }
        return updated;
      });
      toast.error("發送失敗，請重試");
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCopy = (content: string, id: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleClear = () => {
    setMessages([]);
  };

  const suggestions = [
    {
      title: "Cloudflare Workers",
      prompt: "介紹一下 Cloudflare Workers 的主要功能和優勢",
    },
    {
      title: "AI Gateway",
      prompt: "Cloudflare AI Gateway 是什麼？有什麼用途？",
    },
    {
      title: "R2 儲存",
      prompt: "Cloudflare R2 和 AWS S3 有什麼差異？",
    },
  ];

  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                <Sparkles className="h-8 w-8 text-primary" />
              </div>
              <h2 className="mb-2 text-xl font-semibold">AI Agent</h2>
              <p className="mb-8 text-center text-sm text-muted-foreground max-w-md">
                由 Cloudflare Workers AI 驅動，支援知識庫搜尋（RAG）
              </p>
              <div className="grid w-full gap-3 sm:grid-cols-3">
                {suggestions.map((s) => (
                  <button
                    key={s.title}
                    className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent"
                    onClick={() => {
                      setInput(s.prompt);
                      textareaRef.current?.focus();
                    }}
                  >
                    <div className="mb-1 text-sm font-medium">{s.title}</div>
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      {s.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((msg) => (
                <div key={msg.id} className="group">
                  <div
                    className={`flex gap-3 ${
                      msg.role === "user" ? "justify-end" : ""
                    }`}
                  >
                    {msg.role === "assistant" && (
                      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Bot className="h-4 w-4 text-primary" />
                      </div>
                    )}
                    <div
                      className={`max-w-[85%] ${
                        msg.role === "user"
                          ? "rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground"
                          : "flex-1"
                      }`}
                    >
                      {msg.role === "user" ? (
                        <p className="whitespace-pre-wrap text-sm">
                          {msg.content}
                        </p>
                      ) : msg.content ? (
                        <MarkdownRenderer content={msg.content} />
                      ) : isLoading ? (
                        <div className="flex items-center gap-1 py-2">
                          <div className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.3s]" />
                          <div className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.15s]" />
                          <div className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50" />
                        </div>
                      ) : null}
                    </div>
                    {msg.role === "user" && (
                      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <User className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                  {/* Message actions */}
                  {msg.role === "assistant" && msg.content && (
                    <div className="ml-10 mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleCopy(msg.content, msg.id)}
                      >
                        {copiedId === msg.id ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="border-t bg-background p-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2 mb-2">
            <ModelSelector
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
            />
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={handleClear}
              >
                <Trash2 className="size-3.5 mr-1" />
                清除對話
              </Button>
            )}
          </div>
          <div className="relative flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="輸入訊息... (Shift+Enter 換行)"
              className="min-h-[44px] max-h-[200px] resize-none pr-12"
              rows={1}
              disabled={isLoading}
            />
            <div className="absolute bottom-2 right-2">
              {isLoading ? (
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleStop}>
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleSend}
                  disabled={!input.trim()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            由 Cloudflare Workers AI 驅動 | 透過 AI Gateway 路由
          </p>
        </div>
      </div>
    </div>
  );
}
