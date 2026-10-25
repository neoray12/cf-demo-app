// Shapes the JavaScript a model writes for executeJs into statements that end
// in a `return`, so the Dynamic Worker wrapper captures the value.

/**
 * Index of the bracket that closes the one opened at `open`, or -1. Skips
 * string / template literals and comments so braces inside them don't count.
 * Regex literals aren't handled — rare in short demo scripts, and a miss only
 * makes the caller fall back to the (safe) "statement list" interpretation.
 */
function matchBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
    } else if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
    } else if (pairs[c]) {
      stack.push(pairs[c]!);
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Models write the script in one of three shapes; normalize them all into
 * statements that end in a `return`, so the harness's wrapper actually
 * captures the value. Without this an IIFE body evaluates and is discarded,
 * the tool returns null, and the model happily invents an answer.
 *
 * The shape is decided by structure, not by the first keyword: a script that
 * *starts* with `function fib(n) {…}` is almost always a declaration followed
 * by statements (`console.log(fib(40))`), and wrapping that as a function
 * expression is a SyntaxError ("Unexpected identifier 'console'") — which made
 * the first one or two executeJs attempts fail on nearly every demo prompt.
 */
export function normalizeCode(raw: string): string {
  const code = raw.trim().replace(/;\s*$/, '');

  // IIFE: (async () => { ... })()  /  (function(){...})()  — one parenthesised
  // group followed by an empty call, and nothing else.
  if (code.startsWith('(')) {
    const close = matchBracket(code, 0);
    if (close > 0 && /^\(\s*\)$/.test(code.slice(close + 1).trim())) return `return await ${code};`;
  }

  // Anonymous function expression that spans the whole script:
  //   async () => {…}   () => {…}   async function () {…}   function () {…}
  // (a *named* `function foo(){}` is a declaration, handled below). Models
  // sometimes "invoke" an unparenthesised arrow — `async () => {…}()` — so a
  // trailing empty call is dropped and the wrapper invokes it instead.
  const head = code.match(/^(?:async\s+)?(?:function\s*\*?\s*\(|\(\s*[^)]*\)\s*=>\s*\{|[A-Za-z_$][\w$]*\s*=>\s*\{)/);
  if (head) {
    const open = code.indexOf('{', head[0].length - 1);
    const close = open >= 0 ? matchBracket(code, open) : -1;
    if (close > 0 && /^(?:\(\s*\))?$/.test(code.slice(close + 1).trim())) {
      return `return await (${code.slice(0, close + 1)})();`;
    }
  }

  // Statement list (declarations + calls) — assumed to print via console.log
  // or return its own value.
  return code;
}
