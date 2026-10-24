import { describe, expect, it } from "vitest";
import { dispatchDomain, planDispatch } from "./threat-dispatch";

describe("planDispatch", () => {
  it("Chinese attack question with a week-over-week comparison", () => {
    expect(planDispatch("誰在攻擊台灣？跟上週比有什麼變化？")).toEqual({ analysts: ["attack"], location: "TW", compareLastWeek: true });
  });

  it("Chinese bot / AI crawler question picks only the bot analyst", () => {
    expect(planDispatch("台灣的流量有多少是機器人？哪些 AI 爬蟲最活躍？")).toEqual({
      analysts: ["bot"],
      location: "TW",
      compareLastWeek: false,
    });
  });

  it("network keywords (Chinese and English)", () => {
    expect(planDispatch("日本最近有斷網嗎？").analysts).toEqual(["network"]);
    expect(planDispatch("日本最近有斷網嗎？").location).toBe("JP");
    expect(planDispatch("Any BGP hijacks or outages in Singapore?")).toMatchObject({ analysts: ["network"], location: "SG" });
    expect(planDispatch("台灣 ISP 網速與品質如何").analysts).toEqual(["network"]);
  });

  it("English attack and bot keywords", () => {
    expect(planDispatch("Who is launching DDoS attacks against the United States?")).toMatchObject({ analysts: ["attack"], location: "US" });
    expect(planDispatch("Which AI crawler is most active?").analysts).toEqual(["bot"]);
    expect(planDispatch("Are phishing email threats rising compared with last week?")).toMatchObject({
      analysts: ["attack", "bot"], // "threat" → attack, "email"/"phishing" → bot
      compareLastWeek: true,
    });
  });

  it("multiple matches keep a stable order", () => {
    expect(planDispatch("駭客攻擊、斷網和機器人流量，韓國的情況？")).toEqual({
      analysts: ["attack", "network", "bot"],
      location: "KR",
      compareLastWeek: false,
    });
  });

  it("defaults to the attack analyst and TW when nothing matches", () => {
    expect(planDispatch("最近資安情勢如何？")).toEqual({ analysts: ["attack"], location: "TW", compareLastWeek: false });
    expect(planDispatch("hello")).toEqual({ analysts: ["attack"], location: "TW", compareLastWeek: false });
  });

  it("a domain implies the bot analyst (domain_rank)", () => {
    expect(planDispatch("example.com 的網域排名是多少？")).toEqual({
      analysts: ["bot"],
      location: "TW",
      compareLastWeek: false,
      domain: "example.com",
    });
    expect(planDispatch("Is shop.Example.co.jp under attack?")).toEqual({
      analysts: ["attack", "bot"],
      location: "TW",
      compareLastWeek: false,
      domain: "shop.example.co.jp",
    });
  });

  it("dispatchDomain ignores version numbers and plain words", () => {
    expect(dispatchDomain("Kimi K2.6 vs GLM 5.3")).toBeUndefined();
    expect(dispatchDomain("台灣攻擊")).toBeUndefined();
    expect(dispatchDomain("看一下 cloudflare.com。")).toBe("cloudflare.com");
  });
});
