import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { formatCost, usageText } = await import('./aiusage.js');

// Tokens a model used and, with prices set, about what it cost (report 18efc8).
describe('AI usage', () => {
  it('tokens only when no price is set; with prices, the cost in their currency', () => {
    expect(usageText({ input: 1234, output: 567 }, { input: null, output: null, currency: 'USD' })).toBe('1,234 in, 567 out tokens');
    expect(usageText({ input: 1_000_000, output: 500_000 }, { input: 3, output: 15, currency: 'EUR' })).toBe('1,000,000 in, 500,000 out tokens | about 10.50 EUR');
    // One price set: the other counts as free.
    expect(usageText({ input: 2000, output: 100 }, { input: 3, output: null, currency: 'USD' })).toBe('2,000 in, 100 out tokens | about 0.0060 USD');
  });

  it('a small amount keeps its digits; nothing is 0', () => {
    expect(formatCost(0)).toBe('0');
    expect(formatCost(0.00123)).toBe('0.0012');
    expect(formatCost(0.01)).toBe('0.01');
    expect(formatCost(12.345)).toBe('12.35');
  });
});
