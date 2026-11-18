/** Human labels for knowledge-base predicates, link types and fact statuses (uk/en), shared by the API and prompts. */
export type Lang = 'uk' | 'en';

export const PREDICATE_LABELS: Record<string, { uk: string; en: string }> = {
  acquire: { uk: 'придбання', en: 'acquired' },
  invest_in: { uk: 'інвестиція', en: 'invested in' },
  raise_funds: { uk: 'залучення інвестицій', en: 'raised funds' },
  partner_with: { uk: 'партнерство', en: 'partnered with' },
  sign_agreement: { uk: 'угода', en: 'signed an agreement with' },
  launch: { uk: 'запуск', en: 'launched' },
  announce: { uk: 'оголошення', en: 'announced' },
  appoint: { uk: 'призначення', en: 'appointed' },
  dismiss: { uk: 'звільнення з посади', en: 'dismissed' },
  resign: { uk: 'відставка', en: 'resigned' },
  sue: { uk: 'позов', en: 'sued' },
  fine: { uk: 'штраф', en: 'fined' },
  sanction: { uk: 'санкції', en: 'sanctioned' },
  ban: { uk: 'заборона', en: 'banned' },
  approve: { uk: 'схвалення', en: 'approved' },
  reject: { uk: 'відхилення', en: 'rejected' },
  attack: { uk: 'удар / атака', en: 'attacked' },
  destroy: { uk: 'знищення', en: 'destroyed' },
  capture: { uk: 'захоплення', en: 'captured' },
  liberate: { uk: 'звільнення території', en: 'liberated' },
  meet: { uk: 'зустріч', en: 'met' },
  visit: { uk: 'візит', en: 'visited' },
  pledge: { uk: 'обіцянка допомоги', en: 'pledged' },
  provide: { uk: 'передача допомоги', en: 'provided' },
  condemn: { uk: 'засудження', en: 'condemned' },
  accuse: { uk: 'звинувачення', en: 'accused' },
  detain: { uk: 'затримання', en: 'detained' },
  charge: { uk: 'підозра / обвинувачення', en: 'charged' },
  convict: { uk: 'вирок', en: 'convicted' },
  win: { uk: 'перемога', en: 'won' },
  layoffs: { uk: 'скорочення', en: 'layoffs' },
  breach: { uk: 'злам / витік', en: 'breached' },
  supply_trade: { uk: 'постачання', en: 'supplied' },
  state: { uk: 'заява', en: 'stated' },
  deny: { uk: 'заперечення', en: 'denied' },
};

export const LINK_LABELS: Record<string, { uk: string; en: string }> = {
  same_storyline: { uk: 'та сама історія', en: 'same storyline' },
  follow_up: { uk: 'продовження', en: 'follow-up' },
  precedent: { uk: 'прецедент', en: 'precedent' },
  reaction_to: { uk: 'реакція на', en: 'reaction to' },
  causes: { uk: 'причина', en: 'cause' },
  contradicts: { uk: 'суперечить', en: 'contradicts' },
  context: { uk: 'контекст', en: 'context' },
};

export const FACT_STATUS_LABELS: Record<string, { uk: string; en: string }> = {
  confirmed: { uk: 'підтверджено першоджерелом', en: 'confirmed by a primary source' },
  corroborated: { uk: 'підтверджено незалежними джерелами', en: 'corroborated by independent sources' },
  single_source: { uk: 'одне джерело', en: 'single source' },
  disputed: { uk: 'дані розходяться', en: 'disputed' },
  retracted: { uk: 'відкликано', en: 'retracted' },
  superseded: { uk: 'застаріло', en: 'superseded' },
};

export const TIER_LABELS: Record<string, { uk: string; en: string }> = {
  primary: { uk: 'першоджерело', en: 'primary source' },
  wire: { uk: 'інформагенція', en: 'news agency' },
  major: { uk: 'медіа', en: 'media' },
  specialist: { uk: 'профільне медіа', en: 'specialist media' },
  blog: { uk: 'блог', en: 'blog' },
  aggregator: { uk: 'агрегатор', en: 'aggregator' },
  community: { uk: 'спільнота', en: 'community' },
  data: { uk: 'дані / реєстр', en: 'data / registry' },
};

export function label(map: Record<string, { uk: string; en: string }>, key: string | null | undefined, lang: Lang): string {
  if (!key) return '';
  return map[key]?.[lang] ?? key;
}
