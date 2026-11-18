import type { DatabaseService } from '../database/database.service';

export interface DataPoint { period: string; value: string; knownAt: string; versionId: number; historyComplete: boolean; snapshotIds: number[] }
export interface DataAttachment {
  key: string;
  kind: 'series' | 'record' | 'financial_fact';
  id: number;
  title: string;
  provider: string;
  url: string;
  asOf: string;
  referenceDate: string;
  score: number;
  evidence: { entityPath: number[]; relations: string[]; keywordHits: string[]; role: string };
  unit?: string;
  geo?: string;
  points?: DataPoint[];
  value?: string;
  periodStart?: string | null;
  periodEnd?: string;
  filedOn?: string;
  accession?: string;
  snapshotIds?: number[];
  excerpt: string;
}

const GENERIC = new Set(['nbu','нбу','official','офіційний','ukraine','україна','ukrainian','usa','world','global','eu']);
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function matches(text: string, term: string): boolean {
  const clean = normalize(term);
  if (!clean || GENERIC.has(clean) || clean.length < 3) return false;
  if (/^[а-яіїєґ]{5,}$/u.test(clean)) return text.split(' ').some((word) => word.startsWith(clean.slice(0, -2)));
  return ` ${text} `.includes(` ${clean} `);
}

export function matchDataKeywords(text: string, keywords: string[]): string[] {
  const clean = normalize(text);
  return [...new Set(keywords.filter((keyword) => matches(clean, keyword)))];
}

const FINANCIAL_TERMS: Array<[RegExp, string[]]> = [
  [/revenue|sales/i, ['revenue','sales','виручка','дохід','доходи']],
  [/income|profit|earnings/i, ['profit','earnings','income','прибуток','збиток']],
  [/asset/i, ['assets','активи']], [/liabilit|debt/i, ['debt','liabilities','борг','зобовʼязання']],
  [/cash|operatingactivities/i, ['cash flow','cash','грошовий потік','грошові кошти']],
  [/share|stock/i, ['shares','stock','акції']], [/employee/i, ['employees','працівники','персонал']],
];
export function financialKeywords(concept: string): string[] {
  return [...new Set([concept.replace(/([a-z])([A-Z])/g, '$1 $2'), ...FINANCIAL_TERMS.filter(([pattern]) => pattern.test(concept)).flatMap(([, terms]) => terms)])];
}

export function seriesCurrencyMatches(text: string, code: string): boolean {
  if (!code.startsWith('exchange:')) return true;
  const currencies: Record<string, string[]> = { USD: ['usd','dollar','долар'], EUR: ['eur','euro','євро'], PLN: ['pln','zloty','злотий'] };
  const wanted = Object.entries(currencies).filter(([, words]) => matchDataKeywords(text, words).length).map(([currency]) => currency);
  return !wanted.length || wanted.includes(code.split(':')[1].toUpperCase());
}

interface Scope { id: number; depth: number; path: number[]; relations: string[] }
const date = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);

/** Deterministic retrieval: all periods AND publication/known-at dates are bounded by the event cutoff. */
export async function selectEventData(db: DatabaseService, eventId: number, category: string | null, entityIds: number[], asOf: string, text: string, options: { referenceDate?: string; persist?: boolean } = {}): Promise<DataAttachment[]> {
  const at = new Date(asOf);
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid data cutoff');
  const cutoff = at.toISOString();
  const referenceDate = new Date(options.referenceDate ?? cutoff).toISOString().slice(0,10);
  if (referenceDate > cutoff.slice(0,10)) throw new Error('Reference date exceeds knowledge cutoff');
  const scopes = (await db.query<Scope>(
    `WITH RECURSIVE scope(id, depth, path, relations) AS (
       SELECT id, 0, ARRAY[id]::bigint[], ARRAY[]::text[] FROM unnest($1::bigint[]) id
       UNION ALL
       SELECT CASE WHEN r.from_entity_id=s.id THEN r.to_entity_id ELSE r.from_entity_id END, s.depth+1,
              s.path || CASE WHEN r.from_entity_id=s.id THEN r.to_entity_id ELSE r.from_entity_id END,
              s.relations || (r.relation || ':' || CASE WHEN r.from_entity_id=s.id THEN 'forward' ELSE 'reverse' END)
       FROM scope s JOIN kb.entities current_entity ON current_entity.id=s.id
       JOIN kb.entity_relations r ON r.from_entity_id=s.id OR r.to_entity_id=s.id
       WHERE s.depth<2 AND r.origin IN ('fact','wikidata','dataset','manual') AND r.weight>=0.8
         AND r.relation IN ('own','owns','subsidiary_of','parent_company','part_of','headquarters','located_in')
         AND current_entity.kind NOT IN ('place','facility')
         AND (r.relation NOT IN ('headquarters','located_in','part_of') OR r.from_entity_id=s.id)
         AND (r.valid_from IS NULL OR r.valid_from<=$3::date) AND (r.valid_to IS NULL OR r.valid_to>=$3::date)
         AND r.first_seen<=$2::timestamptz
         AND NOT (CASE WHEN r.from_entity_id=s.id THEN r.to_entity_id ELSE r.from_entity_id END=ANY(s.path))
     ) SELECT DISTINCT ON (id) id::int, depth, path::int[], relations FROM scope ORDER BY id, depth, path`,
    [[...new Set(entityIds)].slice(0, 40), cutoff, referenceDate],
  )).rows;
  const scopeById = new Map(scopes.map((scope) => [Number(scope.id), scope]));
  const scopeIds = [...scopeById.keys()];
  const out: DataAttachment[] = [];
  const evidence = (scope: Scope | undefined, hits: string[], role: string): DataAttachment['evidence'] => ({
    entityPath: scope?.path ?? [], relations: scope?.relations ?? [], keywordHits: hits, role,
  });

  const series = (await db.query(
    `SELECT s.*, se.entity_id AS matched_entity, se.role,
       (SELECT json_agg(json_build_object('period',v.period,'value',v.value::text,'knownAt',v.recorded_at,
                  'versionId',v.id,'historyComplete',v.history_complete,'snapshotIds',
                  (SELECT coalesce(json_agg(vs.snapshot_id),'[]') FROM kb.observation_version_sources vs WHERE vs.version_id=v.id)) ORDER BY v.period_start)
        FROM (SELECT DISTINCT ON (v.period) v.* FROM kb.observation_versions v
              WHERE v.series_id=s.id AND v.period_end<=$4::date AND v.recorded_at<=$2::timestamptz
                AND (v.source_published_at IS NULL OR v.source_published_at<=$2::timestamptz)
              ORDER BY v.period, v.recorded_at DESC, v.id DESC) v
        WHERE v.value IS NOT NULL AND v.period_start >= $4::date - 1096) AS points
     FROM kb.series s LEFT JOIN kb.series_entities se ON se.series_id=s.id
     WHERE (se.entity_id=ANY($1::bigint[]) OR (se.entity_id IS NULL AND s.entity_id=ANY($1::bigint[]))
            OR (s.entity_id IS NULL AND s.geo IN ('WLD','EUU','EMU','EUR') AND $3=ANY(s.categories)))
     ORDER BY s.id LIMIT 250`, [scopeIds, cutoff, category, referenceDate],
  )).rows;
  const seenSeries = new Map<number, DataAttachment>();
  for (const row of series) {
    const hits = matchDataKeywords(text, row.keywords ?? []);
    if (!hits.length || !seriesCurrencyMatches(text, row.provider_code)) continue;
    const points = (row.points ?? []).slice(-24) as DataPoint[];
    if (!points.length) continue;
    const scope = scopeById.get(Number(row.matched_entity ?? row.entity_id));
    const score = Math.min(1, (scope ? 0.5 - 0.12 * scope.depth : 0.12) + Math.min(0.35, hits.length * 0.12) + (row.categories?.includes(category) ? 0.15 : 0));
    const item: DataAttachment = { key: `series:${row.id}`, kind: 'series', id: Number(row.id), title: row.title,
      provider: row.provider, url: row.source_url || '', unit: row.unit, geo: row.geo,
      asOf: cutoff, referenceDate, score, evidence: evidence(scope, hits, row.role || 'geography'), points,
      excerpt: `${row.title} (${row.unit ?? ''}, ${row.geo ?? ''}); known by ${cutoff}: ${points.map((p) => `${p.period}: ${p.value}`).join('; ')}.` };
    if (!seenSeries.has(item.id) || seenSeries.get(item.id)!.score < score) seenSeries.set(item.id, item);
  }
  out.push(...seenSeries.values());

  const financial = (await db.query(
    `SELECT f.*, f.period_start::text AS period_start,f.period_end::text AS period_end,f.filed_on::text AS filed_on,
       e.name AS entity_name, r.url, snap.source_url FROM (
       SELECT DISTINCT ON(entity_id,taxonomy,concept,unit,period_start,period_end) * FROM kb.financial_facts
       WHERE entity_id=ANY($1::bigint[]) AND period_end<=$3::date AND available_at<=$2::timestamptz
         AND filed_on<=$2::date AND period_end >= $3::date - 1096
       ORDER BY entity_id,taxonomy,concept,unit,period_start,period_end,available_at DESC,first_seen DESC,id DESC
     ) f JOIN kb.entities e ON e.id=f.entity_id LEFT JOIN kb.records r ON r.id=f.record_id
     LEFT JOIN kb.data_snapshots snap ON snap.id=f.snapshot_id
     ORDER BY f.period_end DESC, f.available_at DESC LIMIT 1000`, [scopeIds, cutoff, referenceDate],
  )).rows;
  const metricCounts = new Map<string, number>();
  for (const row of financial) {
    const hits = matchDataKeywords(text, financialKeywords(row.concept));
    if (!hits.length) continue;
    const duration = row.period_start ? Math.round((Date.parse(date(row.period_end))-Date.parse(date(row.period_start)))/86400000)+1 : 0;
    const periodType = !duration ? 'instant' : duration <= 110 ? 'quarter' : duration <= 200 ? 'half_year' : duration <= 300 ? 'nine_months' : 'annual_or_other';
    const metric = `${row.entity_id}:${row.taxonomy}:${row.concept}:${row.unit}:${periodType}`;
    if ((metricCounts.get(metric) ?? 0) >= 4) continue;
    metricCounts.set(metric, (metricCounts.get(metric) ?? 0) + 1);
    const scope = scopeById.get(Number(row.entity_id));
    out.push({ key: `financial_fact:${row.id}`, kind: 'financial_fact', id: Number(row.id),
      title: `${row.entity_name}: ${row.label}`, provider: 'sec', url: row.url || row.source_url || 'https://www.sec.gov/search-filings',
      asOf: cutoff, referenceDate, score: Math.min(1, 0.65 - (scope?.depth ?? 0) * 0.12 + hits.length * 0.08),
      evidence: evidence(scope, hits, 'reported_financial_value'), unit: row.unit, value: String(row.value),
      periodStart: row.period_start ? date(row.period_start) : null, periodEnd: date(row.period_end), filedOn: date(row.filed_on),
      accession: row.accession, snapshotIds: row.snapshot_id ? [Number(row.snapshot_id)] : [],
      excerpt: `${row.entity_name}; ${row.taxonomy}:${row.concept}; ${row.period_start ? `${date(row.period_start)} through ` : 'instant at '}${date(row.period_end)}: ${row.value} ${row.unit}; ${row.form}, filed ${date(row.filed_on)}, accession ${row.accession}.` });
  }

  const records = (await db.query(
    `SELECT candidates.*,happened_on::text AS happened_on FROM (SELECT DISTINCT ON(r.id) r.*, re.entity_id, re.role, e.name AS entity_name FROM kb.records stored
     JOIN kb.record_entities re ON re.record_id=stored.id JOIN kb.entities e ON e.id=re.entity_id
     JOIN LATERAL (SELECT data FROM kb.record_versions WHERE record_id=stored.id AND recorded_at<=$2::timestamptz ORDER BY recorded_at DESC,id DESC LIMIT 1) version ON true
     CROSS JOIN LATERAL jsonb_populate_record(NULL::kb.records,version.data) r
     WHERE re.entity_id=ANY($1::bigint[]) AND r.happened_on<=$3::date
       AND COALESCE(NULLIF(r.data->>'accepted_at','')::timestamptz, r.first_seen)<=$2::timestamptz
       AND ((r.record_type='filing' AND r.happened_on >= $3::date-90)
         OR (r.record_type IN ('contract_award','tender') AND r.happened_on >= $3::date-730)
         OR (r.record_type='sanction_listing' AND re.role='target')
         OR (r.record_type='arms_transfer' AND r.happened_on >= $3::date-3650)
         OR (r.record_type IN ('bill','decision') AND r.happened_on >= $3::date-730))
       AND NOT COALESCE((r.data->>'delisted')::boolean,false)
     ORDER BY r.id, re.entity_id) candidates ORDER BY candidates.happened_on DESC LIMIT 150`, [scopeIds, cutoff, referenceDate],
  )).rows;
  for (const row of records) {
    const scope = scopeById.get(Number(row.entity_id));
    const recordTerms: Record<string,string[]> = {
      filing: ['earnings','financial results','SEC','filing','звітність','звіт','виручка','прибуток','акції','злиття','acquisition'],
      contract_award: ['закупівля','тендер','контракт','procurement','tender','contract'], tender: ['закупівля','тендер','procurement','tender'],
      sanction_listing: ['санкції','санкційний','sanctions','sanction'], arms_transfer: ['озброєння','зброя','постачання','weapons','arms','defense'],
      bill: ['закон','законопроєкт','парламент','law','bill','parliament'], decision: ['суд','рішення','позов','court','lawsuit','judgment'],
    };
    const hits = matchDataKeywords(text, recordTerms[row.record_type] ?? []);
    if (!hits.length) continue;
    out.push({ key: `record:${row.id}`, kind: 'record', id: Number(row.id), title: row.title, provider: row.provider, url: row.url || '',
      asOf: cutoff, referenceDate, score: Math.min(1, 0.65 - (scope?.depth ?? 0) * 0.12 + (hits.length ? 0.15 : 0)),
      evidence: evidence(scope, hits, row.role), periodEnd: date(row.happened_on), snapshotIds: row.data?.snapshot_ids ?? [],
      excerpt: `${row.entity_name}: ${row.title}. ${row.amount !== null ? `Amount: ${row.amount} ${row.currency || (row.record_type === 'arms_transfer' ? 'SIPRI TIV (not money)' : '')}. ` : ''}Date: ${date(row.happened_on)}.` });
  }
  const selected = out.filter((item) => item.score >= 0.45).sort((a,b) => b.score-a.score || a.key.localeCompare(b.key,undefined,{numeric:true}));
  const counts = new Map<string,number>();
  const balanced = selected.filter((item) => { const n=counts.get(item.kind)??0; counts.set(item.kind,n+1); return n<6; });
  if (options.persist === false) return balanced;
  const links = balanced.map((item) => ({ key: item.key, kind: item.kind, id: item.id, score: item.score, evidence: item.evidence }));
  await db.query(
    `WITH retired AS (UPDATE kb.event_data_links SET active=false,checked_at=now() WHERE event_id=$1
                       AND NOT(data_key=ANY($4::text[])))
     INSERT INTO kb.event_data_links(event_id,data_key,as_of,series_id,record_id,financial_fact_id,score,evidence,algorithm)
     SELECT $1,x.key,$2::timestamptz,CASE WHEN x.kind='series' THEN x.id END,CASE WHEN x.kind='record' THEN x.id END,
            CASE WHEN x.kind='financial_fact' THEN x.id END,x.score,x.evidence,'data-selection-v1'
     FROM jsonb_to_recordset($3::jsonb) x(key text,kind text,id bigint,score real,evidence jsonb)
     ON CONFLICT(event_id,data_key) DO UPDATE SET as_of=EXCLUDED.as_of,score=EXCLUDED.score,evidence=EXCLUDED.evidence,active=true,checked_at=now(),algorithm=EXCLUDED.algorithm`,
    [eventId, cutoff, JSON.stringify(links), links.map((link) => link.key)],
  );
  return balanced;
}
