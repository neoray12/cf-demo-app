import { describe, expect, it } from "vitest";
import { languageInstruction, userLanguage } from "./language";

describe("userLanguage", () => {
  it("Chinese questions -> zh-TW", () => {
    expect(userLanguage("Workers 和 Pages 差在哪？新專案該選哪個？")).toBe("zh-TW");
    expect(userLanguage("誰在攻擊台灣")).toBe("zh-TW");
  });
  it("any CJK character in an otherwise English question -> zh-TW", () => {
    expect(userLanguage("What is 台灣 doing?")).toBe("zh-TW");
    expect(userLanguage("東京のDDoS")).toBe("zh-TW");
  });
  it("English, empty and missing text -> en", () => {
    expect(userLanguage("What is the difference between Workers and Pages?")).toBe("en");
    expect(userLanguage("")).toBe("en");
    expect(userLanguage(undefined)).toBe("en");
    expect(userLanguage("Café déjà vu 123 ?!")).toBe("en");
  });
  it("languageInstruction names the language", () => {
    expect(languageInstruction("zh-TW")).toContain("繁體中文");
    expect(languageInstruction("en")).toContain("English");
  });
});
