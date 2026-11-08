import { describe, expect, it } from 'vitest';
import { aiCost, aiSettingsInput, commandRequest, logFilterRequest } from './ai.js';

describe('aiCost', () => {
  it('is the usage at the prices per million tokens, or nothing without prices', () => {
    expect(aiCost({ input: 2_000_000, output: 500_000 }, { input: 3, output: 15, currency: 'USD' })).toBe(13.5);
    expect(aiCost({ input: 1_000_000, output: 1_000_000 }, { input: null, output: 10, currency: 'EUR' })).toBe(10);
    expect(aiCost({ input: 100, output: 100 }, { input: null, output: null, currency: 'USD' })).toBeNull();
  });
});

describe('AI requests', () => {
  const settings = { provider: 'ollama', ollama: { url: 'http://ollama:11434', model: 'm' }, anthropic: { model: 'c' }, openai: { url: 'https://llm.example.com/v1', model: '' } };

  it('settings: real URLs, a timeout of 1 to 120 minutes, prices in a plain currency', () => {
    expect(aiSettingsInput.parse(settings)).toMatchObject({ timeoutMinutes: 10, prices: { input: null, output: null, currency: 'USD' } });
    expect(aiSettingsInput.safeParse({ ...settings, ollama: { url: 'not a url', model: '' } }).success).toBe(false);
    expect(aiSettingsInput.safeParse({ ...settings, timeoutMinutes: 0 }).success).toBe(false);
    expect(aiSettingsInput.safeParse({ ...settings, prices: { input: 1, output: 1, currency: '<b>' } }).success).toBe(false);
    expect(aiSettingsInput.safeParse({ ...settings, provider: 'gpt' }).success).toBe(false);
  });

  it('a question is trimmed and bounded, in English unless asked otherwise', () => {
    expect(commandRequest.parse({ hostId: 1, prompt: '  list disks ' })).toEqual({ hostId: 1, prompt: 'list disks', locale: 'en' });
    expect(commandRequest.safeParse({ hostId: 1, prompt: '   ' }).success).toBe(false);
    expect(commandRequest.safeParse({ hostId: 1, prompt: 'x', locale: 'de' }).success).toBe(false);
    expect(logFilterRequest.parse({ prompt: 'errors from the db', sources: ['db'], locale: 'nl' })).toMatchObject({ locale: 'nl' });
    expect(logFilterRequest.safeParse({ prompt: 'x'.repeat(501), sources: [] }).success).toBe(false);
  });
});
