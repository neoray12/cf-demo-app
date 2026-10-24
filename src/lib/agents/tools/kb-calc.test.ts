import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../runtime";
import { kbAgent } from "../defs/knowledge-base";
import { buildKbCalcTools, calcAnnualLeave, calcOvertimePay, calcTravelCost, HANDBOOK, TRAVEL } from "./kb-calc";

const seed = (f: string) => readFileSync(join(__dirname, "..", "..", "..", "..", "scripts", "seed-kb", f), "utf8");

describe("calcAnnualLeave (employee-handbook.md table)", () => {
  const days = (years: number, months = 0) => (calcAnnualLeave({ years, months }) as { days: number }).days;

  it("pins every seniority boundary of the table", () => {
    expect(days(0, 5)).toBe(0);
    expect(days(0, 6)).toBe(3);
    expect(days(0, 11)).toBe(3);
    expect(days(1)).toBe(7);
    expect(days(1, 11)).toBe(7);
    expect(days(2)).toBe(10);
    expect(days(2, 11)).toBe(10);
    expect(days(3)).toBe(14);
    expect(days(3, 6)).toBe(14);
    expect(days(4, 11)).toBe(14);
    expect(days(5)).toBe(15);
    expect(days(9, 11)).toBe(15);
  });

  it("10 years and more: one extra day per year, capped at 30", () => {
    expect(days(10)).toBe(16);
    expect(days(11)).toBe(17);
    expect(days(23)).toBe(29);
    expect(days(24)).toBe(30);
    expect(days(40)).toBe(30);
  });

  it("months roll over into years; fractional years work", () => {
    expect(days(0, 18)).toBe(7);
    expect(days(3.5)).toBe(14);
  });

  it("returns the bracket, rule text and source", () => {
    expect(calcAnnualLeave({ years: 3, months: 6 })).toMatchObject({
      days: 14,
      seniority: "3 年 6 個月",
      bracket: "滿 3 年未滿 5 年",
      source: HANDBOOK,
      rule: expect.stringContaining("滿 3 年未滿 5 年 14 天"),
    });
  });

  it("rejects invalid input", () => {
    expect(calcAnnualLeave({ years: -1 })).toMatchObject({ error: expect.any(String), source: HANDBOOK });
    expect(calcAnnualLeave({ years: 1, months: -2 })).toHaveProperty("error");
    expect(calcAnnualLeave({ years: Number.NaN })).toHaveProperty("error");
    expect(calcAnnualLeave({ years: 61 })).toHaveProperty("error");
  });

  it("the encoded rule matches the seed doc", () => {
    const doc = seed(HANDBOOK);
    for (const row of ["| 滿 6 個月未滿 1 年 | 3 天 |", "| 滿 1 年未滿 2 年 | 7 天 |", "| 滿 2 年未滿 3 年 | 10 天 |", "| 滿 3 年未滿 5 年 | 14 天 |", "| 滿 5 年未滿 10 年 | 15 天 |", "| 滿 10 年以上 | 每年加 1 天，最多 30 天 |"]) {
      expect(doc).toContain(row);
    }
  });
});

describe("calcOvertimePay (employee-handbook.md multipliers)", () => {
  it("weekday 3 h on NT$48,000: 2 h × 1.34 + 1 h × 1.67 at 200/h = 870", () => {
    expect(calcOvertimePay({ monthly_salary: 48000, hours: 3, day_type: "weekday" })).toMatchObject({
      hourlyWage: 200,
      breakdown: [
        { hours: 2, multiplier: 1.34, amount: 536 },
        { hours: 1, multiplier: 1.67, amount: 334 },
      ],
      pay: 870,
      payRounded: 870,
      source: HANDBOOK,
      rule: expect.stringContaining("前 2 小時按 1.34 倍，第 3 至第 4 小時按 1.67 倍"),
      assumption: expect.stringContaining("月薪 ÷ 240"),
    });
  });

  it("weekday tiers: 1, 2 and 4 hours; more than 4 is outside the handbook", () => {
    expect((calcOvertimePay({ monthly_salary: 48000, hours: 1, day_type: "weekday" }) as { pay: number }).pay).toBe(268);
    expect((calcOvertimePay({ monthly_salary: 48000, hours: 2, day_type: "weekday" }) as { pay: number }).pay).toBe(536);
    expect((calcOvertimePay({ monthly_salary: 48000, hours: 4, day_type: "weekday" }) as { pay: number }).pay).toBe(1204);
    expect(calcOvertimePay({ monthly_salary: 48000, hours: 5, day_type: "weekday" })).toMatchObject({ error: expect.stringContaining("4 小時") });
  });

  it("rest day: 1.34 / 1.67 / 2.67 tiers", () => {
    const r = calcOvertimePay({ monthly_salary: 48000, hours: 10, day_type: "rest_day" }) as {
      breakdown: Array<{ hours: number; multiplier: number; amount: number }>;
      pay: number;
    };
    expect(r.breakdown).toEqual([
      { hours: 2, multiplier: 1.34, amount: 536 },
      { hours: 6, multiplier: 1.67, amount: 2004 },
      { hours: 2, multiplier: 2.67, amount: 1068 },
    ]);
    expect(r.pay).toBe(3608);
    expect((calcOvertimePay({ monthly_salary: 48000, hours: 8, day_type: "rest_day" }) as { pay: number }).pay).toBe(2540);
  });

  it("national holiday: one extra day's wage (monthly / 30)", () => {
    expect(calcOvertimePay({ monthly_salary: 48000, hours: 8, day_type: "holiday" })).toMatchObject({ pay: 1600, rule: "國定假日出勤：加倍發給當日工資。" });
    expect(calcOvertimePay({ monthly_salary: 48000, hours: 9, day_type: "holiday" })).toHaveProperty("error");
  });

  it("uses a stated hourly wage and rounds to cents", () => {
    expect(calcOvertimePay({ monthly_salary: 40000, hours: 1, day_type: "weekday", hourly_wage: 183 })).toMatchObject({ hourlyWage: 183, pay: 245.22, payRounded: 245 });
    expect(calcOvertimePay({ monthly_salary: 40000, hours: 1, day_type: "weekday", hourly_wage: 183 })).not.toHaveProperty("assumption");
    expect((calcOvertimePay({ monthly_salary: 50000, hours: 1, day_type: "weekday" }) as { hourlyWage: number }).hourlyWage).toBe(208.33);
  });

  it("rejects invalid input", () => {
    expect(calcOvertimePay({ monthly_salary: 0, hours: 1, day_type: "weekday" })).toHaveProperty("error");
    expect(calcOvertimePay({ monthly_salary: 48000, hours: 0, day_type: "weekday" })).toHaveProperty("error");
    expect(calcOvertimePay({ monthly_salary: 48000, hours: 1, day_type: "sunday" as never })).toHaveProperty("error");
  });

  it("the encoded multipliers match the seed doc", () => {
    const doc = seed(HANDBOOK);
    expect(doc).toContain("平日延長工時：前 2 小時按 1.34 倍，第 3 至第 4 小時按 1.67 倍。");
    expect(doc).toContain("休息日：前 2 小時按 1.34 倍，第 3 至第 8 小時按 1.67 倍，第 9 小時起按 2.67 倍。");
    expect(doc).toContain("國定假日出勤：加倍發給當日工資。");
    expect(doc).toContain("每月加班總時數上限為 46 小時");
  });
});

describe("calcTravelCost (travel-expense.md caps)", () => {
  it("Taipei, 2 nights: lodging 6,400 + meals 3 days × 600 + 120 km × 6", () => {
    expect(calcTravelCost({ destination: "taipei", nights: 2, km: 120 })).toMatchObject({
      items: [
        { item: "住宿費上限", amount: 6400, currency: "TWD" },
        { item: "餐費上限", amount: 1800, currency: "TWD" },
        { item: "自行開車油資", amount: 720, currency: "TWD" },
      ],
      totals: { TWD: 8920 },
      source: TRAVEL,
    });
  });

  it("other counties and overseas caps", () => {
    expect(calcTravelCost({ destination: "domestic_other", nights: 1, days: 1 })).toMatchObject({ totals: { TWD: 3200 } });
    expect(calcTravelCost({ destination: "asia", nights: 3 })).toMatchObject({ totals: { USD: 590 } }); // 130×3 + 50×4
    expect(calcTravelCost({ destination: "europe_america", nights: 5, days: 6 })).toMatchObject({ totals: { USD: 1400 } }); // 220×5 + 50×6
  });

  it("rejects invalid input", () => {
    expect(calcTravelCost({ destination: "asia", nights: 1, km: 10 })).toHaveProperty("error");
    expect(calcTravelCost({ destination: "taipei", nights: -1 })).toHaveProperty("error");
    expect(calcTravelCost({ destination: "taipei", nights: 1.5 })).toHaveProperty("error");
    expect(calcTravelCost({ destination: "mars" as never, nights: 1 })).toHaveProperty("error");
  });

  it("the encoded caps match the seed doc", () => {
    const doc = seed(TRAVEL);
    for (const s of ["台北市：新台幣 3,200 元", "其他縣市：新台幣 2,600 元", "亞洲地區每晚 130 美元，歐美地區每晚 220 美元", "每日餐費上限 600 元", "海外出差每日上限 50 美元", "每公里 6 元"]) {
      expect(doc).toContain(s);
    }
  });
});

describe("knowledge-base agent: calculators only in the default workspace", () => {
  const ctx = (workspace?: string) => ({ env: {}, signal: new AbortController().signal, emit: () => {}, workspace }) as unknown as RunContext;

  it("registers the calc tools and the calculator prompt for `default` (and no workspace)", () => {
    for (const c of [ctx("default"), ctx(undefined)]) {
      expect(Object.keys(kbAgent.tools(c)).sort()).toEqual(["calc_annual_leave", "calc_overtime_pay", "calc_travel_cost", "search_kb"]);
      expect(kbAgent.system(c)).toContain("不要自己做任何算術");
    }
  });

  it("user workspaces get neither", () => {
    expect(Object.keys(kbAgent.tools(ctx("ws-abcdef12")))).toEqual(["search_kb"]);
    expect(kbAgent.system(ctx("ws-abcdef12"))).not.toContain("calc_");
  });

  it("the tools return the calculators' results", async () => {
    const tools = buildKbCalcTools();
    const run = (name: string, input: unknown) =>
      (tools[name] as unknown as { execute(i: unknown, o: unknown): Promise<unknown> }).execute(input, { toolCallId: "x", messages: [] });
    expect(await run("calc_annual_leave", { years: 3, months: 6 })).toMatchObject({ days: 14 });
    expect(await run("calc_overtime_pay", { monthly_salary: 48000, hours: 3, day_type: "weekday" })).toMatchObject({ pay: 870 });
    expect(await run("calc_travel_cost", { destination: "taipei", nights: 1 })).toMatchObject({ totals: { TWD: 4400 } });
  });
});
