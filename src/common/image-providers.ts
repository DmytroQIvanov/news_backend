import { generateImageWithWorkersAi, getWorkersAiConfig } from './workers-ai';

/**
 * Free text-to-image providers, tried in order until one returns an image.
 *  - workers_ai: Cloudflare Workers AI FLUX.1 schnell (needs cloudflare_account_id + cloudflare_api_token, 10k neurons/day free)
 *  - pollinations: image.pollinations.ai, a public keyless endpoint; the zero-setup fallback so caricatures work out of the box
 * Order is configurable with CARICATURE_IMAGE_PROVIDERS="workers_ai,pollinations".
 */
export type ImageProviderId = 'workers_ai' | 'pollinations';

export interface GeneratedImage {
  image: Buffer;
  contentType: string;
  model: string;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function imageProviderOrder(): ImageProviderId[] {
  const raw = (process.env.CARICATURE_IMAGE_PROVIDERS || 'workers_ai,pollinations').split(',').map((s) => s.trim());
  const order = raw.filter((p): p is ImageProviderId => p === 'workers_ai' || p === 'pollinations');
  return order.length ? order : ['workers_ai', 'pollinations'];
}

export function availableImageProviders(): ImageProviderId[] {
  return imageProviderOrder().filter((p) => {
    if (p === 'workers_ai') return Boolean(getWorkersAiConfig());
    return process.env.POLLINATIONS_ENABLED !== 'false';
  });
}

export async function generateImageWithPollinations(prompt: string, fetchFn: typeof fetch = fetch): Promise<GeneratedImage> {
  const seed = Math.floor(Math.random() * 1_000_000);
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}` +
    `?width=768&height=768&nologo=true&private=true&safe=true&model=flux&seed=${seed}`;
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(75_000), headers: { Accept: 'image/*' } });
  const contentType = resp.headers.get('content-type') || '';
  if (!resp.ok || !contentType.startsWith('image/')) {
    await resp.body?.cancel().catch(() => undefined);
    throw new Error(`Pollinations HTTP ${resp.status}`);
  }
  const image = Buffer.from(await resp.arrayBuffer());
  if (image.length < 2_000 || image.length > MAX_IMAGE_BYTES) {
    throw new Error(`Pollinations returned an unusable image (${image.length} bytes)`);
  }
  return { image, contentType: contentType.split(';')[0], model: 'pollinations/flux' };
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const errors: string[] = [];
  for (const provider of availableImageProviders()) {
    try {
      if (provider === 'workers_ai') return await generateImageWithWorkersAi(prompt);
      return await generateImageWithPollinations(prompt);
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No image provider succeeded (${errors.join(' | ') || 'none configured'})`);
}
