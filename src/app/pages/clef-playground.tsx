'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Film,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Music,
  Play,
  Plus,
  Scale,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { PRESETS, SAMPLES, type Preset, type QuestionType, type Sample } from "./clef-presets";

// ── Types ──

type ClefModel = "clef" | "clef-flash" | "clef-omni";

interface ImageClip {
  dataUrl: string;
  sampleId?: string;
}

interface MediaClip {
  sampleId?: string;
  dataUrl: string;
  name: string;
  size: number;
  duration: number;
}

interface DraftQuestion {
  uid: string;
  id: string;
  type: QuestionType;
  instructions: string;
  /** choice: option id → description */
  options: Array<{ key: string; desc: string }>;
  /** score: ordered levels, lowest first */
  levels: string[];
  /** noul: optional meaning of yes / no */
  yes: string;
  no: string;
}

type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number };

interface ModelResult {
  model?: string;
  answers?: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  via?: "ai-gateway" | "rest";
  /** Audio/video were not sent to this model (Clef-omni only). */
  ignoredMedia?: string[];
  error?: string;
}

// Hosted pricing / context windows (Workers AI docs, 2026-10-09). Clef models
// bill input tokens only — no output tokens, since they don't generate text.
const MODELS: Array<{ id: ClefModel; name: string; size: string; pricePerM: number; ctx: string; media: string }> = [
  { id: "clef", name: "Clef", size: "27B", pricePerM: 0.24, ctx: "64K", media: "text · image" },
  { id: "clef-flash", name: "Clef-flash", size: "9B", pricePerM: 0.038, ctx: "24K", media: "text · image" },
  { id: "clef-omni", name: "Clef-omni", size: "30B MoE", pricePerM: 0.15, ctx: "64K", media: "text · image · audio · video" },
];

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
// Clef-omni media limits
const MAX_AUDIO = 4;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 300;
const MAX_VIDEOS = 2;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const MAX_MEDIA_BYTES_TOTAL = 16 * 1024 * 1024;

function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}

function mediaDuration(f: File, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    const url = URL.createObjectURL(f);
    el.preload = "metadata";
    el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration); };
    el.onerror = () => { URL.revokeObjectURL(url); resolve(NaN); };
    el.src = url;
  });
}

let uidCounter = 0;
const uid = () => `q-${Date.now()}-${++uidCounter}`;

function emptyQuestion(type: QuestionType = "noul", index = 1): DraftQuestion {
  return {
    uid: uid(),
    id: `q${index}`,
    type,
    instructions: "",
    options: [{ key: "a", desc: "" }, { key: "b", desc: "" }],
    levels: ["", ""],
    yes: "",
    no: "",
  };
}

function presetToDraft(p: Preset, lang: "zh" | "en"): { state: string; questions: DraftQuestion[] } {
  return {
    state: p.state[lang],
    questions: p.questions.map((q) => ({
      ...emptyQuestion(q.type),
      id: q.id,
      instructions: q.instructions[lang],
      ...(q.options ? { options: q.options.map((o) => ({ key: o.key, desc: o.desc[lang] })) } : {}),
      ...(q.levels ? { levels: q.levels.map((l) => l[lang]) } : {}),
    })),
  };
}

function toApiQuestions(drafts: DraftQuestion[]) {
  return Object.fromEntries(
    drafts.map((q) => {
      if (q.type === "choice") {
        return [q.id, { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.key, o.desc || null])) }];
      }
      if (q.type === "score") return [q.id, { type: "score", instructions: q.instructions, criteria: q.levels }];
      const criteria = q.yes || q.no ? { criteria: { ...(q.yes ? { true: q.yes } : {}), ...(q.no ? { false: q.no } : {}) } } : {};
      return [q.id, { type: "noul", instructions: q.instructions, ...criteria }];
    })
  );
}

// Normalise an answer to a comparable decision for the agreement check
function decisionOf(a: Answer | undefined): string | null {
  if (!a) return null;
  if (a.type === "noul") return a.noul >= 0.5 ? "yes" : "no";
  if (a.type === "choice") return a.choice;
  return String(Math.round(a.score));
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

// ── Result visualisations ──

function Bar({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate ${highlight ? "font-semibold" : "text-muted-foreground"}`} title={label}>{label}</span>
        <span className={`shrink-0 font-mono ${highlight ? "font-semibold" : "text-muted-foreground"}`}>{pct(value)}</span>
      </div>
      <div className="h-1.5 mt-0.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${highlight ? "bg-primary" : "bg-muted-foreground/40"}`} style={{ width: `${Math.max(value * 100, 1)}%` }} />
      </div>
    </div>
  );
}

function AnswerView({ answer, question }: { answer: Answer; question?: DraftQuestion }) {
  const { t } = useTranslation();
  if (answer.type === "noul") {
    return (
      <div className="space-y-1">
        <Bar label={t("clef.yes")} value={answer.noul} highlight={answer.noul >= 0.5} />
        <Bar label={t("clef.no")} value={1 - answer.noul} highlight={answer.noul < 0.5} />
      </div>
    );
  }
  if (answer.type === "choice") {
    const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    return (
      <div className="space-y-1">
        {sorted.map(([k, v]) => {
          const desc = question?.options.find((o) => o.key === k)?.desc;
          return <Bar key={k} label={desc ? `${k} · ${desc}` : k} value={v} highlight={k === answer.choice} />;
        })}
        <div className="text-[11px] text-muted-foreground pt-0.5">{t("clef.confidence")}: {pct(answer.confidence)}</div>
      </div>
    );
  }
  const levels = Object.keys(answer.probabilities).length;
  const max = Math.max(levels - 1, 1);
  return (
    <div className="space-y-2">
      <div>
        <div className="relative h-2 rounded-full bg-gradient-to-r from-emerald-400/50 via-amber-400/50 to-red-500/50">
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-3.5 rounded-full border-2 border-background bg-foreground shadow"
            style={{ left: `${(answer.score / max) * 100}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
          {Object.entries(answer.legend).map(([i, l]) => (
            <span key={i} className="truncate max-w-[25%]" title={String(l)}>{i}·{String(l)}</span>
          ))}
        </div>
      </div>
      <div className="text-xs">
        {t("clef.score")}: <span className="font-mono font-semibold">{answer.score.toFixed(2)}</span>
        <span className="text-muted-foreground"> / {max} · {t("clef.confidence")}: {pct(answer.confidence)}</span>
      </div>
      <div className="space-y-1">
        {Object.entries(answer.probabilities).map(([k, v]) => (
          <Bar key={k} label={`${k} · ${String(answer.legend[k] ?? "")}`} value={v} highlight={k === String(Math.round(answer.score))} />
        ))}
      </div>
    </div>
  );
}

// ── Page ──

export function ClefPlaygroundPage() {
  const { t, i18n } = useTranslation();
  const lang: "zh" | "en" = i18n.language === "en" ? "en" : "zh";
  const initial = useMemo(() => presetToDraft(PRESETS[0]!, lang), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [presetKey, setPresetKey] = useState(PRESETS[0]!.key);
  const [state, setState] = useState(initial.state);
  const [stateIsJson, setStateIsJson] = useState(false);
  const [questions, setQuestions] = useState<DraftQuestion[]>(initial.questions);
  const [images, setImages] = useState<ImageClip[]>([]);
  const [audio, setAudio] = useState<MediaClip[]>([]);
  const [videos, setVideos] = useState<MediaClip[]>([]);
  const [selectedModels, setSelectedModels] = useState<ClefModel[]>(["clef", "clef-flash", "clef-omni"]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<ClefModel, ModelResult>> | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const hasMedia = audio.length > 0 || videos.length > 0;
  const loadToken = useRef(0);

  const jsonError = useMemo(() => {
    if (!stateIsJson) return null;
    try { JSON.parse(state); return null; } catch (e) { return (e as Error).message; }
  }, [state, stateIsJson]);

  const sampleName = (sm: Sample) => sm.name[lang];

  // Fetch bundled sample files and turn them into data URLs. Samples are
  // trusted (small, ours), so they skip the per-file validation uploads get.
  const fetchSample = useCallback(async (sm: Sample) => {
    const blob = await (await fetch(sm.url)).blob();
    const file = new File([blob], sm.url.split("/").pop()!, { type: sm.mime });
    return { sm, file, dataUrl: await readDataUrl(file) };
  }, []);

  const clipOf = (r: { sm: Sample; file: File; dataUrl: string }): MediaClip => ({
    sampleId: r.sm.id,
    dataUrl: r.dataUrl,
    name: r.file.name,
    size: r.file.size,
    duration: r.sm.duration ?? NaN,
  });

  const attachPresetSamples = useCallback(async (p: Preset) => {
    const token = ++loadToken.current;
    const loaded = await Promise.all((p.samples ?? []).map((id) => fetchSample(SAMPLES.find((x) => x.id === id)!)));
    if (token !== loadToken.current) return; // a newer preset was picked meanwhile
    setImages(loaded.filter((r) => r.sm.kind === "image").map((r) => ({ dataUrl: r.dataUrl, sampleId: r.sm.id })));
    setAudio(loaded.filter((r) => r.sm.kind === "audio").map(clipOf));
    setVideos(loaded.filter((r) => r.sm.kind === "video").map(clipOf));
  }, [fetchSample]);

  const loadPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    const d = presetToDraft(p, lang);
    const needsOmni = (p.samples ?? []).some((id) => SAMPLES.find((x) => x.id === id)?.kind !== "image");
    setPresetKey(key);
    setState(d.state);
    setStateIsJson(Boolean(p.json));
    setQuestions(d.questions);
    setImages([]);
    setAudio([]);
    setVideos([]);
    // Audio/video are Clef-omni only — comparing it against models that can't
    // hear the clip would just be noise, so those scenarios run Clef-omni alone.
    setSelectedModels(needsOmni ? ["clef-omni"] : ["clef", "clef-flash", "clef-omni"]);
    setResults(null);
    setError(null);
    void attachPresetSamples(p).catch(() => setError(t("clef.errors.sampleLoad")));
  };

  // Toggle a single sample from the library on/off
  const toggleSample = async (sm: Sample) => {
    setError(null);
    const attached =
      sm.kind === "image" ? images.some((c) => c.sampleId === sm.id)
      : sm.kind === "audio" ? audio.some((c) => c.sampleId === sm.id)
      : videos.some((c) => c.sampleId === sm.id);
    if (attached) {
      if (sm.kind === "image") setImages((prev) => prev.filter((c) => c.sampleId !== sm.id));
      else (sm.kind === "audio" ? setAudio : setVideos)((prev) => prev.filter((c) => c.sampleId !== sm.id));
      return;
    }
    const limit = sm.kind === "image" ? MAX_IMAGES : sm.kind === "audio" ? MAX_AUDIO : MAX_VIDEOS;
    const count = sm.kind === "image" ? images.length : sm.kind === "audio" ? audio.length : videos.length;
    if (count >= limit) { setError(t(`clef.errors.${sm.kind}Count`, { max: limit })); return; }
    try {
      const r = await fetchSample(sm);
      if (sm.kind === "image") setImages((prev) => [...prev, { dataUrl: r.dataUrl, sampleId: sm.id }]);
      else {
        (sm.kind === "audio" ? setAudio : setVideos)((prev) => [...prev, clipOf(r)]);
        setSelectedModels((prev) => (prev.includes("clef-omni") ? prev : [...prev, "clef-omni"]));
      }
    } catch {
      setError(t("clef.errors.sampleLoad"));
    }
  };

  // First scenario ships with its sample already attached
  useEffect(() => {
    void attachPresetSamples(PRESETS[0]!).catch(() => {});
    setSelectedModels(["clef-omni"]);
  }, [attachPresetSamples]);

  const updateQuestion = (u: string, patch: Partial<DraftQuestion>) =>
    setQuestions((qs) => qs.map((q) => (q.uid === u ? { ...q, ...patch } : q)));

  const addImages = useCallback(async (files: File[]) => {
    setError(null);
    const accepted: ImageClip[] = [];
    for (const f of files) {
      if (!ALLOWED_IMAGE_TYPES.includes(f.type)) { setError(t("clef.errors.imageType")); continue; }
      if (f.size > MAX_IMAGE_BYTES) { setError(t("clef.errors.imageSize")); continue; }
      accepted.push({ dataUrl: await readDataUrl(f) });
    }
    setImages((prev) => {
      const next = [...prev, ...accepted];
      if (next.length > MAX_IMAGES) setError(t("clef.errors.imageCount", { max: MAX_IMAGES }));
      return next.slice(0, MAX_IMAGES);
    });
  }, [t]);

  // Audio / video clips — Clef-omni extension
  const addMedia = useCallback(async (files: File[], kind: "audio" | "video") => {
    setError(null);
    const [max, maxBytes, maxSeconds] = kind === "audio"
      ? [MAX_AUDIO, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS]
      : [MAX_VIDEOS, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS];
    const current = kind === "audio" ? audio : videos;
    let totalBytes = [...audio, ...videos].reduce((n, c) => n + c.size, 0);
    const accepted: MediaClip[] = [];
    for (const f of files) {
      if (!f.type.startsWith(`${kind}/`)) { setError(t(`clef.errors.${kind}Type`)); continue; }
      if (current.length + accepted.length >= max) { setError(t(`clef.errors.${kind}Count`, { max })); break; }
      if (f.size > maxBytes) { setError(t(`clef.errors.${kind}Size`, { mb: maxBytes / 1024 / 1024 })); continue; }
      if (totalBytes + f.size > MAX_MEDIA_BYTES_TOTAL) { setError(t("clef.errors.mediaTotal")); continue; }
      const duration = await mediaDuration(f, kind);
      if (duration > maxSeconds) { setError(t(`clef.errors.${kind}Duration`, { s: maxSeconds })); continue; }
      totalBytes += f.size;
      accepted.push({ dataUrl: await readDataUrl(f), name: f.name, size: f.size, duration });
    }
    if (!accepted.length) return;
    (kind === "audio" ? setAudio : setVideos)((prev) => [...prev, ...accepted]);
    // Audio/video only make sense for Clef-omni — make sure it's selected
    setSelectedModels((prev) => (prev.includes("clef-omni") ? prev : [...prev, "clef-omni"]));
  }, [audio, videos, t]);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); void addImages(files); }
  };

  const buildRequest = () => ({
    state: stateIsJson ? JSON.parse(state) : state,
    questions: toApiQuestions(questions),
    ...(images.length ? { images: images.map((c) => c.dataUrl) } : {}),
    ...(audio.length ? { audio: audio.map((c) => c.dataUrl) } : {}),
    ...(videos.length ? { videos: videos.map((c) => c.dataUrl) } : {}),
  });

  const run = async () => {
    setError(null);
    if (jsonError) { setError(t("clef.errors.invalidJson")); return; }
    const ids = questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) { setError(t("clef.errors.duplicateId")); return; }
    setRunning(true);
    setResults(null);
    try {
      const res = await fetch("/api/clef", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildRequest(), models: selectedModels }),
      });
      const data = (await res.json()) as { results?: Partial<Record<ClefModel, ModelResult>>; error?: string };
      if (!res.ok || !data.results) throw new Error(data.error || `HTTP ${res.status}`);
      setResults(data.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const copyCurl = async () => {
    const req = buildRequest();
    const model: ClefModel = hasMedia ? "clef-omni" : (selectedModels[0] ?? "clef");
    const body = {
      model,
      ...req,
      ...(req.images ? { images: req.images.map(() => "data:image/png;base64,<...>") } : {}),
      ...(req.audio ? { audio: req.audio.map(() => "data:audio/mpeg;base64,<...>") } : {}),
      ...(req.videos ? { videos: req.videos.map(() => "data:video/mp4;base64,<...>") } : {}),
    };
    const curl = `curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/${model} \\\n  -X POST \\\n  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\\n  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
    await navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shownModels = MODELS.filter((m) => results?.[m.id]);
  // Successful models only — used for the latency ranking and agreement check
  const okModels = shownModels.filter((m) => !results?.[m.id]?.error);
  const ranked = [...okModels].sort((a, b) => results![a.id]!.latencyMs - results![b.id]!.latencyMs);
  const fastest = ranked.length > 1 ? ranked[0]! : null;
  const slowest = ranked.length > 1 ? ranked[ranked.length - 1]! : null;
  const speedup = fastest && slowest ? results![slowest.id]!.latencyMs / Math.max(results![fastest.id]!.latencyMs, 1) : null;
  const preset = PRESETS.find((p) => p.key === presetKey);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto" onPaste={onPaste}>
      <div className="mb-5">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Scale className="size-6 text-orange-500" />
          {t("clef.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("clef.description")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* ── Input ── */}
        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{t("clef.scenario")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {(["tw", "text"] as const).map((group) => (
                <div key={group} className="space-y-1.5">
                  <div className="text-[11px] font-medium text-muted-foreground">{t(`clef.groups.${group}`)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESETS.filter((p) => p.group === group).map((p) => {
                      const kinds = new Set((p.samples ?? []).map((id) => SAMPLES.find((x) => x.id === id)?.kind));
                      return (
                        <button
                          key={p.key}
                          onClick={() => loadPreset(p.key)}
                          className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                            presetKey === p.key ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"
                          }`}
                        >
                          {kinds.has("audio") && <Music className="size-3" />}
                          {kinds.has("video") && <Film className="size-3" />}
                          {kinds.has("image") && <ImageIcon className="size-3" />}
                          {t(`clef.presets.${p.key}`)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {preset?.useCase && (
                <div className="rounded-lg border-l-4 border-orange-400 bg-orange-500/5 px-3 py-2 text-xs leading-relaxed">
                  <div className="font-medium text-orange-700 dark:text-orange-400 mb-0.5">{t("clef.useCase")}</div>
                  {preset.useCase[lang]}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">State</CardTitle>
              <div className="flex rounded-md border overflow-hidden text-[11px]">
                {[false, true].map((isJson) => (
                  <button
                    key={String(isJson)}
                    onClick={() => setStateIsJson(isJson)}
                    className={`px-2 py-0.5 ${stateIsJson === isJson ? "bg-foreground text-background" : "hover:bg-muted"}`}
                  >
                    {isJson ? "JSON" : t("clef.text")}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={state}
                onChange={(e) => setState(e.target.value)}
                rows={6}
                className={`text-sm ${stateIsJson ? "font-mono text-xs" : ""}`}
                placeholder={t("clef.statePlaceholder")}
              />
              {jsonError && <p className="text-xs text-destructive">{t("clef.errors.invalidJson")}: {jsonError}</p>}
              <div className="flex items-center gap-2 flex-wrap">
                {images.map((c, i) => (
                  <div key={i} className="relative">
                    <img src={c.dataUrl} alt="" className="size-16 object-cover rounded-md border" />
                    <button
                      onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-foreground text-background flex items-center justify-center"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className={`size-16 rounded-md border border-dashed flex flex-col items-center justify-center text-[10px] text-muted-foreground hover:bg-muted`}
                  >
                    <ImagePlus className="size-4 mb-0.5" />
                    {t("clef.addImage")}
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept={ALLOWED_IMAGE_TYPES.join(",")}
                  multiple
                  hidden
                  onChange={(e) => { void addImages(Array.from(e.target.files ?? [])); e.target.value = ""; }}
                />
                <span className="text-[11px] text-muted-foreground">{t("clef.imageHint", { max: MAX_IMAGES })}</span>
              </div>
              <div className={`rounded-lg border border-dashed p-2.5 space-y-2 `}>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="text-[10px]">Clef-omni</Badge>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => audioRef.current?.click()} disabled={audio.length >= MAX_AUDIO}>
                    <Music className="size-3.5" />
                    {t("clef.addAudio")}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => videoRef.current?.click()} disabled={videos.length >= MAX_VIDEOS}>
                    <Film className="size-3.5" />
                    {t("clef.addVideo")}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">{t("clef.mediaHint")}</span>
                  <input ref={audioRef} type="file" accept="audio/*" multiple hidden onChange={(e) => { void addMedia(Array.from(e.target.files ?? []), "audio"); e.target.value = ""; }} />
                  <input ref={videoRef} type="file" accept="video/mp4,video/webm" multiple hidden onChange={(e) => { void addMedia(Array.from(e.target.files ?? []), "video"); e.target.value = ""; }} />
                </div>
                {audio.map((c, i) => (
                  <div key={`a-${i}`} className="flex items-center gap-2">
                    <audio src={c.dataUrl} controls className="h-8 flex-1 min-w-0" />
                    <span className="text-[11px] text-muted-foreground truncate max-w-[40%]" title={c.name}>
                      {c.name} · {Number.isFinite(c.duration) ? `${c.duration.toFixed(1)}s` : "?"} · {(c.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                    <button onClick={() => setAudio((prev) => prev.filter((_, j) => j !== i))} className="p-1 text-muted-foreground hover:text-destructive">
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                {videos.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {videos.map((c, i) => (
                      <div key={`v-${i}`} className="relative">
                        <video src={c.dataUrl} controls className="w-full rounded-md border bg-black aspect-video" />
                        <div className="text-[11px] text-muted-foreground truncate mt-0.5" title={c.name}>
                          {c.name} · {Number.isFinite(c.duration) ? `${c.duration.toFixed(1)}s` : "?"}
                        </div>
                        <button
                          onClick={() => setVideos((prev) => prev.filter((_, j) => j !== i))}
                          className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-foreground text-background flex items-center justify-center"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-lg bg-muted/40 p-2.5 space-y-2">
                <div className="text-xs font-medium">{t("clef.samples")} <span className="font-normal text-muted-foreground">· {t("clef.samplesHint")}</span></div>
                {(["image", "audio", "video"] as const).map((kind) => (
                  <div key={kind} className="flex items-center gap-1.5 flex-wrap">
                    <span className="w-14 shrink-0 text-[11px] text-muted-foreground inline-flex items-center gap-1">
                      {kind === "image" ? <ImageIcon className="size-3" /> : kind === "audio" ? <Music className="size-3" /> : <Film className="size-3" />}
                      {t(`clef.kinds.${kind}`)}
                    </span>
                    {SAMPLES.filter((sm) => sm.kind === kind).map((sm) => {
                      const on = [...images, ...audio, ...videos].some((c) => c.sampleId === sm.id);
                      return (
                        <button
                          key={sm.id}
                          onClick={() => void toggleSample(sm)}
                          title={sm.source[lang]}
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors ${on ? "bg-orange-500/10 border-orange-400 text-orange-700 dark:text-orange-400" : "bg-background hover:bg-muted"}`}
                        >
                          {on ? <Check className="size-3" /> : <Plus className="size-3" />}
                          {sampleName(sm)}
                          {sm.duration ? <span className="text-muted-foreground">{Math.round(sm.duration)}s</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {(() => {
                  const used = SAMPLES.filter((sm) => [...images, ...audio, ...videos].some((c) => c.sampleId === sm.id));
                  return used.length ? (
                    <ul className="text-[10px] text-muted-foreground space-y-0.5">
                      {used.map((sm) => <li key={sm.id}>{sampleName(sm)}：{sm.source[lang]}</li>)}
                    </ul>
                  ) : null;
                })()}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">{t("clef.questions")} ({questions.length}/64)</CardTitle>
              <div className="flex gap-1">
                {(["noul", "choice", "score"] as const).map((type) => (
                  <Button
                    key={type}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    disabled={questions.length >= 64}
                    onClick={() => setQuestions((qs) => [...qs, emptyQuestion(type, qs.length + 1)])}
                  >
                    <Plus className="size-3" />
                    {type}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {questions.map((q) => (
                <div key={q.uid} className="rounded-lg border p-3 space-y-2 bg-muted/20">
                  <div className="flex items-center gap-2">
                    <Input
                      value={q.id}
                      onChange={(e) => updateQuestion(q.uid, { id: e.target.value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100) })}
                      className="h-7 w-32 font-mono text-xs"
                      placeholder="id"
                    />
                    <select
                      value={q.type}
                      onChange={(e) => updateQuestion(q.uid, { type: e.target.value as QuestionType })}
                      className="h-7 rounded-md border bg-background px-2 text-xs"
                    >
                      <option value="noul">noul · {t("clef.types.noul")}</option>
                      <option value="choice">choice · {t("clef.types.choice")}</option>
                      <option value="score">score · {t("clef.types.score")}</option>
                    </select>
                    <div className="flex-1" />
                    <button
                      onClick={() => setQuestions((qs) => qs.filter((x) => x.uid !== q.uid))}
                      disabled={questions.length <= 1}
                      className="p-1 rounded text-muted-foreground hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <Input
                    value={q.instructions}
                    onChange={(e) => updateQuestion(q.uid, { instructions: e.target.value })}
                    className="h-8 text-sm"
                    placeholder={t("clef.instructionsPlaceholder")}
                  />
                  {q.type === "noul" && (
                    <div className="grid grid-cols-2 gap-2">
                      <Input value={q.yes} onChange={(e) => updateQuestion(q.uid, { yes: e.target.value })} className="h-7 text-xs" placeholder={t("clef.yesMeans")} />
                      <Input value={q.no} onChange={(e) => updateQuestion(q.uid, { no: e.target.value })} className="h-7 text-xs" placeholder={t("clef.noMeans")} />
                    </div>
                  )}
                  {q.type === "choice" && (
                    <div className="space-y-1.5">
                      {q.options.map((o, i) => (
                        <div key={i} className="flex gap-1.5">
                          <Input
                            value={o.key}
                            onChange={(e) => updateQuestion(q.uid, { options: q.options.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
                            className="h-7 w-28 font-mono text-xs"
                            placeholder="option"
                          />
                          <Input
                            value={o.desc}
                            onChange={(e) => updateQuestion(q.uid, { options: q.options.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })}
                            className="h-7 text-xs"
                            placeholder={t("clef.optionDesc")}
                          />
                          <button
                            onClick={() => updateQuestion(q.uid, { options: q.options.filter((_, j) => j !== i) })}
                            disabled={q.options.length <= 2}
                            className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => updateQuestion(q.uid, { options: [...q.options, { key: `opt${q.options.length + 1}`, desc: "" }] })}
                        className="text-xs text-primary hover:underline"
                      >
                        + {t("clef.addOption")}
                      </button>
                    </div>
                  )}
                  {q.type === "score" && (
                    <div className="space-y-1.5">
                      {q.levels.map((l, i) => (
                        <div key={i} className="flex gap-1.5 items-center">
                          <span className="w-5 text-xs font-mono text-muted-foreground text-right">{i}</span>
                          <Input
                            value={l}
                            onChange={(e) => updateQuestion(q.uid, { levels: q.levels.map((x, j) => (j === i ? e.target.value : x)) })}
                            className="h-7 text-xs"
                            placeholder={t("clef.levelDesc")}
                          />
                          <button
                            onClick={() => { const lv = [...q.levels]; [lv[i - 1], lv[i]] = [lv[i]!, lv[i - 1]!]; updateQuestion(q.uid, { levels: lv }); }}
                            disabled={i === 0}
                            className="p-1 text-muted-foreground disabled:opacity-30"
                          >
                            <ArrowUp className="size-3" />
                          </button>
                          <button
                            onClick={() => { const lv = [...q.levels]; [lv[i], lv[i + 1]] = [lv[i + 1]!, lv[i]!]; updateQuestion(q.uid, { levels: lv }); }}
                            disabled={i === q.levels.length - 1}
                            className="p-1 text-muted-foreground disabled:opacity-30"
                          >
                            <ArrowDown className="size-3" />
                          </button>
                          <button
                            onClick={() => updateQuestion(q.uid, { levels: q.levels.filter((_, j) => j !== i) })}
                            disabled={q.levels.length <= 2}
                            className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                      {q.levels.length < 10 && (
                        <button onClick={() => updateQuestion(q.uid, { levels: [...q.levels, ""] })} className="text-xs text-primary hover:underline">
                          + {t("clef.addLevel")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex items-center gap-2 flex-wrap">
            {MODELS.map((m) => {
              const on = selectedModels.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedModels((prev) => (on ? (prev.length > 1 ? prev.filter((x) => x !== m.id) : prev) : [...prev, m.id]))}
                  title={`${m.media} · ${t("clef.contextWindow")} ${m.ctx}`}
                  className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border transition-colors text-left ${on ? "bg-orange-500/10 border-orange-400 text-orange-700 dark:text-orange-400" : "hover:bg-muted"}`}
                >
                  {on ? <Check className="size-3 shrink-0" /> : <span className="size-3 shrink-0" />}
                  <span>
                    <span className="block">{m.name} <span className="text-muted-foreground">{m.size}</span></span>
                    <span className="block text-[10px] text-muted-foreground">${m.pricePerM}/M · {m.ctx}</span>
                  </span>
                </button>
              );
            })}
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={copyCurl} disabled={Boolean(jsonError)}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {t("clef.copyCurl")}
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={run} disabled={running || Boolean(jsonError)}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {t("clef.run")}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        {/* ── Results ── */}
        <div className="min-w-0 space-y-3">
          {!results && !running && (
            <div className="h-full min-h-[200px] rounded-xl border border-dashed flex items-center justify-center text-sm text-muted-foreground p-6 text-center">
              {t("clef.emptyState")}
            </div>
          )}
          {running && (
            <div className="min-h-[200px] rounded-xl border flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("clef.running")}
            </div>
          )}
          {results && (
            <>
              {fastest && slowest && speedup && (
                <div className="flex items-center gap-2 text-xs rounded-lg bg-orange-500/10 text-orange-700 dark:text-orange-400 px-3 py-2">
                  <Zap className="size-3.5" />
                  {t("clef.speedup", { fast: fastest.name, slow: slowest.name, x: speedup.toFixed(1) })}
                </div>
              )}
              <div className={`grid gap-3 ${shownModels.length === 2 ? "sm:grid-cols-2" : shownModels.length > 2 ? "sm:grid-cols-2 xl:grid-cols-3" : ""}`}>
                {shownModels.map((m) => {
                  const r = results[m.id]!;
                  return (
                    <Card key={m.id} className="min-w-0">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                          {m.name}
                          <Badge variant="secondary" className="font-mono text-[10px]">@cf/cloudflare/{m.id}</Badge>
                        </CardTitle>
                        <div className="flex gap-1.5 flex-wrap text-[11px]">
                          <span className="px-2 py-0.5 rounded-md bg-muted">{r.latencyMs} ms</span>
                          {r.usage && <span className="px-2 py-0.5 rounded-md bg-muted">{r.usage.input_tokens} tokens</span>}
                          {r.usage && (
                            <span className="px-2 py-0.5 rounded-md bg-muted" title={t("clef.costTooltip", { price: m.pricePerM })}>
                              ≈ ${(r.usage.input_tokens * m.pricePerM).toFixed(2)} / 1M {t("clef.calls")}
                            </span>
                          )}
                          {r.via && <span className="px-2 py-0.5 rounded-md bg-muted">{r.via === "ai-gateway" ? "AI Gateway" : "REST"}</span>}
                        </div>
                        {r.ignoredMedia && (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">{t("clef.ignoredMedia")}</p>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {r.error ? (
                          <p className="text-sm text-destructive">{r.error}</p>
                        ) : (
                          questions.map((q) => {
                            const a = r.answers?.[q.id];
                            if (!a) return null;
                            const decisions = new Set(okModels.map((om) => decisionOf(results[om.id]?.answers?.[q.id])));
                            const disagree = okModels.length > 1 && decisions.size > 1;
                            return (
                              <div key={q.uid} className="space-y-1.5">
                                <div className="flex items-start gap-1.5">
                                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted shrink-0">{q.id}</span>
                                  <span className="text-xs font-medium flex-1">{q.instructions}</span>
                                  {disagree && (
                                    <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400 shrink-0" title={t("clef.disagreeTooltip")}>
                                      <AlertTriangle className="size-3" />
                                      {t("clef.disagree")}
                                    </span>
                                  )}
                                </div>
                                <AnswerView answer={a} question={q} />
                              </div>
                            );
                          })
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              <div>
                <button onClick={() => setShowRaw((v) => !v)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronRight className={`size-3 transition-transform ${showRaw ? "rotate-90" : ""}`} />
                  Raw JSON
                </button>
                {showRaw && (
                  <pre className="mt-1.5 p-3 rounded-lg bg-muted/50 text-[11px] font-mono overflow-auto max-h-[400px]">
                    {JSON.stringify(results, null, 2)}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
