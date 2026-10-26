-- Units the ERP removed that orders still hold; repaid by releases and restocks first (review fix).
-- Hand-edited: Prisma's diff also tried to drop invoice_number_seq, which it can't model.
ALTER TABLE "products" ADD COLUMN "shortfall" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD CONSTRAINT "products_shortfall_check" CHECK ("shortfall" >= 0);
