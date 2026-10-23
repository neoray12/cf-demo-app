// Strips Kimi tool-call markup that leaks into model text.
//
// When tools are disabled (R23 `toolChoice: "none"`) Kimi K2.6 sometimes still "calls" a tool by writing its
// raw chat-template tokens as text, e.g.
//   <|tool_calls_section_begin|><|tool_call_begin|>functions.search_docs:4<|tool_call_argument_begin|>{…}<|tool_call_end|><|tool_calls_section_end|>
// The filter removes
// - everything from <|tool_calls_section_begin|> through <|tool_calls_section_end|> (to the end of the text when
//   the section is never closed),
// - any stray <|tool_call_begin|> … <|tool_call_end|>,
// - any other <|…|> special token,
// and works on streamed chunks: only a possible partial special-token prefix (`<`, `<|tool_ca`) is held back
// between chunks — ordinary text is passed through immediately.

const SECTION_BEGIN = "tool_calls_section_begin";
const SECTION_END = "<|tool_calls_section_end|>";
const CALL_BEGIN = "tool_call_begin";
const CALL_END = "<|tool_call_end|>";
/** Body of a special token: short identifier-like text between `<|` and `|>`. */
const TOKEN_BODY = /^[A-Za-z0-9_.:-]*$/;
const TOKEN_BODY_MAX = 64;

export interface MarkupFilter {
  /** Feed a chunk; returns the text that is safe to show now. */
  push(chunk: string): string;
  /** End of stream: returns whatever held-back text is not markup. */
  flush(): string;
}

export function createMarkupFilter(): MarkupFilter {
  // "text": passing text through; "drop": inside a section / stray call, discarding until `until`.
  let mode: "text" | "drop" = "text";
  let until = "";
  let pending = ""; // text mode: held-back partial `<|…` prefix; drop mode: tail kept to match `until` across chunks

  const scanText = (input: string): string => {
    let out = "";
    let i = 0;
    while (i < input.length) {
      if (mode === "drop") {
        const end = input.indexOf(until, i);
        if (end === -1) {
          // keep just enough to recognise `until` split across chunks
          pending = input.slice(Math.max(i, input.length - (until.length - 1)));
          return out;
        }
        i = end + until.length;
        mode = "text";
        until = "";
        continue;
      }
      const lt = input.indexOf("<", i);
      if (lt === -1) {
        out += input.slice(i);
        return out;
      }
      out += input.slice(i, lt);
      // `<` at the very end: could be the start of `<|`
      if (lt === input.length - 1) {
        pending = "<";
        return out;
      }
      if (input[lt + 1] !== "|") {
        out += "<";
        i = lt + 1;
        continue;
      }
      const close = input.indexOf("|>", lt + 2);
      // unterminated: the chunk may end between `|` and `>`
      const body = close === -1 ? input.slice(lt + 2).replace(/\|$/, "") : input.slice(lt + 2, close);
      if (!TOKEN_BODY.test(body) || body.length > TOKEN_BODY_MAX) {
        // not a special token (e.g. "a <| b"): emit `<|` as text and go on
        out += "<|";
        i = lt + 2;
        continue;
      }
      if (close === -1) {
        // unterminated but still token-like: hold it until the next chunk decides
        pending = input.slice(lt);
        return out;
      }
      i = close + 2;
      if (body === SECTION_BEGIN) {
        mode = "drop";
        until = SECTION_END;
      } else if (body === CALL_BEGIN) {
        mode = "drop";
        until = CALL_END;
      }
      // any other special token (incl. stray *_end / argument_begin) is simply removed
    }
    return out;
  };

  return {
    push(chunk) {
      if (!chunk) return "";
      const input = pending + chunk;
      pending = "";
      return scanText(input);
    },
    flush() {
      const rest = pending;
      pending = "";
      if (mode === "drop") return ""; // unterminated section: dropped to the end
      // a lone `<` is text; a cut-off `<|token` is markup
      return rest === "<" ? "<" : "";
    },
  };
}

/** Whole-string version of the filter. */
export function stripToolCallMarkup(text: string): string {
  const f = createMarkupFilter();
  return f.push(text) + f.flush();
}
