import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  classifyCredibilityTier,
  extractEntitySlugs,
  KG_SEED_ENTITIES,
  KG_SEED_RELATIONS,
} from './kg-seed';

@Injectable()
export class KgService implements OnModuleInit {
  private readonly logger = new Logger(KgService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedOntology();
      await this.syncNewsLinks(100);
    } catch (error) {
      this.logger.warn(`KnowledgeGraph init skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async seedOntology(): Promise<void> {
    for (const entity of KG_SEED_ENTITIES) {
      await this.db.query(
        `INSERT INTO kg_entities (slug, name, entity_type, provider_id, description_uk)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           entity_type = EXCLUDED.entity_type,
           provider_id = COALESCE(EXCLUDED.provider_id, kg_entities.provider_id),
           description_uk = EXCLUDED.description_uk`,
        [entity.slug, entity.name, entity.entityType, entity.providerId || null, entity.descriptionUk],
      );
    }

    const entityRows = await this.db.query<{ id: string; slug: string }>('SELECT id, slug FROM kg_entities');
    const idBySlug = new Map(entityRows.rows.map((r) => [r.slug, r.id]));

    for (const rel of KG_SEED_RELATIONS) {
      const fromId = idBySlug.get(rel.from);
      const toId = idBySlug.get(rel.to);
      if (!fromId || !toId) continue;
      await this.db.query(
        `INSERT INTO kg_relations (from_entity_id, to_entity_id, relation_type, label_uk)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (from_entity_id, to_entity_id, relation_type) DO UPDATE SET
           label_uk = EXCLUDED.label_uk`,
        [fromId, toId, rel.relationType, rel.labelUk],
      );
    }
  }

  async syncNewsLinks(limit = 100): Promise<{ linked: number }> {
    const entityRows = await this.db.query<{ id: string; slug: string }>('SELECT id, slug FROM kg_entities');
    const idBySlug = new Map(entityRows.rows.map((r) => [r.slug, r.id]));

    const newsRows = await this.db.query<{
      id: string;
      original_title: string;
      original_summary: string | null;
      title_uk: string | null;
      summary_uk: string | null;
      url: string;
      unofficial: boolean;
    }>(
      `SELECT n.id::text, n.original_title, n.original_summary, n.title_uk, n.summary_uk, n.url, s.unofficial
       FROM news_items n
       JOIN sources s ON s.id = n.source_id
       WHERE n.status = 'published'
       ORDER BY n.published_at DESC NULLS LAST, n.id DESC
       LIMIT $1`,
      [limit],
    );

    let linked = 0;
    for (const item of newsRows.rows) {
      const text = [item.original_title, item.original_summary, item.title_uk, item.summary_uk, item.url]
        .filter(Boolean)
        .join(' ');
      const slugs = extractEntitySlugs(text);
      for (const slug of slugs) {
        const entityId = idBySlug.get(slug);
        if (!entityId) continue;
        await this.db.query(
          `INSERT INTO news_entities (news_id, entity_id, role)
           VALUES ($1, $2, 'mentioned')
           ON CONFLICT (news_id, entity_id) DO NOTHING`,
          [item.id, entityId],
        );
        linked += 1;
      }

      const { tier } = classifyCredibilityTier(text, item.unofficial);
      await this.db.query(
        `UPDATE news_items
         SET credibility_tier = $2
         WHERE id = $1 AND credibility_tier = 'company_claim'`,
        [item.id, tier],
      );
    }

    return { linked };
  }

  async getOverview() {
    const [entitiesRes, relationsRes, credibilityRes] = await Promise.all([
      this.db.query<{
        id: string;
        slug: string;
        name: string;
        entity_type: string;
        provider_id: string | null;
        description_uk: string | null;
        news_count: string;
      }>(
        `SELECT e.id, e.slug, e.name, e.entity_type, e.provider_id, e.description_uk,
                COUNT(ne.news_id)::text AS news_count
         FROM kg_entities e
         LEFT JOIN news_entities ne ON ne.entity_id = e.id
         GROUP BY e.id
         ORDER BY COUNT(ne.news_id) DESC, e.name ASC`,
      ),
      this.db.query<{
        from_slug: string;
        from_name: string;
        to_slug: string;
        to_name: string;
        relation_type: string;
        label_uk: string | null;
      }>(
        `SELECT f.slug AS from_slug, f.name AS from_name,
                t.slug AS to_slug, t.name AS to_name,
                r.relation_type, r.label_uk
         FROM kg_relations r
         JOIN kg_entities f ON f.id = r.from_entity_id
         JOIN kg_entities t ON t.id = r.to_entity_id
         ORDER BY r.weight DESC, f.name ASC
         LIMIT 30`,
      ),
      this.db.query<{ credibility_tier: string; cnt: string }>(
        `SELECT credibility_tier, COUNT(*)::text AS cnt
         FROM news_items
         WHERE status = 'published'
         GROUP BY credibility_tier`,
      ),
    ]);

    return {
      entities: entitiesRes.rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        entityType: r.entity_type,
        providerId: r.provider_id,
        descriptionUk: r.description_uk,
        newsCount: Number(r.news_count),
      })),
      relations: relationsRes.rows.map((r) => ({
        fromSlug: r.from_slug,
        fromName: r.from_name,
        toSlug: r.to_slug,
        toName: r.to_name,
        relationType: r.relation_type,
        labelUk: r.label_uk,
      })),
      credibilityStats: credibilityRes.rows.map((r) => ({
        tier: r.credibility_tier,
        count: Number(r.cnt),
      })),
    };
  }

  async getEntityGraph(slug: string) {
    const entityRes = await this.db.query<{
      id: string;
      slug: string;
      name: string;
      entity_type: string;
      provider_id: string | null;
      description_uk: string | null;
    }>(
      'SELECT id, slug, name, entity_type, provider_id, description_uk FROM kg_entities WHERE slug = $1 LIMIT 1',
      [slug],
    );

    const entity = entityRes.rows[0];
    if (!entity) return null;

    const [connectionsRes, newsRes, providerRes] = await Promise.all([
      this.db.query<{
        direction: string;
        slug: string;
        name: string;
        entity_type: string;
        provider_id: string | null;
        relation_type: string;
        label_uk: string | null;
      }>(
        `SELECT 'outgoing' AS direction, t.slug, t.name, t.entity_type, t.provider_id, r.relation_type, r.label_uk
         FROM kg_relations r
         JOIN kg_entities t ON t.id = r.to_entity_id
         WHERE r.from_entity_id = $1
         UNION ALL
         SELECT 'incoming' AS direction, f.slug, f.name, f.entity_type, f.provider_id, r.relation_type, r.label_uk
         FROM kg_relations r
         JOIN kg_entities f ON f.id = r.from_entity_id
         WHERE r.to_entity_id = $1`,
        [entity.id],
      ),
      this.db.query(
        `SELECT n.id, n.url, n.title_uk, n.original_title, n.summary_uk, n.category,
                n.importance, n.credibility_tier, n.is_retracted, n.published_at,
                s.name AS source_name, s.slug AS source_slug
         FROM news_entities ne
         JOIN news_items n ON n.id = ne.news_id
         JOIN sources s ON s.id = n.source_id
         WHERE ne.entity_id = $1 AND n.status = 'published'
         ORDER BY n.published_at DESC NULLS LAST, n.id DESC
         LIMIT 15`,
        [entity.id],
      ),
      entity.provider_id
        ? this.db.query(
            `SELECT provider_id, provider_name, title, pricing_summary, subscription_price_usd,
                    min_input_price_per_1m, official_url, last_verified_at
             FROM ai_catalogs WHERE provider_id = $1 LIMIT 1`,
            [entity.provider_id],
          )
        : Promise.resolve({ rows: [] }),
    ]);

    return {
      entity: {
        slug: entity.slug,
        name: entity.name,
        entityType: entity.entity_type,
        providerId: entity.provider_id,
        descriptionUk: entity.description_uk,
      },
      connections: connectionsRes.rows.map((c) => ({
        direction: c.direction,
        slug: c.slug,
        name: c.name,
        entityType: c.entity_type,
        providerId: c.provider_id,
        relationType: c.relation_type,
        labelUk: c.label_uk,
      })),
      provider: providerRes.rows[0] || null,
      relatedNews: newsRes.rows,
    };
  }

  async getEntitiesForNews(idOrExternal: string) {
    const { rows } = await this.db.query<{
      slug: string;
      name: string;
      entity_type: string;
      provider_id: string | null;
    }>(
      `SELECT e.slug, e.name, e.entity_type, e.provider_id
       FROM news_entities ne
       JOIN news_items n ON n.id = ne.news_id
       JOIN kg_entities e ON e.id = ne.entity_id
       WHERE n.id::text = $1 OR n.external_id = $1
       ORDER BY e.entity_type ASC, e.name ASC`,
      [idOrExternal],
    );
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      entityType: r.entity_type,
      providerId: r.provider_id,
    }));
  }

  async markNewsCorrection(
    newsId: number,
    correctionNote: string,
    correctedByNewsId?: number,
    isRetracted = true,
  ) {
    const res = await this.db.query(
      `UPDATE news_items
       SET is_retracted = $2,
           correction_note = $3,
           corrected_at = now(),
           corrected_by_news_id = COALESCE($4, corrected_by_news_id),
           updated_at = now()
       WHERE id = $1
       RETURNING id, is_retracted, correction_note, corrected_at`,
      [newsId, isRetracted, correctionNote, correctedByNewsId ?? null],
    );
    return res.rows[0] || null;
  }
}
