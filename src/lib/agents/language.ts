// Language of the user's question, used to keep researcher/analyst findings and the root answer in one language.
// Pure and client-safe (no server imports).
export type UserLanguage = "zh-TW" | "en";

// Han (incl. extension A), Hiragana, Katakana, Hangul and the CJK punctuation block.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

/** "zh-TW" when the text contains any CJK character (Chinese, Japanese kana, Hangul), otherwise "en". */
export function userLanguage(text: string | undefined | null): UserLanguage {
  return text && CJK_RE.test(text) ? "zh-TW" : "en";
}

/** A one-line instruction for prompts: write the output in the user's language. */
export function languageInstruction(lang: UserLanguage): string {
  return lang === "zh-TW"
    ? "Write your output in Traditional Chinese (繁體中文); keep product names, code, API names and URLs as they are."
    : "Write your output in English.";
}
