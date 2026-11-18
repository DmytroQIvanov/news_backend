import { createHash } from 'node:crypto';

export interface ArticleReview {
  verdict: string;
  issues: Array<{ id: string; location: string; problem: string; fix: string }>;
  articleHash: string;
}

export function reviewHash(article: unknown): string {
  return createHash('sha256').update(JSON.stringify(article)).digest('hex');
}

/** Exactly one well-formed verdict for each expected event; absence and duplicates are holds. */
export function eventReviews(raw: unknown, articles: Array<{ event_id: number }>, eventIds: number[]): Map<number, ArticleReview> {
  const rows = Array.isArray(raw) ? raw : [];
  return new Map(eventIds.map((id) => {
    const mine = rows.filter((r) => r && r.event_id === id);
    const r = mine[0];
    const valid = mine.length === 1 && ['ok', 'fix', 'reject'].includes(r?.verdict)
      && Array.isArray(r.issues) && r.issues.every((i: any) => i && ['location', 'problem', 'fix'].every((k) => typeof i[k] === 'string'))
      && (r.verdict !== 'ok' || r.issues.length === 0);
    return [id, { verdict: valid ? r.verdict : 'missing_or_invalid',
      issues: valid ? r.issues.map((i: any, n: number) => ({ ...i, id: `${id}:${n + 1}` })) : [],
      articleHash: reviewHash(articles.find((a) => a.event_id === id) ?? null) }];
  }));
}

export function reviewApproved(review: ArticleReview | undefined, article: unknown): boolean {
  return review?.verdict === 'ok' && review.issues.length === 0 && review.articleHash === reviewHash(article);
}
