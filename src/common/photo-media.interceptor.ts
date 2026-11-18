import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { map } from 'rxjs/operators';

/** Resolve private-R2 proxy paths for every API client and hide photos past retention. */
export function resolvePhotoMedia(value: unknown, apiBase: string, now = Date.now()): unknown {
  if (Array.isArray(value)) return value.map((v) => resolvePhotoMedia(v, apiBase, now)).filter((v) => v !== undefined);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const photo = value as Record<string, unknown>;
  if (typeof photo.objectKey === 'string' && photo.objectKey.startsWith('photos/')) {
    if (typeof photo.expiresAt !== 'string' || !(new Date(photo.expiresAt).getTime() > now)) return undefined;
  }
  return Object.fromEntries(Object.entries(photo).map(([key, item]) => [key,
    key === 'url' && typeof item === 'string' && item.startsWith('/api/v1/media/photos/')
      ? `${apiBase}${item}` : resolvePhotoMedia(item, apiBase, now),
  ]).filter(([, item]) => item !== undefined));
}

@Injectable()
export class PhotoMediaInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    const base = `${req.protocol}://${req.get('host')}`;
    return next.handle().pipe(map((value: unknown) => resolvePhotoMedia(value, base)));
  }
}
