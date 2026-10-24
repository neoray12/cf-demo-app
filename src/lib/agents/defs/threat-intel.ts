// Threat-intel agent — dispatcher flow (no root planning step):
//   t=0  dispatch (pure keyword rules, tools/threat-dispatch.ts) → in parallel: ONE Radar prefetch tool span and
//        `brief` (deterministic span) → the chosen analysts (invoke_agent, each ≤ 1 parallel tool round + finding)
//   then ONE root model call (no tools) writes the concise answer from the attached reports.
import type { UserLanguage } from "../language";
import { ctxLanguage, errorMessage, runParallel, runSubagent, runTracedTool, type AgentDef, type RunContext, type SubagentDef } from "../runtime";
import { buildRadarTools, runRadarTool, type RadarToolName, type RadarToolOutput } from "../tools/radar";
import { planRadarPrefetch, prefetchSummary, type RadarPrefetchPlan } from "../tools/radar-prefetch";
import { planDispatch, type AnalystKind, type DispatchPlan } from "../tools/threat-dispatch";

// step 0: ALL needed Radar tools as parallel calls; step 1: the finding; one spare step (the last one forces text)
const ANALYST_MAX_STEPS = 3;

interface AnalystInput {
  question: string;
  location: string;
  domain?: string;
  /** The question asks for a week-over-week comparison (from the dispatcher). */
  compareLastWeek?: boolean;
  /** Language of the finding (the user's). */
  language?: UserLanguage;
  /** Compact text of the prefetched Radar result (see prefetchSummary). */
  prefetched?: string;
  /**
   * The Radar prefetch still running in parallel: `prepare` waits for its summary (at most PREFETCH_WAIT_MS) inside
   * the analyst's span, so the analyst starts at once but still sees the prefetched numbers when they come in time.
   */
  pendingPrefetch?: Promise<string | undefined>;
}

/** What the threat-intel prefetch leaves in ctx.prefetched.data. */
export interface ThreatPrefetch {
  dispatch: DispatchPlan;
  plan: RadarPrefetchPlan;
  output: RadarToolOutput | undefined;
  reports: AnalystReport[];
  failed: Array<{ name: string; error: string }>;
}

export interface AnalystReport {
  analyst: AnalystKind;
  report: string;
}

/** How long an analyst waits (in its prepare) for the parallel Radar prefetch before querying on its own. */
export const PREFETCH_WAIT_MS = 5_000;

const UNIT_RULES =
  "每筆結果的 `unit` 欄位說明數字的意義，必須依 unit 描述：percent = 占比（%），不是次數；normalized = 0 到 1 的相對值，不是次數；mbps / ms = 實測的頻寬或延遲，不是占比；rank = 全球熱門度排名（數字越小越熱門）；events = 事件清單，可以說明事件數量。不可把占比或正規化值寫成「X 次」。";

const ANALYST_RULES = [
  "你是 Cloudflare Radar 的資安情資分析師，只能使用你手上的工具，並且只能引用工具回傳的數字，不可使用記憶中的數據或自行推算。",
  `你最多只有 ${ANALYST_MAX_STEPS} 個步驟：第一步在同一個步驟裡一次並行呼叫你需要的「所有」工具（多個 tool call 一起送出，只做一輪），工具回來後立刻寫發現，不要再補查。`,
  "若 prompt 說某個工具「已預先取得」，直接引用其中的數字，不要用相同參數再呼叫同一個工具（換參數或換工具是可以的）。",
  "描述每組數字時，必須照抄該工具回傳的 `scope` 與 `period`，不可改寫成別的意思。特別注意：「源自台灣」的攻擊是從台灣發出的攻擊，絕不能說成「台灣被攻擊」；「攻擊台灣的來源國家」才是針對台灣的攻擊。",
  UNIT_RULES,
  "若問題要求與上週比較，呼叫支援 compareLastWeek 的工具時設 compareLastWeek: true；比較時引用 `previous` 並寫出增減（占比的增減單位是百分點）。",
  "資料為空（data 與 events 都是空）時，明確寫「此期間無紀錄」，不要編造。工具回傳 `error` 時，如實說明該項查詢失敗。",
  "Radar 不提供單一產業在某國的被攻擊數字（例如「台灣金融業被攻擊幾次」）；被問到時說明做不到，只能提供全球產業排名占比。",
  "發現要極度精簡：不超過 150 個中文字（英文則不超過 100 words）加上關鍵數字（附單位與期間），最後附一個所用工具回傳的 sourceUrl；不要條列所有資料、不要寫前言或結語。",
  "輸出語言以 prompt 的「輸出語言」為準（使用者的語言），整份發現都要用該語言；產品名稱、代碼、網址保持原樣。",
].join("\n");

const OUTPUT_LANGUAGE: Record<UserLanguage, string> = {
  "zh-TW": "輸出語言：繁體中文",
  en: "輸出語言：English",
};

function analystPrompt({ question, location, domain, compareLastWeek, language, prefetched }: AnalystInput): string {
  return [
    `問題：${question}`,
    `location：${location}`,
    ...(domain ? [`domain：${domain}`] : []),
    ...(compareLastWeek ? ["與上週比較：是（支援的工具請設 compareLastWeek: true）"] : []),
    ...(language ? [OUTPUT_LANGUAGE[language]] : []),
    ...(prefetched ? ["", prefetched] : []),
  ].join("\n");
}

function makeAnalyst(functionId: string, focus: string, toolNames: RadarToolName[]): SubagentDef<AnalystInput> {
  return {
    functionId,
    model: "glm-5.3-flash", // the run's model (ctx.modelKey) overrides this
    maxSteps: ANALYST_MAX_STEPS,
    system: `${ANALYST_RULES}\n你的專長：${focus}`,
    tools: (ctx) => buildRadarTools(ctx, toolNames),
    prompt: analystPrompt,
    prepare: async ({ pendingPrefetch }) => {
      if (!pendingPrefetch) return "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), PREFETCH_WAIT_MS)));
      try {
        return (await Promise.race([pendingPrefetch.catch(() => undefined), timeout])) ?? "";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const attackAnalyst = makeAnalyst("attack-analyst", "應用層與網路層攻擊（攻擊來源、攻擊目標、緩解手法、受攻擊產業、趨勢）。", [
  "attackers_of",
  "attack_targets_from",
  "l7_attacks_from",
  "l3_attacks_mitigated_in",
  "top_attacked_industries",
  "l7_attack_trend_from",
]);

export const networkAnalyst = makeAnalyst("network-analyst", "網路可用性與路由安全（中斷事件、流量異常、BGP 劫持、網路品質）。", [
  "outages",
  "traffic_anomalies",
  "bgp_hijacks",
  "internet_quality",
]);

export const botAnalyst = makeAnalyst("bot-analyst", "機器人與郵件威脅（人類/機器人占比、AI 爬蟲、惡意郵件、網域排名）。", [
  "bot_vs_human",
  "ai_crawlers",
  "email_threats",
  "domain_rank",
]);

const ANALYSTS = { attack: attackAnalyst, network: networkAnalyst, bot: botAnalyst } as const;

/**
 * Run the dispatcher's analysts in parallel as subagents under `parentSpanId` (the `brief` span). An analyst that
 * fails (after its one retry) or returns no text is reported in `failed`.
 */
export async function dispatchAnalysts(
  ctx: RunContext,
  parentSpanId: string,
  plan: DispatchPlan,
  question: string,
  pendingPrefetch?: Promise<string | undefined>,
): Promise<{ reports: AnalystReport[]; failed: Array<{ name: string; error: string }> }> {
  const keys = [...new Set(plan.analysts)];
  const input: AnalystInput = {
    question,
    location: plan.location,
    ...(plan.domain ? { domain: plan.domain } : {}),
    ...(plan.compareLastWeek ? { compareLastWeek: true } : {}),
    language: ctxLanguage(ctx),
    ...(pendingPrefetch ? { pendingPrefetch } : {}),
  };
  const { ok, failed } = await runParallel(
    keys.map((key, i) => ({ name: key, run: () => runSubagent(ANALYSTS[key], input, ctx, parentSpanId, i) })),
  );
  const reports = ok.filter((r) => r.value.text.trim() !== "").map((r) => ({ analyst: r.name as AnalystKind, report: r.value.text }));
  const empty = ok.filter((r) => r.value.text.trim() === "").map((r) => ({ name: r.name, error: "no report within the step limit" }));
  return { reports, failed: [...failed, ...empty] };
}

const ANALYST_LABEL: Record<AnalystKind, string> = { attack: "attack-analyst", network: "network-analyst", bot: "bot-analyst" };

/** The analysts' reports (+ the prefetched Radar summary) as the root's system-prompt context. */
export function threatPrefetchContext(
  plan: DispatchPlan,
  result: { reports: AnalystReport[]; failed: Array<{ name: string; error: string }> },
  radarSummary: string | undefined,
): string {
  const head = `【分析師報告】系統依問題派出：${plan.analysts.map((a) => ANALYST_LABEL[a]).join("、")}；location：${plan.location}${
    plan.compareLastWeek ? "；與上週比較：是" : ""
  }${plan.domain ? `；domain：${plan.domain}` : ""}`;
  const reports =
    result.reports.length > 0
      ? result.reports.map((r) => `### ${ANALYST_LABEL[r.analyst]}\n${r.report.trim()}`).join("\n\n")
      : "（沒有任何分析師回報結果）";
  const failed =
    result.failed.length > 0
      ? `\n\n【failed：沒有結果的分析師】${result.failed.map((f) => `${f.name}（${f.error}）`).join("；")}`
      : "";
  const radar = radarSummary ? `\n\n【預先查詢的 Radar 資料】\n${radarSummary}` : "";
  return `${head}\n\n${reports}${failed}${radar}`;
}

export const threatIntelAgent: AgentDef = {
  id: "threat-intel",
  functionId: "threat-intel-agent",
  defaultModel: "glm-5.3-flash",
  // The dispatcher + analysts run in the (awaited) prefetch; the root only writes the answer: ONE model call.
  maxSteps: 1,
  system: () =>
    [
      "你是「資安情資分析師」，根據 Cloudflare Radar 的真實資料回答問題，預設地區為台灣（TW）。",
      "系統已依問題自動派出 Radar 分析師並行查詢，他們的報告附在最後的【分析師報告】。你沒有任何工具，只需要根據這些報告寫最終答案；不要寫計畫句，也不要說明你要派誰或要查什麼。",
      "只能依據分析師報告中的數字作答，不要憑空補充。照抄報告中的範圍描述（scope）：「源自台灣」是從台灣發出的攻擊，不是台灣被攻擊；「攻擊台灣的來源國家」才是針對台灣的攻擊。數字的意義依各筆結果的 `unit` 欄位：percent 是占比而非次數；normalized 是 0–1 相對值而非次數；mbps / ms 是實測頻寬與延遲；rank 是全球排名（越小越熱門）；events 是事件清單，可以說明事件數量。",
      "Radar 不提供單一產業在某國的被攻擊次數或占比（例如「台灣金融業被攻擊幾次」）；遇到這類問題要明說 Radar 沒有這個數字，只能提供全球產業排名占比，不要用其他數字替代。資料為空就說「此期間無紀錄」。報告沒有涵蓋使用者問到的某個面向時，簡短說明沒有該資料。",
      "最終答案必須精簡：",
      "- 文字總共不超過 350 個中文字（英文不超過 220 words）：先給一句結論，再補關鍵數字、範圍與單位；",
      "- 最多一個精簡表格（列出最重要的 3–6 列，含單位與期間），不要寫長篇報告、不要多段條列、不要重述分析師的全部內容；",
      "- 最後附 Radar 來源連結（用報告中的 sourceUrl）。",
      "請完全用使用者提問的語言作答：把分析師的發現翻譯整合成該語言，不要貼上未翻譯的段落；產品名稱、程式碼與網址保持原樣。",
      "如果報告附有【failed：沒有結果的分析師】，必須在回答中註明哪些分析師沒有結果。",
    ].join("\n"),
  tools: () => ({}),
  // t=0, awaited: `dispatch` (keyword rules) → in parallel the single Radar prefetch (`{root}/prefetch`, its chart
  // shows up within ~2 s) and `brief` (`{root}/brief`) whose children are the analysts' invoke_agent spans. The
  // analysts start at once; each waits ≤ PREFETCH_WAIT_MS in its own span for the prefetch summary.
  prefetch: async (ctx, rootSpanId, userText) => {
    const question = userText.trim();
    const dispatch = await runTracedTool(ctx, rootSpanId, "dispatch", { question }, async () => planDispatch(question), {
      callId: "dispatch",
    });
    const plan = planRadarPrefetch(question);
    const radar = runTracedTool(
      ctx,
      rootSpanId,
      plan.tool,
      plan.input,
      (toolId) => runRadarTool(ctx, plan.tool, plan.input, toolId),
      { callId: "prefetch", failed: (o) => ("error" in o ? o.error : undefined) },
    ).catch(() => undefined);
    const summary = radar.then((output) => prefetchSummary(plan, output));
    const result = await runTracedTool(
      ctx,
      rootSpanId,
      "brief",
      { question, ...dispatch },
      (briefId) => dispatchAnalysts(ctx, briefId, dispatch, question, summary),
      { callId: "brief", failed: (r) => (r.reports.length === 0 ? "no analyst report" : undefined) },
    ).catch((err) => ({ reports: [] as AnalystReport[], failed: [{ name: "brief", error: errorMessage(err) }] }));
    const output = await radar;
    const radarSummary = await summary;
    return {
      context: threatPrefetchContext(dispatch, result, radarSummary),
      data: { dispatch, plan, output, ...result } satisfies ThreatPrefetch,
    };
  },
  prefetchMode: "await",
};
