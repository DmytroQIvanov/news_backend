/** One publication policy. Aliases are internal SQL identifiers, never user input. */
export function sourceCounts(sources: unknown): { documentCount: number; independentOrigins: number } {
  const documents = new Map<string, string>();
  for (const src of Array.isArray(sources) ? sources : []) {
    if (!src || src.usable === false || !['full', 'partial'].includes(src.extraction ?? src.extraction_status ?? 'full')) continue;
    try {
      const url = new URL(src.canonicalUrl || src.url);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) continue;
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const origin = String(src.evidenceRoot || src.ownerGroup || host).trim().toLowerCase();
      const document = `${host}${url.pathname}`.toLowerCase();
      // Repeated URLs cannot create a second origin even with conflicting lineage labels.
      documents.set(document, [documents.get(document), origin].filter(Boolean).sort()[0]!);
    } catch { /* unusable URL */ }
  }
  return { documentCount: documents.size, independentOrigins: new Set(documents.values()).size };
}

export function eligibleNews(row: { status: string; ai_generated: boolean; cluster_sources: unknown; kbIndependentSources?: number }): boolean {
  return row.status === 'published' && row.ai_generated === true
    && Math.max(sourceCounts(row.cluster_sources).independentOrigins, row.kbIndependentSources ?? 0) >= 2;
}

export function independentOriginsSql(alias = 'n'): string {
  return `GREATEST(
    (SELECT count(DISTINCT origin) FROM (SELECT min(COALESCE(NULLIF(lower(btrim(src->>'evidenceRoot')), ''),
      NULLIF(lower(btrim(src->>'ownerGroup')), ''),
      NULLIF(regexp_replace(lower(substring(COALESCE(NULLIF(src->>'canonicalUrl', ''), src->>'url')
        from '^https?://([^/:?#]+)')), '^www[.]', ''), ''))) AS origin
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.cluster_sources) = 'array'
       THEN ${alias}.cluster_sources ELSE '[]'::jsonb END) src
     WHERE COALESCE(NULLIF(src->>'canonicalUrl', ''), src->>'url') ~* '^https?://[^/:?#[:space:]]+[.]'
       AND COALESCE(src->>'extraction', src->>'extraction_status', 'full') IN ('full', 'partial')
       AND COALESCE(src->>'usable', 'true') <> 'false'
     GROUP BY regexp_replace(regexp_replace(lower(COALESCE(NULLIF(src->>'canonicalUrl', ''), src->>'url')),
       '^https?://(www[.])?', ''), '[?#].*$', '')) origins),
    COALESCE((SELECT e.independent_source_count FROM kb.events e WHERE e.id = ${alias}.kb_event_id), 0))::int`;
}

export function publicationEvidenceSql(alias = 'n'): string {
  return `(COALESCE(${alias}.ai_generated, false) = true AND ${independentOriginsSql(alias)} >= 2)`;
}

export function publicationReadySql(alias = 'n'): string {
  return `(${publicationEvidenceSql(alias)} AND (${alias}.kb_event_id IS NULL OR (
    ${alias}.ai_metadata->'kb'->>'checks_passed' = 'true'
    AND ${alias}.ai_metadata->'kb'->'review'->>'state' = 'approved'
    AND ${alias}.ai_metadata->'kb'->'review'->>'article_hash' = ${alias}.content_hash)))`;
}

// Existing published KB rows need the same evidence gate. Review metadata is required on new candidates at publication.
export const NEWS_ELIGIBILITY_SQL = `(n.status = 'published' AND ${publicationEvidenceSql()})`;
export const NEWS_SOURCE_COUNTS_SQL = `jsonb_array_length(CASE WHEN jsonb_typeof(n.cluster_sources) = 'array'
  THEN n.cluster_sources ELSE '[]'::jsonb END) AS document_count,
  ${independentOriginsSql()} AS independent_source_count`;
