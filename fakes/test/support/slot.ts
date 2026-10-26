/** E2E_SLOT=n lets several checkouts run the e2e suite at once with their own database. */
export const SLOT = Number(process.env.E2E_SLOT ?? 0);
export const dbName = (base: string) => (SLOT ? `${base}_${SLOT}` : base);
