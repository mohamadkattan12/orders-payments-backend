import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../common/config.js';
import { apiError } from '../common/errors.js';

/** Admin routes need X-Admin-Key (compared in constant time). */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const given = Buffer.from(
      context.switchToHttp().getRequest<Request>().header('x-admin-key') ?? '',
    );
    const expected = Buffer.from(config.adminKey());
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw apiError(
        401,
        'admin_key_required',
        'Send a valid X-Admin-Key header.',
      );
    return true;
  }
}
