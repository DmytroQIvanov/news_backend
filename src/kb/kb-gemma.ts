/**
 * Cheap JSON answers from Gemma 4 (31B and 26B, each with its own limits) with strict validation and a Gemini fallback.
 * Gemma has no JSON mode or system prompt, so the instruction travels inside the prompt and the reply is parsed and
 * checked by the caller's validator. Any 503/timeout/malformed answer moves on to the next model.
 */
import { postGeminiGenerateContent } from '../common/gemini-client';
import { estimateTextTokens, GemmaPriority, gemmaLimiter, reservedTokens } from '../common/gemma-limiter';
import { candidateText, geminiJson, models, parseJsonText } from './kb-llm';

export interface GemmaJsonRequest<T> {
  system: string;
  prompt: string;
  /** Returns the cleaned value or null when the answer is unusable. */
  validate: (raw: unknown) => T | null;
  /** Used only for the Gemini fallback (JSON mode needs a schema). */
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  timeoutMs?: number;
  purpose: string;
  temperature?: number;
  /** high = blocks a publication, low = background work that can wait. */
  priority?: GemmaPriority;
  /** Overrides KB_GEMMA_MODELS. */
  models?: string[];
}

/** unavailable = try again later at no cost; invalid = Gemma answered, but the answer (or the request) was unusable. */
export type GemmaAttempt<T> = { ok: true; value: T; model: string } | { ok: false; reason: 'unavailable' | 'invalid' };

const gemmaModels = () => models('KB_GEMMA_MODELS', 'gemma-4-31b-it,gemma-4-26b-a4b-it');

function orderedFor(list: string[], chars: number, maxOutputTokens: number): string[] {
  return gemmaLimiter.order(list, reservedTokens(estimateTextTokens(chars), maxOutputTokens));
}

/** Gemma only: never spends the small Gemini quotas, so background work can simply retry later. */
export async function tryGemmaJson<T>(req: GemmaJsonRequest<T>): Promise<GemmaAttempt<T>> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || process.env.KB_GEMMA === 'false') return { ok: false, reason: 'unavailable' };
  const keys = Object.keys((req.schema as { properties?: Record<string, unknown> }).properties ?? {}).join(', ');
  const text = `${req.system}\n\nReply with ONLY one JSON ${keys ? `object with the keys: ${keys}` : 'value'}. No markdown, no commentary.\n\n${req.prompt}`;
  const maxOutputTokens = req.maxOutputTokens ?? 3000;
  let invalid = false;
  for (const model of orderedFor(req.models ?? gemmaModels(), text.length, maxOutputTokens)) {
    let reply: string;
    let modelUsed: string;
    try {
      const res = await postGeminiGenerateContent({
        apiKey: key, candidateModels: [model], priority: req.priority ?? 'normal', statsTask: req.purpose, budgetPurpose: req.purpose,
        timeoutMs: req.timeoutMs ?? 90_000,
        body: {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: { temperature: req.temperature ?? 0.1, maxOutputTokens },
        },
      });
      reply = candidateText(res.data);
      modelUsed = res.modelUsed;
    } catch (err) {
      if ((err as { status?: number })?.status === 400) invalid = true; // too large or rejected: waiting will not help
      continue; // overloaded or out of quota: next model
    }
    try {
      const value = req.validate(parseJsonText(reply));
      if (value !== null) return { ok: true, value, model: modelUsed };
    } catch {
      /* malformed JSON */
    }
    invalid = true;
  }
  return { ok: false, reason: invalid ? 'invalid' : 'unavailable' };
}

export async function gemmaJson<T>(req: GemmaJsonRequest<T>): Promise<{ value: T; model: string } | null> {
  if (!process.env.GEMINI_API_KEY?.trim()) return null;
  const attempt = await tryGemmaJson(req);
  if (attempt.ok) return { value: attempt.value, model: attempt.model };
  try {
    const res = await geminiJson({
      models: models('KB_GEMMA_FALLBACK_MODELS', 'gemini-3.1-flash-lite,gemini-2.5-flash-lite'), system: req.system, prompt: req.prompt,
      schema: req.schema, maxOutputTokens: req.maxOutputTokens ?? 3000, purpose: req.purpose, timeoutMs: req.timeoutMs ?? 90_000, temperature: req.temperature ?? 0.1,
    });
    const value = req.validate(res.json);
    return value === null ? null : { value, model: res.model };
  } catch {
    return null;
  }
}

/**
 * Plain-text answer from the cheapest available model (Gemma first). Used for tiny edits such as fixing the JSON syntax of a
 * small fragment, so the expensive model's long answer is never regenerated.
 */
export async function gemmaText(prompt: string, purpose: string, maxOutputTokens = 1200): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  for (const model of [...orderedFor(gemmaModels(), prompt.length, maxOutputTokens), ...models('KB_GEMMA_FALLBACK_MODELS', 'gemini-3.1-flash-lite')]) {
    try {
      const { data } = await postGeminiGenerateContent({
        apiKey: key, candidateModels: [model], priority: 'high', statsTask: purpose, budgetPurpose: purpose, timeoutMs: 60_000,
        body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens } },
      });
      const text = candidateText(data).replace(/^```[a-z]*\s*$/gim, '');
      if (text.trim()) return text;
    } catch {
      /* next model */
    }
  }
  return null;
}

/** SnippetFixer for kb-repair: asks the cheapest model to correct only the JSON syntax of a fragment. */
export async function fixJsonFragment(fragment: string, error: string): Promise<string | null> {
  return gemmaText(
    `The following is a fragment cut from a longer JSON document. The parser reported: "${error}".\n` +
      'Fix ONLY the JSON syntax problem (missing/extra comma, quote, bracket, unescaped quote inside a string). Do not change, add or remove any words or numbers. ' +
      `Return the corrected fragment and nothing else — same start, same end, no markdown.\n\nFRAGMENT:\n${fragment}`,
    'json_repair', 800,
  );
}
