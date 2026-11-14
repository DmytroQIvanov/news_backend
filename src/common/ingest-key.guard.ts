import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
@Injectable()
export class IngestKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = req.header('x-ingest-key') || '';
    const expected = process.env.INGEST_API_KEY || '';
    if (!given || !expected) throw new UnauthorizedException('Invalid API key');
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid API key');
    return true;
  }
}
