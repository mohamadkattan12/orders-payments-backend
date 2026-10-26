import { priceLines, vatIncluded } from './money.js';

describe('vatIncluded', () => {
  it.each([
    [11500, 1500], // 115.00 SAR contains exactly 15.00 VAT
    [4500, 587], // 45.00 → 5.8695… → 5.87
    [100, 13], // 1.00 → 0.1304… → 0.13
    [23, 3], // 0.23 → exactly 0.03
    [8, 1], // 0.08 → 0.0104… → 0.01
    [0, 0],
  ])('%i halalas contains %i halalas VAT', (amount, vat) => {
    expect(vatIncluded(amount)).toBe(vat);
  });

  it('rejects fractions, negatives and unsafe integers', () => {
    expect(() => vatIncluded(1.5)).toThrow(RangeError);
    expect(() => vatIncluded(-1)).toThrow(RangeError);
    expect(() => vatIncluded(2 ** 53)).toThrow(RangeError);
  });
});

describe('priceLines', () => {
  it('computes VAT per line and totals as sums of the lines', () => {
    const r = priceLines([
      { qty: 2, unitPriceHalalas: 4500 }, // 90.00, VAT 11.74
      { qty: 1, unitPriceHalalas: 3999 }, // 39.99, VAT 5.22
    ]);
    expect(r.lines.map((l) => [l.lineTotalHalalas, l.lineVatHalalas])).toEqual([
      [9000, 1174],
      [3999, 522],
    ]);
    expect(r).toMatchObject({
      totalHalalas: 12999,
      vatHalalas: 1696,
      subtotalHalalas: 11303,
    });
  });
});
