import { tool } from "ai";
import { z } from "zod";
import type { UserLanguage } from "../language";
import {
  ctxLanguage,
  errorMessage,
  runParallel,
  runSubagent,
  runTracedTool,
  type AgentDef,
  type RunContext,
  type SubagentDef,
} from "../runtime";
import { buildRadarTools, normalizeLocation, runRadarTool, type RadarToolName, type RadarToolOutput } from "../tools/radar";
import { planRadarPrefetch, prefetchSummary, type RadarPrefetchPlan } from "../tools/radar-prefetch";

// step 0: ALL needed Radar tools as parallel calls; step 1: the finding; one spare step (the last one forces text)
const ANALYST_MAX_STEPS = 3;

interface AnalystInput {
  question: string;
  location: string;
  domain?: string;
  /** Language of the finding (the user's). */
  language?: UserLanguage;
  /** Compact text of the prefetched Radar result (see prefetchSummary). */
  prefetched?: string;
}

/** What the threat-intel prefetch leaves in ctx.prefetched.data. */
interface ThreatPrefetch {
  plan: RadarPrefetchPlan;
  output: RadarToolOutput | undefined;
}

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

function analystPrompt({ question, location, domain, language, prefetched }: AnalystInput): string {
  return [
    `問題：${question}`,
    `location：${location}`,
    ...(domain ? [`domain：${domain}`] : []),
    ...(language ? [OUTPUT_LANGUAGE[language]] : []),
    ...(prefetched ? ["", prefetched] : []),
  ].join("\n");
}

function makeAnalyst(functionId: string, focus: string, toolNames: RadarToolName[]): SubagentDef<AnalystInput> {
  return {
    functionId,
    model: "kimi-k2.6", // the run's model (ctx.modelKey) overrides this
    maxSteps: ANALYST_MAX_STEPS,
    system: `${ANALYST_RULES}\n你的專長：${focus}`,
    tools: (ctx) => buildRadarTools(ctx, toolNames),
    prompt: analystPrompt,
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
type AnalystKey = keyof typeof ANALYSTS;

function threatIntelTools(ctx: RunContext) {
  return {
    brief: tool({
      description:
        "Dispatch 1-3 Radar analysts IN PARALLEL and return their reports. 在呼叫此工具前，先用一句話告訴使用者你要派哪些分析師。 attack = attack sources/targets/mitigations/industries/trend; network = outages, traffic anomalies, BGP hijacks, internet quality; bot = bot vs human, AI crawlers, malicious email, domain rank.",
      inputSchema: z.object({
        question: z.string().min(1).describe("The user's question, self-contained"),
        analysts: z.array(z.enum(["attack", "network", "bot"])).min(1).max(3).describe("Which analysts to dispatch"),
        location: z.string().optional().describe("ISO 3166-1 alpha-2 country code, default TW"),
        domain: z.string().optional().describe("Domain for the bot analyst's domain_rank, e.g. example.com"),
      }),
      execute: async ({ question, analysts, location, domain }, options) => {
        let loc: string;
        try {
          loc = normalizeLocation(location);
        } catch (err) {
          return { error: errorMessage(err), reports: [], failed: [] };
        }
        const keys = [...new Set(analysts)] as AnalystKey[];
        // The t=0 prefetch (never rejects) is handed to the analysts as text so they don't repeat it.
        const pre = ctx.prefetched ? ((await ctx.prefetched).data as ThreatPrefetch | undefined) : undefined;
        const input: AnalystInput = {
          question,
          location: loc,
          ...(domain ? { domain } : {}),
          language: ctxLanguage(ctx),
          ...(pre ? { prefetched: prefetchSummary(pre.plan, pre.output) } : {}),
        };
        const { ok, failed } = await runParallel(
          keys.map((key, i) => ({
            name: key,
            run: () => runSubagent(ANALYSTS[key], input, ctx, options.toolCallId, i),
          })),
        );
        // An analyst that spent all its steps on tool calls returns no text: report it as failed.
        const reports = ok.filter((r) => r.value.text.trim() !== "").map((r) => ({ analyst: r.name, report: r.value.text }));
        const empty = ok
          .filter((r) => r.value.text.trim() === "")
          .map((r) => ({ name: r.name, error: "no report within the step limit" }));
        return { reports, failed: [...failed, ...empty] };
      },
    }),
  };
}

export const threatIntelAgent: AgentDef = {
  id: "threat-intel",
  functionId: "threat-intel-agent",
  defaultModel: "kimi-k2.6",
  // step 0: plan + brief; step 1: answer; one spare step (R23 forces the answer on the last one)
  maxSteps: 3,
  system: () =>
    [
      "你是「資安情資分析師」，根據 Cloudflare Radar 的真實資料回答問題，預設地區為台灣（TW）。",
      "【第一步】在呼叫任何工具之前，先用使用者提問的語言寫一句簡短的計畫，說明你會派哪幾位分析師（例如：「我會派攻擊分析師與網路分析師，分別查攻擊來源和近期斷網事件。」），然後才呼叫 brief。這一句話不要超過 40 字，之後不要再重複。",
      "用 brief 一次派出分析師（並行；通常 1–2 位就夠，越少越快）：attack = 攻擊來源/目標/緩解手法/受攻擊產業/趨勢；network = 斷網、流量異常、BGP 劫持、網路品質；bot = 人類與機器人占比、AI 爬蟲、惡意郵件、網域排名。只挑問題需要的分析師。使用者指定國家時帶 location（ISO 兩碼），問到某個網域時帶 domain；問「跟上週比」就要讓攻擊分析師做週對週比較。系統已在一開始預先查好最相關的一個 Radar 工具並交給分析師，他們不會重複查。",
      "只能依據分析師報告中的數字作答，不要憑空補充。照抄報告中的範圍描述（scope）：「源自台灣」是從台灣發出的攻擊，不是台灣被攻擊；「攻擊台灣的來源國家」才是針對台灣的攻擊。數字的意義依各筆結果的 `unit` 欄位：percent 是占比而非次數；normalized 是 0–1 相對值而非次數；mbps / ms 是實測頻寬與延遲；rank 是全球排名（越小越熱門）；events 是事件清單，可以說明事件數量。",
      "Radar 不提供單一產業在某國的被攻擊次數或占比（例如「台灣金融業被攻擊幾次」）；遇到這類問題要明說 Radar 沒有這個數字，只能提供全球產業排名占比，不要用其他數字替代。資料為空就說「此期間無紀錄」。",
      "brief 回傳後直接整合作答，不要再呼叫 brief。最終答案必須精簡：",
      "- 文字總共不超過 350 個中文字（英文不超過 220 words）：先給一句結論，再補關鍵數字、範圍與單位；",
      "- 最多一個精簡表格（列出最重要的 3–6 列，含單位與期間），不要寫長篇報告、不要多段條列、不要重述分析師的全部內容；",
      "- 最後附 Radar 來源連結（用報告中的 sourceUrl）。",
      "請完全用使用者提問的語言作答：把分析師的發現翻譯整合成該語言，不要貼上未翻譯的段落；產品名稱、程式碼與網址保持原樣。",
      "如果 brief 的 failed 不是空的，必須在回答中註明哪些分析師沒有結果。",
    ].join("\n"),
  tools: threatIntelTools,
  // t=0: ONE Radar tool picked by keywords, as a traced tool span under the root, so its chip and chart appear at
  // once. Background: the root's first model call doesn't wait; `brief` awaits it and passes it to the analysts.
  prefetch: async (ctx, rootSpanId, userText) => {
    const plan = planRadarPrefetch(userText);
    const output = await runTracedTool(
      ctx,
      rootSpanId,
      plan.tool,
      plan.input,
      (toolId) => runRadarTool(ctx, plan.tool, plan.input, toolId),
      { callId: "prefetch", failed: (o) => ("error" in o ? o.error : undefined) },
    );
    return { data: { plan, output } satisfies ThreatPrefetch };
  },
  prefetchMode: "background",
};
