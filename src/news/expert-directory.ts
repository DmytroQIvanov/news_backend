import { NewsCategory } from '../ingest/ingest.dto';

export type ExpertPlatform = 'x' | 'facebook' | 'bluesky' | 'web' | 'github';

export interface DocumentedExpertPosition {
  topicKeywords: string[];
  thesisUk: string;
  quoteUk: string;
  keyArgumentsUk: string[];
  url: string;
  publishedAt: string;
}

export interface ExpertProfile {
  slug: string;
  fullName: string;
  handle: string;
  platform: ExpertPlatform;
  roleUk: string;
  organization: string;
  primaryDomains: NewsCategory[];
  specializations: string[];
  profileUrl: string;
  publicFeedUrl?: string;
  knownAffiliationsUk: string;
  biasKeywords?: string[];
  conflictDisclosureUk?: string;
  credibilityWeight: number;
  documentedPositions: DocumentedExpertPosition[];
}

export interface ExpertCompetenceAssessment {
  score: number;
  rationaleUk: string;
  isDirectDomainMatch: boolean;
  potentialBiasUk: string;
  conflictOfInterestUk: string;
}

export const EXPERT_DIRECTORY: ExpertProfile[] = [
  // --- AI & LLM Systems ---
  {
    slug: 'andrej-karpathy',
    fullName: 'Andrej Karpathy',
    handle: '@karpathy',
    platform: 'x',
    roleUk: 'Дослідник ШІ, співзасновник OpenAI, автор освітніх курсів з LLM',
    organization: 'Eureka Labs (ex-OpenAI / Tesla)',
    primaryDomains: ['model', 'coding', 'research', 'education_grants', 'open_source'],
    specializations: ['llm', 'training', 'tokenization', 'coding', 'neural', 'agent', 'education', 'gpt', 'python'],
    profileUrl: 'https://x.com/karpathy',
    knownAffiliationsUk: 'Колишній директор з ШІ у Tesla та співзасновник OpenAI; зараз розвиває освітню платформу Eureka Labs.',
    biasKeywords: ['openai', 'tesla', 'eureka'],
    conflictDisclosureUk: 'Потенційний інтерес до освітніх AI-продуктів та практичної інженерної екосистеми навколо Eureka Labs.',
    credibilityWeight: 97,
    documentedPositions: [
      {
        topicKeywords: ['llm', 'model', 'gpt', 'claude', 'gemini', 'reasoning', 'eval', 'agent'],
        thesisUk: 'Оцінювати нові моделі варто не за синтетичними лідербордами, а за поведінкою в реальних інженерних задачах і контролем контексту.',
        quoteUk: 'Найбільша проблема сучасних LLM — крихкість при довгих ланцюжках міркувань без чіткої верифікації кроків.',
        keyArgumentsUk: [
          'Контекстне вікно працює ефективно лише за грамотної подачі фактів.',
          'Агентні системи потребують жорсткої перевірки вихідного коду та дій.',
        ],
        url: 'https://x.com/karpathy',
        publishedAt: '2026-10-01T12:00:00Z',
      },
      {
        topicKeywords: ['coding', 'education', 'developer', 'copilot', 'ide', 'software'],
        thesisUk: 'ШІ-інструменти переносять роль програміста від ручного набору синтаксису до архітектурної верифікації результату.',
        quoteUk: 'Програмування природною мовою прискорює прототипування, але вимагає від розробника сильнішого розуміння системних обмежень.',
        keyArgumentsUk: [
          'Код, згенерований моделлю, без тестів створює прихований технічний борг.',
          'Фундаментальне навчання алгоритмам і системам стає ще ціннішим.',
        ],
        url: 'https://x.com/karpathy',
        publishedAt: '2026-09-15T12:00:00Z',
      },
    ],
  },
  {
    slug: 'yann-lecun',
    fullName: 'Yann LeCun',
    handle: '@ylecun',
    platform: 'x',
    roleUk: 'Головний науковець із ШІ у Meta, лауреат премії Тюрінга',
    organization: 'Meta FAIR / NYU',
    primaryDomains: ['research', 'model', 'open_source'],
    specializations: ['world models', 'jepa', 'open weights', 'llama', 'autoregressive', 'reasoning', 'agi', 'benchmark'],
    profileUrl: 'https://x.com/ylecun',
    knownAffiliationsUk: 'Chief AI Scientist у Meta (просуває відкриті ваги Llama та неавторегресивні world-моделі JEPA).',
    biasKeywords: ['meta', 'llama', 'openai', 'closed'],
    conflictDisclosureUk: 'Працює в Meta; системно просуває стратегію відкритих моделей Meta проти закритих пропрієтарних API конкурентів.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['model', 'agi', 'reasoning', 'research', 'llm', 'open'],
        thesisUk: 'Чисто авторегресивні мовні моделі мають фундаментальну стелю надійності без world models та планування.',
        quoteUk: 'Масштабування лише наступного токена саме по собі не гарантує справжнього розуміння фізичного світу та стійкого планування.',
        keyArgumentsUk: [
          'Відкриті дослідження прискорюють перевірку гіпотез і зменшують ризик монополізації.',
          'Практичні агенти потребують внутрішніх моделей світу та перевірки фізичної логіки.',
        ],
        url: 'https://x.com/ylecun',
        publishedAt: '2026-10-12T10:00:00Z',
      },
    ],
  },
  {
    slug: 'simon-willison',
    fullName: 'Simon Willison',
    handle: '@simonw',
    platform: 'web',
    roleUk: 'Незалежний розробник та дослідник практичного застосування LLM, співтворець Django',
    organization: 'Datasette / Independent',
    primaryDomains: ['coding', 'api', 'open_source', 'model', 'global_tech'],
    specializations: ['llm', 'sqlite', 'datasette', 'prompt injection', 'api', 'pricing', 'cli', 'python', 'open', 'local', 'benchmark'],
    profileUrl: 'https://simonwillison.net',
    publicFeedUrl: 'https://simonwillison.net/atom/everything/',
    knownAffiliationsUk: 'Незалежний інженер-розробник; тестує нові моделі та API у відкритому блозі без корпоративного фінансування лабораторій.',
    biasKeywords: ['datasette'],
    conflictDisclosureUk: 'Прямого конфлікту з великими AI-провайдерами не зафіксовано; фокусується на практичному developer experience та безпеці.',
    credibilityWeight: 96,
    documentedPositions: [
      {
        topicKeywords: ['api', 'pricing', 'model', 'coding', 'cli', 'open', 'local', 'ollama', 'security'],
        thesisUk: 'Головна цінність нових релізів для розробників — прогнозованість tool calling, зниження ціни за токен і захист від prompt injection.',
        quoteUk: 'Доки агенти виконують зовнішні команди з недовірених даних, ризик prompt injection залишається критичним бар’єром продакшену.',
        keyArgumentsUk: [
          'Вирішальними є стабільний structured output та швидкість локального або дешевого API-інференсу.',
          'Автономні інструменти в коді вимагають пісочниці та чітких меж доступу.',
        ],
        url: 'https://simonwillison.net',
        publishedAt: '2026-10-20T14:00:00Z',
      },
    ],
  },
  {
    slug: 'francois-chollet',
    fullName: 'François Chollet',
    handle: '@fchollet',
    platform: 'x',
    roleUk: 'Співавтор бенчмарку ARC-AGI та творець бібліотеки Keras',
    organization: 'Ndea / ARC Prize (ex-Google)',
    primaryDomains: ['research', 'model', 'open_source'],
    specializations: ['arc-agi', 'benchmark', 'reasoning', 'generalization', 'keras', 'deep learning', 'eval'],
    profileUrl: 'https://x.com/fchollet',
    knownAffiliationsUk: 'Співзасновник ARC Prize Foundation та дослідницької компанії Ndea.',
    biasKeywords: ['arc', 'google', 'keras'],
    conflictDisclosureUk: 'Співзасновник ARC Prize; зацікавлений у методології синтезу програм та тестах узагальнення поверх чистої меморізації.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['benchmark', 'reasoning', 'model', 'research', 'eval', 'test-time'],
        thesisUk: 'Високі бали на статичних бенчмарках часто відображають запам’ятовування даних, а не реальну здатність адаптуватися до нових задач.',
        quoteUk: 'Справжній інтелект вимірюється ефективністю адаптації до незнайомих задач, а не обсягом завчених шаблонів.',
        keyArgumentsUk: [
          'Test-time search дає приріст у логіці, але різко збільшує вартість одного запиту.',
          'Необхідні динамічні тести, недоступні у тренувальних датасетах.',
        ],
        url: 'https://x.com/fchollet',
        publishedAt: '2026-10-05T11:00:00Z',
      },
    ],
  },
  {
    slug: 'ethan-mollick',
    fullName: 'Ethan Mollick',
    handle: '@emollick',
    platform: 'x',
    roleUk: 'Професор Wharton School, дослідник впливу ШІ на роботу, бізнес та освіту',
    organization: 'University of Pennsylvania (Wharton)',
    primaryDomains: ['business', 'education_grants', 'model', 'global_tech'],
    specializations: ['productivity', 'enterprise', 'education', 'university', 'adoption', 'workplace', 'student', 'business'],
    profileUrl: 'https://x.com/emollick',
    knownAffiliationsUk: 'Професор бізнес-школи Wharton; проводить польові експерименти впровадження ШІ в компаніях та університетах.',
    biasKeywords: ['wharton'],
    conflictDisclosureUk: 'Академічний дослідник; фокусується на бізнес-ефекті та освітніх кейсах, а не на низькорівневій інфраструктурі.',
    credibilityWeight: 92,
    documentedPositions: [
      {
        topicKeywords: ['business', 'enterprise', 'education', 'student', 'adoption', 'workplace', 'model'],
        thesisUk: 'Технологічний стрибок моделей дає реальну віддачу компаніям і університетам лише після перебудови робочих процесів, а не купівлі ліцензій.',
        quoteUk: 'Розрив між можливостями frontier-моделей і щоденною практикою організацій усе ще величезний через брак методик використання.',
        keyArgumentsUk: [
          'Масова доступність потужних інструментів змінює вимоги до освіти й підготовки молодих фахівців.',
          'Поверхнева автоматизація без контролю якості знижує довіру команд.',
        ],
        url: 'https://x.com/emollick',
        publishedAt: '2026-10-18T16:00:00Z',
      },
    ],
  },
  {
    slug: 'gary-marcus',
    fullName: 'Gary Marcus',
    handle: '@GaryMarcus',
    platform: 'x',
    roleUk: 'Когнітивіст, критик і скептик надмірних обіцянок навколо генеративного ШІ',
    organization: 'NYU (Emeritus) / Marcus on AI',
    primaryDomains: ['research', 'business', 'model', 'global_tech'],
    specializations: ['hallucination', 'reliability', 'regulation', 'safety', 'hype', 'neurosymbolic', 'copyright', 'valuation'],
    profileUrl: 'https://x.com/GaryMarcus',
    knownAffiliationsUk: 'Послідовний скептик суто статистичного масштабування LLM; регулярно публікує критику маркетингових заяв AI-корпорацій.',
    biasKeywords: ['openai', 'valuation', 'agi'],
    conflictDisclosureUk: 'Має виражену скептичну позицію щодо чистого scaling-підходу LLM; надає важливий контраргумент корпоративному хайпу.',
    credibilityWeight: 86,
    documentedPositions: [
      {
        topicKeywords: ['hallucination', 'regulation', 'business', 'reliability', 'agi', 'hype', 'model'],
        thesisUk: 'Економічна окупність наддорогих AI-датацентрів під питанням, доки галюцинації не дозволяють покластися на моделі у критичних процесах.',
        quoteUk: 'Без символьної верифікації та гарантованої надійності висока точність у демо не перетворюється на безпечний продакшн.',
        keyArgumentsUk: [
          'Капітальні витрати на інфраструктуру випереджають підтверджену бізнес-виручку.',
          'Регулятори та замовники вимагатимуть прозорого аудиту джерел і помилок.',
        ],
        url: 'https://x.com/GaryMarcus',
        publishedAt: '2026-10-14T15:00:00Z',
      },
    ],
  },
  {
    slug: 'jim-fan',
    fullName: 'Jim Fan',
    handle: '@DrJimFan',
    platform: 'x',
    roleUk: 'Senior Research Manager у NVIDIA, керівник проєктів embodied AI та робототехніки',
    organization: 'NVIDIA Research',
    primaryDomains: ['research', 'hardware_gaming', 'model'],
    specializations: ['robotics', 'embodied', 'simulation', 'cuda', 'gpu', 'multimodal', 'vision', 'inference'],
    profileUrl: 'https://x.com/DrJimFan',
    knownAffiliationsUk: 'Працює в NVIDIA Research (GEAR Lab); спеціалізується на фізичному ШІ, симуляціях та робототехніці.',
    biasKeywords: ['nvidia', 'gpu', 'cuda', 'robotics'],
    conflictDisclosureUk: 'Співробітник NVIDIA; напряму пов’язаний із просуванням GPU-платформ та симуляційних стеків NVIDIA.',
    credibilityWeight: 93,
    documentedPositions: [
      {
        topicKeywords: ['robotics', 'embodied', 'gpu', 'simulation', 'multimodal', 'nvidia', 'vision'],
        thesisUk: 'Наступна велика хвиля ШІ переходить із текстових чатів у фізичний світ робототехніки завдяки синтетичним симуляціям.',
        quoteUk: 'Головний дефіцит у робототехніці — не лише обчислення, а різноманітні фізично коректні траєкторії взаємодії зі світом.',
        keyArgumentsUk: [
          'Симулятори прискорюють навчання політик керування перед виходом на реальне залізо.',
          'Потрібна низька затримка мультимодального інференсу на борту пристрою.',
        ],
        url: 'https://x.com/DrJimFan',
        publishedAt: '2026-10-08T13:00:00Z',
      },
    ],
  },
  {
    slug: 'harrison-chase',
    fullName: 'Harrison Chase',
    handle: '@hwchase17',
    platform: 'x',
    roleUk: 'Співзасновник і CEO LangChain, архітектор агентних пайплайнів',
    organization: 'LangChain',
    primaryDomains: ['api', 'coding', 'open_source'],
    specializations: ['agents', 'langchain', 'langgraph', 'rag', 'orchestration', 'evals', 'api', 'workflow'],
    profileUrl: 'https://x.com/hwchase17',
    knownAffiliationsUk: 'Співзасновник та CEO комерційної компанії LangChain.',
    biasKeywords: ['langchain', 'agent', 'orchestration'],
    conflictDisclosureUk: 'Очолює LangChain, тому просуває підходи оркестрації, трасування й моніторингу агентів.',
    credibilityWeight: 89,
    documentedPositions: [
      {
        topicKeywords: ['agent', 'api', 'workflow', 'rag', 'evals', 'coding'],
        thesisUk: 'Перехід від простих промптів до продакшн-агентів впирається у спостережуваність, керований стан і повторюваність викликів.',
        quoteUk: 'Без системного оцінювання проміжних кроків агентні застосунки ламаються при першому ж оновленні базової моделі.',
        keyArgumentsUk: [
          'Детерміновані графи станів часто ефективніші за повністю вільні цикли LLM.',
          'Спостережуваність і трасування кожного кроку — базова вимога для API-команд.',
        ],
        url: 'https://x.com/hwchase17',
        publishedAt: '2026-10-02T11:00:00Z',
      },
    ],
  },
  {
    slug: 'clem-delangue',
    fullName: 'Clem Delangue',
    handle: '@ClementDelangue',
    platform: 'x',
    roleUk: 'Співзасновник і CEO платформи Hugging Face',
    organization: 'Hugging Face',
    primaryDomains: ['open_source', 'model', 'business'],
    specializations: ['open source', 'open weights', 'hugging face', 'datasets', 'transformers', 'local ai', 'fine-tuning'],
    profileUrl: 'https://x.com/ClementDelangue',
    knownAffiliationsUk: 'CEO компанії Hugging Face — ключового хабу відкритих моделей, датасетів та інференс-інструментів.',
    biasKeywords: ['hugging face', 'open', 'closed', 'proprietary'],
    conflictDisclosureUk: 'Комерційний інтерес у домінуванні відкритих моделей та інфраструктури Hugging Face над закритими монополіями.',
    credibilityWeight: 90,
    documentedPositions: [
      {
        topicKeywords: ['open', 'hugging', 'weights', 'dataset', 'local', 'model'],
        thesisUk: 'Компактні відкриті моделі з дотренуванням під конкретний домен швидко наздоганяють дорогі закриті API за меншої ціни.',
        quoteUk: 'Більшості компаній потрібен контроль над даними та власною моделлю, а не залежність від одного закритого провайдера.',
        keyArgumentsUk: [
          'Відкриті ваги дозволяють розгортання всередині приватного периметра безпеки.',
          'Прозорі датасети спрощують аудит та відповідність регуляторним вимогам.',
        ],
        url: 'https://x.com/ClementDelangue',
        publishedAt: '2026-10-10T09:00:00Z',
      },
    ],
  },

  // --- Cybersecurity, Cloud & DevOps ---
  {
    slug: 'bruce-schneier',
    fullName: 'Bruce Schneier',
    handle: '@schneierblog',
    platform: 'web',
    roleUk: 'Криптограф, дослідник кібербезпеки та політики безпеки технологій',
    organization: 'Harvard Kennedy School / Inrupt',
    primaryDomains: ['cybersecurity', 'global_tech', 'defense'],
    specializations: ['cryptography', 'security', 'privacy', 'surveillance', 'regulation', 'ai security', 'policy', 'trust'],
    profileUrl: 'https://www.schneier.com',
    publicFeedUrl: 'https://www.schneier.com/feed/atom/',
    knownAffiliationsUk: 'Викладач Harvard Kennedy School та Chief of Security Architecture в Inrupt.',
    biasKeywords: ['inrupt', 'privacy', 'surveillance'],
    conflictDisclosureUk: 'Співзасновник/архітектор в Inrupt; оцінює події передусім крізь призму системної безпеки, приватності та балансу влади.',
    credibilityWeight: 96,
    documentedPositions: [
      {
        topicKeywords: ['cybersecurity', 'security', 'privacy', 'vulnerability', 'ai', 'regulation'],
        thesisUk: 'Автоматизація пошуку вразливостей та атак зміщує перевагу на користь тих, хто впроваджує захист за замовчуванням, а не латає симптоми.',
        quoteUk: 'Безпека — це не функція окремого патча, а безперервний процес стримування системних ризиків і зловживань.',
        keyArgumentsUk: [
          'Прозорі стандарти й відповідальне розкриття вразливостей зменшують масштаб інцидентів.',
          'Централізовані AI-агенти створюють нові вектори атак на корпоративні дані.',
        ],
        url: 'https://www.schneier.com',
        publishedAt: '2026-10-19T12:00:00Z',
      },
    ],
  },
  {
    slug: 'brian-krebs',
    fullName: 'Brian Krebs',
    handle: '@briankrebs',
    platform: 'web',
    roleUk: 'Розслідувальний журналіст з кібербезпеки, автор KrebsOnSecurity',
    organization: 'KrebsOnSecurity',
    primaryDomains: ['cybersecurity', 'startups_fintech'],
    specializations: ['ransomware', 'breach', 'threat actor', 'botnet', 'phishing', 'zero-day', 'cve', 'fraud', 'fintech'],
    profileUrl: 'https://krebsonsecurity.com',
    publicFeedUrl: 'https://krebsonsecurity.com/feed/',
    knownAffiliationsUk: 'Незалежний розслідувальний журналіст; спеціалізується на кіберзлочинності, витоках даних та фінансовому шахрайстві.',
    conflictDisclosureUk: 'Незалежне видання KrebsOnSecurity; публічних корпоративних конфліктів з вендорами не має.',
    credibilityWeight: 97,
    documentedPositions: [
      {
        topicKeywords: ['breach', 'ransomware', 'cve', 'zero-day', 'phishing', 'vulnerability', 'cyber'],
        thesisUk: 'Більшість масштабних зламів трапляються не через фантастичні експлойти, а через непатчені периметрові сервіси та слабку багатофакторну автентифікацію.',
        quoteUk: 'Поверхня атаки компаній зростає швидше за їхню здатність інвентаризувати власні відкриті сервіси та доступи.',
        keyArgumentsUk: [
          'Критичні оновлення периметрових VPN і хмарних панелей слід застосовувати в перші години.',
          'Фішинг із використанням компрометованих облікових записів залишається головним вектором входу.',
        ],
        url: 'https://krebsonsecurity.com',
        publishedAt: '2026-10-21T14:00:00Z',
      },
    ],
  },
  {
    slug: 'troy-hunt',
    fullName: 'Troy Hunt',
    handle: '@troyhunt',
    platform: 'x',
    roleUk: 'Експерт із веб-безпеки, творець сервісу Have I Been Pwned',
    organization: 'Have I Been Pwned',
    primaryDomains: ['cybersecurity', 'api', 'global_tech'],
    specializations: ['data breach', 'credentials', 'authentication', 'passkeys', 'cloudflare', 'web security', 'api'],
    profileUrl: 'https://x.com/troyhunt',
    knownAffiliationsUk: 'Творець і оператор сервісу перевірки витоків Have I Been Pwned (партнерує з держорганами та 1Password).',
    biasKeywords: ['1password', 'hibp', 'cloudflare'],
    conflictDisclosureUk: 'Має партнерства у сфері менеджменту паролів (1Password) та CDN/безпеки (Cloudflare).',
    credibilityWeight: 94,
    documentedPositions: [
      {
        topicKeywords: ['breach', 'password', 'passkey', 'authentication', 'cloudflare', 'security', 'api'],
        thesisUk: 'Масові витоки облікових даних знецінюють традиційні паролі, роблячи passkeys і апаратну автентифікацію необхідністю.',
        quoteUk: 'Головна небезпека після будь-якого витоку — повторне використання тих самих паролів на робочих і фінансових сервісах.',
        keyArgumentsUk: [
          'Мінімізація персональних даних у логах зменшує шкоду від інциденту.',
          'Швидке повідомлення користувачів важливіше за PR-замовчування.',
        ],
        url: 'https://x.com/troyhunt',
        publishedAt: '2026-10-16T10:00:00Z',
      },
    ],
  },
  {
    slug: 'kelsey-hightower',
    fullName: 'Kelsey Hightower',
    handle: '@kelseyhightower',
    platform: 'x',
    roleUk: 'Інженер з хмарної інфраструктури та Kubernetes, ex-Distinguished Engineer Google',
    organization: 'Independent (ex-Google Cloud)',
    primaryDomains: ['api', 'coding', 'cybersecurity', 'global_tech'],
    specializations: ['cloud', 'kubernetes', 'serverless', 'devops', 'infrastructure', 'architecture', 'reliability'],
    profileUrl: 'https://x.com/kelseyhightower',
    knownAffiliationsUk: 'Незалежний архітектор; раніше Distinguished Engineer у Google Cloud.',
    biasKeywords: ['google cloud', 'kubernetes'],
    conflictDisclosureUk: 'Працював у Google Cloud; підтримує простоту архітектури та критикує зайве ускладнення хмарних стеків.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['cloud', 'kubernetes', 'infrastructure', 'serverless', 'api', 'devops'],
        thesisUk: 'Складність інфраструктури виправдана лише тоді, коли продукт вичерпав прості та надійні способи масштабування.',
        quoteUk: 'Найкраща інфраструктура — та, про яку розробникам не доводиться думати щодня, доки вона передбачувано працює в продакшені.',
        keyArgumentsUk: [
          'Автоматизація деплою має зменшувати операційне навантаження, а не плодити нові шари абстракцій.',
          'Моніторинг вартості хмари та резервне відновлення повинні бути закладені на старті.',
        ],
        url: 'https://x.com/kelseyhightower',
        publishedAt: '2026-10-09T11:00:00Z',
      },
    ],
  },
  {
    slug: 'mitchell-hashimoto',
    fullName: 'Mitchell Hashimoto',
    handle: '@mitchellh',
    platform: 'x',
    roleUk: 'Співзасновник HashiCorp, автор Terraform, Vagrant та терміналу Ghostty',
    organization: 'Ghostty (ex-HashiCorp)',
    primaryDomains: ['coding', 'open_source', 'api'],
    specializations: ['devtools', 'zig', 'terraform', 'infrastructure', 'cli', 'open source', 'systems', 'compiler'],
    profileUrl: 'https://x.com/mitchellh',
    knownAffiliationsUk: 'Співзасновник HashiCorp; зараз веде open-source проєкт Ghostty та системні devtools.',
    biasKeywords: ['hashicorp', 'terraform'],
    conflictDisclosureUk: 'Асоційований із HashiCorp та відкритими системними інструментами; прямого конфлікту з AI-вендорами немає.',
    credibilityWeight: 94,
    documentedPositions: [
      {
        topicKeywords: ['devtools', 'cli', 'open', 'coding', 'systems', 'sdk', 'release'],
        thesisUk: 'Висока швидкість локальних інструментів та зрозуміла діагностика помилок дають розробникам більше продуктивності, ніж важкі хмарні обгортки.',
        quoteUk: 'Якісний інженерний інструмент виграє за рахунок надійності, передбачуваної швидкодії й прозорої архітектури.',
        keyArgumentsUk: [
          'Відкритий вихідний код критичних devtools формує довгострокову довіру спільноти.',
          'Увага до дрібних деталей UX у терміналі й CLI економить години роботи команд.',
        ],
        url: 'https://x.com/mitchellh',
        publishedAt: '2026-10-11T15:00:00Z',
      },
    ],
  },
  {
    slug: 'guillermo-rauch',
    fullName: 'Guillermo Rauch',
    handle: '@rauchg',
    platform: 'x',
    roleUk: 'CEO Vercel, творець Next.js та платформ для веб-інтерфейсів',
    organization: 'Vercel',
    primaryDomains: ['coding', 'api', 'startups_fintech', 'global_tech'],
    specializations: ['nextjs', 'frontend', 'vercel', 'edge', 'ai sdk', 'streaming', 'web', 'typescript'],
    profileUrl: 'https://x.com/rauchg',
    knownAffiliationsUk: 'CEO Vercel (комерційна платформа хостингу, Next.js та Vercel AI SDK).',
    biasKeywords: ['vercel', 'nextjs', 'cloudflare'],
    conflictDisclosureUk: 'CEO Vercel; зацікавлений у популяризації edge-інфраструктури, Next.js та frontend-first підходу.',
    credibilityWeight: 90,
    documentedPositions: [
      {
        topicKeywords: ['web', 'sdk', 'api', 'coding', 'frontend', 'edge', 'streaming'],
        thesisUk: 'Конкурентна перевага сучасних ШІ-продуктів зміщується з голої моделі у швидкий стримінговий UI та інтеграцію з веб-інструментами.',
        quoteUk: 'Користувач оцінює не модель у вакуумі, а те, наскільки швидко інтерфейс реагує та виконує реальну дію.',
        keyArgumentsUk: [
          'Edge-кешування та інкрементальний рендеринг знижують затримку для кінцевого користувача.',
          'Абстракції SDK дають змогу швидко перемикатися між провайдерами моделей.',
        ],
        url: 'https://x.com/rauchg',
        publishedAt: '2026-10-15T13:00:00Z',
      },
    ],
  },

  // --- DefenseTech & Ukraine ---
  {
    slug: 'serhii-beskrestnov',
    fullName: 'Сергій Бескрестнов («Сергій Флеш»)',
    handle: 'Serhii.Flash',
    platform: 'facebook',
    roleUk: 'Український експерт із військового радіозв’язку, РЕБ та БПЛА',
    organization: 'Незалежний військовий технічний консультант',
    primaryDomains: ['defense', 'cybersecurity', 'hardware_gaming'],
    specializations: ['дрон', 'реб', 'бпла', 'fpv', 'зв’язок', 'радіо', 'drone', 'electronic warfare', 'uav', 'antennas'],
    profileUrl: 'https://www.facebook.com/Serhii.Flash',
    knownAffiliationsUk: 'Незалежний український фахівець і консультант фронтових підрозділів із засобів РЕБ, РЕР та зв’язку.',
    conflictDisclosureUk: 'Незалежний технічний експерт; критично перевіряє заявлені характеристики засобів РЕБ і БПЛА у реальних бойових умовах.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['дрон', 'реб', 'бпла', 'fpv', 'drone', 'uav', 'defense', 'electronic warfare'],
        thesisUk: 'Ефективність бойових дронів і систем РЕБ визначається адаптивністю частот, стійкістю зв’язку та реальним польовим тестуванням, а не паперовими ТТХ.',
        quoteUk: 'У сучасній війні дронів будь-яке технічне рішення застаріває за кілька місяців, тому вирішальною є швидкість інженерної ітерації.',
        keyArgumentsUk: [
          'Машинний зір і автономне донаведення потребують стійкого до завад бортового обчислення.',
          'Масштабування без стандартизації та зворотного зв’язку з фронту знижує реальну користь засобів.',
        ],
        url: 'https://www.facebook.com/Serhii.Flash',
        publishedAt: '2026-10-22T09:00:00Z',
      },
    ],
  },
  {
    slug: 'taras-chmut',
    fullName: 'Тарас Чмут',
    handle: '@TarasChmut',
    platform: 'x',
    roleUk: 'Директор фонду «Повернись живим», військовий аналітик',
    organization: 'Фонд «Повернись живим» / Мілітарний',
    primaryDomains: ['defense', 'business', 'global_tech'],
    specializations: ['оборона', 'зсу', 'бпла', 'розвідка', 'defense', 'procurement', 'military', 'artillery', 'uav'],
    profileUrl: 'https://x.com/TarasChmut',
    knownAffiliationsUk: 'Керівник фонду компетентної допомоги армії «Повернись живим» та співзасновник «Мілітарного».',
    biasKeywords: ['закупівлі', 'фонд', 'procurement'],
    conflictDisclosureUk: 'Фонд здійснює масштабні закупівлі оборонних технологій для Сил оборони України, тому оцінює рішення крізь системні закупівлі та логістику.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['оборон', 'зсу', 'бпла', 'defense', 'military', 'drone', 'procurement'],
        thesisUk: 'Системна перевага на полі бою залежить від комплексного поєднання розвідки, зв’язку, підготовки екіпажів та стабільного серійного виробництва.',
        quoteUk: 'Окремі інноваційні прототипи не змінюють ситуацію на фронті, доки не налагоджено їх масове обслуговування та навчання підрозділів.',
        keyArgumentsUk: [
          'Пріоритет слід надавати перевіреним масштабованим комплексам з прогнозованою логістикою.',
          'Інтеграція розвідувальних даних і засобів ураження скорочує цикл прийняття рішень.',
        ],
        url: 'https://x.com/TarasChmut',
        publishedAt: '2026-10-18T11:00:00Z',
      },
    ],
  },
  {
    slug: 'mykhailo-fedorov',
    fullName: 'Михайло Федоров',
    handle: '@FedorovMykhailo',
    platform: 'x',
    roleUk: 'Віцепрем’єр-міністр з інновацій, розвитку освіти, науки та технологій — Міністр цифрової трансформації України',
    organization: 'Мінцифра України / Дія / Brave1',
    primaryDomains: ['defense', 'global_tech', 'education_grants', 'startups_fintech'],
    specializations: ['brave1', 'дія', 'diia', 'дрон', 'defense', 'govtech', 'ukraine', 'grant', 'ai'],
    profileUrl: 'https://x.com/FedorovMykhailo',
    knownAffiliationsUk: 'Керівник Мінцифри України, куратор державної платформи оборонних інновацій Brave1 та цифровізації.',
    biasKeywords: ['brave1', 'дія', 'мінцифра', 'ukraine'],
    conflictDisclosureUk: 'Представник уряду та ініціатор державних програм Дія і Brave1 — оцінює ініціативи з позиції державної політики впровадження.',
    credibilityWeight: 91,
    documentedPositions: [
      {
        topicKeywords: ['brave1', 'ukraine', 'україн', 'defense', 'дрон', 'govtech', 'grant', 'education'],
        thesisUk: 'Швидка дерегуляція ринку дронів, гранти R&D і цифровізація державних сервісів створили в Україні модель прискореного впровадження технологій.',
        quoteUk: 'Пряма взаємодія інженерів із бойовими підрозділами та грантова підтримка на етапі прототипу скорочують шлях до серії в рази.',
        keyArgumentsUk: [
          'Відкритий ринок і конкуренція приватних команд дають швидше зростання, ніж державні монополії.',
          'Освітні програми й підтримка стартапів формують базу для післявоєнної економіки.',
        ],
        url: 'https://x.com/FedorovMykhailo',
        publishedAt: '2026-10-17T10:00:00Z',
      },
    ],
  },
  {
    slug: 'nataliia-kushnerska',
    fullName: 'Наталія Кушнерська',
    handle: 'Brave1',
    platform: 'web',
    roleUk: 'Керівниця оборонного кластера Brave1',
    organization: 'Brave1',
    primaryDomains: ['defense', 'education_grants', 'startups_fintech'],
    specializations: ['brave1', 'грант', 'defense', 'uav', 'ugv', 'реб', 'оборон', 'стартап', 'cluster'],
    profileUrl: 'https://brave1.gov.ua',
    knownAffiliationsUk: 'Очолює державний defense-tech кластер Brave1 (розподіл грантів та тестування розробок).',
    biasKeywords: ['brave1', 'грант', 'defense'],
    conflictDisclosureUk: 'Керівниця Brave1; представляє інституційну позицію державного оборонного кластера щодо стандартів і грантових програм.',
    credibilityWeight: 91,
    documentedPositions: [
      {
        topicKeywords: ['brave1', 'грант', 'defense', 'оборон', 'дрон', 'стартап'],
        thesisUk: 'Ключовими пріоритетами українського defense tech залишаються протидія РЕБ, наземні роботизовані комплекси, автономна навігація та перехоплювачі БПЛА.',
        quoteUk: 'Команди отримують масштабування тоді, коли їхня розробка проходить кодифікацію та доводить ефективність на полігонах.',
        keyArgumentsUk: [
          'Грантові програми перекривають найбільш ризиковий етап переходу від ідеї до першого дослідного зразка.',
          'Кооперація українських та європейських виробників відкриває доступ до інвестицій і компонентів.',
        ],
        url: 'https://brave1.gov.ua',
        publishedAt: '2026-10-15T12:00:00Z',
      },
    ],
  },
  {
    slug: 'mick-ryan',
    fullName: 'Mick Ryan',
    handle: '@WarintheFuture',
    platform: 'x',
    roleUk: 'Військовий стратег, генерал-майор у відставці, дослідник адаптації сучасної війни',
    organization: 'CSIS / Futura Doctrina',
    primaryDomains: ['defense', 'global_tech', 'research'],
    specializations: ['strategy', 'adaptation', 'autonomy', 'drone', 'military', 'doctrine', 'ukraine', 'nato'],
    profileUrl: 'https://x.com/WarintheFuture',
    knownAffiliationsUk: 'Австралійський військовий аналітик і дослідник адаптації армій у війні дронів та ШІ.',
    conflictDisclosureUk: 'Незалежний військовий аналітик (CSIS); фокус на стратегічній і доктринальній адаптації армій.',
    credibilityWeight: 93,
    documentedPositions: [
      {
        topicKeywords: ['defense', 'military', 'drone', 'autonomy', 'ukraine', 'nato', 'strategy'],
        thesisUk: 'Перевагу дає не окрема дорога платформа, а організаційна здатність швидко адаптувати тактику та інтегрувати масові безпілотні системи.',
        quoteUk: 'Індустріальний темп оновлення програмного забезпечення та сенсорів перетворюється на вирішальний чинник сучасної оборони.',
        keyArgumentsUk: [
          'Український досвід масового застосування БПЛА переглядає традиційні оборонні бюджети НАТО.',
          'Людина залишається ключовою ланкою у складних рішеннях попри зростання автономності.',
        ],
        url: 'https://x.com/WarintheFuture',
        publishedAt: '2026-10-13T08:00:00Z',
      },
    ],
  },
  {
    slug: 'samuel-bendett',
    fullName: 'Samuel Bendett',
    handle: '@sambendett',
    platform: 'x',
    roleUk: 'Аналітик безпілотних систем, автономності та РЕБ у CNA та CNAS',
    organization: 'CNA / CNAS',
    primaryDomains: ['defense', 'hardware_gaming', 'research'],
    specializations: ['uav', 'ugv', 'fpv', 'drone', 'electronic warfare', 'autonomy', 'defense', 'military'],
    profileUrl: 'https://x.com/sambendett',
    knownAffiliationsUk: 'Аналітик дослідницьких центрів CNA та CNAS; відстежує розвиток БПЛА, НРК та систем протидії дронам.',
    conflictDisclosureUk: 'Незалежний дослідник аналітичних центрів CNA/CNAS; публікує технічні порівняння систем безпілотної боротьби.',
    credibilityWeight: 92,
    documentedPositions: [
      {
        topicKeywords: ['uav', 'ugv', 'fpv', 'drone', 'defense', 'ew', 'autonomy'],
        thesisUk: 'Поле бою переходить від ручного керування FPV до роїв із комп’ютерним зором та інтеграцією наземних логістичних дронів.',
        quoteUk: 'Кожне нове рішення автономного наведення миттєво викликає гонку дешевих контрзаходів і переналаштування частот.',
        keyArgumentsUk: [
          'Дешеві компоненти цивільної електроніки та комп’ютерний зір знизили поріг входу для виробників.',
          'Ефективність залежить від захисту каналів передачі даних і навігації без GPS.',
        ],
        url: 'https://x.com/sambendett',
        publishedAt: '2026-10-14T16:00:00Z',
      },
    ],
  },

  // --- Startups, Venture & Fintech ---
  {
    slug: 'paul-graham',
    fullName: 'Paul Graham',
    handle: '@paulg',
    platform: 'web',
    roleUk: 'Співзасновник Y Combinator, есеїст і венчурний інвестор',
    organization: 'Y Combinator',
    primaryDomains: ['startups_fintech', 'business', 'education_grants'],
    specializations: ['startup', 'founder', 'y combinator', 'yc', 'seed', 'venture', 'product', 'growth'],
    profileUrl: 'https://paulgraham.com',
    knownAffiliationsUk: 'Співзасновник акселератора Y Combinator; інвестор у сотні технологічних компаній.',
    biasKeywords: ['y combinator', 'yc', 'startup'],
    conflictDisclosureUk: 'Співзасновник Y Combinator; оцінює ринок крізь призму ранніх технологічних стартапів та венчурного зростання.',
    credibilityWeight: 94,
    documentedPositions: [
      {
        topicKeywords: ['startup', 'founder', 'yc', 'y combinator', 'seed', 'venture', 'product'],
        thesisUk: 'Навіть у хвилі платформних змін перемагають малі команди, які вирішують гостру реальну проблему перших користувачів, а не женуться за модою.',
        quoteUk: 'Зробити продукт, який по-справжньому потрібен невеликій групі людей, надійніше за гучний запуск без утримання аудиторії.',
        keyArgumentsUk: [
          'Низька вартість розробки підвищує важливість швидкості ітерацій і фокусу.',
          'Надлишкові інвестиції на ранній стадії часто шкодять дисципліні продукту.',
        ],
        url: 'https://paulgraham.com',
        publishedAt: '2026-10-03T12:00:00Z',
      },
    ],
  },
  {
    slug: 'garry-tan',
    fullName: 'Garry Tan',
    handle: '@garrytan',
    platform: 'x',
    roleUk: 'Президент і CEO Y Combinator',
    organization: 'Y Combinator',
    primaryDomains: ['startups_fintech', 'business', 'coding'],
    specializations: ['y combinator', 'yc', 'startup', 'venture', 'seed round', 'series a', 'founder', 'ai startup'],
    profileUrl: 'https://x.com/garrytan',
    knownAffiliationsUk: 'CEO Y Combinator та співзасновник Initialized Capital.',
    biasKeywords: ['y combinator', 'yc', 'startup', 'venture'],
    conflictDisclosureUk: 'Очолює Y Combinator; прямо зацікавлений у промоції венчурної моделі YC та AI-стартапів портфеля.',
    credibilityWeight: 89,
    documentedPositions: [
      {
        topicKeywords: ['startup', 'yc', 'venture', 'seed', 'series', 'funding', 'founder'],
        thesisUk: 'Невеликі інженерні команди за допомогою сучасних інструментів автоматизації здатні будувати B2B-продукти з виручкою корпорацій минулого.',
        quoteUk: 'Головний захист стартапу сьогодні — глибоке знання вертикального робочого процесу клієнта та власні дані.',
        keyArgumentsUk: [
          'Вертикальні продукти виграють у загальних чат-ботів за рахунок інтеграції у бізнес-процеси.',
          'Швидке виявлення попиту важливіше за раннє роздування штату.',
        ],
        url: 'https://x.com/garrytan',
        publishedAt: '2026-10-12T17:00:00Z',
      },
    ],
  },
  {
    slug: 'benedict-evans',
    fullName: 'Benedict Evans',
    handle: '@benedictevans',
    platform: 'web',
    roleUk: 'Незалежний аналітик технологічних платформ і ринків (ex-a16z)',
    organization: 'Benedict Evans',
    primaryDomains: ['business', 'global_tech', 'startups_fintech'],
    specializations: ['market share', 'antitrust', 'enterprise', 'adoption', 'big tech', 'platform', 'eu', 'revenue'],
    profileUrl: 'https://www.ben-evans.com',
    knownAffiliationsUk: 'Незалежний макроаналітик технологічної індустрії (раніше партнер Andreessen Horowitz).',
    conflictDisclosureUk: 'Незалежний аналітик; не має прямої залежності від окремих AI-вендорів і фокусується на макроекономіці технологій.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['business', 'market', 'antitrust', 'enterprise', 'big tech', 'regulation', 'revenue'],
        thesisUk: 'Кожна нова технологія спершу автоматизує існуючі завдання, але справжня трансформація ринку починається після зміни бізнес-моделей.',
        quoteUk: 'Головне запитання до нової платформи — чи створює вона нову цінність і попит, а не лише перерозподіляє наявні бюджети.',
        keyArgumentsUk: [
          'Історичні технологічні цикли показують лаг у 5–10 років між проривом і масовим корпоративним прибутком.',
          'Регуляторні обмеження в ЄС і США дедалі сильніше формують продуктову архітектуру.',
        ],
        url: 'https://www.ben-evans.com',
        publishedAt: '2026-10-11T10:00:00Z',
      },
    ],
  },
  {
    slug: 'vitalik-buterin',
    fullName: 'Vitalik Buterin',
    handle: '@VitalikButerin',
    platform: 'web',
    roleUk: 'Співзасновник Ethereum, дослідник криптографії та децентралізованих систем',
    organization: 'Ethereum Foundation',
    primaryDomains: ['startups_fintech', 'cybersecurity', 'research'],
    specializations: ['fintech', 'crypto', 'blockchain', 'zero-knowledge', 'zk', 'cryptography', 'ethereum', 'payments', 'stablecoin'],
    profileUrl: 'https://vitalik.eth.limo',
    knownAffiliationsUk: 'Співзасновник Ethereum; просуває децентралізовані протоколи та криптографічні докази (ZK).',
    biasKeywords: ['ethereum', 'crypto', 'blockchain', 'web3'],
    conflictDisclosureUk: 'Ключовий фігурант екосистеми Ethereum; зацікавлений у децентралізованій криптографічній архітектурі.',
    credibilityWeight: 93,
    documentedPositions: [
      {
        topicKeywords: ['fintech', 'crypto', 'blockchain', 'payments', 'stablecoin', 'zk', 'cryptography'],
        thesisUk: 'Довготривала корисність фінтех- та блокчейн-рішень вимагає криптографічної верифікації, низьких комісій та захисту приватності користувача.',
        quoteUk: 'Поєднання криптографічних доказів із відкритими сервісами дає змогу перевіряти чесність обчислень без сліпої довіри до посередника.',
        keyArgumentsUk: [
          'Безпека гаманців і захист від соціальної інженерії критичні для масових платежів.',
          'Перетин криптографії та ШІ корисний у верифікації ідентичності та боротьбі з ботами.',
        ],
        url: 'https://vitalik.eth.limo',
        publishedAt: '2026-10-07T14:00:00Z',
      },
    ],
  },
  {
    slug: 'rostyslav-diuk',
    fullName: 'Ростислав Дюк / Український фонд стартапів',
    handle: '@usf_ua',
    platform: 'web',
    roleUk: 'Український фінтех-лідер та екосистемний координатор інновацій (USF / UAFIC)',
    organization: 'Український фонд стартапів / UAFIC',
    primaryDomains: ['startups_fintech', 'education_grants', 'global_tech'],
    specializations: ['стартап', 'фінтех', 'грант', 'інвестиції', 'україна', 'usf', 'fintech', 'startup', 'grant', 'ukraine'],
    profileUrl: 'https://usf.com.ua',
    knownAffiliationsUk: 'Пов’язаний із розвитком фінтех-екосистеми UAFIC та грантової підтримки Українського фонду стартапів (USF).',
    biasKeywords: ['usf', 'грант', 'стартап', 'фінтех'],
    conflictDisclosureUk: 'Екосистемний інституційний інтерес до грантових і фінтех-ініціатив України.',
    credibilityWeight: 88,
    documentedPositions: [
      {
        topicKeywords: ['стартап', 'фінтех', 'грант', 'інвестиц', 'ukraine', 'startup', 'fintech', 'grant'],
        thesisUk: 'Українські стартапи та фінтех-проєкти утримують глобальну конкурентність завдяки поєднанню грантового капіталу на старті та експортного фокусу.',
        quoteUk: 'Доступ до безповоротних грантів і міжнародних інтеграцій дозволяє українським командам проходити долину смерті без втрати контролю над компанією.',
        keyArgumentsUk: [
          'Гранти ранніх стадій працюють найефективніше разом із менторством і виходом на ринки ЄС/США.',
          'Фінтех та оборонні технології лишаються драйверами технологічного експорту України.',
        ],
        url: 'https://usf.com.ua',
        publishedAt: '2026-10-09T10:00:00Z',
      },
    ],
  },

  // --- Science, Space & Biotech ---
  {
    slug: 'jonathan-mcdowell',
    fullName: 'Jonathan McDowell',
    handle: '@planet4589',
    platform: 'x',
    roleUk: 'Астрофізик Center for Astrophysics (Harvard & Smithsonian), автор каталогу космічних запусків',
    organization: 'Harvard-Smithsonian CfA',
    primaryDomains: ['science_space', 'research'],
    specializations: ['space', 'orbit', 'satellite', 'rocket', 'nasa', 'spacex', 'launch', 'iss', 'starlink', 'astronomy'],
    profileUrl: 'https://x.com/planet4589',
    knownAffiliationsUk: 'Астрофізик Harvard-Smithsonian CfA; веде незалежний публічний реєстр усіх орбітальних запусків і супутників.',
    conflictDisclosureUk: 'Незалежний академічний астрофізик та верифікатор орбітальних запусків; не представляє комерційних космічних операторів.',
    credibilityWeight: 97,
    documentedPositions: [
      {
        topicKeywords: ['space', 'orbit', 'rocket', 'satellite', 'nasa', 'spacex', 'launch', 'telescope'],
        thesisUk: 'Зростання кількості запусків на низьку навколоземну орбіту вимагає жорсткішої координації космічного руху та контролю орбітального сміття.',
        quoteUk: 'Дані телеметрії та незалежне відстеження орбіт залишаються єдиним надійним критерієм успіху місії.',
        keyArgumentsUk: [
          'Переповнення низьких орбіт підвищує ризики каскадних зіткнень.',
          'Своєчасне зведення відпрацьованих ступенів і супутників стає обов’язковим стандартом.',
        ],
        url: 'https://x.com/planet4589',
        publishedAt: '2026-10-18T08:00:00Z',
      },
    ],
  },
  {
    slug: 'eric-topol',
    fullName: 'Eric Topol',
    handle: '@EricTopol',
    platform: 'x',
    roleUk: 'Кардіолог, генетик, директор Scripps Research Translational Institute',
    organization: 'Scripps Research (Ground Truths)',
    primaryDomains: ['science_space', 'research', 'model'],
    specializations: ['biotech', 'medicine', 'health', 'clinical', 'genome', 'crispr', 'alphafold', 'diagnosis', 'trial'],
    profileUrl: 'https://x.com/EricTopol',
    knownAffiliationsUk: 'Професор і директор Scripps Research Translational Institute; автор наукових оглядів з біомедицини та медичного ШІ.',
    conflictDisclosureUk: 'Академічний дослідник біомедицини; вимагає рандомізованих клінічних випробувань перед клінічним застосуванням ШІ.',
    credibilityWeight: 96,
    documentedPositions: [
      {
        topicKeywords: ['biotech', 'medicine', 'clinical', 'genome', 'crispr', 'health', 'research', 'trial'],
        thesisUk: 'Медичні та біотехнологічні алгоритми доводять цінність лише у проспективних клінічних випробуваннях на реальних пацієнтах, а не в ретроспективних датасетах.',
        quoteUk: 'ШІ в медицині стає проривом для скринінгу й молекулярного моделювання, коли працює під контролем лікаря та суворої клінічної валідації.',
        keyArgumentsUk: [
          'Рандомізовані клінічні дослідження залишаються золотим стандартом безпеки.',
          'Мультиоміка й прогнозування білкових структур прискорюють розробку ліків.',
        ],
        url: 'https://x.com/EricTopol',
        publishedAt: '2026-10-16T14:00:00Z',
      },
    ],
  },
  {
    slug: 'casey-handmer',
    fullName: 'Casey Handmer',
    handle: '@CJHandmer',
    platform: 'x',
    roleUk: 'Фізик, колишній інженер NASA JPL, дослідник космічної інфраструктури та енергетики',
    organization: 'Terraform Industries (ex-NASA JPL)',
    primaryDomains: ['science_space', 'global_tech', 'hardware_gaming'],
    specializations: ['nasa', 'spacex', 'starship', 'energy', 'solar', 'rocket', 'mars', 'physics', 'propulsion'],
    profileUrl: 'https://x.com/CJHandmer',
    knownAffiliationsUk: 'Колишній інженер NASA JPL; засновник енергетичного стартапу Terraform Industries.',
    biasKeywords: ['terraform industries', 'solar', 'synthetic fuel'],
    conflictDisclosureUk: 'Засновник Terraform Industries; зацікавлений у дешевій сонячній енергетиці та синтетичному паливі.',
    credibilityWeight: 90,
    documentedPositions: [
      {
        topicKeywords: ['nasa', 'spacex', 'rocket', 'mars', 'energy', 'space', 'physics'],
        thesisUk: 'Здешевлення виведення кілограма корисного навантаження на орбіту змінює економіку наукових апаратів, даючи змогу запускати серійні прилади замість поодиноких десятилітніх проєктів.',
        quoteUk: 'Коли вартість доступу до космосу падає на порядок, інженерні ризики можна вирішувати частими ітераціями заліза.',
        keyArgumentsUk: [
          'Багаторазові носії радикально змінюють бюджет космічної науки та зв’язку.',
          'Енергетична масштабованість є базовим обмеженням для індустрії та ШІ-датацентрів.',
        ],
        url: 'https://x.com/CJHandmer',
        publishedAt: '2026-10-06T12:00:00Z',
      },
    ],
  },
  {
    slug: 'sabine-hossenfelder',
    fullName: 'Sabine Hossenfelder',
    handle: '@skdh',
    platform: 'x',
    roleUk: 'Фізикиня-теоретикиня, наукова комунікаторка та скептична коментаторка фундаментальних досліджень',
    organization: 'Munich Center for Mathematical Philosophy',
    primaryDomains: ['science_space', 'research'],
    specializations: ['quantum', 'physics', 'fusion', 'cern', 'particle', 'computing', 'cosmology', 'science'],
    profileUrl: 'https://x.com/skdh',
    knownAffiliationsUk: 'Дослідниця теоретичної фізики та авторка наукових оглядів; послідовно відокремлює доведену фізику від лабораторного піару.',
    conflictDisclosureUk: 'Незалежна наукова оглядачка; критично оцінює завищені заяви щодо квантових комп’ютерів і термоядерного синтезу.',
    credibilityWeight: 91,
    documentedPositions: [
      {
        topicKeywords: ['quantum', 'physics', 'fusion', 'cern', 'science', 'nature', 'research'],
        thesisUk: 'У квантових обчисленнях і термоядерному синтезі рекорди окремих кубітів чи імпульсів часто далекі від комерційної та фізичної окупності.',
        quoteUk: 'Головний критерій квантового чи термоядерного прориву — корекція помилок та чистий вихід енергії на рівні всієї установки.',
        keyArgumentsUk: [
          'Масштабування логічних кубітів залишається головним технологічним бар’єром.',
          'Науковим пресрелізам бракує чесного акценту на практичних термінах впровадження.',
        ],
        url: 'https://x.com/skdh',
        publishedAt: '2026-10-10T15:00:00Z',
      },
    ],
  },

  // --- Hardware, Systems & Gaming ---
  {
    slug: 'john-carmack',
    fullName: 'John Carmack',
    handle: '@ID_AA_Carmack',
    platform: 'x',
    roleUk: 'Легендарний інженер графіки та систем, співзасновник id Software, Keen Technologies',
    organization: 'Keen Technologies (ex-id Software / Meta)',
    primaryDomains: ['hardware_gaming', 'coding', 'research', 'model'],
    specializations: ['gpu', 'graphics', 'vr', 'game engine', 'rendering', 'fps', 'latency', 'agi', 'optimization', 'silicon'],
    profileUrl: 'https://x.com/ID_AA_Carmack',
    knownAffiliationsUk: 'Засновник Keen Technologies (AGI), раніше CTO Oculus VR та співзасновник id Software.',
    biasKeywords: ['keen technologies', 'meta', 'oculus'],
    conflictDisclosureUk: 'Працює над AGI у Keen Technologies; підходить до оцінки заліза та ШІ з позиції суворої системної оптимізації.',
    credibilityWeight: 98,
    documentedPositions: [
      {
        topicKeywords: ['gpu', 'graphics', 'vr', 'gaming', 'engine', 'latency', 'optimization', 'agi'],
        thesisUk: 'Продуктивність інтерактивних систем та ШІ визначається дисципліною роботи з пам’яттю, затримками і профілюванням кожного рівня стеку.',
        quoteUk: 'Справжній інженерний приріст майже завжди ховається у пропускній здатності пам’яті та мінімізації зайвих кроків обчислень.',
        keyArgumentsUk: [
          'Затримка кадру й відгук інтерфейсу критично впливають на досвід у іграх та VR.',
          'Апаратні обмеження пропускної здатності важливіші за пікові маркетингові терафлопси.',
        ],
        url: 'https://x.com/ID_AA_Carmack',
        publishedAt: '2026-10-12T18:00:00Z',
      },
    ],
  },
  {
    slug: 'ian-cutress',
    fullName: 'Dr. Ian Cutress',
    handle: '@IanCutress',
    platform: 'x',
    roleUk: 'Експерт із напівпровідників, процесорів та архітектури CPU/GPU, TechTechPotato',
    organization: 'More Than Moore',
    primaryDomains: ['hardware_gaming', 'global_tech', 'business'],
    specializations: ['cpu', 'gpu', 'semiconductor', 'tsmc', 'intel', 'amd', 'nvidia', 'ryzen', 'chip', 'wafer', 'node'],
    profileUrl: 'https://x.com/IanCutress',
    knownAffiliationsUk: 'Аналітик напівпровідникової індустрії (More Than Moore), колишній головний редактор AnandTech з CPU.',
    biasKeywords: ['intel', 'amd', 'nvidia', 'tsmc'],
    conflictDisclosureUk: 'Проводить індустріальний консалтинг через More Than Moore; дотримується незалежної інженерної методології тестування чипів.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['cpu', 'gpu', 'semiconductor', 'intel', 'amd', 'nvidia', 'chip', 'tsmc'],
        thesisUk: 'Реальний прогрес процесорів та прискорювачів визначається енергоефективністю на ват, виходом годних кристалів та упаковкою чиплетів.',
        quoteUk: 'Техпроцес у нанометрах давно став маркетинговою назвою; порівнювати чипи треба за реальним споживанням, щільністю та вартістю пластини.',
        keyArgumentsUk: [
          'Конкуренція TSMC та Intel Foundry формує доступність GPU й серверних CPU на роки вперед.',
          'Перегрів і ліміти живлення часто зводять нанівець пікові паспортні частоти.',
        ],
        url: 'https://x.com/IanCutress',
        publishedAt: '2026-10-19T13:00:00Z',
      },
    ],
  },
  {
    slug: 'richard-leadbetter',
    fullName: 'Richard Leadbetter',
    handle: 'Digital Foundry',
    platform: 'web',
    roleUk: 'Засновник Digital Foundry, технічний аналітик ігрової графіки та консольного заліза',
    organization: 'Digital Foundry / Eurogamer',
    primaryDomains: ['hardware_gaming'],
    specializations: ['gaming', 'playstation', 'ps5', 'xbox', 'nintendo', 'unreal engine', 'fps', 'dlss', 'ray tracing', 'console'],
    profileUrl: 'https://www.eurogamer.net/digitalfoundry',
    knownAffiliationsUk: 'Технічний редактор Digital Foundry на платформі Eurogamer.',
    biasKeywords: ['eurogamer', 'sony', 'microsoft', 'nvidia'],
    conflictDisclosureUk: 'Працює в медіагрупі Eurogamer/Digital Foundry; тестує консольне й ПК-залізо незалежними покадровими методиками.',
    credibilityWeight: 95,
    documentedPositions: [
      {
        topicKeywords: ['gaming', 'playstation', 'ps5', 'xbox', 'nintendo', 'unreal', 'fps', 'dlss', 'console'],
        thesisUk: 'Якість сучасних ігор на консолях і ПК залежить від розумного поєднання апскейлінгу (DLSS/FSR) і стабільного фреймпейсингу, а не лише нативної роздільної здатності.',
        quoteUk: 'Стабільна частота кадрів без статерів компіляції шейдерів важливіша для гравця, ніж сухі цифри нативних пікселів.',
        keyArgumentsUk: [
          'Апскейлінг на базі ШІ став обов’язковою опорою при трасуванні променів.',
          'Апаратне оновлення консолей фокусується на прискоренні рейтрейсингу та AI-масштабуванні.',
        ],
        url: 'https://www.eurogamer.net/digitalfoundry',
        publishedAt: '2026-10-20T16:00:00Z',
      },
    ],
  },
  {
    slug: 'linus-torvalds',
    fullName: 'Linus Torvalds',
    handle: 'Linux Kernel',
    platform: 'web',
    roleUk: 'Творець ядра Linux та системи контролю версій Git',
    organization: 'Linux Foundation / Kernel.org',
    primaryDomains: ['open_source', 'coding', 'hardware_gaming', 'cybersecurity'],
    specializations: ['linux', 'kernel', 'rust', 'c', 'git', 'open source', 'systems', 'drivers', 'hardware'],
    profileUrl: 'https://lkml.org',
    knownAffiliationsUk: 'Головний мейнтейнер ядра Linux під егідою Linux Foundation.',
    conflictDisclosureUk: 'Лідер відкритої розробки ядра Linux; відстоює практичну надійність і зворотну сумісність для користувачів.',
    credibilityWeight: 98,
    documentedPositions: [
      {
        topicKeywords: ['linux', 'kernel', 'open', 'rust', 'drivers', 'hardware', 'security', 'git'],
        thesisUk: 'Системні технології та нові мови в ядрі мають доводити практичну простоту супроводу без ламання користувацького простору.',
        quoteUk: 'У масштабах реальної системи головний критерій — не теоретична елегантність, а відсутність регресій для мільйонів користувачів.',
        keyArgumentsUk: [
          'Безпечна робота з пам’яттю та поступове впровадження Rust у драйвери зменшують клас критичних помилок.',
          'Підтримка нового заліза у відкритому ядрі вимагає прозорої роботи вендорів із мейнтейнерами.',
        ],
        url: 'https://lkml.org',
        publishedAt: '2026-10-14T11:00:00Z',
      },
    ],
  },
];

export function scoreExpertCompetenceForTopic(
  expert: ExpertProfile,
  articleCategory: string,
  articleTitle: string,
  articleSummary = '',
): ExpertCompetenceAssessment {
  const category = (articleCategory || 'other').toLowerCase() as NewsCategory;
  const haystack = `${articleTitle || ''} ${articleSummary || ''}`.toLowerCase();

  const isPrimaryDomain = expert.primaryDomains.includes(category);
  const matchedSpecs = expert.specializations.filter((token) =>
    haystack.includes(token.toLowerCase()),
  );

  let score = isPrimaryDomain ? 76 : 28;
  score += Math.min(18, matchedSpecs.length * 6);
  if (isPrimaryDomain && expert.primaryDomains[0] === category) {
    score += 4;
  }
  if (!isPrimaryDomain && matchedSpecs.length >= 2) {
    score += 18;
  } else if (!isPrimaryDomain && matchedSpecs.length === 0) {
    score = Math.min(42, Math.max(20, Math.round(expert.credibilityWeight * 0.35)));
  }

  score = Math.max(15, Math.min(99, Math.round(score)));
  const isDirectDomainMatch = isPrimaryDomain || score >= 75;

  const domainText = expert.primaryDomains.join(', ');
  const rationaleUk = isDirectDomainMatch
    ? matchedSpecs.length > 0
      ? `Прямий збіг профілю (${category}) і спеціалізації (${matchedSpecs.slice(0, 3).join(', ')}).`
      : `Пряма доменна експертиза у категорії «${category}» (${expert.roleUk}).`
    : `Тема «${category}» поза основним фокусом експерта (${domainText}), тому оцінка компетентності знижена.`;

  const biasHit = (expert.biasKeywords ?? []).find((kw) => haystack.includes(kw.toLowerCase()));
  const potentialBiasUk = biasHit
    ? `У темі згадується «${biasHit}», що перетинається із профілем чи позицією експерта: ${expert.knownAffiliationsUk}`
    : `Перспектива сформована професійною роллю (${expert.organization}): ${expert.knownAffiliationsUk}`;

  const conflictOfInterestUk = biasHit
    ? expert.conflictDisclosureUk || `Можлива афіліація з «${biasHit}» через ${expert.organization}.`
    : expert.conflictDisclosureUk || `Прямого конфлікту інтересів щодо цієї події не виявлено (${expert.organization}).`;

  return {
    score,
    rationaleUk,
    isDirectDomainMatch,
    potentialBiasUk,
    conflictOfInterestUk,
  };
}
