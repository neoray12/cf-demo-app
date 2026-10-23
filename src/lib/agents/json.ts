/**
 * Lenient JSON extraction for model output: strips ``` / ```json fences and
 * parses the text between the first `{` and the last `}`. Returns null when
 * nothing parseable is found.
 */
export function parseJsonLoose<T>(text: string): T | null {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
