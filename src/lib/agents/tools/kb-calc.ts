// Rule calculators for the knowledge base's read-only `default` workspace (the fictional 雲朵科技 sample docs in
// scripts/seed-kb/). The numbers below are copied from those docs; the model calls these tools instead of doing
// arithmetic itself, and every result carries the rule text it applied and the source filename to cite.
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const HANDBOOK = "employee-handbook.md";
export const TRAVEL = "travel-expense.md";

export type CalcError = { error: string; source: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// 特別休假 (employee-handbook.md「特別休假（特休）」)

const LEAVE_RULE =
  "特休依年資計算，到職滿 6 個月起享有：滿 6 個月未滿 1 年 3 天；滿 1 年未滿 2 年 7 天；滿 2 年未滿 3 年 10 天；滿 3 年未滿 5 年 14 天；滿 5 年未滿 10 年 15 天；滿 10 年以上每年加 1 天，最多 30 天。";

/** [minimum seniority in months, days, bracket label] — employee-handbook.md table. */
const LEAVE_TABLE: Array<[number, number, string]> = [
  [6, 3, "滿 6 個月未滿 1 年"],
  [12, 7, "滿 1 年未滿 2 年"],
  [24, 10, "滿 2 年未滿 3 年"],
  [36, 14, "滿 3 年未滿 5 年"],
  [60, 15, "滿 5 年未滿 10 年"],
];
const LEAVE_MAX_DAYS = 30;
const MAX_SENIORITY_MONTHS = 60 * 12;

export interface AnnualLeaveResult {
  days: number;
  seniority: string;
  bracket: string;
  rule: string;
  source: string;
  note?: string;
}

export function calcAnnualLeave({ years, months = 0 }: { years: number; months?: number }): AnnualLeaveResult | CalcError {
  if (!Number.isFinite(years) || !Number.isFinite(months) || years < 0 || months < 0) {
    return { error: "年資必須是 ≥ 0 的數字（years、months）", source: HANDBOOK };
  }
  const total = Math.floor(years * 12 + months + 1e-9);
  if (total > MAX_SENIORITY_MONTHS) return { error: "年資超出可計算範圍（最多 60 年）", source: HANDBOOK };
  const seniority = `${Math.floor(total / 12)} 年 ${total % 12} 個月`;
  if (total < 6) {
    return { days: 0, seniority, bracket: "未滿 6 個月", rule: LEAVE_RULE, source: HANDBOOK, note: "到職滿 6 個月起才享有特休。" };
  }
  if (total >= 120) {
    const fullYears = Math.floor(total / 12);
    const days = Math.min(15 + (fullYears - 9), LEAVE_MAX_DAYS);
    return {
      days,
      seniority,
      bracket: "滿 10 年以上",
      rule: LEAVE_RULE,
      source: HANDBOOK,
      note: `以「滿 5 年未滿 10 年 15 天」為基礎，滿 10 年起每滿 1 年加 1 天（滿 ${fullYears} 年 = 15 + ${fullYears - 9}），上限 ${LEAVE_MAX_DAYS} 天。`,
    };
  }
  const row = [...LEAVE_TABLE].reverse().find(([min]) => total >= min)!;
  return { days: row[1], seniority, bracket: row[2], rule: LEAVE_RULE, source: HANDBOOK };
}

// ---------------------------------------------------------------------------
// 加班費 (employee-handbook.md「加班與加班費」)

export type DayType = "weekday" | "rest_day" | "holiday";

const OVERTIME_RULES: Record<DayType, string> = {
  weekday: "平日延長工時：前 2 小時按 1.34 倍，第 3 至第 4 小時按 1.67 倍（加班費依平日每小時工資額計算）。",
  rest_day: "休息日：前 2 小時按 1.34 倍，第 3 至第 8 小時按 1.67 倍，第 9 小時起按 2.67 倍（加班費依平日每小時工資額計算）。",
  holiday: "國定假日出勤：加倍發給當日工資。",
};

/** [hours in this tier, multiplier] — from employee-handbook.md. */
const OVERTIME_TIERS: Record<Exclude<DayType, "holiday">, Array<[number, number]>> = {
  weekday: [
    [2, 1.34],
    [2, 1.67],
  ],
  rest_day: [
    [2, 1.34],
    [6, 1.67],
    [Number.POSITIVE_INFINITY, 2.67],
  ],
};
/** The handbook only defines weekday overtime up to the 4th hour. */
const WEEKDAY_MAX_HOURS = 4;
/** Not in the handbook: a sanity bound for one rest day (8 + 4 hours). */
const REST_DAY_MAX_HOURS = 12;
const HOLIDAY_MAX_HOURS = 8;
export const MONTHLY_OVERTIME_CAP_HOURS = 46;

const HOURLY_ASSUMPTION =
  "手冊只寫「依平日每小時工資額計算」，沒有定義時薪算法；此處採勞基法慣例：平日每小時工資額 = 月薪 ÷ 30 ÷ 8（= 月薪 ÷ 240）。";

export interface OvertimeResult {
  dayType: DayType;
  hours: number;
  hourlyWage: number;
  breakdown: Array<{ hours: number; multiplier: number; amount: number }>;
  /** Overtime pay in NT$, rounded to 2 decimals. */
  pay: number;
  /** Rounded to whole NT$. */
  payRounded: number;
  rule: string;
  source: string;
  assumption?: string;
  notes: string[];
}

export function calcOvertimePay(input: {
  monthly_salary: number;
  hours: number;
  day_type: DayType;
  hourly_wage?: number;
}): OvertimeResult | CalcError {
  const { monthly_salary: salary, hours, day_type: dayType, hourly_wage: given } = input;
  if (!Number.isFinite(salary) || salary <= 0) return { error: "月薪必須是大於 0 的數字", source: HANDBOOK };
  if (!Number.isFinite(hours) || hours <= 0) return { error: "加班時數必須大於 0", source: HANDBOOK };
  if (given !== undefined && (!Number.isFinite(given) || given <= 0)) return { error: "時薪必須是大於 0 的數字", source: HANDBOOK };
  if (!(dayType in OVERTIME_RULES)) return { error: "day_type 必須是 weekday、rest_day 或 holiday", source: HANDBOOK };
  const notes = [`每月加班總時數上限為 ${MONTHLY_OVERTIME_CAP_HOURS} 小時；員工可選擇領加班費或換補休（6 個月內休完）。`];
  const hourlyWage = round2(given ?? salary / 240);
  const assumption = given === undefined ? HOURLY_ASSUMPTION : undefined;

  if (dayType === "holiday") {
    if (hours > HOLIDAY_MAX_HOURS) {
      return { error: `手冊只規定國定假日出勤「加倍發給當日工資」，沒有超過 ${HOLIDAY_MAX_HOURS} 小時的計算方式`, source: HANDBOOK };
    }
    const daily = round2(salary / 30);
    return {
      dayType,
      hours,
      hourlyWage,
      breakdown: [{ hours, multiplier: 1, amount: daily }],
      pay: daily,
      payRounded: Math.round(daily),
      rule: OVERTIME_RULES.holiday,
      source: HANDBOOK,
      assumption: "「加倍發給當日工資」解讀為：除原本的當日工資外，再加發 1 日工資；日薪 = 月薪 ÷ 30（勞基法慣例，手冊未定義）。",
      notes,
    };
  }

  const max = dayType === "weekday" ? WEEKDAY_MAX_HOURS : REST_DAY_MAX_HOURS;
  if (hours > max) {
    return {
      error:
        dayType === "weekday"
          ? `手冊只規定平日加班前 ${WEEKDAY_MAX_HOURS} 小時的倍率（前 2 小時 1.34 倍、第 3–4 小時 1.67 倍），無法計算超過 ${WEEKDAY_MAX_HOURS} 小時`
          : `休息日加班超過 ${REST_DAY_MAX_HOURS} 小時不在計算範圍`,
      source: HANDBOOK,
    };
  }
  const breakdown: OvertimeResult["breakdown"] = [];
  let left = hours;
  for (const [tierHours, multiplier] of OVERTIME_TIERS[dayType]) {
    if (left <= 0) break;
    const h = Math.min(left, tierHours);
    breakdown.push({ hours: h, multiplier, amount: round2(h * hourlyWage * multiplier) });
    left -= h;
  }
  const pay = round2(breakdown.reduce((s, b) => s + b.amount, 0));
  return {
    dayType,
    hours,
    hourlyWage,
    breakdown,
    pay,
    payRounded: Math.round(pay),
    rule: OVERTIME_RULES[dayType],
    source: HANDBOOK,
    ...(assumption ? { assumption } : {}),
    notes,
  };
}

// ---------------------------------------------------------------------------
// 差旅費上限 (travel-expense.md「住宿費上限」「交通費」「餐費補助」)

export type Destination = "taipei" | "domestic_other" | "asia" | "europe_america";

const LODGING: Record<Destination, { cap: number; currency: "TWD" | "USD"; label: string }> = {
  taipei: { cap: 3200, currency: "TWD", label: "台北市" },
  domestic_other: { cap: 2600, currency: "TWD", label: "其他縣市" },
  asia: { cap: 130, currency: "USD", label: "海外・亞洲地區" },
  europe_america: { cap: 220, currency: "USD", label: "海外・歐美地區" },
};
const MEAL_CAP = { domestic: 600, overseas: 50 } as const;
const MILEAGE_PER_KM = 6;
const TRAVEL_RULE =
  "住宿費上限（每人每晚）：台北市 3,200 元、其他縣市 2,600 元、亞洲地區 130 美元、歐美地區 220 美元。餐費：國內每日上限 600 元（早 100、午 200、晚 300），海外每日上限 50 美元。自行開車依每公里 6 元計算油資，另加實際過路費。";
const MAX_NIGHTS = 60;

export interface TravelResult {
  destination: string;
  items: Array<{ item: string; detail: string; amount: number; currency: "TWD" | "USD" }>;
  totals: Partial<Record<"TWD" | "USD", number>>;
  rule: string;
  source: string;
  notes: string[];
}

export function calcTravelCost(input: { destination: Destination; nights: number; days?: number; km?: number }): TravelResult | CalcError {
  const { destination, nights, km } = input;
  const lodging = LODGING[destination];
  if (!lodging) return { error: "destination 必須是 taipei、domestic_other、asia 或 europe_america", source: TRAVEL };
  const isInt = (n: number) => Number.isInteger(n) && n >= 0;
  if (!isInt(nights) || nights > MAX_NIGHTS) return { error: `住宿晚數必須是 0–${MAX_NIGHTS} 的整數`, source: TRAVEL };
  const days = input.days ?? nights + 1;
  if (!isInt(days) || days > MAX_NIGHTS + 1) return { error: `出差天數必須是 0–${MAX_NIGHTS + 1} 的整數`, source: TRAVEL };
  const domestic = lodging.currency === "TWD";
  if (km !== undefined && (!Number.isFinite(km) || km < 0)) return { error: "公里數必須 ≥ 0", source: TRAVEL };
  if (km !== undefined && km > 0 && !domestic) return { error: "每公里 6 元的油資只適用國內出差", source: TRAVEL };

  const mealCap = domestic ? MEAL_CAP.domestic : MEAL_CAP.overseas;
  const items: TravelResult["items"] = [
    { item: "住宿費上限", detail: `${lodging.label} ${lodging.cap} × ${nights} 晚`, amount: lodging.cap * nights, currency: lodging.currency },
    { item: "餐費上限", detail: `${mealCap} × ${days} 天`, amount: mealCap * days, currency: lodging.currency },
  ];
  if (km !== undefined && km > 0) {
    items.push({ item: "自行開車油資", detail: `${km} 公里 × ${MILEAGE_PER_KM} 元`, amount: round2(km * MILEAGE_PER_KM), currency: "TWD" });
  }
  const totals: TravelResult["totals"] = {};
  for (const it of items) totals[it.currency] = round2((totals[it.currency] ?? 0) + it.amount);
  return {
    destination: lodging.label,
    items,
    totals,
    rule: TRAVEL_RULE,
    source: TRAVEL,
    notes: [
      "以上是可報銷的上限，不是實際花費；超過住宿上限的部分由員工自付（除非事先取得部門主管書面核准）。",
      ...(domestic ? ["交通費（高鐵標準車廂、台鐵自強號、客運）實報實銷，過路費另計，未包含在上限內。"] : ["機票（經濟艙）實報實銷，未包含在上限內；外幣以台灣銀行賣出匯率換算。"]),
    ],
  };
}

// ---------------------------------------------------------------------------
// AI SDK tools (registered only for the `default` workspace)

export function buildKbCalcTools(): ToolSet {
  return {
    calc_annual_leave: tool({
      description:
        "Compute 雲朵科技 annual leave (特休) days from seniority, using the employee handbook's table. Returns days, the bracket, the rule text and the source file.",
      inputSchema: z.object({
        years: z.number().min(0).describe("Full years of seniority (年資年數)"),
        months: z.number().min(0).optional().describe("Additional months (0-11), default 0"),
      }),
      execute: async ({ years, months }) => calcAnnualLeave({ years, months: months ?? 0 }),
    }),
    calc_overtime_pay: tool({
      description:
        "Compute 雲朵科技 overtime pay (加班費) with the employee handbook's multipliers. day_type: weekday (平日), rest_day (休息日), holiday (國定假日). Returns the per-tier breakdown, total, rule text, assumptions and source file.",
      inputSchema: z.object({
        monthly_salary: z.number().positive().describe("Monthly salary in NT$ (月薪)"),
        hours: z.number().positive().describe("Overtime hours that day"),
        day_type: z.enum(["weekday", "rest_day", "holiday"]),
        hourly_wage: z.number().positive().optional().describe("Only if the user states the hourly wage; default monthly_salary / 240"),
      }),
      execute: async (input) => calcOvertimePay(input),
    }),
    calc_travel_cost: tool({
      description:
        "Compute 雲朵科技 reimbursable travel caps (住宿費、餐費上限、自行開車油資) from the travel expense policy. destination: taipei (台北市), domestic_other (其他縣市), asia (亞洲), europe_america (歐美).",
      inputSchema: z.object({
        destination: z.enum(["taipei", "domestic_other", "asia", "europe_america"]),
        nights: z.number().int().min(0).describe("Nights of lodging"),
        days: z.number().int().min(0).optional().describe("Travel days for meal allowance; default nights + 1"),
        km: z.number().min(0).optional().describe("Kilometres driven in an own car (domestic only)"),
      }),
      execute: async (input) => calcTravelCost(input),
    }),
  };
}
