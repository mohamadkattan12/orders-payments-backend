import type { PrismaClient } from '../generated/prisma/client.js';
import { PRODUCTS } from './data.js';

/** Idempotent: adds missing products and refreshes names and prices; never resets stock. */
export async function seed(prisma: PrismaClient): Promise<void> {
  for (const { stock, ...product } of PRODUCTS) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      create: { ...product, stock },
      update: product,
    });
  }
}
