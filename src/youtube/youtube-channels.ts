import { NewsCategory } from '../ingest/ingest.dto';

export interface YoutubeChannelDefinition {
  slug: string;
  channelId: string;
  name: string;
  category: NewsCategory;
  credibilityWeight: number;
  priorityTier: 'high' | 'standard';
  language: 'en' | 'uk';
  topics: string[];
}

/**
 * Curated high-signal YouTube channels across AI experts, gaming/hardware,
 * coding/cybersecurity, science/space, startups, and Ukraine/DefenseTech.
 */
export const YOUTUBE_RSS_CHANNELS: YoutubeChannelDefinition[] = [
  // AI & Engineering Experts
  {
    slug: 'yt-andrej-karpathy',
    channelId: 'UCXUPKJO5MZQN11PqgIvyuvQ',
    name: 'Andrej Karpathy (YouTube)',
    category: 'model',
    credibilityWeight: 98,
    priorityTier: 'high',
    language: 'en',
    topics: ['llm', 'agents', 'training', 'coding', 'architecture'],
  },
  {
    slug: 'yt-ai-explained',
    channelId: 'UCNJ1Ymd5yFuUPtn21xtRbbw',
    name: 'AI Explained',
    category: 'model',
    credibilityWeight: 93,
    priorityTier: 'high',
    language: 'en',
    topics: ['benchmarks', 'reasoning', 'safety', 'frontier models'],
  },
  {
    slug: 'yt-dwarkesh-patel',
    channelId: 'UCXl4i9dYBrFOabk0xGmbkRA',
    name: 'Dwarkesh Patel',
    category: 'research',
    credibilityWeight: 94,
    priorityTier: 'high',
    language: 'en',
    topics: ['ai interviews', 'scaling', 'science', 'founders'],
  },
  {
    slug: 'yt-two-minute-papers',
    channelId: 'UCbfYPyITQ-7l4upoX8nvctg',
    name: 'Two Minute Papers',
    category: 'research',
    credibilityWeight: 88,
    priorityTier: 'standard',
    language: 'en',
    topics: ['papers', 'graphics', 'simulation', 'ai research'],
  },
  {
    slug: 'yt-google-deepmind',
    channelId: 'UCP7jMXSY2xbc3KCAE0MHQ-A',
    name: 'Google DeepMind (YouTube)',
    category: 'model',
    credibilityWeight: 95,
    priorityTier: 'high',
    language: 'en',
    topics: ['deepmind', 'gemini', 'alphafold', 'robotics'],
  },

  // Hardware, Gaming & Gamedev
  {
    slug: 'yt-digital-foundry',
    channelId: 'UC9PBzalIcEQCsiIkq36PyUA',
    name: 'Digital Foundry',
    category: 'hardware_gaming',
    credibilityWeight: 94,
    priorityTier: 'high',
    language: 'en',
    topics: ['game engines', 'consoles', 'gpu', 'rendering', 'performance'],
  },
  {
    slug: 'yt-gamers-nexus',
    channelId: 'UChIs72whgZI9w6d6FhwGGHA',
    name: 'Gamers Nexus',
    category: 'hardware_gaming',
    credibilityWeight: 93,
    priorityTier: 'high',
    language: 'en',
    topics: ['gpu', 'cpu', 'benchmarks', 'hardware engineering'],
  },
  {
    slug: 'yt-gdc',
    channelId: 'UC0JB7TSe49lg56u6qH8y_MQ',
    name: 'GDC Festival of Gaming',
    category: 'hardware_gaming',
    credibilityWeight: 91,
    priorityTier: 'standard',
    language: 'en',
    topics: ['gamedev', 'game design', 'graphics', 'postmortem'],
  },

  // Coding & Cybersecurity
  {
    slug: 'yt-fireship',
    channelId: 'UCsBjURrPoezykLs9EqgamOA',
    name: 'Fireship',
    category: 'coding',
    credibilityWeight: 88,
    priorityTier: 'standard',
    language: 'en',
    topics: ['webdev', 'devtools', 'ai tools', 'programming'],
  },
  {
    slug: 'yt-john-hammond',
    channelId: 'UCVeW9qkBjo3zosnqUbG7CFw',
    name: 'John Hammond',
    category: 'cybersecurity',
    credibilityWeight: 91,
    priorityTier: 'high',
    language: 'en',
    topics: ['cve', 'malware', 'infosec', 'exploit analysis'],
  },

  // Science, Space & Startups
  {
    slug: 'yt-scott-manley',
    channelId: 'UCxzC4EngIsMrPmbm6Nxvb-A',
    name: 'Scott Manley',
    category: 'science_space',
    credibilityWeight: 93,
    priorityTier: 'high',
    language: 'en',
    topics: ['rockets', 'spacex', 'orbital mechanics', 'aerospace'],
  },
  {
    slug: 'yt-veritasium',
    channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
    name: 'Veritasium',
    category: 'science_space',
    credibilityWeight: 92,
    priorityTier: 'standard',
    language: 'en',
    topics: ['physics', 'engineering', 'science'],
  },
  {
    slug: 'yt-y-combinator',
    channelId: 'UCcefcZRL2oaA_uBNeo5UOWg',
    name: 'Y Combinator (YouTube)',
    category: 'startups_fintech',
    credibilityWeight: 92,
    priorityTier: 'high',
    language: 'en',
    topics: ['startups', 'founders', 'ai startups', 'venture'],
  },

  // Ukraine & DefenseTech
  {
    slug: 'yt-militarnyi',
    channelId: 'UC3cntnJoRiiLaZ7dZwTTQ8A',
    name: 'Мілітарний (YouTube)',
    category: 'defense',
    credibilityWeight: 94,
    priorityTier: 'high',
    language: 'uk',
    topics: ['оборона', 'бпла', 'реб', 'defensetech', 'аналітика'],
  },
  // Expanded (v2.0): explainers, hardware reviews, interviews and science
  {
    slug: 'yt-lex-fridman',
    channelId: 'UCSHZKyawb77ixDdsGog4iWA',
    name: 'Lex Fridman',
    category: 'research',
    credibilityWeight: 88,
    priorityTier: 'standard',
    language: 'en',
    topics: ['interview', 'ai', 'science'],
  },
  {
    slug: 'yt-yannic-kilcher',
    channelId: 'UCZHmQk67mSJgfCCTn7xBfew',
    name: 'Yannic Kilcher',
    category: 'research',
    credibilityWeight: 90,
    priorityTier: 'standard',
    language: 'en',
    topics: ['papers', 'llm', 'research'],
  },
  {
    slug: 'yt-3blue1brown',
    channelId: 'UCYO_jab_esuFRV4b17AJtAw',
    name: '3Blue1Brown',
    category: 'research',
    credibilityWeight: 92,
    priorityTier: 'standard',
    language: 'en',
    topics: ['math', 'neural networks', 'explainers'],
  },
  {
    slug: 'yt-computerphile',
    channelId: 'UC9-y-6csu5WGm29I7JiwpnA',
    name: 'Computerphile',
    category: 'coding',
    credibilityWeight: 88,
    priorityTier: 'standard',
    language: 'en',
    topics: ['computer science', 'security', 'ai'],
  },
  {
    slug: 'yt-linus-tech-tips',
    channelId: 'UCXuqSBlHAE6Xw-yeJA0Tunw',
    name: 'Linus Tech Tips',
    category: 'hardware_gaming',
    credibilityWeight: 80,
    priorityTier: 'standard',
    language: 'en',
    topics: ['hardware', 'reviews', 'pc'],
  },
  {
    slug: 'yt-mkbhd',
    channelId: 'UCBJycsmduvYEL83R_U4JriQ',
    name: 'Marques Brownlee',
    category: 'hardware_gaming',
    credibilityWeight: 84,
    priorityTier: 'standard',
    language: 'en',
    topics: ['smartphones', 'gadgets', 'reviews'],
  },
  {
    slug: 'yt-nasa',
    channelId: 'UCLA_DiR1FfKNvjuUpBHmylQ',
    name: 'NASA',
    category: 'science_space',
    credibilityWeight: 95,
    priorityTier: 'high',
    language: 'en',
    topics: ['space', 'missions', 'launch'],
  },
  {
    slug: 'yt-kurzgesagt',
    channelId: 'UCsXVk37bltHxD1rDPwtNM8Q',
    name: 'Kurzgesagt',
    category: 'science_space',
    credibilityWeight: 86,
    priorityTier: 'standard',
    language: 'en',
    topics: ['science', 'explainers'],
  },
];

export function buildYoutubeRssUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId.trim())}`;
}

export function extractYoutubeVideoId(rawUrl: string): string | null {
  const parsed = URL.parse((rawUrl || '').trim());
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = parsed.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
    const match = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/.exec(parsed.pathname);
    if (match?.[1]) return match[1];
  }
  return null;
}
