import { describe, expect, it } from "vitest";
import { createMarkupFilter, stripToolCallMarkup } from "./markup-filter";

const LEAK =
  '<|tool_calls_section_begin|><|tool_call_begin|>functions.search_docs:4<|tool_call_argument_begin|>{"query": "Workers vs Pages"}<|tool_call_end|><|tool_calls_section_end|>';

/** Feed `text` in pieces of `size` characters and collect the output (plus what each push returned). */
function streamed(text: string, size: number) {
  const f = createMarkupFilter();
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(f.push(text.slice(i, i + size)));
  pieces.push(f.flush());
  return { out: pieces.join(""), pieces };
}

describe("stripToolCallMarkup", () => {
  it("removes a whole tool-call section", () => {
    expect(stripToolCallMarkup(`Finding: KV is eventually consistent.${LEAK}`)).toBe("Finding: KV is eventually consistent.");
    expect(stripToolCallMarkup(`a${LEAK}b`)).toBe("ab");
  });

  it("drops an unterminated section to the end of the text", () => {
    expect(stripToolCallMarkup('ok <|tool_calls_section_begin|><|tool_call_begin|>functions.x:0<|tool_call_argument_begin|>{"q"')).toBe("ok ");
  });

  it("removes stray tool_call_begin…tool_call_end and other special tokens", () => {
    expect(stripToolCallMarkup('x<|tool_call_begin|>functions.a:1<|tool_call_argument_begin|>{}<|tool_call_end|>y')).toBe("xy");
    expect(stripToolCallMarkup("done<|im_end|>")).toBe("done");
    expect(stripToolCallMarkup("a<|tool_calls_section_end|>b")).toBe("ab");
  });

  it("leaves ordinary text with < and | alone", () => {
    for (const s of ["a < b", "x <| y", "if (a<b || c) {}", "<div>|</div>", "1 <|> 2", "<"]) {
      expect(stripToolCallMarkup(s)).toBe(s);
    }
  });
});

describe("createMarkupFilter (streaming)", () => {
  it.each([1, 2, 3, 5, 7, 11, 1000])("gives the same result for chunks of %i chars", (size) => {
    const text = `前言 <b> ${LEAK} 結論 a<|im_end|>b x <| y <`;
    expect(streamed(text, size).out).toBe("前言 <b>  結論 ab x <| y <");
  });

  it("does not hold back normal text", () => {
    const f = createMarkupFilter();
    expect(f.push("Hello ")).toBe("Hello ");
    expect(f.push("world")).toBe("world");
    expect(f.push(" a<b")).toBe(" a<b");
  });

  it("holds only a partial <| prefix until the next chunk decides", () => {
    const f = createMarkupFilter();
    expect(f.push("text <")).toBe("text ");
    expect(f.push("|tool_ca")).toBe("");
    expect(f.push("lls_section_begin|>junk")).toBe("");
    expect(f.push("<|tool_calls_sec")).toBe("");
    expect(f.push("tion_end|>after")).toBe("after");
    expect(f.flush()).toBe("");
  });

  it("flush: a lone trailing < is text, a cut-off special token is not", () => {
    const a = createMarkupFilter();
    expect(a.push("x <")).toBe("x ");
    expect(a.flush()).toBe("<");
    const b = createMarkupFilter();
    expect(b.push("x <|tool_call")).toBe("x ");
    expect(b.flush()).toBe("");
  });
});
