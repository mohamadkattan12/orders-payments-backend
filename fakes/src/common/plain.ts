import { instanceToPlain } from 'class-transformer';
import type { Prisma } from '../generated/prisma/client.js';

/** A validated DTO as a JSON column value. */
export const plain = (dto: object) =>
  instanceToPlain(dto) as Prisma.InputJsonValue;
