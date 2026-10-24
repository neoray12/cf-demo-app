'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { McpPromptInfo } from "@/lib/mcp-client";

export interface PromptForm {
  prompt: McpPromptInfo;
  values: Record<string, string>;
}

interface Options {
  input: string;
  setInput: (value: string) => void;
  connectedServers: string[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Slash-command picker for MCP prompts.
 *
 * Typing `/` (and nothing but a command word) at the start of the chat input
 * lists the prompts of the connected servers. Choosing one expands it through
 * the server and *fills the input box* — it never sends on its own, so the user
 * reviews (and can edit) the text before it reaches the model.
 */
export function useMcpPromptPicker({ input, setInput, connectedServers, textareaRef }: Options) {
  const { t } = useTranslation();

  const [prompts, setPrompts] = useState<McpPromptInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [form, setForm] = useState<PromptForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fetchedKeyRef = useRef<string | null>(null);

  const serversKey = connectedServers.join(",");
  const slash = /^\/(\S*)$/.exec(input);
  const query = slash ? slash[1]!.toLowerCase() : null;
  const open = form !== null || (query !== null && dismissedFor !== input);

  // Fetch lazily the first time the picker opens, and again when the set of
  // connected servers changes. The API caches per session for 5 minutes.
  useEffect(() => {
    if (!open || !serversKey || fetchedKeyRef.current === serversKey) return;
    fetchedKeyRef.current = serversKey;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/mcp/prompts?servers=${encodeURIComponent(serversKey)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { prompts: McpPromptInfo[] };
      })
      .then((data) => setPrompts(data.prompts))
      .catch(() => {
        fetchedKeyRef.current = null; // allow a retry the next time it opens
        setLoadError(t("chat.prompts.loadError"));
      })
      .finally(() => setLoading(false));
  }, [open, serversKey, t]);

  const items = useMemo(() => {
    if (query === null) return [];
    const wanted = new Set(connectedServers);
    return prompts.filter((p) => {
      if (!wanted.has(p.serverId)) return false;
      if (!query) return true;
      return [p.name, p.title, p.description, p.serverName].some((f) => f?.toLowerCase().includes(query));
    });
  }, [prompts, query, connectedServers]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  const fillInput = useCallback((text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
      el.focus();
      el.setSelectionRange(0, 0);
      el.scrollTop = 0;
    });
  }, [setInput, textareaRef]);

  const expand = useCallback(async (prompt: McpPromptInfo, values: Record<string, string>) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: prompt.serverId, name: prompt.name, args: values }),
      });
      const data = (await res.json()) as { text?: string; skipped?: number; error?: string };
      if (!res.ok || typeof data.text !== "string") {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setForm(null);
      setDismissedFor(null);
      fillInput(data.text);
      const parts = [t("chat.prompts.filled", { count: data.text.length.toLocaleString() })];
      if (data.skipped) parts.push(t("chat.prompts.skipped", { count: data.skipped }));
      setNotice(parts.join(" "));
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [fillInput, t]);

  const select = useCallback((prompt: McpPromptInfo) => {
    setActionError(null);
    if (prompt.arguments?.length) {
      setForm({ prompt, values: {} });
    } else {
      void expand(prompt, {});
    }
  }, [expand]);

  const setFormValue = useCallback((name: string, value: string) => {
    setForm((f) => (f ? { ...f, values: { ...f.values, [name]: value } } : f));
  }, []);

  const submitForm = useCallback(() => {
    if (form) void expand(form.prompt, form.values);
  }, [form, expand]);

  const cancel = useCallback(() => {
    setForm(null);
    setActionError(null);
    setDismissedFor(input);
    textareaRef.current?.focus();
  }, [input, textareaRef]);

  /** Returns true when the key was consumed and the caller must not send. */
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return true;
    }
    if (form || items.length === 0) return false; // let Enter send a literal "/something"
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length));
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const chosen = items[Math.min(active, items.length - 1)];
      if (chosen) select(chosen);
      return true;
    }
    return false;
  }, [open, form, items, active, cancel, select]);

  return {
    open,
    items,
    active,
    setActive,
    loading,
    loadError,
    hasServers: connectedServers.length > 0,
    form,
    busy,
    actionError,
    notice,
    select,
    setFormValue,
    submitForm,
    cancel,
    handleKeyDown,
  };
}

export type McpPromptPicker = ReturnType<typeof useMcpPromptPicker>;
