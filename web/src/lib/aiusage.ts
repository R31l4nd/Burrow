import { aiCost, type AiPrices, type AiUsage } from '@burrow/shared';
import { locale, t } from './i18n/index.svelte.js';

// Tokens a model used, and what that about cost when prices are set
// (report 18efc8): "1,234 in, 567 out tokens | about 0.0123 USD".

const num = (n: number) => n.toLocaleString(locale());

/** A cost readable at any size: small amounts keep their digits. */
export const formatCost = (c: number) => (c === 0 ? '0' : c < 0.01 ? c.toFixed(4) : c.toFixed(2));

export function usageText(u: AiUsage, p: AiPrices): string {
  const cost = aiCost(u, p);
  const tokens = t('ai.tokens', { in: num(u.input), out: num(u.output) });
  return cost === null ? tokens : `${tokens} | ${t('ai.cost', { cost: formatCost(cost), currency: p.currency })}`;
}
