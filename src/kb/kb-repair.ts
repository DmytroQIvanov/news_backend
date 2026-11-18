/**
 * Syntax repair of model output without rewriting it.
 *   1. Deterministic repair (free): code fences, comments, raw newlines in strings, trailing commas, truncated output
 *      (unterminated string / unclosed brackets), dangling keys.
 *   2. Local patch by the cheapest model: only a small window around the parser's error position is sent; the model returns the
 *      corrected window and it is spliced back. The rest of the (possibly 30k-token) answer is never regenerated.
 */

function extractJsonStart(text: string): string {
  const t = text.replace(/^\uFEFF/, '').replace(/```(?:json|JSON)?/g, '').trim();
  const i = t.search(/[{[]/);
  return i > 0 ? t.slice(i) : t;
}

export function repairJsonDeterministic(input: string): string {
  const text = extractJsonStart(input);
  const out: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out.push(ch);
        escaped = false;
      } else if (ch === '\\') {
        out.push(ch);
        escaped = true;
      } else if (ch === '"') {
        out.push(ch);
        inString = false;
      } else if (ch === '\n') out.push('\\n');
      else if (ch === '\r') out.push('\\r');
      else if (ch === '\t') out.push('\\t');
      else out.push(ch);
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out.push(ch);
    } else if (ch === '}' || ch === ']') {
      // drop a trailing comma before the closer
      while (out.length && /\s/.test(out[out.length - 1])) out.pop();
      if (out[out.length - 1] === ',') out.pop();
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      out.push(ch);
      if (!stack.length) break; // anything after the root value is commentary
    } else out.push(ch);
  }
  if (inString) out.push('"');
  while (out.length && /\s/.test(out[out.length - 1])) out.pop();
  if (out[out.length - 1] === ',') out.pop();
  if (out[out.length - 1] === ':') out.push('null'); // dangling key
  let result = out.join('');
  // a truncated string may end in the middle of a key: "abc" without colon inside an object
  if (stack.length && stack[stack.length - 1] === '}' && /[{,]\s*"[^"\\]*"$/.test(result)) result += ':null';
  while (stack.length) result += stack.pop();
  return result;
}

function errorPosition(err: unknown): number | null {
  const m = /position (\d+)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

export type SnippetFixer = (fragment: string, error: string) => Promise<string | null>;

/** Parse with every repair stage; throws only when nothing helps. `fixer` is the cheap-model patcher (optional). */
export async function parseJsonRobust(text: string, fixer?: SnippetFixer, maxPatches = 3): Promise<any> {
  const attempt = (s: string) => JSON.parse(s);
  const base = extractJsonStart(text);
  try {
    return attempt(base);
  } catch {
    /* continue */
  }
  let current = repairJsonDeterministic(text);
  for (let n = 0; n <= maxPatches; n += 1) {
    try {
      return attempt(current);
    } catch (err) {
      const pos = errorPosition(err);
      if (!fixer || pos === null || n === maxPatches) throw new Error(`model did not return valid JSON (${err instanceof Error ? err.message : err})`);
      const from = Math.max(0, pos - 220);
      const to = Math.min(current.length, pos + 220);
      const fixed = await fixer(current.slice(from, to), err instanceof Error ? err.message : String(err)).catch(() => null);
      const content = (x: string) => x.replace(/[\s,"'\[\]{}:\\]/g, '');
      if (!fixed || fixed.length > (to - from) * 1.5 || fixed.length < (to - from) * 0.5 || content(fixed) !== content(current.slice(from, to))) {
        throw new Error('JSON syntax patch was rejected (it changed more than syntax)');
      }
      current = current.slice(0, from) + fixed + current.slice(to);
      current = repairJsonDeterministic(current);
    }
  }
  throw new Error('model did not return valid JSON');
}
