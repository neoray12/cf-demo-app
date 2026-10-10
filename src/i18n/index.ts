import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import zhTW from "./zh-TW.json";
import en from "./en.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "zh-TW": { translation: zhTW },
      en: { translation: en },
    },
    fallbackLng: "zh-TW",
    supportedLngs: ["zh-TW", "en"],
    interpolation: {
      escapeValue: false,
    },
    // Default to Traditional Chinese regardless of browser language; only an
    // explicit switch (sidebar / login toggle) is remembered. The storage key
    // was bumped from "cf-demo-lang" because that one also cached the old
    // navigator-detected value, which would keep English browsers on English.
    detection: {
      order: ["localStorage"],
      caches: ["localStorage"],
      lookupLocalStorage: "cf-demo-lang-v2",
    },
  });

export default i18n;
