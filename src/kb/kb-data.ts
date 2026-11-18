/**
 * Open data for a dossier (task 3): statistics series, registry records and global coverage that concern the event's
 * participants, as citable [S#] items. Official numbers are quoted exactly with their period and source; ACLED
 * fatality counts are labelled as estimates; SIPRI values are TIV (a volume indicator), never money.
 */
import { DatabaseService } from '../database/database.service';
import type { DossierDoc, DossierEntity } from './kb-dossier';
import { selectEventData } from './kb-data-selection';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

function fmt(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  if (Math.abs(n) >= 1e9) return `${+(n / 1e9).toFixed(2)} bn`;
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(2)} m`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const PROVIDER_URL: Record<string, string> = {
  worldbank: 'https://data.worldbank.org/', eurostat: 'https://ec.europa.eu/eurostat/', ecb: 'https://data.ecb.europa.eu/',
  fred: 'https://fred.stlouisfed.org/', eia: 'https://www.eia.gov/', unhcr: 'https://www.unhcr.org/refugee-statistics/',
  faostat: 'https://www.fao.org/faostat/', nbu: 'https://bank.gov.ua/', oecd: 'https://data-explorer.oecd.org/',
  ukrstat: 'https://stat.gov.ua/',
};

const RECORD_URL: Record<string, string> = {
  eu_sanctions: 'https://www.sanctionsmap.eu/', acled: 'https://acleddata.com/', sipri: 'https://armstrade.sipri.org/',
  prozorro: 'https://prozorro.gov.ua/', rada: 'https://itd.rada.gov.ua/', court: 'https://reyestr.court.gov.ua/',
};

export async function buildDataDocs(db: DatabaseService, eventId: number, category: string | null, entities: DossierEntity[], when: string | null, options: { text?: string; asOf?: string; persist?: boolean } = {}): Promise<DossierDoc[]> {
  const ids = entities.slice(0, 40).map((e) => e.id);
  const knownAt = options.asOf ?? new Date().toISOString();
  const at = when && when <= knownAt ? when : knownAt;
  const out: Array<Omit<DossierDoc, 'ref'>> = [];
  const doc = (title: string, url: string, excerpt: string, name: string, date: string | null): Omit<DossierDoc, 'ref'> => ({
    documentId: 0, sourceName: name, sourceSlug: null, tier: 'data', evidenceRoot: name, role: 'data', title, url,
    publishedAt: date, lang: 'en', extraction: 'full', excerpt, newsId: null,
  });

  // Match metric/record topics to event text, then expand only trusted, dated entity relations.
  const text = options.text || (await db.query(
    `SELECT string_agg(left(d.title || ' ' || COALESCE(d.body,d.feed_summary,''),6000),' ') AS text
     FROM (SELECT document_id FROM kb.event_documents WHERE event_id=$1 ORDER BY document_id LIMIT 8) ed
     JOIN kb.documents d ON d.id=ed.document_id`, [eventId],
  )).rows[0]?.text || '';
  const datasets = await selectEventData(db,eventId,category,ids,knownAt,text,{referenceDate:at,persist:options.persist});
  for (const data of datasets) out.push({ ...doc(data.title,data.url || PROVIDER_URL[data.provider] || RECORD_URL[data.provider] || '',
    data.excerpt,data.provider,data.filedOn || data.periodEnd || null), data });

  // Ukrainian companies among the participants: the State Register (ЄДР) card
  const companies = (await db.query(
    `SELECT DISTINCT ON (c.edrpou) c.*, COALESCE(en.name_uk, en.name) AS entity
     FROM kb.entity_identifiers i JOIN kb.ua_companies c ON c.edrpou = i.value JOIN kb.entities en ON en.id = i.entity_id
     WHERE i.entity_id = ANY($1) AND i.scheme = 'edrpou' AND c.updated_at <= $2::timestamptz LIMIT 4`,
    [ids, knownAt],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  for (const c of companies) {
    const parts = [`${c.name} (EDRPOU ${c.edrpou})`, c.legal_form, c.status && `status: ${c.status}`,
      c.capital != null && `authorized capital ${fmt(c.capital)} UAH`,
      c.founders?.length && `founders: ${c.founders.slice(0, 5).join('; ')}`,
      c.beneficiaries?.length && `beneficial owners: ${c.beneficiaries.slice(0, 5).join('; ')}`,
      c.signers?.length && `signatories: ${c.signers.slice(0, 3).join('; ')}`].filter(Boolean);
    out.push(doc(`ЄДР: ${c.name}`, `https://usr.minjust.gov.ua/`, `${parts.join('; ')}. Source: Unified State Register of Ukraine (open data, as of ${iso(c.updated_at)?.slice(0, 10)}).`, 'edr', iso(c.updated_at)));
  }

  // court decisions in the cases that the event's documents quote (case numbers like 757/12345/26)
  const court = (await db.query(
    `SELECT cd.* FROM kb.court_documents cd
     WHERE cd.adjudication_date <= $2::date AND cd.first_seen <= $3::timestamptz AND cd.cause_num IN (SELECT DISTINCT (regexp_matches(d.body, '\\m(\\d{1,4}/\\d{1,7}/\\d{2})\\M', 'g'))[1]
                            FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
                            WHERE ed.event_id = $1 AND d.body IS NOT NULL)
     ORDER BY cd.adjudication_date DESC LIMIT 5`,
    [eventId, at, knownAt],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  for (const c of court) {
    out.push(doc(`Court decision, case ${c.cause_num}`, `https://reyestr.court.gov.ua/Review/${c.doc_id}`,
      `${c.court_name ?? 'Court'}: ${c.judgment_form ?? 'decision'} of ${iso(c.adjudication_date)?.slice(0, 10) ?? 'n/a'} in case ${c.cause_num} (${c.justice_kind ?? ''}${c.category ? `, ${c.category}` : ''}); judge ${c.judge || 'n/a'}. Source: Unified State Register of Court Decisions.`,
      'court', iso(c.adjudication_date)));
  }

  // statements from the event's videos (one Flash-Lite pass over the transcript), linked to the exact moment
  const vclaims = (await db.query(
    `SELECT vc.t_sec, vc.speaker, vc.text, vc.quote, vc.modality, d.url, d.title, d.published_at
     FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id AND d.kind = 'transcript'
     JOIN kb.video_claims vc ON vc.document_id = d.id
     WHERE ed.event_id = $1 ORDER BY d.id, vc.t_sec LIMIT 12`,
    [eventId, at, knownAt],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  for (const v of vclaims) {
    const t = Number(v.t_sec) || 0;
    const label = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const url = `${v.url}${String(v.url).includes('?') ? '&' : '?'}t=${t}s`;
    out.push(doc(`${v.title} — ${label}`, url,
      `At ${label} of the video ${v.speaker ? `${v.speaker} says` : 'it is said'} (${v.modality}): ${v.text}${v.quote ? ` Original words: "${v.quote}".` : ''} Video transcript statement, attribute it to the speaker.`,
      'video', iso(v.published_at)));
  }

  // satellite fire detections (NASA FIRMS) within ~15 km of the event's places, 2 days before to 1 day after
  const fires = (await db.query(
    `SELECT COALESCE(en.name_uk, en.name) AS place, count(f.id) AS n, max(f.frp) AS frp, min(f.detected_at) AS t0, max(f.detected_at) AS t1
     FROM kb.entities en
     JOIN kb.fire_detections f
       ON f.latitude BETWEEN (en.attributes->'coord'->>0)::float8 - 0.14 AND (en.attributes->'coord'->>0)::float8 + 0.14
      AND f.longitude BETWEEN (en.attributes->'coord'->>1)::float8 - 0.2 AND (en.attributes->'coord'->>1)::float8 + 0.2
      AND f.detected_at BETWEEN $2::timestamptz - interval '2 days' AND $2::timestamptz + interval '0 days'
     WHERE f.first_seen <= $3::timestamptz AND en.id = ANY($1) AND en.kind IN ('place', 'facility') AND en.attributes ? 'coord'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
    [ids, at, knownAt],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  for (const f of fires) {
    out.push(doc(`NASA FIRMS: thermal anomalies near ${f.place}`, 'https://firms.modaps.eosdis.nasa.gov/map/',
      `NASA FIRMS satellites (VIIRS) detected ${f.n} thermal anomalies within about 15 km of ${f.place} between ${iso(f.t0)?.slice(0, 16)} and ${iso(f.t1)?.slice(0, 16)} UTC; max fire radiative power ${fmt(f.frp)} MW. A hot spot shows a fire or heat source, not its cause.`,
      'nasa_firms', iso(f.t1)));
  }

  // documented conflict events in the participant countries around the event date (ACLED, estimates)
  const conflict = (await db.query(
    `SELECT r.geo, count(*) AS events, sum(r.amount) AS fatalities, min(r.happened_on) AS d0, max(r.happened_on) AS d1,
            (SELECT json_agg(x) FROM (SELECT r2.data->>'admin1' AS region, count(*) AS n FROM kb.records r2
              WHERE r2.first_seen <= $3::timestamptz AND r2.provider = 'acled' AND r2.geo = r.geo AND r2.happened_on BETWEEN $2::date - 7 AND $2::date
              GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x) AS regions
     FROM kb.records r
     WHERE r.first_seen <= $3::timestamptz AND r.provider = 'acled' AND r.happened_on BETWEEN $2::date - 7 AND $2::date
       AND r.geo IN (SELECT DISTINCT i.value FROM kb.entity_identifiers i WHERE i.entity_id = ANY($1) AND i.scheme = 'iso3166_3')
     GROUP BY r.geo`,
    [ids, at.slice(0, 10), knownAt],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  for (const c of conflict) {
    out.push(doc(`ACLED: political violence in ${c.geo}, 7 days`, RECORD_URL.acled,
      `ACLED recorded ${c.events} events in ${c.geo} between ${iso(c.d0)?.slice(0, 10)} and ${iso(c.d1)?.slice(0, 10)} with an estimated ${fmt(c.fatalities)} fatalities (ACLED estimates). Most events: ${(c.regions ?? []).map((x: any) => `${x.region} ${x.n}`).join(', ')}.`,
      'acled', iso(c.d1)));
  }

  // how widely the event is covered worldwide (GDELT): context, never confirmation
  const cov = (await db.query(
    `SELECT data FROM kb.records WHERE provider = 'gdelt' AND data->>'event_id' = $1 AND first_seen <= $2::timestamptz ORDER BY first_seen DESC LIMIT 1`, [String(eventId), knownAt],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows[0];
  if (cov?.data?.articles) {
    const d = cov.data;
    out.push(doc('GDELT: global coverage', 'https://www.gdeltproject.org/', `GDELT found ${d.articles} articles about this in the last 3 days from ${d.countries?.length ?? 0} countries in ${d.languages?.length ?? 0} languages (${(d.countries ?? []).slice(0, 12).join(', ')}).`, 'gdelt', null));
  }
  return out.map((d, i) => ({ ...d, ref: `S${i + 1}` }));
}
