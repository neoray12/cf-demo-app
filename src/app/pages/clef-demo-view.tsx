'use client';

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Headset, Loader2, MessageSquareWarning, PhoneOff, Play, Receipt, Scale, ShieldAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PRESETS } from "./clef-presets";
import { FEATURED_PRESETS, demoDecision } from "@/lib/clef-demo";
import type { Answer, DraftQuestion, ImageClip, MediaClip, ModelResult } from "./clef-playground";

const ICONS: Record<(typeof FEATURED_PRESETS)[number], LucideIcon> = {
  scamCall: PhoneOff,
  scamSms: MessageSquareWarning,
  invoice: Receipt,
  customerCall: Headset,
  moderation: ShieldAlert,
  judge: Scale,
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The answer as one headline: the chosen option and how sure Clef is. */
function headline(a: Answer, q: DraftQuestion | undefined, t: (k: string, o?: Record<string, unknown>) => string) {
  if (a.type === "noul") {
    const yes = a.noul >= 0.5;
    return { value: `${yes ? t("clef.yes") : t("clef.no")} ${pct(yes ? a.noul : 1 - a.noul)}`, sub: null };
  }
  if (a.type === "choice") {
    const desc = q?.options.find((o) => o.key === a.choice)?.desc || a.choice;
    return { value: `${desc} ${pct(a.probabilities[a.choice] ?? a.confidence)}`, sub: null };
  }
  const max = Math.max(Object.keys(a.probabilities).length - 1, 1);
  return {
    value: String(a.legend[String(Math.round(a.score))] ?? Math.round(a.score)),
    sub: t("clef.demo.scoreOf", { score: a.score.toFixed(1), max }),
  };
}

/**
 * The simple Clef demo: pick one of a few scenarios, see what Clef is given and
 * asked, press Decide, and read each answer as one number — plus a threshold on
 * the scenario's yes/no question that turns the probability into an action.
 */
export function ClefDemoView({
  lang,
  presetKey,
  onPick,
  stateText,
  images,
  audio,
  videos,
  questions,
  model,
  running,
  error,
  result,
  onRun,
  onCompare,
}: {
  lang: "zh" | "en";
  presetKey: string;
  onPick: (key: string) => void;
  stateText: string;
  images: ImageClip[];
  audio: MediaClip[];
  videos: MediaClip[];
  questions: DraftQuestion[];
  model: { name: string; pricePerM: number };
  running: boolean;
  error: string | null;
  result: ModelResult | undefined;
  onRun: () => void;
  onCompare: () => void;
}) {
  const { t } = useTranslation();
  const preset = PRESETS.find((p) => p.key === presetKey);
  const demo = preset?.demo;
  const [threshold, setThreshold] = useState(demo?.threshold ?? 0.8);
  useEffect(() => setThreshold(demo?.threshold ?? 0.8), [presetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const samplesPending = (preset?.samples?.length ?? 0) > 0 && images.length + audio.length + videos.length === 0;
  const decisionQuestion = questions.find((q) => q.id === demo?.question);
  const decisionAnswer = demo ? result?.answers?.[demo.question] : undefined;
  const decision = decisionAnswer?.type === "noul" ? demoDecision(decisionAnswer.noul, threshold) : null;
  const sectionTitle = "text-sm font-medium text-muted-foreground mb-2";

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("clef.demo.intro")}</p>

      <section>
        <h2 className={sectionTitle}>{t("clef.demo.step1")}</h2>
        <div className="grid gap-2.5 grid-cols-2 md:grid-cols-3">
          {FEATURED_PRESETS.map((key) => {
            const p = PRESETS.find((x) => x.key === key)!;
            const Icon = ICONS[key];
            const on = key === presetKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onPick(key)}
                className={`text-left rounded-xl border px-4 py-3 transition-colors ${on ? "border-orange-400 bg-orange-500/5 ring-1 ring-orange-400" : "hover:bg-muted/50"}`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Icon className="size-4 shrink-0 text-orange-500" />
                  {t(`clef.presets.${key}`)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{p.demo?.tagline[lang]}</div>
              </button>
            );
          })}
        </div>
        {preset?.useCase && <p className="text-xs text-muted-foreground mt-2.5 leading-relaxed">{preset.useCase[lang]}</p>}
      </section>

      <section>
        <h2 className={sectionTitle}>{t("clef.demo.step2")}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl bg-muted/40 p-4 space-y-3 min-w-0">
            <div className="text-xs text-muted-foreground">{t("clef.demo.input")}</div>
            {samplesPending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("clef.demo.loadingSamples")}
              </div>
            )}
            {images.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {images.map((c, i) => <img key={i} src={c.dataUrl} alt="" className="h-32 rounded-md border object-contain bg-background" />)}
              </div>
            )}
            {audio.map((c, i) => <audio key={i} src={c.dataUrl} controls className="w-full h-9" />)}
            {videos.map((c, i) => <video key={i} src={c.dataUrl} controls className="w-full max-h-56 rounded-md border bg-black" />)}
            <p className="text-sm whitespace-pre-wrap break-words max-h-40 overflow-auto">{stateText}</p>
          </div>
          <div className="rounded-xl bg-muted/40 p-4 min-w-0">
            <div className="text-xs text-muted-foreground mb-2">{t("clef.demo.questions")}</div>
            <ol className="space-y-1.5 text-sm">
              {questions.map((q) => (
                <li key={q.uid} className="flex items-baseline gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-background text-muted-foreground shrink-0">{t(`clef.types.${q.type}`)}</span>
                  <span>{q.instructions}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <Button onClick={onRun} disabled={running || samplesPending} className="gap-1.5">
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? t("clef.demo.judging") : t("clef.demo.judge")}
          </Button>
          {result && !result.error && (
            <span className="text-xs text-muted-foreground">
              {t("clef.demo.meta", {
                model: model.name,
                ms: result.latencyMs,
                cost: result.usage ? (result.usage.input_tokens * model.pricePerM).toFixed(2) : "—",
              })}
            </span>
          )}
        </div>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      </section>

      <section>
        <h2 className={sectionTitle}>{t("clef.demo.step3")}</h2>
        {!result && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("clef.demo.empty")}</div>}
        {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
        {result && !result.error && (
          <div className="space-y-3">
            <div className="grid gap-2.5 grid-cols-2 md:grid-cols-3">
              {questions.map((q) => {
                const a = result.answers?.[q.id];
                if (!a) return null;
                const h = headline(a, q, t);
                const key = q.id === demo?.question;
                return (
                  <div key={q.uid} className={`rounded-xl p-3.5 min-w-0 ${key ? "bg-orange-500/10 ring-1 ring-orange-400" : "bg-muted/40"}`}>
                    <div className="text-xs text-muted-foreground">{q.instructions}</div>
                    <div className="text-xl font-semibold mt-1 break-words">{h.value}</div>
                    {h.sub && <div className="text-xs text-muted-foreground mt-0.5">{h.sub}</div>}
                  </div>
                );
              })}
            </div>
            {demo && decision && (
              <div className="rounded-xl border p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <label htmlFor="clef-threshold" className="text-sm text-muted-foreground whitespace-nowrap">{t("clef.demo.threshold")}</label>
                  <input
                    id="clef-threshold"
                    type="range"
                    min={50}
                    max={99}
                    step={1}
                    value={Math.round(threshold * 100)}
                    onChange={(e) => setThreshold(Number(e.target.value) / 100)}
                    className="flex-1 accent-orange-500"
                  />
                  <span className="w-12 text-right text-sm font-semibold tabular-nums">{pct(threshold)}</span>
                </div>
                <div className={`rounded-lg px-3 py-2 text-sm ${decision.pass ? "bg-orange-500/15 text-orange-800 dark:text-orange-300" : "bg-muted text-foreground"}`}>
                  {t(decision.pass ? "clef.demo.passRule" : "clef.demo.failRule", {
                    question: decisionQuestion?.instructions ?? demo.question,
                    p: pct(decision.p),
                    th: pct(threshold),
                    action: (decision.pass ? demo.pass : demo.fail)[lang],
                  })}
                </div>
              </div>
            )}
            <button type="button" onClick={onCompare} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3" />
              {t("clef.demo.compare")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
