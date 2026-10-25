import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('products')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.product.findMany({
      select: {
        sku: true,
        nameAr: true,
        nameEn: true,
        priceHalalas: true,
        stock: true,
      },
      orderBy: { sku: 'asc' },
    });
  }
}
