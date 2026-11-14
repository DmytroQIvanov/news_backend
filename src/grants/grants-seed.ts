export type GrantCountryCode = 'ua' | 'eu' | 'us' | 'uk' | 'global';
export type GrantSector =
  | 'ai_deeptech'
  | 'defensetech'
  | 'greentech'
  | 'edtech_science'
  | 'sme_veterans'
  | 'creative_media';
export type GrantOpportunityType =
  | 'grant'
  | 'hackathon'
  | 'accelerator'
  | 'contest'
  | 'cloud_credits'
  | 'fellowship';
export type GrantStage = 'idea' | 'mvp' | 'scale';
export type GrantAudienceCode =
  | 'students_youth'
  | 'indie_devs'
  | 'startups'
  | 'researchers'
  | 'defense_veterans'
  | 'sme_ngo';

export interface GrantOpportunityItem {
  id: string;
  externalId: string;
  title: string;
  titleUk: string;
  organization: string;
  countryCode: GrantCountryCode;
  countryLabelUk: string;
  regionDetailsUk: string | null;
  sector: GrantSector;
  sectorLabelUk: string;
  opportunityType: GrantOpportunityType;
  audiences: GrantAudienceCode[];
  targetAudienceUk: string;
  fundingAmount: string;
  fundingMaxUsd: number;
  equityFree: boolean;
  coFinancingPct: number;
  stage: GrantStage;
  deadlineAt: string | null;
  isRolling: boolean;
  summaryUk: string;
  eligibilityUk: string;
  requirementsUk: string[];
  applicationTipsUk: string | null;
  officialUrl: string;
  worthScore: number;
  status: 'active' | 'expired';
  lastVerifiedAt: string;
}

export const GRANT_COUNTRY_LABELS_UK: Record<GrantCountryCode, string> = {
  ua: 'Україна',
  eu: 'ЄС',
  us: 'США',
  uk: 'Велика Британія',
  global: 'Глобально',
};

export const GRANT_SECTOR_LABELS_UK: Record<GrantSector, string> = {
  ai_deeptech: 'AI та DeepTech',
  defensetech: 'DefenseTech та Кібербезпека',
  greentech: 'GreenTech та AgroTech',
  edtech_science: 'EdTech та Наука',
  sme_veterans: 'МСБ та Ветеранський бізнес',
  creative_media: 'Креатив, Медіа та Open Source',
};

export const GRANT_TYPE_LABELS_UK: Record<GrantOpportunityType, string> = {
  grant: 'Грант',
  hackathon: 'Хакатон',
  accelerator: 'Акселератор',
  contest: 'Конкурс',
  cloud_credits: 'Хмарні кредити',
  fellowship: 'Стипендія / Research',
};

export const GRANT_STAGE_LABELS_UK: Record<GrantStage, string> = {
  idea: 'Ідея / Pre-seed',
  mvp: 'MVP / Прототип',
  scale: 'Масштабування / Scale',
};

export const GRANT_AUDIENCE_LABELS_UK: Record<GrantAudienceCode, string> = {
  students_youth: 'Студенти та молодь',
  indie_devs: 'Інді-розробники та соло-білдери',
  startups: 'Стартапи та команди',
  researchers: 'Науковці та дослідники',
  defense_veterans: 'DefenseTech та ветерани',
  sme_ngo: 'МСБ та ГО',
};

const SEED_VERIFIED_AT = '2026-11-14T18:00:00Z';

export const INITIAL_GRANTS_SEED: GrantOpportunityItem[] = [
  {
    id: 'seed-brave1',
    externalId: 'brave1-defense-tech',
    title: 'Brave1 Defense Tech Grants',
    titleUk: 'Brave1 — Гранти на DefenseTech-розробки',
    organization: 'Brave1 (Мінцифри, Міноборони, Генштаб, USF)',
    countryCode: 'ua',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.ua,
    regionDetailsUk: 'Україна (для зареєстрованих в Україні команд та оборонних підприємств)',
    sector: 'defensetech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.defensetech,
    opportunityType: 'grant',
    audiences: ['defense_veterans', 'startups', 'researchers'],
    targetAudienceUk: 'Оборонні стартапи, інженери-дослідники та ветеранські команди',
    fundingAmount: 'до $25,000–$200,000 (в екв.)',
    fundingMaxUsd: 200000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Державний кластер підтримки оборонних технологій в Україні. Надає безповоротні гранти на R&D, створення та випробування БПЛА, НРК, РЕБ, засобів ШІ-наведення, розмінування та кіберзахисту.',
    eligibilityUk:
      'Українські юрособи (ТОВ) або ФОП із розробками рівня TRL 4+, що пройшли оборонну експертизу та не мають звʼязків із рф/рб.',
    requirementsUk: [
      'Заповнена анкета та опис технології на порталі Brave1',
      'Технічна презентація (pitch deck) і відео демонстрації прототипу',
      'Бюджет проєкту з обґрунтуванням витрат на R&D та компоненти',
      'Відсутність санкційних або корпоративних звʼязків із державами-агресорами',
    ],
    applicationTipsUk:
      'Чітко вказуйте тактико-технічні характеристики, поточний TRL та результати полігонних випробувань — це прискорює проходження військової експертизи.',
    officialUrl: 'https://brave1.gov.ua/',
    worthScore: 98,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-seeds-of-bravery',
    externalId: 'seeds-of-bravery-deeptech',
    title: 'Seeds of Bravery (UASEEDs) — Innovative Entrepreneurship & DeepTech',
    titleUk: 'Seeds of Bravery (UASEEDs) — Інноваційне підприємництво та DeepTech',
    organization: 'Seeds of Bravery / EIC (Horizon Europe)',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'ЄС (спеціальна програма Horizon Europe для українських технологічних стартапів)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'grant',
    audiences: ['startups', 'researchers'],
    targetAudienceUk: 'Українські DeepTech-стартапи та R&D-команди',
    fundingAmount: 'до €60,000',
    fundingMaxUsd: 65000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: '2026-12-20T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Пряме безповоротне фінансування ЄС у межах Horizon Europe для українських DeepTech та інноваційних стартапів: до €25,000 на інноваційні сервіси, €25,000 на інноваційне підприємництво та до €50,000–€60,000 на DeepTech-інкубацію й відбудову.',
    eligibilityUk:
      'Технологічні стартапи, зареєстровані в Україні або перенесені до ЄС, у яких щонайменше один засновник чи ключова команда працює в Україні (статус МСП за критеріями ЄС).',
    requirementsUk: [
      'Зареєстрована компанія (ТОВ в Україні або юрособа в ЄС із українським засновником)',
      'Pitch deck англійською мовою та опис інноваційної переваги (TRL 4–7)',
      'Фінансовий план використання гранту на 6–12 місяців',
      'Коротке відео-презентація команди (2–3 хв)',
    ],
    applicationTipsUk:
      'Обирайте трек DeepTech Incubators або Rebuild Ukraine, якщо маєте готовий MVP і чіткий план виходу на європейський ринок.',
    officialUrl: 'https://seedsofbravery.eu/',
    worthScore: 96,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-usf',
    externalId: 'usf-preseed-seed',
    title: 'Ukrainian Startup Fund (USF) — Pre-seed & Seed',
    titleUk: 'Український фонд стартапів (USF) — Pre-seed та Seed гранти',
    organization: 'Український фонд стартапів (USF)',
    countryCode: 'ua',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.ua,
    regionDetailsUk: 'Україна (національна програма підтримки інноваційних стартапів)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'grant',
    audiences: ['startups', 'indie_devs', 'students_youth'],
    targetAudienceUk: 'Ранні технологічні стартапи, студентські команди та інді-розробники',
    fundingAmount: '$25,000 – $50,000',
    fundingMaxUsd: 50000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Державний грантовий фонд для українських стартапів на ранніх стадіях: $25,000 на стадії Pre-seed для валідації ідеї й створення MVP та $50,000 на стадії Seed для масштабування продукту (зокрема dual-use, AI, EdTech, HealthTech).',
    eligibilityUk:
      'Стартапи, зареєстровані в Україні (ФОП або ТОВ), із ключовою командою розробки в Україні та прозорою структурою власності.',
    requirementsUk: [
      'Заявка в особистому кабінеті на порталі USF',
      'Pitch deck (проблема, рішення, ринок, бізнес-модель, команда)',
      'Кошторис витрат (зарплати розробників, хмарна інфраструктура, маркетинг, IP)',
      'Готовність до публічного пітчу перед незалежними експертами фонду',
    ],
    applicationTipsUk:
      'Перед подачею перевірте прозорість структури власності та підготуйте вимірювані KPI на 6 місяців грантового періоду.',
    officialUrl: 'https://usf.com.ua/',
    worthScore: 95,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-yerobota',
    externalId: 'yerobota-diia-veterans',
    title: 'eRobota / Diia.Business — Grants for Veterans & Processing SMEs',
    titleUk: 'єРобота / Дія.Бізнес — Гранти для ветеранів та переробних підприємств',
    organization: 'Мінекономіки України / Дія / Державна служба зайнятості',
    countryCode: 'ua',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.ua,
    regionDetailsUk: 'Вся підконтрольна територія України (онлайн-подача через портал Дія)',
    sector: 'sme_veterans',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.sme_veterans,
    opportunityType: 'grant',
    audiences: ['defense_veterans', 'sme_ngo'],
    targetAudienceUk: 'Ветерани, члени їхніх родин та малі й середні підприємства України',
    fundingAmount: '250 тис. – 8 млн грн',
    fundingMaxUsd: 200000,
    equityFree: true,
    coFinancingPct: 30,
    stage: 'scale',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Державна програма безповоротних грантів для створення й розширення бізнесу: до 250–500 тис. грн для ветеранів та членів їхніх родин (до 1 млн грн за співфінансування 30%) та до 8 млн грн на розвиток переробної промисловості.',
    eligibilityUk:
      'Громадяни України, учасники бойових дій / особи з інвалідністю внаслідок війни, члени їхніх сімей, а також діючі ФОП та ТОВ у сфері переробки й сервісів.',
    requirementsUk: [
      'Електронний підпис (Дія.Підпис або КЕП) для подачі заявки на порталі Дія',
      'Детальний бізнес-план за затвердженою формою Мінекономіки',
      'Зобовʼязання створити 1–25 нових робочих місць залежно від суми гранту',
      'Підтвердження власного внеску (для переробних та великих ветеранських грантів від 30%)',
    ],
    applicationTipsUk:
      'У бізнес-плані реалістично розрахуйте податкові надходження за 3 роки — саме за рахунок податків із нових робочих місць грант вважається окупленим для держави.',
    officialUrl: 'https://diia.gov.ua/services/grant-na-vlasnu-spravu',
    worthScore: 94,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-eic-accelerator',
    externalId: 'eic-accelerator-horizon',
    title: 'EIC Accelerator (Horizon Europe)',
    titleUk: 'EIC Accelerator (Horizon Europe) — Масштабування DeepTech',
    organization: 'European Innovation Council (Європейська комісія)',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'ЄС та асоційовані країни (Україна має повноправний доступ без внесків)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'grant',
    audiences: ['startups', 'researchers'],
    targetAudienceUk: 'DeepTech-стартапи з проривними технологіями TRL 5–8 та наукові спін-оффи',
    fundingAmount: 'до €2.5M грант (+ equity опція)',
    fundingMaxUsd: 2700000,
    equityFree: true,
    coFinancingPct: 30,
    stage: 'scale',
    deadlineAt: '2027-01-15T17:00:00Z',
    isRolling: false,
    summaryUk:
      'Найбільша європейська програма фінансування проривних DeepTech та AI-інновацій рівня TRL 5–8: до €2.5M безповоротного гранту (покриває 70% R&D-бюджету) з можливістю додаткових інвестицій EIC Fund до €10–15M.',
    eligibilityUk:
      'Інноваційні МСП та стартапи, зареєстровані в Україні або країнах ЄС, із технологією високого ризику й глобальним потенціалом масштабування (TRL 5–6+).',
    requirementsUk: [
      'Коротка заявка Step 1 (Short Proposal, 12 сторінок + pitch deck + 3-хвилинне відео)',
      'Повна заявка Step 2 з детальним планом комерціалізації, IP-стратегією та фінансовою моделлю',
      'Підтвердження фінансової спроможності покрити 30% співфінансування грантової частини',
      'Наявність захисту інтелектуальної власності (патенти, ноу-хау, свобода дій FTO)',
    ],
    applicationTipsUk:
      'Обовʼязково подавайтесь на Short Proposal заздалегідь (розгляд триває 4–6 тижнів) та залучайте українських менторів EIC / Seeds of Bravery для ревʼю Step 2.',
    officialUrl: 'https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en',
    worthScore: 97,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-digital-europe',
    externalId: 'digital-europe-ai-cyber',
    title: 'Digital Europe Programme — AI & Cybersecurity Grants',
    titleUk: 'Digital Europe Programme — Гранти на ШІ та кібербезпеку',
    organization: 'Європейська комісія (DG CONNECT)',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'ЄС та Україна (асоційована участь у програмі «Цифрова Європа»)',
    sector: 'defensetech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.defensetech,
    opportunityType: 'grant',
    audiences: ['startups', 'sme_ngo', 'researchers'],
    targetAudienceUk: 'ІТ-компанії, МСП, університети та кібербезпекові консорціуми',
    fundingAmount: '€100,000 – €1,500,000',
    fundingMaxUsd: 1600000,
    equityFree: true,
    coFinancingPct: 25,
    stage: 'scale',
    deadlineAt: '2027-02-10T17:00:00Z',
    isRolling: false,
    summaryUk:
      'Конкурси Європейської комісії на впровадження передових рішень у кібербезпеці, AI-інфраструктурі, цифрових двійниках та хмарних сервісах для бізнесу й публічного сектору (рівень співфінансування ЄС зазвичай 50–75%).',
    eligibilityUk:
      'Юридичні особи, технологічні компанії, університети та консорціуми з України та країн ЄС із підтвердженим досвідом у кібербезпеці або ШІ.',
    requirementsUk: [
      'Реєстрація організації на порталі EU Funding & Tenders та отримання PIC-коду',
      'Партнерство в консорціумі (для більшості колаб — від 3 партнерів із різних країн)',
      'Технічна пропозиція проєкту та матриця ризиків кібербезпеки',
      'Бюджет із підтвердженням власного внеску 25–50%',
    ],
    applicationTipsUk:
      'Використовуйте мережу Національного контактного пункту та партнерів EDIH (European Digital Innovation Hubs), щоб швидко увійти до сильного консорціуму.',
    officialUrl: 'https://digital-strategy.ec.europa.eu/en/activities/digital-programme',
    worthScore: 91,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-house-of-europe',
    externalId: 'house-of-europe-culture-media',
    title: 'House of Europe — Culture, Media & Digital Projects',
    titleUk: 'House of Europe — Культура, медіа та цифрові проєкти',
    organization: 'House of Europe (Goethe-Institut / ЄС)',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'Україна та країни ЄС (програма Євросоюзу для креативного й медійного сектору)',
    sector: 'creative_media',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.creative_media,
    opportunityType: 'grant',
    audiences: ['sme_ngo', 'indie_devs', 'students_youth'],
    targetAudienceUk: 'Незалежні медіа, ГО, креативні студії, молодь та інді-розробники',
    fundingAmount: '€5,000 – €50,000',
    fundingMaxUsd: 54000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: '2026-12-10T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Гранти ЄС на створення незалежних медіапродуктів, цифрових архівів, інтерактивних культурних проєктів, подкастів, гейміфікованих платформ і міжнародної співпраці між українськими та європейськими командами.',
    eligibilityUk:
      'Незалежні медіа, ГО, культурні інституції, креативні студії та ФОП, які працюють в Україні або у партнерстві з організаціями ЄС.',
    requirementsUk: [
      'Онлайн-заявка на платформі House of Europe (українською або англійською)',
      'Концепція проєкту, план розповсюдження та очікуване охоплення аудиторії',
      'Реалістичний кошторис без прихованих комерційних витрат',
      'Портфоліо попередніх медіа- або культурних проєктів',
    ],
    applicationTipsUk:
      'Найвищі бали отримують проєкти з виразним суспільним впливом, доступністю контенту та чітким партнерством із організацією з країни ЄС або Великої Британії.',
    officialUrl: 'https://houseofeurope.org.ua/',
    worthScore: 89,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-usaid-cep',
    externalId: 'usaid-cep-ukraine',
    title: 'USAID Competitive Economy Program Ukraine (CEP)',
    titleUk: 'USAID «Конкурентоспроможна економіка України» (CEP)',
    organization: 'USAID / Chemonics International',
    countryCode: 'us',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.us,
    regionDetailsUk: 'Програма уряду США в Україні для підтримки експортоорієнтованих МСБ',
    sector: 'sme_veterans',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.sme_veterans,
    opportunityType: 'grant',
    audiences: ['sme_ngo', 'startups', 'defense_veterans'],
    targetAudienceUk: 'Українські МСБ, експортери, ІТ-компанії та ветеранські підприємства',
    fundingAmount: '$50,000 – $300,000',
    fundingMaxUsd: 300000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'scale',
    deadlineAt: '2026-12-28T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Американська грантова програма для українських малих і середніх підприємств (включно з ІТ-продуктами, виробництвом, ветеранським і жіночим бізнесом), спрямована на модернізацію потужностей, сертифікацію та вихід на міжнародні ринки.',
    eligibilityUk:
      'Діючі приватні українські МСБ (ТОВ або ФОП) із позитивною репутацією, стабільною виручкою та потенціалом експорту чи створення робочих місць.',
    requirementsUk: [
      'Концепція проєкту та детальна заявка за запитом на надання гранту (RFA)',
      'Фінансова звітність компанії за останні 1–2 роки та податкова довідка',
      'План експортного зростання або релокації/модернізації виробництва',
      'Комерційні пропозиції від постачальників обладнання чи сервісів',
    ],
    applicationTipsUk:
      'Фокусуйтесь на кількісних KPI: обсяг нового експорту в доларах, збережені та створені робочі місця, сертифікація за стандартами ЄС/США.',
    officialUrl: 'https://www.usaid.gov/ukraine',
    worthScore: 93,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-google-cloud-ai',
    externalId: 'google-for-startups-cloud-ai',
    title: 'Google for Startups Cloud Program (AI Tier)',
    titleUk: 'Google for Startups Cloud Program — До $350k на хмару та AI',
    organization: 'Google Cloud',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобальна програма (відкрита для українських AI-стартапів)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'cloud_credits',
    audiences: ['startups', 'indie_devs'],
    targetAudienceUk: 'AI-стартапи та незалежні розробники хмарних продуктів',
    fundingAmount: 'до $350,000 (Cloud & GPU/TPU кредити)',
    fundingMaxUsd: 350000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Спеціальний AI-трек від Google Cloud, що надає до $350,000 у вигляді хмарних кредитів протягом двох років ($250k у 1-й рік + $100k у 2-й рік) на використання Vertex AI, Gemini API, GPU та TPU v5 для навчання й інференсу моделей.',
    eligibilityUk:
      'Технологічні стартапи віком до 10 років із власним доменом та продуктом на базі ШІ (від стадії Pre-seed/Bootstrapped до Series A).',
    requirementsUk: [
      'Корпоративний домен, сайт продукту та бізнес-акаунт Google Cloud (Billing ID)',
      'Для AI Tier ($350k): підтвердження того, що ШІ є ключовою технологією продукту, або наявність інституційного фінансування/акселератора',
      'Опис архітектури навантаження на Vertex AI / GPU / TPU',
    ],
    applicationTipsUk:
      'Подавайте заявку через партнерський код акселератора (наприклад, Google for Startups Ukraine Support Fund, USF або NVIDIA Inception) для швидшого апруву.',
    officialUrl: 'https://cloud.google.com/startup',
    worthScore: 96,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-nvidia-inception',
    externalId: 'nvidia-inception-dgx-credits',
    title: 'NVIDIA Inception + DGX Cloud Credits',
    titleUk: 'NVIDIA Inception — Хмарні GPU-кредити та апаратна підтримка',
    organization: 'NVIDIA',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобальна безкоштовна програма підтримки AI та DeepTech стартапів',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'cloud_credits',
    audiences: ['startups', 'researchers'],
    targetAudienceUk: 'AI/ML-стартапи та інженерно-дослідницькі команди',
    fundingAmount: 'до $100,000 у хмарних GPU + знижки на H100/B200',
    fundingMaxUsd: 100000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Глобальна програма NVIDIA без передачі частки, що відкриває доступ до хмарних GPU-кредитів партнерів (до $100k через AWS, Google Cloud, Azure, Oracle), знижок на робочі станції/сервери та курсів Deep Learning Institute.',
    eligibilityUk:
      'Будь-який зареєстрований стартап, який розробляє продукт на базі ШІ, компʼютерного зору, робототехніки чи високопродуктивних обчислень і має щонайменше 1 розробника та сайт.',
    requirementsUk: [
      'Офіційний вебсайт стартапу з доменом компанії',
      'Реєстрація юрособи (в Україні чи за кордоном) і робочий прототип або бета',
      'Анкета з описом стеків CUDA / TensorRT / NeMo / LLM',
    ],
    applicationTipsUk:
      'Членство в NVIDIA Inception служить потужною рекомендацією при подачі на інші хмарні гранти (Google Cloud, AWS Activate, OVHcloud).',
    officialUrl: 'https://www.nvidia.com/en-us/startups/',
    worthScore: 94,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-microsoft-founders-hub',
    externalId: 'microsoft-founders-hub',
    title: 'Microsoft for Startups Founders Hub',
    titleUk: 'Microsoft for Startups Founders Hub — Azure та OpenAI кредити',
    organization: 'Microsoft',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобальна програма (доступна для ранніх команд навіть без інвесторів)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'cloud_credits',
    audiences: ['startups', 'indie_devs', 'students_youth'],
    targetAudienceUk: 'Ранні стартапи, соло-розробники та студентські команди на стадії ідеї',
    fundingAmount: 'до $150,000 Azure & OpenAI API кредитів',
    fundingMaxUsd: 150000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Багаторівнева програма підтримки стартапів від стадії ідеї до масштабування: $1,000–$5,000 миттєвих Azure-кредитів на старті та поступове розширення до $150,000, включно з Azure OpenAI Service, GitHub Enterprise та Microsoft 365.',
    eligibilityUk:
      'Приватні програмні/AI-стартапи на будь-якій ранній стадії (навіть без попереднього венчурного раунду, достатньо профілю LinkedIn засновника та опису продукту).',
    requirementsUk: [
      'Профіль LinkedIn засновника для верифікації заявки',
      'Короткий опис розроблюваного софту або AI-рішення (рівень Ideate / Develop / Grow)',
      'Проходження технічної верифікації домену при переході на рівні $25k–$150k',
    ],
    applicationTipsUk:
      'Для розблокування рівня $25,000+ і $150,000 підготуйте демо продукту, GitHub-репозиторій або активну інтеграцію Azure OpenAI.',
    officialUrl: 'https://www.microsoft.com/en-us/startups',
    worthScore: 93,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-aws-activate',
    externalId: 'aws-activate-startups',
    title: 'AWS Activate for Startups',
    titleUk: 'AWS Activate — Хмарні кредити та інфраструктурна підтримка',
    organization: 'Amazon Web Services (AWS)',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобальна програма для стартапів (Founders та Portfolio треки)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'cloud_credits',
    audiences: ['startups', 'indie_devs'],
    targetAudienceUk: 'Стартапи та інді-розробники, що будують інфраструктуру на AWS',
    fundingAmount: 'до $100,000 AWS Activate кредитів',
    fundingMaxUsd: 100000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Програма AWS для технологічних стартапів: $1,000 на старті (Founders) і до $100,000 через партнерів-акселераторів/фонди (Portfolio) на інфраструктуру EC2, Bedrock, SageMaker, Trainium/Inferentia та технічну підтримку AWS Support.',
    eligibilityUk:
      'Раніше не профінансовані через AWS Activate стартапи віком до 10 років із власним вебсайтом і підтвердженим AWS Account ID.',
    requirementsUk: [
      'Активний акаунт AWS із привʼязаною платіжною карткою',
      'Корпоративний вебсайт та email на домені компанії',
      'Org ID партнера (USF, Techstars, NVIDIA Inception, Y Combinator тощо) для треку до $100k',
    ],
    applicationTipsUk:
      'Використовуйте спершу Founders-пакет ($1,000) тільки якщо плануєте пізніше подаватись на Portfolio ($10k–$100k) — сума попередніх кредитів віднімається від ліміту $100k.',
    officialUrl: 'https://aws.amazon.com/activate/',
    worthScore: 91,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-uk-ukraine-techbridge',
    externalId: 'uk-ukraine-techbridge-innovate',
    title: 'UK-Ukraine TechBridge / Innovate UK Global Grants',
    titleUk: 'UK-Ukraine TechBridge / Innovate UK — Глобальні гранти й акселератор',
    organization: 'Innovate UK / UK Department for Business and Trade',
    countryCode: 'uk',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.uk,
    regionDetailsUk: 'Велика Британія та Україна (спільні R&D та освітні технологічні програми)',
    sector: 'edtech_science',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.edtech_science,
    opportunityType: 'accelerator',
    audiences: ['startups', 'researchers', 'students_youth'],
    targetAudienceUk: 'EdTech/SciTech стартапи, дослідники та університетські команди',
    fundingAmount: '£25,000 – £150,000',
    fundingMaxUsd: 190000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: '2027-01-25T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Британсько-українська технологічна платформа та грантові конкурси Innovate UK (Global Alliance / EdTech / R&D), що забезпечують інтенсивну акселерацію, менторство британських інвестиційних партнерів та безповоротні гранти на інновації.',
    eligibilityUk:
      'Українські та британські технологічні компанії, EdTech/SciTech команди та університетські спін-оффи, які працюють над спільними або масштабованими інноваціями.',
    requirementsUk: [
      'Англомовна заявка на порталі Innovation Funding Service (IFS) або UK-Ukraine TechBridge',
      'Обґрунтування науково-технологічної новизни та ринкової потреби',
      'План партнерства з британським бізнесом, університетом чи менторами',
      'Деталізація бюджету та календарного плану проєкту (6–18 місяців)',
    ],
    applicationTipsUk:
      'Партнерство з британським університетом або UK-зареєстрованим партнером суттєво розширює перелік доступних конкурсів Innovate UK.',
    officialUrl: 'https://www.ukri.org/councils/innovate-uk/',
    worthScore: 90,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-eit-jumpstarter',
    externalId: 'eit-jumpstarter-greentech',
    title: 'EIT Jumpstarter & GreenTech / AgroTech Accelerator',
    titleUk: 'EIT Jumpstarter — Акселератор для GreenTech та AgroTech',
    organization: 'European Institute of Innovation & Technology (EIT)',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'ЄС, Центрально-Східна Європа та Україна (програма EIT RIS)',
    sector: 'greentech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.greentech,
    opportunityType: 'accelerator',
    audiences: ['students_youth', 'researchers', 'startups'],
    targetAudienceUk: 'Студенти, науковці, інженери та молоді стартап-команди',
    fundingAmount: 'до €10,000 приз + вихід на EIT Seed до €50k',
    fundingMaxUsd: 55000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: '2027-02-01T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Провідний пре-акселератор Європейського інституту інновацій і технологій (EIT Food, EIT Climate-KIC, EIT InnoEnergy, New European Bauhaus) для команд із науково-технічними ідеями в AgroTech, чистій енергетиці та екологічних рішеннях.',
    eligibilityUk:
      'Науковці, інженери, студенти та стартап-команди з України та країн EIT RIS (юридична особа на момент подачі не є обовʼязковою).',
    requirementsUk: [
      'Команда від 2 осіб із технологічною чи бізнес-ідеєю в одному з треків EIT',
      'Заповнення короткої анкети ідеї та профілю команди англійською мовою',
      'Готовність пройти 6-місячну онлайн-програму буткемпів та пітчингу',
    ],
    applicationTipsUk:
      'Навіть на стадії ідеї покажіть лабораторну перевірку концепції або попередні інтервʼю з фермерами/енергетичними компаніями — журі EIT цінує валідацію проблеми.',
    officialUrl: 'https://eitjumpstarter.eu/',
    worthScore: 88,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-openai-researcher',
    externalId: 'openai-cybersecurity-researcher',
    title: 'OpenAI Cybersecurity & Researcher Access Program',
    titleUk: 'OpenAI Cybersecurity & Researcher Access — Дослідницькі гранти та API',
    organization: 'OpenAI',
    countryCode: 'us',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.us,
    regionDetailsUk: 'США (міжнародна програма для дослідників, кіберзахисників та EdTech/Science)',
    sector: 'edtech_science',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.edtech_science,
    opportunityType: 'fellowship',
    audiences: ['researchers', 'indie_devs', 'defense_veterans'],
    targetAudienceUk: 'Дослідники ШІ, фахівці з кіберзахисту та незалежні інженери',
    fundingAmount: '$10,000 – $100,000 (гранти та API-кредити)',
    fundingMaxUsd: 100000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Програма мікрогрантів та API-кредитів OpenAI для фінансування оборонного кіберзахисту (OpenAI Cybersecurity Grant Program) та академічних/освітніх досліджень безпеки й ефективності LLM (Researcher Access Program).',
    eligibilityUk:
      'Незалежні дослідники, інженери кібербезпеки, викладачі, університетські лабораторії та неприбуткові/open-source проєкти з України й світу.',
    requirementsUk: [
      'Академічний або дослідницький план проєкту (abstract, методологія, очікувані результати)',
      'Пояснення суспільної чи оборонної користі (особливо для кібербезпеки)',
      'Список публікацій, GitHub-профілів або попередніх open-source інструментів',
    ],
    applicationTipsUk:
      'Для кібербезпеки акцентуйте увагу на захисті критичної інфраструктури, виявленні вразливостей у відкритому коді та безпечних бенчмарках.',
    officialUrl: 'https://openai.com/index/openai-cybersecurity-grant-program/',
    worthScore: 89,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-github-nlnet',
    externalId: 'github-nlnet-ngi-zero',
    title: 'GitHub Secure Open Source Fund & NLnet NGI Zero',
    titleUk: 'GitHub Secure Open Source & NLnet NGI Zero — Гранти на Open Source',
    organization: 'NLnet Foundation / GitHub / Європейська комісія',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобально / ЄС (пряма підтримка незалежних розробників і медіа-інструментів)',
    sector: 'creative_media',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.creative_media,
    opportunityType: 'fellowship',
    audiences: ['indie_devs', 'researchers', 'students_youth'],
    targetAudienceUk: 'Інді-розробники open-source, дослідники та студенти-контрибʼютори',
    fundingAmount: '€5,000 – €50,000 + $10k менторство',
    fundingMaxUsd: 55000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Безповоротні гранти на відкрите програмне забезпечення, децентралізовані медіа, приватність, пошукові рушії та безпеку open-source інфраструктури. Проста двосторінкова заявка без бюрократії для індивідуальних розробників і команд.',
    eligibilityUk:
      'Індивідуальні розробники, контрибʼютори open source, незалежні дослідники, ФОП та невеликі команди з усього світу (включно з Україною).',
    requirementsUk: [
      'Відкрита ліцензія на код (OSI-approved: MIT, Apache 2.0, GPL тощо)',
      'Короткий технічний опис проєкту, архітектури та етапів (milestones)',
      'Деталізація бюджету з погодинною чи етапною оцінкою робіт',
    ],
    applicationTipsUk:
      'Розбивайте план робіт на 4–6 конкретних технічних етапів (milestones) — NLnet виплачує грант частинами після приймання кожного етапу.',
    officialUrl: 'https://nlnet.nl/propose/',
    worthScore: 92,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-mhp-poruch',
    externalId: 'mhp-poruch-agrotech-energy',
    title: 'MHP Poruch & AgroTech / Energy Resilience Grants (UA)',
    titleUk: 'МХП Поруч — Гранти для AgroTech, енергостійкості та локального бізнесу',
    organization: 'БФ «МХП-Громаді» / Програма «МХП Поруч»',
    countryCode: 'ua',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.ua,
    regionDetailsUk: 'Регіони України (громади присутності, аграрні та енергетичні ініціативи)',
    sector: 'greentech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.greentech,
    opportunityType: 'grant',
    audiences: ['sme_ngo', 'defense_veterans'],
    targetAudienceUk: 'Місцевий МСБ, фермери, ГО, громади та ветерани',
    fundingAmount: 'до 500 тис. – 1.5 млн грн',
    fundingMaxUsd: 40000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: '2026-12-18T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Грантовий конкурс для підтримки мікро- та малого бізнесу, аграрних інновацій, децентралізованої зеленої енергетики та проєктів енергостійкості громад в Україні, включно з окремими лотами для ветеранів і переселенців.',
    eligibilityUk:
      'Українські ФОП, фермерські господарства, кооперативи та невеликі підприємства, що впроваджують енергоефективні або агротехнологічні рішення.',
    requirementsUk: [
      'Заповнена грантова заявка конкурсу «Роби своє» / «МХП Поруч»',
      'Бізнес-план або техніко-економічне обґрунтування проєкту енергостійкості',
      'Реєстраційні документи ФОП/ТОВ та довідка про відсутність податкового боргу',
      'Кошторис на закупівлю обладнання, сонячних/біоенергетичних систем або AgroTech-сенсорів',
    ],
    applicationTipsUk:
      'Підкресліть економію енергоресурсів, локальний соціально-економічний ефект для громади та швидкий строк окупності впровадження.',
    officialUrl: 'https://mhp.com.ua/uk/mhp-poruch',
    worthScore: 87,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  // 8 additional programs: Hackathons, Contests, Youth, Indie Devs, Researchers, Veterans, SMEs/NGOs
  {
    id: 'seed-ethglobal-hackathons',
    externalId: 'ethglobal-ai-hackathons',
    title: 'ETHGlobal Hackathons & AI Agents Track',
    titleUk: 'ETHGlobal — Міжнародні онлайн- та офлайн-хакатони',
    organization: 'ETHGlobal',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобально (регулярні онлайн-хакатони та події у Європі й Північній Америці)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'hackathon',
    audiences: ['indie_devs', 'students_youth', 'startups'],
    targetAudienceUk: 'Інді-розробники, студенти та ранні продуктові команди (1–5 осіб)',
    fundingAmount: '$10,000 – $500,000 (призовий фонд)',
    fundingMaxUsd: 100000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Найбільша світова серія хакатонів із треками для AI-агентів, ZK-криптографії, децентралізованої інфраструктури та Web3-платежів. Дає швидкий вихід на призи спонсорів і мікрогранти на продовження проєкту.',
    eligibilityUk:
      'Будь-які розробники, дизайнери та студенти від 18 років (юрособа не потрібна; участь індивідуально або в команді до 5 осіб).',
    requirementsUk: [
      'Публічний GitHub-репозиторій із кодом, написаним під час хакатону',
      'Робоче демо або прототип та 2–4 хвилинне відео-презентація проєкту',
      'Короткий технічний опис архітектури на платформі ETHGlobal',
    ],
    applicationTipsUk:
      'Поєднуйте AI-агентів із партнерськими SDK спонсорів — окремі bounty-номінації дають високі шанси виграти $2,000–$15,000 навіть соло-розробнику.',
    officialUrl: 'https://ethglobal.com/events',
    worthScore: 90,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-devpost-mlh-hackathons',
    externalId: 'devpost-mlh-ai-hackathons',
    title: 'Devpost & MLH Global AI Hackathons',
    titleUk: 'Devpost & MLH — Глобальні AI-хакатони для студентів та інді-розробників',
    organization: 'Devpost / Major League Hacking (MLH)',
    countryCode: 'us',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.us,
    regionDetailsUk: 'США / Глобально (онлайн-хакатони від Google, Microsoft, AWS, NVIDIA)',
    sector: 'ai_deeptech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.ai_deeptech,
    opportunityType: 'hackathon',
    audiences: ['students_youth', 'indie_devs'],
    targetAudienceUk: 'Студенти, молодь та інді-розробники (соло або в команді)',
    fundingAmount: '$5,000 – $100,000 + хмарні кредити',
    fundingMaxUsd: 100000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Постійні онлайн-хакатони від технологічних корпорацій на платформах Devpost і MLH: створення AI-асистентів, мультимодальних додатків, мобільних сервісів і developer tools із грошовими призами та API-кредитами.',
    eligibilityUk:
      'Студенти ВНЗ, випускники, інді-розробники та невеликі команди з усього світу (для більшості глобальних онлайн-хакатонів достатньо віку 18+).',
    requirementsUk: [
      'Зареєстрований проєкт на сторінці хакатону Devpost до дедлайну сабміту',
      'Посилання на відкритий код, інструкція запуску та демо-відео (до 3 хв)',
      'Короткий опис використаних API/моделей та вирішеної проблеми користувачів',
    ],
    applicationTipsUk:
      'Робіть чисте коротке відео з реальним UX-сценарієм у перші 20 секунд — журі переглядає сотні заявок і спершу оцінює працююче демо.',
    officialUrl: 'https://devpost.com/hackathons',
    worthScore: 91,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-brave1-hackathon',
    externalId: 'brave1-defensetech-hackathon',
    title: 'Brave1 Defense Tech Hackathon & Precision Innovation',
    titleUk: 'Brave1 Хакатони — Оборонні та ШІ-інновації для фронту',
    organization: 'Brave1 / Мінцифри / Міноборони України',
    countryCode: 'ua',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.ua,
    regionDetailsUk: 'Україна (інженерні хакатони та SPRINT-змагання для розробників)',
    sector: 'defensetech',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.defensetech,
    opportunityType: 'hackathon',
    audiences: ['defense_veterans', 'indie_devs', 'students_youth', 'startups'],
    targetAudienceUk: 'Інженери, інді-розробники, студенти технічних ВНЗ, ветерани й стартапи',
    fundingAmount: 'до $50,000 (призи, R&D-контракти й фаст-трек до грантів)',
    fundingMaxUsd: 50000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: '2026-12-22T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Спеціалізовані оборонні хакатони та технологічні спринти Brave1 (AI для виявлення цілей, автономна навігація без GPS, перехоплення БПЛА, тактичний софт і кіберзахист) із прискореним переходом до грантів $25k–$200k.',
    eligibilityUk:
      'Українські інженери, R&D-команди, студенти, ветерани та стартапи (наявність юрособи на етапі хакатону не є обовʼязковою).',
    requirementsUk: [
      'Онлайн-реєстрація команди та вибір інженерного треку до закриття набору',
      'Технічне рішення або робочий PoC/алгоритм, презентований перед військовими менторами',
      'Дотримання правил інформаційної безпеки та нерозголошення чутливих даних',
    ],
    applicationTipsUk:
      'Навіть без заліза можна перемогти у софтверному треку (computer vision, оптична навігація, симулятори, OSINT/кібер) та отримати команду й грант на впровадження.',
    officialUrl: 'https://brave1.gov.ua/',
    worthScore: 95,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-erasmus-social-contest',
    externalId: 'erasmus-youth-digital-contests',
    title: 'Erasmus+ Youth & European Social Innovation Competition',
    titleUk: 'Erasmus+ & European Social Innovation — Конкурси для молоді та ГО',
    organization: 'Європейська комісія / EIC / Erasmus+',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'ЄС та асоційовані країни (Україна бере участь у програмах ЄС для молоді й ГО)',
    sector: 'edtech_science',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.edtech_science,
    opportunityType: 'contest',
    audiences: ['students_youth', 'sme_ngo'],
    targetAudienceUk: 'Студенти, молодіжні ініціативи, громадські організації та освітні проєкти',
    fundingAmount: '€15,000 – €75,000',
    fundingMaxUsd: 81000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: '2027-01-30T17:00:00Z',
    isRolling: false,
    summaryUk:
      'Щорічні європейські конкурси соціальних, цифрових і освітніх інновацій від Єврокомісії та EIC (премії по €50,000–€75,000 переможцям + менторська академія у фіналі для молодіжних і громадських ініціатив).',
    eligibilityUk:
      'Молодіжні команди, студенти, соціальні підприємці, освітні стартапи та ГО з України та країн ЄС.',
    requirementsUk: [
      'Опис інноваційного рішення та його вимірного соціального чи освітнього ефекту',
      'План масштабування або впровадження проєкту в громадах протягом 12 місяців',
      'Короткий бюджет використання призу та презентація команди',
    ],
    applicationTipsUk:
      'Чітко привʼяжіть проєкт до поточної теми року (цифрова освіта, зелена відбудова, інклюзія, стійкість громад) та наведіть перші пілотні метрики.',
    officialUrl: 'https://eic.ec.europa.eu/eic-prizes/european-social-innovation-competition_en',
    worthScore: 87,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-kaggle-competitions',
    externalId: 'kaggle-ai-research-competitions',
    title: 'Kaggle Featured AI & Science Competitions',
    titleUk: 'Kaggle — Глобальні конкурси з ML, LLM-бенчмарків та науки',
    organization: 'Kaggle (Google)',
    countryCode: 'global',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.global,
    regionDetailsUk: 'Глобально (відкриті міжнародні змагання з машинного навчання)',
    sector: 'edtech_science',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.edtech_science,
    opportunityType: 'contest',
    audiences: ['researchers', 'indie_devs', 'students_youth'],
    targetAudienceUk: 'Науковці, ML-дослідники, інді-розробники та студенти',
    fundingAmount: '$25,000 – $1,000,000 (призові фонди)',
    fundingMaxUsd: 250000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: null,
    isRolling: true,
    summaryUk:
      'Провідна світова платформа наукових та інженерних AI-конкурсів (ARC Prize, AIMO Math Olympiad, медичне зображення, LLM alignment) з прозорим оцінюванням на лідерборді, безкоштовними GPU/TPU квотами та великими грошовими призами.',
    eligibilityUk:
      'Будь-які учасники від 18 років (індивідуально або у команді), незалежно від країни проживання чи наявності компанії.',
    requirementsUk: [
      'Акаунт на Kaggle та прийняття офіційних правил конкретного конкурсу',
      'Відтворюваний ноутбук/код інференсу, що завантажується для перевірки на прихованому тесті',
      'Для призерів — відкритий опис рішення (write-up) та перевірка коду на відсутність витоків',
    ],
    applicationTipsUk:
      'Використовуйте безкоштовні 30 год/тиждень GPU P100/T4 та TPU на Kaggle для експериментів і обʼєднуйтесь у команди за 2 тижні до мердж-дедлайну.',
    officialUrl: 'https://www.kaggle.com/competitions',
    worthScore: 93,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-uk-british-council-contest',
    externalId: 'uk-royal-society-british-council',
    title: 'British Council & UKRI Research Partnership Contests',
    titleUk: 'British Council & UKRI — Наукові конкурси та партнерства з Великою Британією',
    organization: 'British Council / UK Research and Innovation (UKRI)',
    countryCode: 'uk',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.uk,
    regionDetailsUk: 'Велика Британія та Україна (спільні академічні, студентські та ГО-проєкти)',
    sector: 'edtech_science',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.edtech_science,
    opportunityType: 'contest',
    audiences: ['researchers', 'students_youth', 'sme_ngo'],
    targetAudienceUk: 'Українські науковці, університети, студенти й освітні ГО',
    fundingAmount: '£15,000 – £100,000',
    fundingMaxUsd: 128000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'idea',
    deadlineAt: '2027-02-15T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Конкурси грантів та академічного партнерства між українськими й британськими університетами, дослідниками та освітніми ГО (UK-Ukraine R&I Twinning, Going Global Partnerships, дослідницькі стажування та спільні публікації).',
    eligibilityUk:
      'Українські університети, наукові установи, аспіранти/дослідники та неприбуткові освітні організації у партнерстві з установою у Великій Британії.',
    requirementsUk: [
      'Спільна англомовна конкурсна заявка від українського та британського партнерів',
      'План наукового або освітнього обміну, спільних курсів чи досліджень',
      'Лист підтримки від керівництва обох установ та бюджет за статтями UKRI',
    ],
    applicationTipsUk:
      'Британська Рада регулярно публікує списки UK-університетів, які шукають українських партнерів — використайте їхній matchmaking-портал.',
    officialUrl: 'https://www.britishcouncil.org.ua/',
    worthScore: 88,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-uvf-varto-contest',
    externalId: 'uvf-varto-veteran-contest',
    title: 'Ukrainian Veteran Fund (UVF) — VARTO Business Contest',
    titleUk: 'Український ветеранський фонд — Конкурс «Варто» для ветеранського бізнесу',
    organization: 'Український ветеранський фонд (Мінветеранів)',
    countryCode: 'ua',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.ua,
    regionDetailsUk: 'Україна (державна конкурсна підтримка ветеранського підприємництва та ГО)',
    sector: 'sme_veterans',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.sme_veterans,
    opportunityType: 'contest',
    audiences: ['defense_veterans', 'sme_ngo'],
    targetAudienceUk: 'Ветерани, члени їхніх родин, ветеранський МСБ та громадські організації',
    fundingAmount: '500 тис. – 1.5 млн грн',
    fundingMaxUsd: 38000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: '2026-12-26T23:59:59Z',
    isRolling: false,
    summaryUk:
      'Конкурсна програма фінансування «ВАРТО» від Українського ветеранського фонду: безповоротна фінансова підтримка на запуск або масштабування бізнесу ветеранів, агропідприємств, сервісів, IT-продуктів та реабілітаційних ініціатив ГО.',
    eligibilityUk:
      'Ветерани війни, особи з інвалідністю внаслідок війни, члени сімей загиблих Захисників і Захисниць, зареєстровані як ФОП, ТОВ або ГО.',
    requirementsUk: [
      'Посвідчення УБД / довідка про участь у бойових діях або документи члена родини',
      'Виписка з ЄДР (ФОП, ТОВ або ГО з відповідним КВЕД)',
      'Аплікаційна форма, опис бізнес-ідеї, кошторис та календарний план реалізації',
      'Захист проєкту (онлайн-інтервʼю) у разі проходження технічного відбору',
    ],
    applicationTipsUk:
      'Детально перевірте всі обовʼязкові довідки до подачі (відсутність заборгованості, правильний шаблон кошторису), щоб не відсіятися на формальній перевірці.',
    officialUrl: 'https://veteranfund.com.ua/',
    worthScore: 94,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
  {
    id: 'seed-horizon-msca-fellowship',
    externalId: 'horizon-msca-research-fellowships',
    title: 'Horizon Europe — MSCA Fellowships & MSCA4Ukraine',
    titleUk: 'Horizon Europe MSCA — Стипендії для українських науковців і дослідників',
    organization: 'European Research Executive Agency (Horizon Europe)',
    countryCode: 'eu',
    countryLabelUk: GRANT_COUNTRY_LABELS_UK.eu,
    regionDetailsUk: 'ЄС та Україна (європейські дослідницькі гранти для PhD і постдоків)',
    sector: 'edtech_science',
    sectorLabelUk: GRANT_SECTOR_LABELS_UK.edtech_science,
    opportunityType: 'fellowship',
    audiences: ['researchers', 'students_youth'],
    targetAudienceUk: 'Науковці, аспіранти (PhD), постдоки та дослідницькі групи з України',
    fundingAmount: '€70,000 – €220,000 (стипендія + R&D бюджет)',
    fundingMaxUsd: 240000,
    equityFree: true,
    coFinancingPct: 0,
    stage: 'mvp',
    deadlineAt: '2027-02-20T17:00:00Z',
    isRolling: false,
    summaryUk:
      'Престижні індивідуальні дослідницькі стипендії ЄС (MSCA Postdoctoral Fellowships та спеціальна схема MSCA4Ukraine), що повністю покривають зарплату дослідника, витрати на дослідження, мобільність та публікації протягом 12–24 місяців.',
    eligibilityUk:
      'Дослідники з науковим ступенем PhD або кандидати наук (а для докторантури MSCA — магістри/студенти старших курсів), у співпраці з приймаючим університетом чи R&D-центром.',
    requirementsUk: [
      'Наукова пропозиція (Part B1 + B2, до 10 сторінок) за шаблоном Horizon Europe',
      'Погодження приймаючої установи (Host Institution) та наукового керівника (Supervisor)',
      'CV дослідника з переліком публікацій, патентів або відкритих датасетів/коду',
    ],
    applicationTipsUk:
      'Починайте пошук приймаючої лабораторії за 2–3 місяці до дедлайну — європейські університети мають спеціальні грант-офіси, що допомагають відшліфувати заявку.',
    officialUrl: 'https://marie-sklodowska-curie-actions.ec.europa.eu/',
    worthScore: 93,
    status: 'active',
    lastVerifiedAt: SEED_VERIFIED_AT,
  },
];

export interface GrantMatchProfile {
  legalStatus?: string;
  stage?: string;
  sector?: string;
  country?: string;
  audience?: GrantAudienceCode;
  preferEquityFree?: boolean;
}

const STAGE_ORDER: Record<GrantStage, number> = {
  idea: 0,
  mvp: 1,
  scale: 2,
};

export function computeGrantMatchScore(
  grant: GrantOpportunityItem,
  profile: GrantMatchProfile,
): number {
  let score = 60 + Math.round((grant.worthScore - 80) * 0.25);

  // Audience fit (+12 when matched)
  if (profile.audience && (profile.audience as string) !== 'all') {
    if (grant.audiences.includes(profile.audience)) {
      score += 12;
    } else {
      score -= 6;
    }
  }

  // Sector match
  if (profile.sector && profile.sector !== 'all') {
    if (grant.sector === profile.sector) {
      score += 18;
    } else if (
      (profile.sector === 'ai_deeptech' &&
        (grant.sector === 'defensetech' || grant.sector === 'edtech_science')) ||
      (grant.opportunityType === 'cloud_credits' &&
        ['defensetech', 'greentech', 'edtech_science', 'creative_media'].includes(profile.sector))
    ) {
      score += 6;
    } else {
      score -= 10;
    }
  }

  // Stage match
  if (profile.stage && profile.stage !== 'all' && profile.stage in STAGE_ORDER) {
    const targetStage = STAGE_ORDER[profile.stage as GrantStage];
    const grantStage = STAGE_ORDER[grant.stage];
    const diff = Math.abs(targetStage - grantStage);
    if (diff === 0) {
      score += 12;
    } else if (diff === 1) {
      score += 4;
    } else {
      score -= 12;
    }
  }

  // Country / Region match
  if (profile.country && profile.country !== 'all') {
    if (grant.countryCode === profile.country) {
      score += 10;
    } else if (grant.countryCode === 'global') {
      score += 8;
    } else if (profile.country === 'ua' && grant.countryCode === 'eu') {
      score += 6;
    } else if (profile.country === 'ua' && (grant.countryCode === 'us' || grant.countryCode === 'uk')) {
      score += 3;
    } else {
      score -= 8;
    }
  }

  // Legal status fit
  if (profile.legalStatus) {
    const legal = profile.legalStatus.trim().toLowerCase();
    if (legal === 'individual' || legal === 'person' || legal === 'researcher') {
      if (
        grant.opportunityType === 'fellowship' ||
        grant.opportunityType === 'hackathon' ||
        grant.opportunityType === 'contest' ||
        grant.stage === 'idea'
      ) {
        score += 8;
      }
      if (grant.stage === 'scale' || grant.coFinancingPct > 0) {
        score -= 14;
      }
    } else if (legal === 'fop') {
      if (grant.countryCode === 'ua' || grant.opportunityType === 'cloud_credits' || grant.stage !== 'scale') {
        score += 6;
      }
      if (grant.fundingMaxUsd >= 1_000_000) {
        score -= 10;
      }
    } else if (legal === 'tov' || legal === 'llc' || legal === 'company') {
      if (grant.stage === 'mvp' || grant.stage === 'scale' || grant.opportunityType === 'grant') {
        score += 8;
      }
    } else if (legal === 'ngo' || legal === 'nonprofit') {
      if (
        grant.audiences.includes('sme_ngo') ||
        grant.sector === 'creative_media' ||
        grant.sector === 'edtech_science' ||
        grant.opportunityType === 'fellowship'
      ) {
        score += 8;
      } else if (grant.opportunityType === 'cloud_credits') {
        score -= 5;
      }
    } else if (legal === 'veteran') {
      if (grant.audiences.includes('defense_veterans') || grant.sector === 'sme_veterans' || grant.countryCode === 'ua') {
        score += 12;
      }
    }
  }

  // Equity-free preference
  if (profile.preferEquityFree === true) {
    if (grant.equityFree && grant.coFinancingPct === 0) {
      score += 6;
    } else if (grant.equityFree) {
      score += 2;
    } else {
      score -= 15;
    }
  }

  return Math.max(40, Math.min(99, Math.round(score)));
}
