import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "./json";

describe("parseJsonLoose", () => {
  it("strips ```json fences", () => {
    expect(parseJsonLoose('```json\n{"unsupported":[]}\n```')).toEqual({ unsupported: [] });
  });

  it("returns null for non-JSON text", () => {
    expect(parseJsonLoose("nope")).toBeNull();
  });

  it("takes the first { … last } span out of surrounding prose", () => {
    expect(parseJsonLoose('Sure! Here it is: {"a":{"b":1}} hope that helps')).toEqual({ a: { b: 1 } });
  });

  it("returns null for malformed JSON between braces", () => {
    expect(parseJsonLoose("{ not: json }")).toBeNull();
  });
});
