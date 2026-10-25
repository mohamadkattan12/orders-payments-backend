/** Saudi VAT rate, in percent. Prices include it. */
export const VAT_PERCENT = 15;

/**
 * VAT contained in a VAT-inclusive amount, in halalas, rounded half up (an exact half can't occur
 * at 15/115, so the direction only matters for the formula):
 * round(amount × 15 / 115), computed in integers so no floating-point error.
 */
export function vatIncluded(amountHalalas: number): number {
  if (!Number.isSafeInteger(amountHalalas) || amountHalalas < 0)
    throw new RangeError(`invalid amount: ${amountHalalas}`);
  const divisor = 100 + VAT_PERCENT;
  return Math.floor(
    (amountHalalas * VAT_PERCENT * 2 + divisor) / (divisor * 2),
  );
}

export interface PricedLine {
  qty: number;
  unitPriceHalalas: number;
}

/** Per-line VAT (as ZATCA invoices do), and order totals as sums of the lines. */
export function priceLines<L extends PricedLine>(lines: L[]) {
  const priced = lines.map((l) => {
    const lineTotalHalalas = l.qty * l.unitPriceHalalas;
    return {
      ...l,
      lineTotalHalalas,
      lineVatHalalas: vatIncluded(lineTotalHalalas),
    };
  });
  const totalHalalas = priced.reduce((a, l) => a + l.lineTotalHalalas, 0);
  const vatHalalas = priced.reduce((a, l) => a + l.lineVatHalalas, 0);
  return {
    lines: priced,
    totalHalalas,
    vatHalalas,
    subtotalHalalas: totalHalalas - vatHalalas, // VAT excluded
  };
}
