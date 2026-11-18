/**
 * Model calls used by the knowledge-base editor. Every Gemini request goes through postGeminiGenerateContent, so the
 * shared daily budget (llm-budget.ts) is respected; when one model's quota is used up the next model in the list is
 * tried, and when all are used up the task simply waits for the next cycle (quality is never traded for speed).
 */
import { postGeminiGenerateContent } from '../common/gemini-client';
import { generateJsonWithRouter, LlmTask } from '../common/llm-router';
import { fixJsonFragment } from './kb-gemma';
import { parseJsonRobust } from './kb-repair';

export interface JsonRequest {
  models: string[];
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  purpose: string;
  timeoutMs: number;
  temperature?: number;
}

/** (request) -> parsed JSON + model. Replaceable in tests. */
export type JsonLlm = (req: JsonRequest) => Promise<{ json: any; model: string }>;

export interface SearchResult {
  text: string;
  sources: Array<{ url: string; title: string }>;
  model: string;
}

export type SearchLlm = (req: { models: string[]; prompt: string; purpose: string; timeoutMs: number }) => Promise<SearchResult>;

export function candidateText(data: unknown): string {
  return ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }).candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought).map((p) => p.text).join('');
}

export function parseJsonText(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('model did not return JSON');
  }
}

export const geminiJson: JsonLlm = async (req) => {
  const { data, modelUsed } = await postGeminiGenerateContent({
    apiKey: process.env.GEMINI_API_KEY!.trim(),
    candidateModels: req.models,
    priority: 'high',
    statsTask: req.purpose,
    budgetPurpose: req.purpose,
    timeoutMs: req.timeoutMs,
    jsonSchemaWhenNoTools: req.schema,
    body: {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: req.schema,
      },
    },
  });
  return { json: await parseJsonRobust(candidateText(data), fixJsonFragment), model: modelUsed };
};

/** Cheap tasks (translation, image queries): the router tries Groq / Gemini / OpenRouter by their free budgets. */
export async function cheapJson<T = any>(task: LlmTask, system: string, prompt: string, schema: Record<string, unknown>, maxTokens = 4000): Promise<{ json: T; model: string } | null> {
  const res = await generateJsonWithRouter<T>({ task, system, prompt, schema, maxTokens, temperature: 0.2, timeoutMs: 120_000 });
  return res ? { json: res.data, model: `${res.provider}:${res.model}` } : null;
}

/**
 * Web research with Google Search grounding (a cheap Gemini model). Returns the model's notes and the source URLs it
 * used. The notes are only leads: the editor cites pages that our own collector fetched and extracted.
 */
export const geminiSearch: SearchLlm = async (req) => {
  const { data, modelUsed } = await postGeminiGenerateContent({
    apiKey: process.env.GEMINI_API_KEY!.trim(),
    candidateModels: req.models,
    priority: 'normal',
    statsTask: req.purpose,
    budgetPurpose: req.purpose,
    timeoutMs: req.timeoutMs,
    body: {
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 6000 },
    },
  });
  const cand = (data as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }> }).candidates?.[0];
  const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => ({ url: String(c.web?.uri || ''), title: String(c.web?.title || '') }))
    .filter((s) => /^https:\/\//.test(s.url));
  return { text: candidateText(data), sources, model: modelUsed };
};

/** Grounding links are redirects; resolve them to the publisher's URL before our collector fetches the page. */
export async function resolveRedirect(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    resp.body?.cancel().catch(() => undefined);
    const final = resp.url || url;
    return /^https:\/\//.test(final) && !/vertexaisearch|google\.com\/url/.test(final) ? final : null;
  } catch {
    return null;
  }
}

export function models(envName: string, fallback: string): string[] {
  return (process.env[envName] || fallback).split(',').map((m) => m.trim()).filter(Boolean);
}
