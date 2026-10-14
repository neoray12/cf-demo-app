'use client';

import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["py"], { languageName: "python" });

/**
 * Syntax-highlighted code for the dark code blocks. Unknown languages are
 * shown as plain text. highlight.js escapes the source, so the generated HTML
 * is safe to inject.
 */
export function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, language]);

  if (html == null) return <code>{code}</code>;
  // `hljs` adds the theme's token colours; the block keeps its own background.
  return <code className="hljs !bg-transparent !p-0" dangerouslySetInnerHTML={{ __html: html }} />;
}
