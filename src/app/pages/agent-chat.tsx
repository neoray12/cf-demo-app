'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Activity, ArrowUp, ExternalLink, Square, SquarePen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { AGENTS_DASHBOARD_URL, type AgentCatalogEntry } from "@/lib/agents/catalog";
import { AGENT_MODELS, type ModelKey } from "@/lib/agents/models";
import { AgentMessage } from "@/app/components/agents/agent-message";
import { KbWorkspace } from "@/app/components/agents/kb-workspace";
import { TracePanel } from "@/app/components/agents/trace-panel";
import { useAgentRun } from "@/app/components/agents/use-agent-run";

const MODEL_KEYS = Object.keys(AGENT_MODELS) as ModelKey[];
/** Within this many px of the bottom, new content keeps the chat pinned to the bottom. */
const STICKY_PX = 120;
/** The trace panel sits beside the chat from lg up; below that (incl. < md phones) it lives in a Sheet. */
const SIDE_PANEL_QUERY = "(min-width: 1024px)";

function useSidePanel(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia(SIDE_PANEL_QUERY);
    const onChange = () => setWide(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export function AgentChatPage({ agent }: { agent: AgentCatalogEntry }) {
  const { t } = useTranslation();
  const sidePanel = useSidePanel();
  const { turns, send, retry, stop, running, reset } = useAgentRun(agent.id);
  const [model, setModel] = useState<ModelKey>(agent.defaultModel);
  const [input, setInput] = useState("");
  // Knowledge-base workspace controls: defaults = sample workspace, content recorded in the trace.
  const [workspace, setWorkspace] = useState("default");
  const [storeContent, setStoreContent] = useState(true);
  const [traceOpen, setTraceOpen] = useState(false);
  const [selectedTurn, setSelectedTurn] = useState(0);

  const scrollRootRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Follow the newest turn in the trace panel.
  useEffect(() => {
    setSelectedTurn(Math.max(0, turns.length - 1));
  }, [turns.length]);

  // Keep the chat pinned to the bottom while streaming, unless the user scrolled up.
  const viewport = () =>
    scrollRootRef.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]") ?? null;
  useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const onScroll = () => {
      stickRef.current = vp.scrollHeight - vp.scrollTop - vp.clientHeight < STICKY_PX;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const vp = viewport();
    if (vp && stickRef.current) vp.scrollTop = vp.scrollHeight;
  }, [turns]);

  const submit = (text: string) => {
    if (!text.trim() || running) return;
    stickRef.current = true;
    // The sample workspace is the server's default, so only a user workspace is sent explicitly.
    send(text, {
      model,
      workspace: agent.features.workspace && workspace !== "default" ? workspace : undefined,
      storeContent,
    });
    setInput("");
  };

  // 重試: same question, same model / workspace / storeContent as the failed turn (a new turn at the bottom).
  const retryTurn = useCallback(
    (turnId: string) => {
      if (running) return;
      stickRef.current = true;
      retry(turnId);
    },
    [retry, running],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a newline; never send while an IME is composing (Chinese input).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit(input);
    }
  };

  const tracePanel = (
    <TracePanel turns={turns} selected={selectedTurn} onSelect={setSelectedTurn} className="w-full" />
  );
  const AgentIcon = agent.icon;

  return (
    <div className="flex h-[calc(100svh-3.5rem)] overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 md:px-4">
          <div className="flex min-w-[12rem] flex-1 items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <AgentIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold md:text-base">{t(agent.titleKey)}</h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">{t(agent.descKey)}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Select value={model} onValueChange={(v) => setModel(v as ModelKey)} disabled={running}>
              <SelectTrigger size="sm" className="h-8 max-w-[11rem] text-xs md:max-w-none" aria-label={t("agents.chat.model")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {MODEL_KEYS.map((k) => {
                  const m = AGENT_MODELS[k];
                  return (
                    <SelectItem key={k} value={k} className="text-xs">
                      <span>{t(m.labelKey)}</span>
                      <span className="text-[10px] text-muted-foreground">{t("agents.chat.ttftHint", { hint: m.ttftHint })}</span>
                      {m.slow && (
                        <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal text-amber-600 dark:text-amber-400">
                          {t("agents.chat.slow")}
                        </Badge>
                      )}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {turns.length > 0 && (
              <Button variant="ghost" size="sm" className="h-8 px-2" onClick={reset} title={t("agents.chat.newChat")} aria-label={t("agents.chat.newChat")}>
                <SquarePen className="size-4" />
                <span className="hidden lg:inline">{t("agents.chat.newChat")}</span>
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-8 px-2" asChild>
              <a
                href={AGENTS_DASHBOARD_URL}
                target="_blank"
                rel="noopener noreferrer"
                title={t("agents.chat.viewTrace")}
                aria-label={t("agents.chat.viewTrace")}
              >
                <ExternalLink className="size-3.5" />
                <span className="hidden xl:inline">{t("agents.chat.viewTrace")}</span>
              </a>
            </Button>
            {!sidePanel && (
              <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => setTraceOpen(true)}>
                <Activity className="size-3.5" />
                {t("agents.chat.traceButton")}
              </Button>
            )}
          </div>
        </div>

        {agent.features.workspace && (
          <KbWorkspace
            value={workspace}
            onChange={setWorkspace}
            storeContent={storeContent}
            onStoreContentChange={setStoreContent}
          />
        )}

        {/* Messages */}
        <ScrollArea
          ref={scrollRootRef}
          className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block"
        >
          <div className="mx-auto max-w-3xl px-3 md:px-4">
            {turns.length === 0 ? (
              <div className="flex flex-col gap-4 py-8">
                <div>
                  <h2 className="text-xl font-bold tracking-tight md:text-2xl">{t(agent.titleKey)}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t(agent.descKey)}</p>
                </div>
                <div className="text-xs font-medium text-muted-foreground">{t("agents.chat.suggestionsTitle")}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {agent.suggestionKeys.map((k) => (
                    <Card
                      key={k}
                      role="button"
                      tabIndex={0}
                      onClick={() => submit(t(k))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          submit(t(k));
                        }
                      }}
                      className="cursor-pointer px-4 py-3 text-sm shadow-none transition-colors hover:bg-muted/60"
                    >
                      {t(k)}
                    </Card>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-6 py-6">
                {turns.map((turn) => (
                  <div key={turn.id} className="flex flex-col gap-3">
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 md:px-5 md:py-3">
                        <p className="whitespace-pre-wrap break-words text-sm">{turn.user}</p>
                      </div>
                    </div>
                    <AgentMessage turn={turn} onRetry={retryTurn} retryDisabled={running} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="shrink-0 px-3 pb-4 pt-2 md:px-4">
          <div className="mx-auto max-w-3xl">
            <div className="relative rounded-3xl border bg-muted/30 transition-colors focus-within:border-foreground/20">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t("agents.chat.placeholder")}
                rows={1}
                className="max-h-[200px] min-h-[52px] resize-none border-0 bg-transparent px-4 pb-12 pt-3.5 shadow-none focus-visible:ring-0 md:px-5 dark:bg-transparent"
              />
              <div className="absolute bottom-2.5 right-3">
                {running ? (
                  <Button size="sm" className="h-8 rounded-full px-3" onClick={stop}>
                    <Square className="size-3" />
                    {t("agents.chat.stop")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-8 rounded-full px-3"
                    onClick={() => submit(input)}
                    disabled={!input.trim()}
                  >
                    <ArrowUp className="size-3.5" />
                    {t("agents.chat.send")}
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground/60">{t("agents.chat.footer")}</p>
          </div>
        </div>
      </div>

      {/* Trace: side panel (lg+) / Sheet (narrower, incl. phones) */}
      {sidePanel && <div className="flex w-[400px] shrink-0 border-l xl:w-[460px]">{tracePanel}</div>}
      {!sidePanel && (
        <Sheet open={traceOpen} onOpenChange={setTraceOpen}>
          <SheetContent side="right" className="w-[92%] p-0 sm:max-w-md">
            <VisuallyHidden>
              <SheetTitle>{t("agents.trace.title")}</SheetTitle>
              <SheetDescription>{t("agents.trace.empty")}</SheetDescription>
            </VisuallyHidden>
            {tracePanel}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
