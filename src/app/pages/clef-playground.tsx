'use client';

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  ImagePlus,
  Loader2,
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

// ── Types ──

type QuestionType = "noul" | "choice" | "score";
type ClefModel = "clef" | "clef-flash";

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
  error?: string;
}

// ── Presets (bilingual, the state text is what the model evaluates) ──

type L10n = { zh: string; en: string };
interface PresetQuestion {
  id: string;
  type: QuestionType;
  instructions: L10n;
  options?: Array<{ key: string; desc: L10n }>;
  levels?: L10n[];
}
interface Preset {
  key: string;
  json?: boolean;
  vision?: boolean;
  state: L10n;
  questions: PresetQuestion[];
}

const PRESETS: Preset[] = [
  {
    key: "triage",
    state: {
      zh: "過去一小時所有客戶在結帳頁面都失敗，畫面顯示 502 錯誤。我們的黑色星期五活動今晚就要上線，請立刻處理！",
      en: "Checkout has been failing for every customer for the last hour with a 502 error. Our Black Friday campaign goes live tonight, please fix this now!",
    },
    questions: [
      { id: "urgent", type: "noul", instructions: { zh: "這個支援請求緊急嗎？", en: "Is this support request urgent?" } },
      {
        id: "team",
        type: "choice",
        instructions: { zh: "應該由哪個團隊處理？", en: "Which team should handle this request?" },
        options: [
          { key: "billing", desc: { zh: "付款、發票與退款", en: "Payments, invoices, and refunds" } },
          { key: "technical", desc: { zh: "服務中斷、錯誤與設定", en: "Outages, errors, and configuration" } },
          { key: "sales", desc: { zh: "方案與升級", en: "Plans and upgrades" } },
        ],
      },
      {
        id: "severity",
        type: "score",
        instructions: { zh: "對客戶的影響有多嚴重？", en: "How severe is the customer impact?" },
        levels: [
          { zh: "無影響", en: "No impact" },
          { zh: "輕微", en: "Minor" },
          { zh: "嚴重", en: "Major" },
          { zh: "重大", en: "Critical" },
        ],
      },
    ],
  },
  {
    key: "phishing",
    state: {
      zh: "寄件者：security@paypa1-support.com\n主旨：【緊急】您的帳戶已被暫停\n\n親愛的用戶，我們偵測到異常登入，您的帳戶將在 24 小時內永久停用。請立即點擊以下連結驗證身分並輸入信用卡資料：http://paypa1-verify.xyz/login",
      en: "From: security@paypa1-support.com\nSubject: [URGENT] Your account has been suspended\n\nDear user, we detected unusual sign-in activity and your account will be permanently disabled within 24 hours. Click the link below immediately to verify your identity and enter your credit card details: http://paypa1-verify.xyz/login",
    },
    questions: [
      { id: "phishing", type: "noul", instructions: { zh: "這封郵件是釣魚郵件嗎？", en: "Is this email a phishing attempt?" } },
      {
        id: "tactic",
        type: "choice",
        instructions: { zh: "主要使用的社交工程手法是什麼？", en: "What is the primary social-engineering tactic?" },
        options: [
          { key: "urgency", desc: { zh: "製造急迫感", en: "Creating urgency" } },
          { key: "impersonation", desc: { zh: "冒充品牌或機構", en: "Brand or authority impersonation" } },
          { key: "reward", desc: { zh: "利誘獎賞", en: "Promise of a reward" } },
          { key: "none", desc: { zh: "無明顯手法", en: "No clear tactic" } },
        ],
      },
      {
        id: "action",
        type: "choice",
        instructions: { zh: "郵件閘道應採取什麼動作？", en: "What should the email gateway do?" },
        options: [
          { key: "deliver", desc: { zh: "正常投遞", en: "Deliver normally" } },
          { key: "warn", desc: { zh: "加上警告標籤後投遞", en: "Deliver with a warning banner" } },
          { key: "quarantine", desc: { zh: "隔離", en: "Quarantine" } },
        ],
      },
    ],
  },
  {
    key: "moderation",
    state: {
      zh: "這家餐廳的服務生態度超爛，我等了一小時才上菜。老闆你最好小心點，下次再這樣我就讓你好看。",
      en: "The waiter at this restaurant was terrible and I waited an hour for my food. Owner, you'd better watch out — if this happens again I'll make you regret it.",
    },
    questions: [
      { id: "toxic", type: "noul", instructions: { zh: "這則留言含有不當或有害內容嗎？", en: "Does this comment contain toxic or harmful content?" } },
      {
        id: "category",
        type: "choice",
        instructions: { zh: "最符合的內容類別是？", en: "Which content category fits best?" },
        options: [
          { key: "complaint", desc: { zh: "一般抱怨", en: "Ordinary complaint" } },
          { key: "harassment", desc: { zh: "騷擾或人身攻擊", en: "Harassment or personal attack" } },
          { key: "threat", desc: { zh: "威脅", en: "Threat" } },
          { key: "hate", desc: { zh: "仇恨言論", en: "Hate speech" } },
        ],
      },
      {
        id: "action",
        type: "choice",
        instructions: { zh: "平台應如何處理？", en: "How should the platform handle it?" },
        options: [
          { key: "publish", desc: { zh: "直接發布", en: "Publish" } },
          { key: "review", desc: { zh: "送人工審核", en: "Send to human review" } },
          { key: "remove", desc: { zh: "移除", en: "Remove" } },
        ],
      },
    ],
  },
  {
    key: "judge",
    json: true,
    state: {
      zh: JSON.stringify(
        {
          question: "Cloudflare Workers 的 CPU 時間上限是多少？",
          answer: "Workers 付費方案預設每個請求 30 秒 CPU 時間，可設定到最多 5 分鐘；免費方案為 10 毫秒。",
        },
        null,
        2
      ),
      en: JSON.stringify(
        {
          question: "What is the CPU time limit for Cloudflare Workers?",
          answer: "On the Workers Paid plan the default is 30 seconds of CPU time per request, configurable up to 5 minutes; the Free plan allows 10 ms.",
        },
        null,
        2
      ),
    },
    questions: [
      {
        id: "correctness",
        type: "score",
        instructions: { zh: "回答的正確性", en: "How correct is the answer?" },
        levels: [
          { zh: "錯誤", en: "Wrong" },
          { zh: "部分正確", en: "Partially correct" },
          { zh: "大致正確", en: "Mostly correct" },
          { zh: "完全正確", en: "Fully correct" },
        ],
      },
      {
        id: "completeness",
        type: "score",
        instructions: { zh: "回答的完整度", en: "How complete is the answer?" },
        levels: [
          { zh: "不完整", en: "Incomplete" },
          { zh: "普通", en: "Adequate" },
          { zh: "完整", en: "Complete" },
        ],
      },
      { id: "hallucination", type: "noul", instructions: { zh: "回答中是否有捏造的內容？", en: "Does the answer contain fabricated information?" } },
    ],
  },
  {
    key: "vision",
    vision: true,
    state: {
      zh: "請根據附上的網頁截圖判斷。",
      en: "Judge based on the attached web page screenshot.",
    },
    questions: [
      {
        id: "page_type",
        type: "choice",
        instructions: { zh: "這是哪一種網頁？", en: "What kind of page is this?" },
        options: [
          { key: "landing", desc: { zh: "產品/行銷首頁", en: "Product or marketing landing page" } },
          { key: "login", desc: { zh: "登入頁", en: "Login page" } },
          { key: "docs", desc: { zh: "技術文件", en: "Documentation" } },
          { key: "error", desc: { zh: "錯誤頁", en: "Error page" } },
          { key: "dashboard", desc: { zh: "後台儀表板", en: "Dashboard" } },
        ],
      },
      { id: "has_form", type: "noul", instructions: { zh: "頁面上是否有可輸入的表單？", en: "Does the page contain an input form?" } },
      {
        id: "design",
        type: "score",
        instructions: { zh: "視覺設計品質", en: "Visual design quality" },
        levels: [
          { zh: "差", en: "Poor" },
          { zh: "普通", en: "Average" },
          { zh: "良好", en: "Good" },
          { zh: "優秀", en: "Excellent" },
        ],
      },
    ],
  },
];

const MODELS: Array<{ id: ClefModel; name: string; size: string }> = [
  { id: "clef", name: "Clef", size: "27B" },
  { id: "clef-flash", name: "Clef-flash", size: "9B" },
];

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

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
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-28 shrink-0 truncate ${highlight ? "font-semibold" : "text-muted-foreground"}`} title={label}>{label}</span>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${highlight ? "bg-primary" : "bg-muted-foreground/40"}`} style={{ width: `${Math.max(value * 100, 1)}%` }} />
      </div>
      <span className={`w-12 text-right font-mono ${highlight ? "font-semibold" : "text-muted-foreground"}`}>{pct(value)}</span>
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
  const [images, setImages] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<ClefModel[]>(["clef", "clef-flash"]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<ClefModel, ModelResult>> | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const jsonError = useMemo(() => {
    if (!stateIsJson) return null;
    try { JSON.parse(state); return null; } catch (e) { return (e as Error).message; }
  }, [state, stateIsJson]);

  const loadPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    const d = presetToDraft(p, lang);
    setPresetKey(key);
    setState(d.state);
    setStateIsJson(Boolean(p.json));
    setQuestions(d.questions);
    setImages([]);
    setResults(null);
    setError(null);
  };

  const updateQuestion = (u: string, patch: Partial<DraftQuestion>) =>
    setQuestions((qs) => qs.map((q) => (q.uid === u ? { ...q, ...patch } : q)));

  const addImages = useCallback(async (files: File[]) => {
    setError(null);
    const accepted: string[] = [];
    for (const f of files) {
      if (!ALLOWED_IMAGE_TYPES.includes(f.type)) { setError(t("clef.errors.imageType")); continue; }
      if (f.size > MAX_IMAGE_BYTES) { setError(t("clef.errors.imageSize")); continue; }
      accepted.push(await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(f);
      }));
    }
    setImages((prev) => {
      const next = [...prev, ...accepted];
      if (next.length > MAX_IMAGES) setError(t("clef.errors.imageCount", { max: MAX_IMAGES }));
      return next.slice(0, MAX_IMAGES);
    });
  }, [t]);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); void addImages(files); }
  };

  const buildRequest = () => ({
    state: stateIsJson ? JSON.parse(state) : state,
    questions: toApiQuestions(questions),
    ...(images.length ? { images } : {}),
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
    const model = selectedModels[0] ?? "clef";
    const body = { model, ...req, ...(req.images ? { images: req.images.map(() => "data:image/png;base64,<...>") } : {}) };
    const curl = `curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/${model} \\\n  -X POST \\\n  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\\n  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
    await navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shownModels = MODELS.filter((m) => results?.[m.id]);
  const both = results?.clef && results?.["clef-flash"] && !results.clef.error && !results["clef-flash"].error;
  const speedup = both ? results!.clef!.latencyMs / Math.max(results!["clef-flash"]!.latencyMs, 1) : null;
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
            <CardContent className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => loadPreset(p.key)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                    presetKey === p.key ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"
                  }`}
                >
                  {t(`clef.presets.${p.key}`)}
                </button>
              ))}
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
                {images.map((src, i) => (
                  <div key={i} className="relative">
                    <img src={src} alt="" className="size-16 object-cover rounded-md border" />
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
                    className={`size-16 rounded-md border border-dashed flex flex-col items-center justify-center text-[10px] text-muted-foreground hover:bg-muted ${preset?.vision && !images.length ? "border-orange-400 text-orange-600" : ""}`}
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
                  className={`inline-flex items-center gap-1.5 text-xs px-3 h-8 rounded-lg border transition-colors ${on ? "bg-orange-500/10 border-orange-400 text-orange-700 dark:text-orange-400" : "hover:bg-muted"}`}
                >
                  {on ? <Check className="size-3" /> : <span className="size-3" />}
                  {m.name} <span className="text-muted-foreground">{m.size}</span>
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
              {speedup && (
                <div className="flex items-center gap-2 text-xs rounded-lg bg-orange-500/10 text-orange-700 dark:text-orange-400 px-3 py-2">
                  <Zap className="size-3.5" />
                  {t("clef.speedup", { x: speedup.toFixed(1) })}
                </div>
              )}
              <div className={`grid gap-3 ${shownModels.length > 1 ? "md:grid-cols-2" : ""}`}>
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
                          {r.via && <span className="px-2 py-0.5 rounded-md bg-muted">{r.via === "ai-gateway" ? "AI Gateway" : "REST"}</span>}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {r.error ? (
                          <p className="text-sm text-destructive">{r.error}</p>
                        ) : (
                          questions.map((q) => {
                            const a = r.answers?.[q.id];
                            if (!a) return null;
                            const other = m.id === "clef" ? results["clef-flash"] : results.clef;
                            const disagree = both && decisionOf(a) !== decisionOf(other?.answers?.[q.id]);
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
