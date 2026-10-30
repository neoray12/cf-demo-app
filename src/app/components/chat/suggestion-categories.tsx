"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Braces,
  Camera,
  Cloud,
  Globe,
  Hand,
  KeyRound,
  MailCheck,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Zap,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { GUARDRAIL_SCENARIOS } from "@/lib/mcp-guardrails";
import { CODE_MODE_EXAMPLES } from "@/lib/experiment-compare";
import { HITL_EXAMPLES, randomDealName } from "@/lib/approvals";

export interface SuggestionSendOpts {
  /** MCP server that must be connected; the turn is sent with only this server. */
  mcp?: string;
  /** Code Mode comparison example: send twice (without, then with Code Mode) under this experiment id. */
  experiment?: string;
  /** A click fills the input so the prompt can be changed first; sending it passes `false` (these options still apply). */
  edit?: boolean;
}

interface SuggestionItem {
  title: string;
  desc: string;
  icon?: LucideIcon;
  /** Navigate instead of sending a prompt. */
  href?: string;
  /** Overrides the category's send options for this example. */
  opts?: SuggestionSendOpts;
  /** Called after the card was used (e.g. to pick a new random name for next time). */
  afterPick?: () => void;
}

type CategoryId = "basics" | "sandbox" | "dw" | "codemode" | "browser" | "safety" | "guardrails" | "hitl";

interface CategoryStyle {
  /** Category card classes (idle). */
  card: string;
  /** Category card classes when expanded. */
  cardActive: string;
  /** Category icon colour. */
  icon: string;
  /** Example card classes (unchanged from the original home page). */
  item: string;
  /** Example icon colour. */
  itemIcon: string;
  /** Example title classes. */
  itemTitle: string;
  /** Example grid columns at sm+. */
  grid: string;
}

const STYLES: Record<CategoryId, CategoryStyle> = {
  basics: {
    card: "border-border/60 hover:bg-muted/50",
    cardActive: "bg-muted/60 border-foreground/20",
    icon: "text-muted-foreground",
    item: "border-border/60 hover:bg-muted/50 active:bg-muted/70",
    itemIcon: "text-muted-foreground",
    itemTitle: "",
    grid: "sm:grid-cols-3",
  },
  sandbox: {
    card: "border-sky-300/40 dark:border-sky-800/40 hover:bg-sky-50/50 dark:hover:bg-sky-950/20",
    cardActive: "bg-sky-50 dark:bg-sky-950/30 border-sky-400/70 dark:border-sky-700/70",
    icon: "text-sky-600 dark:text-sky-400",
    item: "border-sky-300/40 dark:border-sky-800/40 hover:bg-sky-50/50 dark:hover:bg-sky-950/20 active:bg-sky-50 dark:active:bg-sky-950/30",
    itemIcon: "text-sky-600 dark:text-sky-400",
    itemTitle: "",
    grid: "sm:grid-cols-3",
  },
  dw: {
    card: "border-amber-300/40 dark:border-amber-800/40 hover:bg-amber-50/50 dark:hover:bg-amber-950/20",
    cardActive: "bg-amber-50 dark:bg-amber-950/30 border-amber-400/70 dark:border-amber-700/70",
    icon: "text-amber-600 dark:text-amber-400",
    item: "border-amber-300/40 dark:border-amber-800/40 hover:bg-amber-50/50 dark:hover:bg-amber-950/20 active:bg-amber-50 dark:active:bg-amber-950/30",
    itemIcon: "text-amber-600 dark:text-amber-400",
    itemTitle: "",
    grid: "sm:grid-cols-3",
  },
  codemode: {
    card: "border-teal-300/40 dark:border-teal-800/40 hover:bg-teal-50/50 dark:hover:bg-teal-950/20",
    cardActive: "bg-teal-50 dark:bg-teal-950/30 border-teal-400/70 dark:border-teal-700/70",
    icon: "text-teal-600 dark:text-teal-400",
    item: "border-teal-300/40 dark:border-teal-800/40 hover:bg-teal-50/50 dark:hover:bg-teal-950/20 active:bg-teal-50 dark:active:bg-teal-950/30",
    itemIcon: "text-teal-600 dark:text-teal-400",
    itemTitle: "",
    grid: "sm:grid-cols-2",
  },
  browser: {
    card: "border-violet-300/40 dark:border-violet-800/40 hover:bg-violet-50/50 dark:hover:bg-violet-950/20",
    cardActive: "bg-violet-50 dark:bg-violet-950/30 border-violet-400/70 dark:border-violet-700/70",
    icon: "text-violet-600 dark:text-violet-400",
    item: "border-violet-300/40 dark:border-violet-800/40 hover:bg-violet-50/50 dark:hover:bg-violet-950/20 active:bg-violet-50 dark:active:bg-violet-950/30",
    itemIcon: "text-violet-600 dark:text-violet-400",
    itemTitle: "",
    grid: "sm:grid-cols-2",
  },
  safety: {
    card: "border-destructive/30 hover:bg-destructive/5",
    cardActive: "bg-destructive/10 border-destructive/60",
    icon: "text-destructive",
    item: "border-destructive/30 hover:bg-destructive/5 active:bg-destructive/10",
    itemIcon: "text-destructive",
    itemTitle: "text-destructive",
    grid: "sm:grid-cols-3",
  },
  guardrails: {
    card: "border-emerald-300/40 dark:border-emerald-800/40 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20",
    cardActive: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-400/70 dark:border-emerald-700/70",
    icon: "text-emerald-600 dark:text-emerald-400",
    item: "border-emerald-300/40 dark:border-emerald-800/40 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 active:bg-emerald-50 dark:active:bg-emerald-950/30",
    itemIcon: "text-emerald-600 dark:text-emerald-400",
    itemTitle: "",
    grid: "sm:grid-cols-2",
  },
  hitl: {
    card: "border-orange-300/40 dark:border-orange-800/40 hover:bg-orange-50/50 dark:hover:bg-orange-950/20",
    cardActive: "bg-orange-50 dark:bg-orange-950/30 border-orange-400/70 dark:border-orange-700/70",
    icon: "text-orange-600 dark:text-orange-400",
    item: "border-orange-300/40 dark:border-orange-800/40 hover:bg-orange-50/50 dark:hover:bg-orange-950/20 active:bg-orange-50 dark:active:bg-orange-950/30",
    itemIcon: "text-orange-600 dark:text-orange-400",
    itemTitle: "",
    grid: "sm:grid-cols-3",
  },
};

interface Category {
  id: CategoryId;
  icon: LucideIcon;
  items: SuggestionItem[];
  opts: SuggestionSendOpts;
}

export function SuggestionCategories({
  onSend,
}: {
  onSend: (prompt: string, opts: SuggestionSendOpts) => void;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [openId, setOpenId] = useState<CategoryId | null>(null);
  // "bigDeal" creates a record every time, so each use gets a new opportunity name
  // (picked after mount: a random value during render would not match the server HTML).
  const [dealName, setDealName] = useState("");
  const nextDealName = () => setDealName((prev) => randomDealName(i18n.language, prev));
  useEffect(nextDealName, [i18n.language]); // eslint-disable-line react-hooks/exhaustive-deps

  const s2 = GUARDRAIL_SCENARIOS.find((s) => s.id === 2);

  const categories: Category[] = [
    {
      id: "basics",
      icon: Cloud,
      opts: {},
      items: [
        { title: t("chat.suggestions.workers.title"), desc: t("chat.suggestions.workers.prompt") },
        { title: t("chat.suggestions.aiGateway.title"), desc: t("chat.suggestions.aiGateway.prompt") },
        { title: t("chat.suggestions.r2.title"), desc: t("chat.suggestions.r2.prompt") },
      ],
    },
    {
      id: "sandbox",
      icon: Terminal,
      opts: {},
      items: [
        { title: t("chat.sandboxSuggestions.factorial.title"), desc: t("chat.sandboxSuggestions.factorial.prompt"), icon: Terminal },
        { title: t("chat.sandboxSuggestions.fibonacci.title"), desc: t("chat.sandboxSuggestions.fibonacci.prompt"), icon: Terminal },
        { title: t("chat.sandboxSuggestions.countdown.title"), desc: t("chat.sandboxSuggestions.countdown.prompt"), icon: Globe },
        // Egress control: credential added at the egress / blocked exfiltration / allowlisted PyPI
        { title: t("chat.sandboxSuggestions.githubToken.title"), desc: t("chat.sandboxSuggestions.githubToken.prompt"), icon: KeyRound },
        { title: t("chat.sandboxSuggestions.exfil.title"), desc: t("chat.sandboxSuggestions.exfil.prompt"), icon: ShieldAlert },
        { title: t("chat.sandboxSuggestions.pipInstall.title"), desc: t("chat.sandboxSuggestions.pipInstall.prompt"), icon: Terminal },
      ],
    },
    {
      id: "dw",
      icon: Zap,
      opts: {},
      items: [
        { title: t("chat.dwSuggestions.speed.title"), desc: t("chat.dwSuggestions.speed.prompt"), icon: Zap },
        { title: t("chat.dwSuggestions.compare.title"), desc: t("chat.dwSuggestions.compare.prompt"), icon: Zap },
        { title: t("chat.dwSuggestions.benchmark.title"), desc: t("chat.dwSuggestions.benchmark.prompt"), icon: Zap },
        { title: t("chat.dwSuggestions.blocked.title"), desc: t("chat.dwSuggestions.blocked.prompt"), icon: Zap },
      ],
    },
    {
      // Each question runs twice — without and with the Portal's Code Mode — and
      // is compared (tokens, model/tool calls, time); see experiment-compare.ts.
      id: "codemode",
      icon: Braces,
      opts: { mcp: "saas" },
      items: CODE_MODE_EXAMPLES.map((e) => ({
        title: t(`chat.codeModeSuggestions.examples.${e.key}.title`),
        desc: t(`chat.codeModeSuggestions.examples.${e.key}.prompt`),
        icon: Braces,
        opts: { mcp: "saas", experiment: e.id },
      })),
    },
    {
      id: "browser",
      icon: Globe,
      opts: {},
      items: [
        { title: t("chat.browserSuggestions.screenshot.title"), desc: t("chat.browserSuggestions.screenshot.prompt"), icon: Camera },
        { title: t("chat.browserSuggestions.summarize.title"), desc: t("chat.browserSuggestions.summarize.prompt"), icon: BookOpen },
      ],
    },
    {
      id: "safety",
      icon: ShieldAlert,
      opts: {},
      items: [
        { title: t("chat.safetySuggestions.bully.title"), desc: t("chat.safetySuggestions.bully.prompt") },
        { title: t("chat.safetySuggestions.hate.title"), desc: t("chat.safetySuggestions.hate.prompt") },
        { title: t("chat.safetySuggestions.violence.title"), desc: t("chat.safetySuggestions.violence.prompt") },
        { title: t("chat.safetySuggestions.pii.title"), desc: t("chat.safetySuggestions.pii.prompt") },
        { title: t("chat.safetySuggestions.injection1.title"), desc: t("chat.safetySuggestions.injection1.prompt") },
        { title: t("chat.safetySuggestions.injection2.title"), desc: t("chat.safetySuggestions.injection2.prompt") },
      ],
    },
    {
      id: "guardrails",
      icon: ShieldCheck,
      opts: { mcp: "saas" },
      items: [
        ...GUARDRAIL_SCENARIOS.map((s) => ({ title: t(s.titleKey), desc: t(s.blockPromptKey), icon: ShieldCheck })),
        ...(s2?.resetPromptKey
          ? [{ title: t("chat.guardrailSuggestions.resetTitle"), desc: t(s2.resetPromptKey), icon: RotateCcw }]
          : []),
        { title: t("chat.guardrailSuggestions.viewPolicy"), desc: t("chat.guardrailSuggestions.viewPolicyDesc"), icon: ArrowRight, href: "/mcp-guardrails" },
      ],
    },
    {
      // Writes the harness holds for a human: low risk is approved in the chat,
      // high risk goes to a Cloudflare Workflow that emails the manager. They are
      // writes, so the prompt goes into the input to be checked / changed first.
      id: "hitl",
      icon: Hand,
      opts: { mcp: "saas" },
      items: HITL_EXAMPLES.map((e) => ({
        title: t(`chat.hitlSuggestions.${e.key}.title`),
        desc: t(`chat.hitlSuggestions.${e.key}.prompt`, e.key === "bigDeal" ? { name: dealName } : undefined),
        icon: e.risk === "high" ? MailCheck : Hand,
        ...(e.key === "bigDeal" ? { afterPick: nextDealName } : {}),
      })),
    },
  ];

  const open = categories.find((c) => c.id === openId) ?? null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {categories.map((c) => {
          const style = STYLES[c.id];
          const isOpen = c.id === openId;
          const count = c.items.filter((i) => !i.href).length;
          return (
            <button
              key={c.id}
              type="button"
              aria-expanded={isOpen}
              aria-controls="suggestion-category-panel"
              onClick={() => setOpenId(isOpen ? null : c.id)}
              className={`text-left rounded-2xl border px-3.5 py-3 transition-colors min-w-0 ${isOpen ? style.cardActive : style.card}`}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <c.icon className={`size-3.5 shrink-0 ${style.icon}`} />
                <span className="truncate">{t(`chat.categories.${c.id}.title`)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t(`chat.categories.${c.id}.desc`)}</div>
              <div className="text-[11px] text-muted-foreground/70 mt-1">{t("chat.categories.count", { count })}</div>
            </button>
          );
        })}
      </div>

      {open && (
        <div id="suggestion-category-panel" className={`grid grid-cols-1 ${STYLES[open.id].grid} gap-2.5`}>
          {open.items.map((s) => {
            const style = STYLES[open.id];
            return (
              <button
                key={s.title}
                type="button"
                onClick={() => {
                  if (s.href) return router.push(s.href);
                  onSend(s.desc, s.opts ?? open.opts);
                  s.afterPick?.();
                }}
                className={`text-left rounded-2xl border px-4 py-3.5 transition-colors ${style.item}`}
              >
                <div className={`flex items-center gap-1.5 text-sm font-medium ${style.itemTitle}`}>
                  {s.icon && <s.icon className={`size-3.5 shrink-0 ${style.itemIcon}`} />}
                  {s.title}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.desc}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
