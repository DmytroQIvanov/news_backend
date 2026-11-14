import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArticleDto, CATEGORIES, SourceDto } from './ingest.dto';

const textSchema = { type: 'string' };
const enumSchema = (values: readonly string[]) => ({ type: 'string', enum: values });
const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties) });
const arraySchema = (items: unknown) => ({ type: 'array', items });
const confidence = ['high', 'medium', 'low'] as const;
const evidence = ['confirmed', 'company_claim', 'unverified'] as const;
const schema = objectSchema({
  title: textSchema, summary: textSchema, body: textSchema,
  important: { type: 'boolean' }, importance_reason: textSchema, category: enumSchema(CATEGORIES),
  sources: arraySchema(objectSchema({ title: textSchema, url: textSchema })),
  facts: arraySchema(objectSchema({ claim: textSchema, status: enumSchema(evidence), url: textSchema })),
  comparisons: arraySchema(textSchema), confidence: enumSchema(confidence),
  editorial: objectSchema({ angles: arraySchema(textSchema), style: textSchema, limitations: textSchema }),
});

type GeminiResponse = { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] };
  groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[] };

@Injectable()
export class GeminiEditorService {
  private readonly prompt = readFileSync(join(__dirname, 'editorial-prompt.md'), 'utf8');
  private readonly model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
  private readonly key = process.env.GEMINI_API_KEY?.trim();
  private readonly research = process.env.GEMINI_RESEARCH === 'true';

  get enabled() { return !!this.key; }

  private input(source: SourceDto, item: ArticleDto) {
    return { company: source.name, homepage: source.homepageUrl, feed: source.feedUrl,
      unofficial_feed: source.unofficial ?? false, title: item.originalTitle, url: item.url,
      published_at: item.publishedAt, available_excerpt: item.originalSummary };
  }

  fingerprint(source: SourceDto, item: ArticleDto) {
    return createHash('sha256').update(JSON.stringify([this.prompt, this.model, this.research, schema, this.input(source, item)])).digest('hex');
  }

  async edit(source: SourceDto, item: ArticleDto, fingerprint: string): Promise<ArticleDto> {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key! },
        signal: AbortSignal.timeout(65_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: this.prompt }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(this.input(source, item)) }] }],
          tools: this.research ? [{ googleSearch: {} }, { urlContext: {} }] : undefined,
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 12000 },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Gemini HTTP ${response.status}`);
      }
      const candidate = (await response.json() as GeminiResponse).candidates?.[0];
      if (candidate?.finishReason !== 'STOP') throw new Error('Gemini did not finish the article');
      const output = candidate.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('');
      const article = validateArticle(JSON.parse(output ?? ''), item.url);
      const grounding = (candidate.groundingMetadata?.groundingChunks ?? []).flatMap(chunk => {
        const url = httpsUrl(chunk.web?.uri);
        return url ? [{ url, title: (chunk.web?.title || '').slice(0, 200) }] : [];
      }).slice(0, 20);
      return { ...item, titleUk: article.title, summaryUk: article.summary, whyItMatters: article.importance_reason,
        category: article.category, importance: article.important ? 'high' : 'low', freeAccess: 'unknown',
        aiMetadata: { editorial_fingerprint: fingerprint, model: this.model, researched: grounding.length > 0, grounding, article } };
    } catch (error) {
      const message = error instanceof Error && /^Gemini HTTP \d+$/.test(error.message) ? error.message : 'Gemini editorial response unavailable or invalid';
      throw new ServiceUnavailableException(message);
    }
  }
}

function httpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return;
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && !url.username && !url.password) return url.href;
}

function validateArticle(raw: unknown, originalUrl: string) {
  function object(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
    return value as Record<string, unknown>;
  }
  function text(value: unknown, max: number, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('Invalid editorial text');
    return value.trim();
  }
  function choice<T extends string>(value: unknown, options: readonly T[]) {
    const selected = options.find(option => option === value);
    if (!selected) throw new Error('Invalid editorial value');
    return selected;
  }
  function list<T>(value: unknown, max: number, parse: (entry: unknown) => T) {
    if (!Array.isArray(value) || value.length > max) throw new Error('Invalid editorial list');
    return value.map(parse);
  }
  const a = object(raw);
  if (typeof a.important !== 'boolean') throw new Error('Invalid importance');
  const sources = list(a.sources, 12, entry => {
    const s = object(entry);
    const url = httpsUrl(s.url);
    if (!url) throw new Error('Invalid source URL');
    return { title: text(s.title, 240), url };
  });
  const original = httpsUrl(originalUrl);
  if (!original) throw new Error('Invalid original URL');
  if (!sources.some(source => source.url === original)) sources.unshift({ title: 'Першоджерело', url: original });
  const facts = list(a.facts, 16, entry => {
    const fact = object(entry);
    const url = httpsUrl(fact.url);
    if (!url || !sources.some(source => source.url === url)) throw new Error('Fact source is missing');
    return { claim: text(fact.claim, 750), status: choice(fact.status, evidence), url };
  });
  const editorial = object(a.editorial);
  return { title: text(a.title, 350), summary: text(a.summary, 2500), body: text(a.body, 16000),
    important: a.important, importance_reason: text(a.importance_reason, 1500), category: choice(a.category, CATEGORIES),
    sources, facts, comparisons: list(a.comparisons, 10, entry => text(entry, 1200)),
    confidence: choice(a.confidence, confidence), editorial: { angles: list(editorial.angles, 10, entry => text(entry, 100)),
      style: text(editorial.style, 200), limitations: text(editorial.limitations, 2000, true) } };
}
