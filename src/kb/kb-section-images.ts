/**
 * Section images for big articles and flagships: a cheap model reads the article and proposes, per section, what a
 * fitting, accurate picture would show and a search query; Wikimedia Commons (documentary photos of the real people,
 * places, objects) and Pixabay/Openverse/Pexels (neutral illustrative photos) are searched through their APIs. Figures carry the
 * section's words in `match`, so the app places each image after the right paragraph.
 */
import { cheapJson } from './kb-llm';
import type { ArticleFigure } from '../news/article-resources';
import { pickStockPhoto, type PhotoSearchOptions } from '../common/stock-photos';
import type { PhotoStorageService } from '../common/photo-storage.service';
import { searchCommonsImages } from '../news/resource-enrichment';

const SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string' },
          query_en: { type: 'string' },
          source: { type: 'string', enum: ['commons', 'stock'] },
          must_match: { type: 'array', items: { type: 'string' } },
          caption_en: { type: 'string' },
        },
        required: ['section', 'query_en', 'source', 'must_match', 'caption_en'],
      },
    },
  },
  required: ['images'],
};

const SYSTEM = `You are the photo editor of a serious news outlet. Choose images that inform, never decorate misleadingly.
For each chosen section propose ONE image:
- source "commons" for real, identifiable subjects (a named person, place, building, weapon system, vehicle, document,
  logo) — query with the exact name; must_match = words that must appear in the file title/description;
- source "stock" (Pixabay first, then Openverse and Pexels) only for neutral illustrations of a general concept (e.g. "power lines at night", "grain harvest");
  never use stock photos to depict a specific real event, person or victim.
Skip sections where no image would be accurate. No graphic violence.`;

function sections(body: string): Array<{ heading: string; text: string; index: number }> {
  const parts = body.split(/\n(?=## )/);
  return parts.map((p, index) => {
    const m = p.match(/^##\s+(.+)\n?/);
    return { heading: m ? m[1].trim() : '', text: (m ? p.slice(m[0].length) : p).trim(), index };
  }).filter((s) => s.text.length > 80);
}

export async function planSectionImages(title: string, body: string, max: number) {
  const secs = sections(body);
  if (!secs.length) return [];
  const prompt = `ARTICLE: ${title}\nPropose up to ${max} images.\n\n${secs.map((s) => `## ${s.heading || '(opening)'}\n${s.text.slice(0, 700)}`).join('\n\n')}`;
  const res = await cheapJson<{ images: Array<{ section: string; query_en: string; source: 'commons' | 'stock'; must_match: string[]; caption_en: string }> }>(
    'summary', SYSTEM, prompt, SCHEMA, 1500,
  );
  return (res?.json?.images ?? []).slice(0, max).map((img) => {
    const sec = secs.find((s) => s.heading && img.section && (s.heading.toLowerCase().includes(img.section.toLowerCase()) || img.section.toLowerCase().includes(s.heading.toLowerCase()))) ?? secs[0];
    return { ...img, sectionIndex: sec.index, sectionCount: Math.max(1, body.split(/\n(?=## )/).length), heading: sec.heading, firstWords: sec.text.split(/\s+/).slice(0, 12) };
  });
}

export async function findSectionFigures(title: string, body: string, max: number, usedUrls: Set<string>, options: PhotoSearchOptions & { storage?: PhotoStorageService } = {}): Promise<ArticleFigure[]> {
  const plans = await planSectionImages(title, body, max).catch(() => []);
  const figures: ArticleFigure[] = [];
  for (const p of plans) {
    const match = [...new Set([...p.heading.split(/\s+/), ...p.firstWords].map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')).filter((w) => w.length > 3))].slice(0, 12);
    const position = Math.min(0.98, (p.sectionIndex + 0.5) / p.sectionCount);
    if (p.source === 'commons') {
      const found = await searchCommonsImages(p.query_en, { limit: 1, mustMatchTerms: p.must_match, usedUrls }).catch(() => []);
      const f = found[0];
      if (f) {
        usedUrls.add(f.url);
        figures.push({ ...f, id: `sec-${p.sectionIndex}-${f.id}`, caption: f.caption || p.caption_en, match, position });
      }
      if (f) continue;
      // Documentary fallback still requires exact subject terms; generic stock is never used here.
      if (!options.storage?.configured || !p.must_match?.length) continue;
    }
    if (!options.storage?.configured) continue;
    const best = await pickStockPhoto(p.query_en, {
      ...options, query: p.query_en, usedUrls,
      ...(p.source === 'commons' ? { providers: ['openverse' as const], mustMatchTerms: p.must_match } : {}),
      accept: (photo) => options.storage!.persist(photo),
    });
    if (best) {
      usedUrls.add(best.originalUrl || best.url);
      usedUrls.add(best.url);
      figures.push({
        ...best, id: `sec-${p.sectionIndex}-${best.provider}-${best.id}`, kind: 'photo',
        caption: p.source === 'commons' ? best.alt : `Ілюстративне фото. ${p.caption_en}`,
        link: best.photoPageUrl, match, position, origin: 'stock',
      });
    }
  }
  return figures;
}
