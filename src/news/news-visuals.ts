/**
 * Structured visuals attached to a news item (charts, tables, key figures, timelines).
 * They come from two places: open-data adapters (Eurostat, NBU…) and an LLM data-extraction pass over the article.
 * Whatever the origin, everything goes through sanitizeVisuals(): the app only ever renders validated data.
 */

export const VISUAL_TYPES = [
  'stat', 'bar', 'column', 'line', 'area', 'donut', 'gauge', 'ranking', 'compare', 'timeline', 'table',
] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

export interface VisualSource {
  name: string;
  url?: string;
}

export interface NewsVisual {
  id: string;
  type: VisualType;
  title: string;
  caption?: string;
  unit?: string;
  source: VisualSource;
  labels?: string[];
  series?: Array<{ name: string; values: Array<number | null> }>;
  items?: Array<{ label: string; value: number; unit?: string; delta?: number; note?: string }>;
  max?: number;
  events?: Array<{ date: string; title: string; detail?: string }>;
  columns?: string[];
  rows?: string[][];
  /** 'extracted' = numbers quoted from the article; 'open_data' = official API; 'researched' = model-sourced with citation. */
  origin: 'extracted' | 'open_data' | 'researched';
}

export const MAX_VISUALS_PER_NEWS = 4;
const MAX_POINTS = 24;

function text(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function num(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e15 ? n : null;
}

function safeUrl(raw: unknown): string | undefined {
  const t = text(raw, 500);
  const parsed = t ? URL.parse(t) : null;
  return parsed && parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined;
}

export function sanitizeVisual(raw: unknown, origin: NewsVisual['origin'], index = 0): NewsVisual | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = text(r.type, 20) as VisualType;
  if (!VISUAL_TYPES.includes(type)) return null;
  const title = text(r.title, 120);
  if (title.length < 3) return null;

  const srcRaw = (r.source && typeof r.source === 'object' ? r.source : {}) as Record<string, unknown>;
  const sourceName = text(srcRaw.name, 80) || (origin === 'extracted' ? 'За даними статті' : '');
  if (!sourceName) return null;

  const out: NewsVisual = {
    id: `v${index}-${type}`,
    type,
    title,
    source: { name: sourceName, ...(safeUrl(srcRaw.url) ? { url: safeUrl(srcRaw.url) } : {}) },
    origin,
    ...(text(r.caption, 240) ? { caption: text(r.caption, 240) } : {}),
    ...(text(r.unit, 12) ? { unit: text(r.unit, 12) } : {}),
  };

  const labels = Array.isArray(r.labels) ? r.labels.map((l) => text(l, 40)).slice(0, MAX_POINTS) : [];
  const seriesRaw = Array.isArray(r.series) ? r.series : [];
  const series = seriesRaw
    .map((s) => {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const values = Array.isArray(o.values) ? o.values.slice(0, MAX_POINTS).map(num) : [];
      return { name: text(o.name, 40) || title.slice(0, 40), values };
    })
    .filter((s) => s.values.some((v) => v !== null))
    .slice(0, 4);
  const itemsRaw = Array.isArray(r.items) ? r.items : [];
  const items = itemsRaw
    .map((it) => {
      const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
      const value = num(o.value);
      const label = text(o.label, 50);
      if (value === null || !label) return null;
      const delta = num(o.delta);
      return {
        label,
        value,
        ...(text(o.unit, 12) ? { unit: text(o.unit, 12) } : {}),
        ...(delta !== null ? { delta } : {}),
        ...(text(o.note, 100) ? { note: text(o.note, 100) } : {}),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 12);

  switch (type) {
    case 'stat': {
      if (items.length < 1) return null;
      out.items = items.slice(0, 4);
      return out;
    }
    case 'gauge': {
      if (items.length < 1) return null;
      const max = num(r.max) ?? 100;
      if (max <= 0) return null;
      out.items = [items[0]];
      out.max = max;
      return out;
    }
    case 'bar':
    case 'column':
    case 'ranking':
    case 'donut': {
      // Accept either items [{label,value}] or labels + one series.
      let rows = items;
      if (rows.length === 0 && series[0] && labels.length) {
        rows = series[0].values
          .map((v, i) => (v === null || !labels[i] ? null : { label: labels[i], value: v }))
          .filter((x): x is { label: string; value: number } => x !== null);
      }
      if (rows.length < 2) return null;
      if (type === 'donut' && rows.some((x) => x.value < 0)) return null;
      out.items = rows.slice(0, type === 'donut' ? 7 : 12);
      return out;
    }
    case 'line':
    case 'area':
    case 'compare': {
      if (labels.length < 2 || series.length < 1) return null;
      const points = Math.min(labels.length, ...series.map((s) => s.values.length));
      if (points < 2) return null;
      out.labels = labels.slice(0, points);
      out.series = series.map((s) => ({ name: s.name, values: s.values.slice(0, points) }));
      return out;
    }
    case 'timeline': {
      const events = (Array.isArray(r.events) ? r.events : [])
        .map((e) => {
          const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
          const date = text(o.date, 24);
          const t = text(o.title, 120);
          return date && t ? { date, title: t, ...(text(o.detail, 200) ? { detail: text(o.detail, 200) } : {}) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 8);
      if (events.length < 2) return null;
      out.events = events;
      return out;
    }
    case 'table': {
      const columns = (Array.isArray(r.columns) ? r.columns : []).map((c) => text(c, 40)).filter(Boolean).slice(0, 5);
      const rows = (Array.isArray(r.rows) ? r.rows : [])
        .map((row) => (Array.isArray(row) ? row.slice(0, columns.length).map((c) => text(typeof c === 'number' ? String(c) : c, 80)) : null))
        .filter((row): row is string[] => Boolean(row) && row!.length === columns.length && row!.some(Boolean))
        .slice(0, 10);
      if (columns.length < 2 || rows.length < 2) return null;
      out.columns = columns;
      out.rows = rows;
      return out;
    }
    default:
      return null;
  }
}

export function sanitizeVisuals(raw: unknown, origin: NewsVisual['origin']): NewsVisual[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: NewsVisual[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of list.entries()) {
    const v = sanitizeVisual(entry, origin, i);
    if (!v) continue;
    const key = `${v.type}:${v.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_VISUALS_PER_NEWS) break;
  }
  return out;
}

/** JSON schema for the extraction request (kept permissive; sanitizeVisuals is the real gate). */
export const VISUALS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    heroCaptionUk: { type: 'string' },
    visuals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...VISUAL_TYPES] },
          title: { type: 'string' },
          caption: { type: 'string' },
          unit: { type: 'string' },
          source: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' } }, required: ['name'] },
          labels: { type: 'array', items: { type: 'string' } },
          series: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] },
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, delta: { type: 'number' }, note: { type: 'string' } },
              required: ['label', 'value'],
            },
          },
          max: { type: 'number' },
          events: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } }, required: ['date', 'title'] } },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['type', 'title', 'source'],
      },
    },
  },
  required: ['visuals'],
};

export function buildVisualsPrompt(news: { title: string; titleEn?: string; summary: string; body: string; category: string }): string {
  return `You are the data editor of a news app. Decide whether this story deserves a chart, table or key-figure card, and build it.

STRICT RULES
- Use ONLY numbers, dates and names that appear in the text below. Never invent, estimate or extrapolate a figure.
- If the text has no usable quantitative data (fewer than 2 comparable numbers, or only one number), return {"visuals": []}. Most stories need none; returning nothing is correct and preferred over a weak visual.
- Each visual needs "source": {"name": "<who published the figures, taken from the text>"}.
- Pick the most fitting type: stat (1-4 headline figures with optional delta), bar/column/ranking (compare categories), line/area (values over time; "labels" = periods, "series" = [{name, values}]), donut (shares of a whole, 2-7 slices), gauge (one value of a maximum, give "max"), compare (2-4 series over the same labels), timeline (dated events, 2-8), table (2-5 columns, 2-10 rows).
- Titles, labels, captions in Ukrainian. Keep units short ("%", "$ млрд", "млн").
- Maximum ${MAX_VISUALS_PER_NEWS} visuals, each telling a different part of the story.
- "heroCaptionUk": one neutral sentence (max 140 chars) that could caption the story's lead photo. No speculation about what the photo shows.

CATEGORY: ${news.category}
TITLE: ${news.title}${news.titleEn ? `\nORIGINAL TITLE: ${news.titleEn}` : ''}
SUMMARY: ${news.summary.slice(0, 1200)}
TEXT: ${news.body.slice(0, 5000)}`;
}
