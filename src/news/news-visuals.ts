/**
 * Structured visuals attached to a news item (charts, tables, timelines, flows, scenarios, graphs, market reactions).
 * They come from two places: open-data adapters (Eurostat, NBU...) and an LLM data-extraction pass over the article.
 * Whatever the origin, everything goes through sanitizeVisuals(): the app only ever renders validated data.
 */

export const VISUAL_TYPES = [
  'stat',
  'bar',
  'column',
  'line',
  'area',
  'donut',
  'gauge',
  'ranking',
  'compare',
  'timeline',
  'table',
  // Extended animated visual catalog
  'step_flow',
  'impact_bars',
  'scenarios',
  'network_graph',
  'market_chart',
  'pros_cons',
  'heatmap',
  'funnel',
  'split_ratio',
  'before_after',
  'range',
  'waterfall',
  'checklist',
] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

export interface VisualSource {
  name: string;
  url?: string;
}

export interface VisualTimelineEvent {
  date: string;
  title: string;
  detail?: string;
  tone?: 'normal' | 'alert' | 'success' | 'muted';
}

export interface VisualStepNode {
  label: string;
  sub?: string;
  tone?: 'normal' | 'alert' | 'success';
  status?: 'done' | 'in_progress' | 'pending' | 'blocked';
}

export interface VisualScenarioCard {
  name: string;
  probability: number;
  detail: string;
  tone?: 'neutral' | 'negative' | 'positive';
}

export interface VisualNetworkNode {
  label: string;
  role?: string;
  tone?: 'primary' | 'info' | 'warning' | 'danger' | 'success';
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
  events?: VisualTimelineEvent[];
  columns?: string[];
  rows?: string[][];
  steps?: VisualStepNode[];
  scenarios?: VisualScenarioCard[];
  center?: { label: string; sub?: string };
  nodes?: VisualNetworkNode[];
  pros?: string[];
  cons?: string[];
  prosLabel?: string;
  consLabel?: string;
  rowLabels?: string[];
  matrix?: number[][];
  before?: { label: string; detail: string };
  after?: { label: string; detail: string };
  ranges?: Array<{ label: string; low: number; high: number; value?: number; note?: string }>;
  /** Editorial placement, independent of the app's navigation and controls. Paragraphs are 1-based. */
  placement?: {
    slot: 'after_title' | 'after_summary' | 'after_context' | 'body' | 'after_body';
    afterParagraph?: number;
    anchor?: string;
    position?: number;
  };
  /** 'extracted' = numbers quoted from the article; 'open_data' = official API; 'researched' = model-sourced with citation. */
  origin: 'extracted' | 'open_data' | 'researched';
}

export const MAX_VISUALS_PER_NEWS = 6;
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

function parseTone<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const s = text(raw, 20) as T;
  return allowed.includes(s) ? s : fallback;
}

export function sanitizeVisual(raw: unknown, origin: NewsVisual['origin'], index = 0): NewsVisual | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = text(r.type, 24) as VisualType;
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
  const placement = r.placement && typeof r.placement === 'object' ? r.placement as Record<string, unknown> : null;
  if (placement && ['after_title', 'after_summary', 'after_context', 'body', 'after_body'].includes(String(placement.slot))) {
    const paragraph = num(placement.afterParagraph);
    const position = num(placement.position);
    out.placement = {
      slot: placement.slot as NonNullable<NewsVisual['placement']>['slot'],
      ...(paragraph !== null && Number.isInteger(paragraph) && paragraph >= 1 && paragraph <= 2000 ? { afterParagraph: paragraph } : {}),
      ...(text(placement.anchor, 180) ? { anchor: text(placement.anchor, 180) } : {}),
      ...(position !== null && position >= 0 && position <= 1 ? { position } : {}),
    };
  }

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
      if (max <= 0 || items[0].value < 0 || items[0].value > max) return null;
      out.items = [items[0]];
      out.max = max;
      return out;
    }
    case 'bar':
    case 'column':
    case 'ranking':
    case 'donut':
    case 'split_ratio':
    case 'funnel': {
      let rows = items;
      if (rows.length === 0 && series[0] && labels.length) {
        rows = series[0].values
          .map((v, i) => (v === null || !labels[i] ? null : { label: labels[i], value: v }))
          .filter((x): x is { label: string; value: number } => x !== null);
      }
      if (rows.length < (type === 'funnel' ? 3 : 2)) return null;
      if ((type === 'donut' || type === 'split_ratio') && rows.some((x) => x.value < 0)) return null;
      if ((type === 'donut' || type === 'split_ratio') && rows.every((x) => x.value === 0)) return null;
      if (type === 'funnel' && rows.some((x) => x.value <= 0)) return null;
      if (type === 'funnel' && rows.some((row, i) => i > 0 && row.value > rows[i - 1].value)) return null;
      out.items = rows.slice(0, type === 'donut' ? 7 : type === 'split_ratio' || type === 'funnel' ? 6 : 12);
      return out;
    }
    case 'impact_bars': {
      if (items.length < 2) return null;
      out.items = items.slice(0, 8);
      return out;
    }
    case 'waterfall': {
      if (items.length < 2 || new Set(items.map((item) => item.unit || out.unit || '')).size > 1) return null;
      out.items = items.slice(0, 8);
      return out;
    }
    case 'before_after': {
      const state = (raw: unknown) => {
        const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const label = text(o.label, 60);
        const detail = text(o.detail, 320);
        return label && detail.length >= 3 ? { label, detail } : null;
      };
      const before = state(r.before);
      const after = state(r.after);
      if (!before || !after || before.detail === after.detail) return null;
      out.before = before;
      out.after = after;
      return out;
    }
    case 'range': {
      const ranges = (Array.isArray(r.ranges) ? r.ranges : []).map((entry) => {
        const o = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const label = text(o.label, 60);
        const low = num(o.low);
        const high = num(o.high);
        const value = num(o.value);
        if (!label || low === null || high === null || low > high || (value !== null && (value < low || value > high))) return null;
        return { label, low, high, ...(value !== null ? { value } : {}), ...(text(o.note, 160) ? { note: text(o.note, 160) } : {}) };
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null).slice(0, 6);
      if (!ranges.length) return null;
      out.ranges = ranges;
      return out;
    }
    case 'checklist': {
      const steps = (Array.isArray(r.steps) ? r.steps : []).map((entry): VisualStepNode | null => {
        const o = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        const label = text(o.label, 80);
        if (!label || !['done', 'in_progress', 'pending', 'blocked'].includes(String(o.status))) return null;
        return { label, status: o.status as VisualStepNode['status'], ...(text(o.sub, 160) ? { sub: text(o.sub, 160) } : {}) };
      }).filter((entry): entry is VisualStepNode => entry !== null).slice(0, 8);
      if (steps.length < 2) return null;
      out.steps = steps;
      return out;
    }
    case 'line':
    case 'area':
    case 'compare':
    case 'market_chart': {
      if (labels.length < 2 || series.length < 1) return null;
      const points = Math.min(labels.length, ...series.map((s) => s.values.length));
      if (points < 2) return null;
      const slicedSeries = series
        .map((s) => ({ name: s.name, values: s.values.slice(0, points) }))
        .filter((s) => s.values.filter((v) => v !== null).length >= 2);
      if (slicedSeries.length < 1) return null;
      out.labels = labels.slice(0, points);
      out.series = slicedSeries;
      if (type === 'market_chart' && items.length) out.items = items.slice(0, 4);
      return out;
    }
    case 'timeline': {
      const events = (Array.isArray(r.events) ? r.events : [])
        .map((e): VisualTimelineEvent | null => {
          const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
          const date = text(o.date, 28);
          const t = text(o.title, 120);
          if (!date || !t) return null;
          const tone = o.tone ? parseTone(o.tone, ['normal', 'alert', 'success', 'muted'] as const, 'normal') : undefined;
          return {
            date,
            title: t,
            ...(text(o.detail, 200) ? { detail: text(o.detail, 200) } : {}),
            ...(tone && tone !== 'normal' ? { tone } : {}),
          };
        })
        .filter((x): x is VisualTimelineEvent => x !== null)
        .slice(0, 8);
      if (events.length < 2) return null;
      out.events = events;
      return out;
    }
    case 'step_flow': {
      const steps = (Array.isArray(r.steps) ? r.steps : [])
        .map((s): VisualStepNode | null => {
          const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
          const label = text(o.label, 48);
          if (!label) return null;
          const tone = o.tone ? parseTone(o.tone, ['normal', 'alert', 'success'] as const, 'normal') : undefined;
          return {
            label,
            ...(text(o.sub, 36) ? { sub: text(o.sub, 36) } : {}),
            ...(tone && tone !== 'normal' ? { tone } : {}),
          };
        })
        .filter((x): x is VisualStepNode => x !== null)
        .slice(0, 6);
      if (steps.length < 3) return null;
      out.steps = steps;
      return out;
    }
    case 'scenarios': {
      const scenarios = (Array.isArray(r.scenarios) ? r.scenarios : [])
        .map((sc) => {
          const o = (sc && typeof sc === 'object' ? sc : {}) as Record<string, unknown>;
          const name = text(o.name, 40);
          const detail = text(o.detail, 140);
          const prob = num(o.probability);
          if (!name || !detail || prob === null || prob < 0 || prob > 100) return null;
          const tone = o.tone ? parseTone(o.tone, ['neutral', 'negative', 'positive'] as const, 'neutral') : undefined;
          return { name, probability: Math.round(prob), detail, ...(tone ? { tone } : {}) };
        })
        .filter((x): x is VisualScenarioCard => x !== null)
        .slice(0, 4);
      if (scenarios.length < 2) return null;
      out.scenarios = scenarios;
      return out;
    }
    case 'network_graph': {
      const cRaw = (r.center && typeof r.center === 'object' ? r.center : {}) as Record<string, unknown>;
      const cLabel = text(cRaw.label, 40);
      const nodes = (Array.isArray(r.nodes) ? r.nodes : [])
        .map((n) => {
          const o = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
          const label = text(o.label, 36);
          if (!label) return null;
          const tone = o.tone ? parseTone(o.tone, ['primary', 'info', 'warning', 'danger', 'success'] as const, 'primary') : undefined;
          return {
            label,
            ...(text(o.role, 30) ? { role: text(o.role, 30) } : {}),
            ...(tone ? { tone } : {}),
          };
        })
        .filter((x): x is VisualNetworkNode => x !== null)
        .slice(0, 6);
      if (!cLabel || nodes.length < 3) return null;
      out.center = { label: cLabel, ...(text(cRaw.sub, 30) ? { sub: text(cRaw.sub, 30) } : {}) };
      out.nodes = nodes;
      return out;
    }
    case 'pros_cons': {
      const pros = (Array.isArray(r.pros) ? r.pros : []).map((p) => text(p, 140)).filter(Boolean).slice(0, 5);
      const cons = (Array.isArray(r.cons) ? r.cons : []).map((c) => text(c, 140)).filter(Boolean).slice(0, 5);
      if (pros.length < 1 || cons.length < 1) return null;
      out.pros = pros;
      out.cons = cons;
      if (text(r.prosLabel, 40)) out.prosLabel = text(r.prosLabel, 40);
      if (text(r.consLabel, 40)) out.consLabel = text(r.consLabel, 40);
      return out;
    }
    case 'heatmap': {
      const columns = (Array.isArray(r.columns) ? r.columns : []).map((c) => text(c, 28)).filter(Boolean).slice(0, 5);
      const rowLabels = (Array.isArray(r.rowLabels) ? r.rowLabels : []).map((l) => text(l, 32)).filter(Boolean).slice(0, 5);
      const matrixRaw = Array.isArray(r.matrix) ? r.matrix : [];
      if (columns.length < 2 || rowLabels.length < 2 || matrixRaw.length < rowLabels.length) return null;
      const matrix: number[][] = [];
      for (let ri = 0; ri < rowLabels.length; ri += 1) {
        const rowRaw = matrixRaw[ri];
        if (!Array.isArray(rowRaw) || rowRaw.length < columns.length) return null;
        const parsedRow = rowRaw.slice(0, columns.length).map(num);
        if (parsedRow.some((v) => v === null)) return null;
        matrix.push(parsedRow as number[]);
      }
      out.columns = columns;
      out.rowLabels = rowLabels;
      out.matrix = matrix;
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
          placement: {
            type: 'object',
            properties: {
              slot: { type: 'string', enum: ['after_title', 'after_summary', 'after_context', 'body', 'after_body'] },
              afterParagraph: { type: 'integer' }, anchor: { type: 'string' }, position: { type: 'number' },
            },
            required: ['slot'],
          },
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
          events: {
            type: 'array',
            items: {
              type: 'object',
              properties: { date: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, tone: { type: 'string' } },
              required: ['date', 'title'],
            },
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, sub: { type: 'string' }, tone: { type: 'string' }, status: { type: 'string', enum: ['done', 'in_progress', 'pending', 'blocked'] } },
              required: ['label'],
            },
          },
          scenarios: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, probability: { type: 'number' }, detail: { type: 'string' }, tone: { type: 'string' } },
              required: ['name', 'probability', 'detail'],
            },
          },
          center: { type: 'object', properties: { label: { type: 'string' }, sub: { type: 'string' } }, required: ['label'] },
          nodes: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, role: { type: 'string' }, tone: { type: 'string' } }, required: ['label'] },
          },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          prosLabel: { type: 'string' },
          consLabel: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          rowLabels: { type: 'array', items: { type: 'string' } },
          matrix: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          before: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' } }, required: ['label', 'detail'] },
          after: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' } }, required: ['label', 'detail'] },
          ranges: {
            type: 'array', items: {
              type: 'object', properties: { label: { type: 'string' }, low: { type: 'number' }, high: { type: 'number' }, value: { type: 'number' }, note: { type: 'string' } },
              required: ['label', 'low', 'high'],
            },
          },
        },
        required: ['type', 'title', 'source'],
      },
    },
  },
  required: ['visuals'],
};

export function buildVisualsPrompt(news: { title: string; titleEn?: string; summary: string; body: string; category: string }): string {
  return `You are the visual data editor of a tech & world news app. Build clear, high-impact visual cards that illustrate this story accurately.

STRICT RULES
- Use ONLY numbers, dates, entities, market moves, probabilities, and events explicitly mentioned in the text below. Never invent or guess figures!
- If the text only supports structural visuals without fake numbers (such as step_flow, timeline, network_graph, pros_cons), you MAY build those strictly from facts in the text.
- If the text has neither quantitative facts nor clear structured stages/entities/arguments, return {"visuals": []}.
- Each visual needs "source": {"name": "<who published the figures/facts, taken from the text>"}.
- Choose the best visual types from this catalog:
  1. "stat": 1-4 KPI headline cards (items: [{label, value, unit?, delta?, note?}])
  2. "step_flow": 3-6 chronological stages of an event (steps: [{label, sub?, tone?: "normal"|"alert"|"success"}])
  3. "timeline": 2-8 timestamped/dated milestones (events: [{date, title, detail?, tone?: "normal"|"alert"|"success"|"muted"}])
  4. "impact_bars": 2-8 positive/negative impact percentages or deltas (items: [{label, value, unit?}])
  5. "scenarios": 2-4 explicitly stated risk/outcome scenarios with probabilities 0-100 (scenarios: [{name, probability, detail, tone?: "neutral"|"negative"|"positive"}])
  6. "network_graph": central event/subject + 3-6 participants/stakeholders (center: {label, sub?}, nodes: [{label, role?, tone?: "primary"|"info"|"warning"|"danger"|"success"}])
  7. "market_chart": 1-4 market/stock/index series over periods (labels, series, optional items for final % moves)
  8. "bar" / "column" / "ranking": compare categories (items: [{label, value, unit?}])
  9. "line" / "area" / "compare": values over time (labels, series)
  10. "donut" / "split_ratio": shares of a whole (items, non-negative)
  11. "gauge": single progress/utilization metric out of max (items: [one], max)
  12. "funnel": 3-6 decreasing funnel stages (items)
  13. "heatmap": 2D intensity grid (columns, rowLabels, matrix of numbers)
  14. "pros_cons": explicit arguments/advantages vs risks/criticisms (pros: [...], cons: [...], prosLabel?, consLabel?)
  15. "table": 2-5 columns, 2-10 rows
  16. "before_after": an explicitly described change to a product, rule or situation; before/after: {label, detail}.
  17. "range": scientific estimates or forecasts with EXPLICIT bounds; ranges: [{label, low, high, value?, note?}], shared unit.
      Never infer bounds or label an ordinary range as a confidence interval unless the text states this.
  18. "waterfall": 2-8 signed additive changes with the SAME unit (items). Each item is a contribution starting from zero;
      the app computes the net change. Never mix a starting balance/total with changes or mix percentages with currency.
  19. "checklist": 2-8 verified milestones with steps: [{label, sub?, status: "done"|"in_progress"|"pending"|"blocked"}].
      A planned event is "pending", never "done". Do not infer completion from silence.
- Match format to the story: product/hardware releases → before_after, comparison table; science → range or measured data;
  policy/law → before_after and effective-date timeline; earnings/budgets → waterfall or market_chart;
  launches/ongoing events → checklist, step_flow or timeline; stakeholders → network_graph; explicit pros/risks → pros_cons.
  Use existing supported types only. Do not choose a chart merely because it is animated. No unsupported map coordinates.
- Titles, labels, captions, roles in Ukrainian. Keep units short ("%", "$ млрд", "млн", "хв").
- Maximum ${MAX_VISUALS_PER_NEWS} visuals, each showing a different dimension of the story.
- Each visual MUST include "placement": {"slot": "after_title"|"after_summary"|"after_context"|"body"|"after_body"}.
  Place it where it explains the adjacent text: "after_title" for a short lead fact, "after_summary" for an overview,
  "after_context" after why-it-matters, "body" next to the relevant numbered paragraph, "after_body" for a recap.
  For "body", add "afterParagraph" (the 1-based P number below), "anchor" (an exact short quote from that paragraph),
  and "position" (0..1 through the full text, for translated paragraphs). Prefer body placement; spread cards out.
  Never put more than two visuals together. Do not modify navigation, source attribution or safety notices.
- "heroCaptionUk": one neutral sentence (max 140 chars) that could caption the story's lead photo.

CATEGORY: ${news.category}
TITLE: ${news.title}${news.titleEn ? `\nORIGINAL TITLE: ${news.titleEn}` : ''}
SUMMARY: ${news.summary.slice(0, 1200)}
TEXT (numbered paragraphs):\n${news.body.split(/\n\s*\n|\n(?=##\s)/).map((p) => p.trim()).filter(Boolean)
    .map((p, i) => `[P${i + 1}] ${p}`).join('\n\n').slice(0, 24000)}`;
}
