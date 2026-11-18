import { readEnv } from './r2-storage';

/**
 * Cloudflare Workers AI text-to-image (free daily allocation: 10k neurons/day).
 * FLUX.2 [klein] 9B gives sharp editorial illustration quality in 4 fixed steps (~1,364 neurons/MP).
 * It renders text poorly, so captions are always shown by the app, never baked into the image.
 */
export const DEFAULT_WORKERS_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';

export function getWorkersAiConfig(): { accountId: string; apiToken: string; model: string } | null {
  const accountId = readEnv('cloudflare_account_id');
  const apiToken = readEnv('cloudflare_api_token');
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !apiToken) return null;
  const model = readEnv('cloudflare_image_model') || DEFAULT_WORKERS_IMAGE_MODEL;
  return { accountId, apiToken, model };
}

export function isMultipartWorkersImageModel(model: string): boolean {
  return /(^|\/)flux-2-/i.test(model);
}

export async function generateImageWithWorkersAi(
  prompt: string,
  options?: { steps?: number; width?: number; height?: number; fetchFn?: typeof fetch },
) {
  const config = getWorkersAiConfig();
  if (!config) throw new Error('Cloudflare Workers AI is not configured');
  const fetchImpl = options?.fetchFn ?? fetch;
  const width = Math.min(1024, Math.max(512, options?.width ?? 768));
  const height = Math.min(1024, Math.max(512, options?.height ?? 768));
  const trimmedPrompt = prompt.slice(0, 2000);

  let body: FormData | string;
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiToken}` };

  if (isMultipartWorkersImageModel(config.model)) {
    const form = new FormData();
    form.append('prompt', trimmedPrompt);
    form.append('width', String(width));
    form.append('height', String(height));
    if (/flux-2-dev/i.test(config.model)) {
      form.append('steps', String(Math.min(28, Math.max(4, options?.steps ?? 20))));
    }
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      prompt: trimmedPrompt,
      steps: Math.min(25, Math.max(1, options?.steps ?? 8)),
      width,
      height,
    });
  }

  const resp = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.model}`,
    {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    },
  );
  const contentType = resp.headers.get('content-type') || '';
  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`Workers AI HTTP ${resp.status}: ${text}`);
  }
  // Some models stream raw PNG bytes, FLUX returns JSON { result: { image: base64 } }.
  if (contentType.startsWith('image/')) {
    return { image: Buffer.from(await resp.arrayBuffer()), contentType: contentType.split(';')[0], model: config.model };
  }
  const json = (await resp.json()) as { success?: boolean; result?: { image?: string } };
  const b64 = json.result?.image;
  if (!b64) throw new Error('Workers AI returned no image');
  return { image: Buffer.from(b64, 'base64'), contentType: 'image/jpeg', model: config.model };
}
