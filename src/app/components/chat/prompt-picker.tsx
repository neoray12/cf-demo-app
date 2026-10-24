'use client';

import { useEffect, useRef } from "react";
import { Loader2, Slash, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import type { McpPromptPicker } from "./use-mcp-prompt-picker";

/** Popover shown above the chat input while the slash-command picker is open. */
export function PromptPicker({ picker }: { picker: McpPromptPicker }) {
  const { t } = useTranslation();
  const { open, items, active, form, notice } = picker;
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  // A short note after filling stays visible even once the picker has closed.
  if (!open) {
    return notice ? (
      <div className="absolute bottom-full left-0 right-0 mb-2 px-4 md:px-5 text-xs text-muted-foreground">
        {notice}
      </div>
    ) : null;
  }

  const shell = "absolute bottom-full left-0 right-0 mb-2 z-20 rounded-2xl border bg-popover text-popover-foreground shadow-lg";

  if (form) {
    const { prompt, values } = form;
    const missing = (prompt.arguments ?? []).some((a) => a.required && !values[a.name]?.trim());
    return (
      <form
        className={`${shell} p-4 space-y-3`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing && !picker.busy) picker.submitForm();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{prompt.title || prompt.name}</div>
            {prompt.description && <div className="text-xs text-muted-foreground mt-0.5">{prompt.description}</div>}
          </div>
          <button type="button" onClick={picker.cancel} className="text-muted-foreground hover:text-foreground cursor-pointer" title={t("chat.prompts.cancel")}>
            <X className="size-4" />
          </button>
        </div>
        {(prompt.arguments ?? []).map((arg, i) => (
          <label key={arg.name} className="block space-y-1">
            <span className="text-xs font-medium">
              {arg.name}
              {arg.required && <span className="text-destructive ml-0.5">*</span>}
            </span>
            {arg.description && <span className="block text-xs text-muted-foreground">{arg.description}</span>}
            <Input
              autoFocus={i === 0}
              value={values[arg.name] ?? ""}
              onChange={(e) => picker.setFormValue(arg.name, e.target.value)}
              disabled={picker.busy}
            />
          </label>
        ))}
        {picker.actionError && <div className="text-xs text-destructive break-words">{picker.actionError}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={picker.cancel} className="h-8 px-3 rounded-full text-xs text-muted-foreground hover:bg-muted cursor-pointer">
            {t("chat.prompts.cancel")}
          </button>
          <button
            type="submit"
            disabled={missing || picker.busy}
            className="h-8 px-4 rounded-full bg-foreground text-background text-xs font-medium flex items-center gap-1.5 disabled:bg-muted-foreground/30 disabled:text-muted-foreground/50 hover:bg-foreground/80 transition-colors cursor-pointer"
          >
            {picker.busy && <Loader2 className="size-3 animate-spin" />}
            {t("chat.prompts.fill")}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={`${shell} max-h-72 overflow-y-auto p-1.5`} role="listbox" aria-label={t("chat.prompts.title")}>
      {!picker.hasServers ? (
        <Message>{t("chat.prompts.noServers")}</Message>
      ) : picker.loading && items.length === 0 ? (
        <Message><Loader2 className="size-3.5 animate-spin" /> {t("chat.prompts.loading")}</Message>
      ) : picker.loadError ? (
        <Message>{picker.loadError}</Message>
      ) : items.length === 0 ? (
        <Message>{t("chat.prompts.empty")}</Message>
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">
            <Slash className="size-3" /> {t("chat.prompts.title")}
          </div>
          {items.map((p, i) => (
            <button
              key={`${p.serverId}:${p.name}`}
              ref={i === active ? activeRef : undefined}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => picker.setActive(i)}
              onClick={() => picker.select(p)}
              className={`w-full text-left rounded-xl px-2.5 py-2 transition-colors cursor-pointer ${i === active ? "bg-muted" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{p.title || p.name}</span>
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted-foreground/10 text-muted-foreground">{p.serverName}</span>
                {p.arguments?.length ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t("chat.prompts.argCount", { count: p.arguments.length })}
                  </span>
                ) : null}
              </div>
              {p.description && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{p.description}</div>}
              <div className="text-[11px] font-mono text-muted-foreground/60 mt-0.5 truncate">{p.name}</div>
            </button>
          ))}
        </>
      )}
      {picker.actionError && <div className="px-2.5 py-1.5 text-xs text-destructive break-words">{picker.actionError}</div>}
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">{children}</div>;
}
