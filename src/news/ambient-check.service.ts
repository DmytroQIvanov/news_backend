/**
 * Decides whether the faint background picture of an article really fits the story.
 *
 * The ambient image is picked by keywords (stock photo search), so it can be unrelated (a concrete texture under a bridge
 * attack). Gemma looks at the picture (when the model accepts images) together with the article's title and summary and
 * answers fits / score / reason. The verdict is stored in media.ambientBg.gemma; the website shows a background only when
 * fits is true. Gemma has no daily request cap, so this does not touch the Gemini budget.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { postGeminiDecisions } from '../common/decision-client';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';

const SCHEMA = {
  type: 'object',
  properties: { fits: { type: 'boolean' }, score: { type: 'number' }, reason: { type: 'string' } },
  required: ['fits', 'score', 'reason'],
};

const PROMPT = (title: string, summary: string, alt: string, credit: string) => `You are a picture editor for a news site. A faint (about 7% opacity) decorative background picture
will sit behind the text of the article below. Decide whether the picture is relevant to the story: it must show something the story is
about (the place, the object, the activity, the theme). Reject generic textures, unrelated scenery, people who could be mistaken for
the story's subjects, logos, text, or anything that could mislead or look inappropriate for a news story (violence, victims, children).

ARTICLE TITLE: ${title}
ARTICLE SUMMARY: ${summary}
PICTURE TAGS / ALT: ${alt}
PICTURE CREDIT: ${credit}

Answer JSON: {"fits": boolean, "score": number from 0 to 1, "reason": "one short sentence"}. fits is true only when score >= 0.65.`;

export interface AmbientVerdict { fits: boolean; score: number; reason: string; model: string; vision: boolean; at: string }
export type AmbientJudge = (input: { title: string; summary: string; alt: string; credit: string; imageUrl: string }) => Promise<AmbientVerdict | null>;

async function fetchImage(url: string): Promise<{ mime: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 900_000) return null; // keep requests small: the image is only a thumbnail-sized judgement
    return { mime, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

export async function judgeAmbientWithDecisions(input: {
  title: string;
  summary: string;
  alt: string;
  credit: string;
}): Promise<AmbientVerdict | null> {
  if (process.env.AMBIENT_DECISIONS === 'false' || !process.env.GEMINI_API_KEY?.trim()) return null;
  const text = [
    `ARTICLE TITLE: ${input.title.slice(0, 300)}`,
    `ARTICLE SUMMARY: ${input.summary.slice(0, 900)}`,
    `PICTURE TAGS / ALT: ${input.alt.slice(0, 300)}`,
    `PICTURE CREDIT: ${input.credit.slice(0, 80)}`,
  ].join('\n');
  try {
    const res = await postGeminiDecisions({
      purpose: 'ambient_check',
      priority: 'low',
      input: text,
      questions: {
        fits: {
          type: 'noul',
          instructions: 'Is this decorative background picture relevant and appropriate for the news article? True only if the picture tags depict the place, object, activity, or theme of the story (reject generic textures, unrelated scenery, misleading subjects, logos/text, or inappropriate imagery).',
        },
      },
    });
    const score = Math.max(0, Math.min(1, Number(res.answers.fits?.noul ?? 0)));
    const conf = Number(res.answers.fits?.confidence ?? 0);
    return {
      fits: score >= 0.65,
      score,
      reason: `${res.modelUsed} text-only (p=${score.toFixed(2)}, conf=${conf.toFixed(2)})`,
      model: res.modelUsed,
      vision: false,
      at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export const gemmaJudge: AmbientJudge = async ({ title, summary, alt, credit, imageUrl }) => {
  const prompt = PROMPT(title.slice(0, 300), summary.slice(0, 900), alt.slice(0, 300), credit.slice(0, 80));
  const image = await fetchImage(imageUrl);
  const call = async (withImage: boolean) => postGeminiGenerateContent({
    apiKey: process.env.GEMINI_API_KEY!.trim(),
    candidateModels: ['gemma-4-31b-it'],
    priority: 'low',
    statsTask: 'ambient_check',
    timeoutMs: 90_000,
    jsonSchemaWhenNoTools: SCHEMA,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }, ...(withImage && image ? [{ inlineData: { mimeType: image.mime, data: image.data } }] : [])] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: 'application/json', responseJsonSchema: SCHEMA },
    },
  });
  let vision = Boolean(image);
  let data: unknown;
  if (vision) {
    try {
      ({ data } = await call(true));
    } catch {
      vision = false; // vision failed: prefer fast Decisions API for text-only judgment, then Gemma text-only fallback
      const dec = await judgeAmbientWithDecisions({ title, summary, alt, credit });
      if (dec) return dec;
      ({ data } = await call(false));
    }
  } else {
    const dec = await judgeAmbientWithDecisions({ title, summary, alt, credit });
    if (dec) return dec;
    ({ data } = await call(false));
  }
  const text = ((data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }).candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  const parsed = JSON.parse(text.replace(/```(?:json)?/g, '').trim()) as { fits?: boolean; score?: number; reason?: string };
  const score = Math.max(0, Math.min(1, Number(parsed.score)));
  if (!Number.isFinite(score)) return null;
  return { fits: Boolean(parsed.fits) && score >= 0.65, score, reason: String(parsed.reason ?? '').slice(0, 200), model: 'gemma-4-31b-it', vision, at: new Date().toISOString() };
};

@Injectable()
export class AmbientCheckService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmbientCheckService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  judge: AmbientJudge = gemmaJudge;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.AMBIENT_CHECK === 'false' || !process.env.GEMINI_API_KEY?.trim()) return;
    this.timer = setTimeout(() => void this.loop(), 120_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`Ambient check failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), 3 * 60_000);
    }
  }

  async runOnce(limit = 4) {
    const out = { checked: 0, fits: 0, rejected: 0, failed: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const { rows } = await this.db.query<{ id: string; title: string; summary: string; bg: { url: string; alt?: string; credit?: string } }>(
        `SELECT n.id, COALESCE(n.ai_metadata->'article'->>'title', n.original_title) AS title,
                COALESCE(n.ai_metadata->'article'->>'summary', n.summary_uk, n.original_summary, '') AS summary,
                n.media->'ambientBg' AS bg
         FROM news_items n
         WHERE n.status = 'published' AND n.media->'ambientBg'->>'url' IS NOT NULL AND n.media->'ambientBg'->'gemma' IS NULL
         ORDER BY n.published_at DESC NULLS LAST LIMIT $1`,
        [limit],
      );
      for (const r of rows) {
        if (this.stopped) break;
        const verdict = await this.judge({ title: r.title, summary: r.summary, alt: r.bg.alt ?? '', credit: r.bg.credit ?? '', imageUrl: r.bg.url }).catch(() => null);
        if (!verdict) { out.failed += 1; continue; }
        await this.db.query(
          `UPDATE news_items SET media = jsonb_set(media, '{ambientBg,gemma}', $2::jsonb, true) WHERE id = $1 AND media->'ambientBg' IS NOT NULL`,
          [r.id, JSON.stringify(verdict)],
        );
        out.checked += 1;
        if (verdict.fits) out.fits += 1; else out.rejected += 1;
      }
    } finally {
      this.running = false;
    }
    if (out.checked || out.failed) this.logger.log(`Ambient check: ${JSON.stringify(out)}`);
    return out;
  }
}
