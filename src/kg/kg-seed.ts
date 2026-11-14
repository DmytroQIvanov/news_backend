export type KgEntityType = 'company' | 'model' | 'technology' | 'product' | 'event';
export type CredibilityTier = 'verified_fact' | 'company_claim' | 'independent_test' | 'ai_inference';

export interface KgSeedEntity {
  slug: string;
  name: string;
  entityType: KgEntityType;
  providerId?: string;
  descriptionUk: string;
  keywords: string[];
}

export interface KgSeedRelation {
  from: string;
  to: string;
  relationType: string;
  labelUk: string;
}

export const KG_SEED_ENTITIES: KgSeedEntity[] = [
  // Companies
  {
    slug: 'nvidia',
    name: 'NVIDIA',
    entityType: 'company',
    descriptionUk: 'Лідер AI-прискорювачів, GPU та локальної інфраструктури CUDA.',
    keywords: ['nvidia', 'geforce', 'rtx', 'h100', 'h200', 'b200', 'blackwell', 'cuda', 'tensorrt'],
  },
  {
    slug: 'openai',
    name: 'OpenAI',
    entityType: 'company',
    providerId: 'openai',
    descriptionUk: 'Розробник сімейства моделей GPT, o-серії та ChatGPT.',
    keywords: ['openai', 'sam altman', 'chatgpt', 'gpt-4', 'gpt-5', 'o3', 'o4-mini', 'sora'],
  },
  {
    slug: 'anthropic',
    name: 'Anthropic',
    entityType: 'company',
    providerId: 'anthropic',
    descriptionUk: 'Компанія AI-безпеки, розробник моделей Claude та Claude Code.',
    keywords: ['anthropic', 'claude', 'sonnet', 'opus', 'haiku', 'claude code'],
  },
  {
    slug: 'google',
    name: 'Google DeepMind',
    entityType: 'company',
    providerId: 'google',
    descriptionUk: 'Розробник Gemini, Gemma, TPU та AI Studio.',
    keywords: ['google', 'deepmind', 'gemini', 'gemma', 'ai studio', 'vertex ai', 'tpu'],
  },
  {
    slug: 'xai',
    name: 'xAI',
    entityType: 'company',
    providerId: 'xai',
    descriptionUk: 'AI-компанія Ілона Маска, розробник моделей Grok.',
    keywords: ['xai', 'grok'],
  },
  {
    slug: 'mistral',
    name: 'Mistral AI',
    entityType: 'company',
    providerId: 'mistral',
    descriptionUk: 'Європейський розробник відкритих і комерційних LLM.',
    keywords: ['mistral', 'mixtral', 'codestral', 'pixtral'],
  },
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    entityType: 'company',
    providerId: 'deepseek',
    descriptionUk: 'Розробник високоефективних відкритих reasoning-моделей.',
    keywords: ['deepseek', 'deepseek-r1', 'deepseek-v3'],
  },
  {
    slug: 'groq',
    name: 'Groq',
    entityType: 'company',
    providerId: 'groq',
    descriptionUk: 'Провайдер надшвидкого LPU-інференсу для відкритих моделей.',
    keywords: ['groq', 'lpu'],
  },
  {
    slug: 'meta',
    name: 'Meta AI',
    entityType: 'company',
    descriptionUk: 'Розробник відкритого сімейства моделей Llama.',
    keywords: ['meta ai', 'llama 3', 'llama 4', 'llama-3', 'llama-4', 'pytorch'],
  },
  // Models
  {
    slug: 'gpt-series',
    name: 'GPT / o-series',
    entityType: 'model',
    providerId: 'openai',
    descriptionUk: 'Флагманські мультимодальні та reasoning-моделі OpenAI.',
    keywords: ['gpt-4', 'gpt-4o', 'gpt-5', 'o1', 'o3', 'o4-mini'],
  },
  {
    slug: 'claude-models',
    name: 'Claude 3.7 / 4',
    entityType: 'model',
    providerId: 'anthropic',
    descriptionUk: 'Моделі Anthropic для кодингу, агентів і складного аналізу.',
    keywords: ['claude 3', 'claude 4', 'claude sonnet', 'claude opus', 'claude haiku'],
  },
  {
    slug: 'gemini-models',
    name: 'Gemini 2.5 / Flash',
    entityType: 'model',
    providerId: 'google',
    descriptionUk: 'Моделі Google з контекстом до 1-2M токенів та мультимодальністю.',
    keywords: ['gemini 2', 'gemini 1.5', 'gemini flash', 'gemini pro'],
  },
  {
    slug: 'llama-models',
    name: 'Llama Open Weights',
    entityType: 'model',
    providerId: 'together',
    descriptionUk: 'Популярні відкриті моделі для локального та хмарного запуску.',
    keywords: ['llama', 'llama 3', 'llama 4'],
  },
  // Technologies
  {
    slug: 'gpu-hardware',
    name: 'GPU та AI-прискорювачі',
    entityType: 'technology',
    descriptionUk: 'Апаратне забезпечення (Blackwell, H100, RTX, TPU, LPU) для навчання й інференсу.',
    keywords: ['gpu', 'blackwell', 'rtx', 'h100', 'h200', 'b200', 'cuda', 'vram', 'tpu', 'lpu', 'chip'],
  },
  {
    slug: 'local-ai',
    name: 'Локальний ШІ',
    entityType: 'technology',
    descriptionUk: 'Запуск LLM локально на власних GPU/CPU без передачі даних у хмару.',
    keywords: ['local ai', 'on-device', 'ollama', 'vllm', 'llama.cpp', 'gguf', 'quantization', 'локальн'],
  },
  {
    slug: 'ai-agents',
    name: 'AI-агенти та MCP',
    entityType: 'technology',
    descriptionUk: 'Автономні агенти, tool-use, Model Context Protocol та багатокрокові воркфлоу.',
    keywords: ['agent', 'agents', 'agentic', 'mcp', 'model context protocol', 'tool use', 'workflow', 'агент'],
  },
  {
    slug: 'reasoning',
    name: 'Reasoning / Мислення',
    entityType: 'technology',
    descriptionUk: 'Моделі з ланцюжком міркувань (CoT) для математики, коду та науки.',
    keywords: ['reasoning', 'chain-of-thought', 'thinking', 'math', 'r1', 'o3'],
  },
  {
    slug: 'benchmarks',
    name: 'Бенчмарки та Оцінювання',
    entityType: 'event',
    descriptionUk: 'Незалежні тести якості та швидкості (SWE-bench, GPQA, Arena, LiveBench).',
    keywords: ['benchmark', 'swe-bench', 'mmlu', 'gpqa', 'arena', 'eval', 'leaderboard', 'бенчмарк'],
  },
  // Products
  {
    slug: 'ollama-vllm',
    name: 'Ollama & vLLM',
    entityType: 'product',
    descriptionUk: 'Провідні рушії для локального та серверного запуску відкритих моделей.',
    keywords: ['ollama', 'vllm', 'lm studio'],
  },
  {
    slug: 'ai-coding-tools',
    name: 'AI-інструменти кодингу',
    entityType: 'product',
    descriptionUk: 'Середовища та CLI для розробки з ШІ: Claude Code, Cursor, Copilot.',
    keywords: ['claude code', 'cursor', 'copilot', 'windsurf', 'codex', 'ide'],
  },
];

export const KG_SEED_RELATIONS: KgSeedRelation[] = [
  { from: 'nvidia', to: 'gpu-hardware', relationType: 'develops', labelUk: 'виробляє GPU' },
  { from: 'gpu-hardware', to: 'local-ai', relationType: 'supports', labelUk: 'прискорює локальний ШІ' },
  { from: 'local-ai', to: 'ollama-vllm', relationType: 'uses', labelUk: 'працює через' },
  { from: 'ollama-vllm', to: 'llama-models', relationType: 'supports', labelUk: 'запускає моделі' },
  { from: 'ollama-vllm', to: 'benchmarks', relationType: 'benchmarks', labelUk: 'тестується в' },
  { from: 'openai', to: 'gpt-series', relationType: 'develops', labelUk: 'розробляє' },
  { from: 'anthropic', to: 'claude-models', relationType: 'develops', labelUk: 'розробляє' },
  { from: 'anthropic', to: 'ai-coding-tools', relationType: 'develops', labelUk: 'створює Claude Code' },
  { from: 'google', to: 'gemini-models', relationType: 'develops', labelUk: 'розробляє' },
  { from: 'meta', to: 'llama-models', relationType: 'develops', labelUk: 'випускає' },
  { from: 'claude-models', to: 'ai-agents', relationType: 'supports', labelUk: 'оптимізовано для агентів' },
  { from: 'gpt-series', to: 'reasoning', relationType: 'supports', labelUk: 'має режим мислення' },
  { from: 'deepseek', to: 'reasoning', relationType: 'supports', labelUk: 'відкритий reasoning' },
  { from: 'deepseek', to: 'local-ai', relationType: 'supports', labelUk: 'доступно локально' },
  { from: 'groq', to: 'llama-models', relationType: 'runs_on', labelUk: 'прискорює на LPU' },
  { from: 'ai-coding-tools', to: 'benchmarks', relationType: 'benchmarks', labelUk: 'перевіряється на SWE-bench' },
];

export function extractEntitySlugs(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const entity of KG_SEED_ENTITIES) {
    if (entity.keywords.some((kw) => lower.includes(kw))) {
      matched.push(entity.slug);
    }
  }
  return matched;
}

export function classifyCredibilityTier(text: string, sourceUnofficial = false): {
  tier: CredibilityTier;
  isCorrectionSignal: boolean;
} {
  const lower = text.toLowerCase();
  const isCorrectionSignal = /\b(retract|correction|erratum|clarification|спростування|виправлення|уточнення)\b/i.test(lower);

  if (/\b(benchmark|swe-bench|independent|lmsys|arena|evaluation|arxiv|paper|peer-reviewed)\b/i.test(lower)) {
    return { tier: 'independent_test', isCorrectionSignal };
  }
  if (/\b(release notes|changelog|github\.com|documentation|docs\.|api reference|v\d+\.\d+)\b/i.test(lower) && !sourceUnofficial) {
    return { tier: 'verified_fact', isCorrectionSignal };
  }
  if (sourceUnofficial || /\b(rumor|leak|reportedly|might|could|speculation|чутки|імовірно)\b/i.test(lower)) {
    return { tier: 'ai_inference', isCorrectionSignal };
  }
  return { tier: 'company_claim', isCorrectionSignal };
}
