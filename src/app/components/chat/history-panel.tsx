'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, X, Search, MoreHorizontal, Pencil, Download, Trash2, RotateCcw, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AI_MODELS } from "@/lib/types";
import type { ConversationSummary } from "@/lib/chat-history";

interface HistoryPanelProps {
  onClose: () => void;
  /** The conversation open in the chat right now (highlighted). */
  activeId: string;
  onOpen: (id: string) => void;
  /** Called after the open conversation is deleted. */
  onDeleted: (id: string) => void;
  /** Bumped by the chat page when a turn finishes, so the list picks up new/updated conversations. */
  refreshKey: number;
}

type LoadState = "loading" | "ready" | "unauthenticated" | "unconfigured" | "error";

const DAY_MS = 24 * 60 * 60 * 1000;

function groupOf(updatedAt: number, now: number): "today" | "yesterday" | "week" | "older" {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return "today";
  if (updatedAt >= startOfToday - DAY_MS) return "yesterday";
  if (updatedAt >= startOfToday - 6 * DAY_MS) return "week";
  return "older";
}

function modelName(model: string | null): string {
  if (!model) return "";
  const m = AI_MODELS.find((x) => x.id === model || x.providerModelId === model || x.workersAiModel === model);
  return m?.name ?? model.split("/").pop() ?? model;
}

export function HistoryPanel({ onClose, activeId, onOpen, onDeleted, refreshKey }: HistoryPanelProps) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const requestSeq = useRef(0);

  const load = useCallback(async (q: string) => {
    const seq = ++requestSeq.current;
    try {
      const res = await fetch(`/api/chat/history?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" });
      if (seq !== requestSeq.current) return;
      if (res.status === 401) return setState("unauthenticated");
      if (res.status === 503) return setState("unconfigured");
      if (!res.ok) return setState("error");
      const data = (await res.json()) as { conversations: ConversationSummary[] };
      setItems(data.conversations);
      setState("ready");
    } catch {
      if (seq === requestSeq.current) setState("error");
    }
  }, []);

  // Debounced search; refreshKey reloads immediately-ish after each finished turn.
  useEffect(() => {
    const timer = setTimeout(() => load(query.trim()), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, refreshKey, load]);

  const rename = async (id: string) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    setItems((cur) => cur.map((c) => (c.id === id ? { ...c, title } : c)));
    await fetch(`/api/chat/history/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => {});
  };

  const remove = async (c: ConversationSummary) => {
    if (!window.confirm(t("chat.history.deleteConfirm", { title: c.title }))) return;
    const res = await fetch(`/api/chat/history/${c.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) return;
    setItems((cur) => cur.filter((x) => x.id !== c.id));
    if (c.id === activeId) onDeleted(c.id);
  };

  const now = Date.now();
  const groups = (["today", "yesterday", "week", "older"] as const)
    .map((g) => ({ g, list: items.filter((c) => groupOf(c.updatedAt, now) === g) }))
    .filter((x) => x.list.length > 0);
  const timeFmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en" : "zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col h-full border-l bg-background">
      <div className="px-4 py-3 border-b shrink-0 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t("chat.history.title")}</span>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 transition-colors" aria-label={t("chat.history.close")}>
            <X className="size-4" />
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chat.history.search")}
            className="w-full h-8 rounded-md border bg-muted/30 pl-8 pr-2 text-xs focus:outline-none focus:border-foreground/20"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {state === "loading" && (
          <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        )}
        {state === "unauthenticated" && <p className="px-3 py-6 text-xs text-muted-foreground text-center">{t("chat.history.signInToSave")}</p>}
        {state === "unconfigured" && <p className="px-3 py-6 text-xs text-muted-foreground text-center">{t("chat.history.unconfigured")}</p>}
        {state === "error" && (
          <div className="px-3 py-6 text-center space-y-2">
            <p className="text-xs text-destructive">{t("chat.history.loadError")}</p>
            <button onClick={() => { setState("loading"); load(query.trim()); }} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border hover:bg-muted/60">
              <RotateCcw className="size-3" /> {t("chat.history.retry")}
            </button>
          </div>
        )}
        {state === "ready" && items.length === 0 && (
          <p className="px-3 py-6 text-xs text-muted-foreground text-center">{query ? t("chat.history.noMatch") : t("chat.history.empty")}</p>
        )}
        {state === "ready" &&
          groups.map(({ g, list }) => (
            <div key={g} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground/70">{t(`chat.history.group.${g}`)}</div>
              {list.map((c) => {
                const active = c.id === activeId;
                return (
                  <div
                    key={c.id}
                    className={`group flex items-start gap-1 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${active ? "bg-muted" : "hover:bg-muted/50"}`}
                    onClick={() => renamingId !== c.id && onOpen(c.id)}
                  >
                    <div className="flex-1 min-w-0">
                      {renamingId === c.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => rename(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) rename(c.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="w-full h-6 rounded border bg-background px-1.5 text-sm focus:outline-none"
                        />
                      ) : (
                        <div className="text-sm truncate">{c.title}</div>
                      )}
                      <div className="text-[11px] text-muted-foreground/70 truncate">
                        {timeFmt.format(c.updatedAt)} · {modelName(c.model)} · {t("chat.history.turns", { count: c.turnCount })}
                        {c.lastStatus && c.lastStatus !== "completed" && <span className="ml-1 text-amber-600 dark:text-amber-400">· {t(`chat.history.status.${c.lastStatus}`)}</span>}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-background transition-opacity"
                          aria-label={t("chat.history.actions")}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onClick={() => { setRenamingId(c.id); setRenameValue(c.title); }}>
                          <Pencil className="size-3.5" /> {t("chat.history.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <a href={`/api/chat/history/${c.id}?raw=1`} download={`chat-${c.id}.json`}>
                            <Download className="size-3.5" /> {t("chat.history.export")}
                          </a>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => remove(c)} className="text-red-600">
                          <Trash2 className="size-3.5" /> {t("chat.history.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
            </div>
          ))}
      </div>
    </div>
  );
}
