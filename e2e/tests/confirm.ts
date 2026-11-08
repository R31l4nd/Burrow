import type { Page } from '@playwright/test';

/**
 * Yes to the app's own "are you sure?" whenever it asks (it replaced the
 * browser's confirm()), answered in the page itself so it happens whatever
 * the test does next (a locator handler only runs before an action on this
 * page). With a name, a question that asks for one gets it; without, such a
 * question is left for the test to fill in. Returns what was asked.
 */
export async function sayYes(page: Page, name?: string): Promise<() => Promise<string[]>> {
  const answer = (n: string | null) => {
    const w = window as unknown as { __sayYes?: boolean; __asked?: string[] };
    if (w.__sayYes) return;
    w.__sayYes = true;
    w.__asked = [];
    setInterval(() => {
      const ok = document.querySelector<HTMLButtonElement>('dialog[open] [data-testid=confirm-ok]');
      if (!ok || ok.disabled) return;
      const input = document.querySelector<HTMLInputElement>('dialog[open] [data-testid=confirm-input]');
      if (input) {
        if (n === null) return;
        input.value = n;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // The question and what it lists to read first (each item its own block).
      const items = [...document.querySelectorAll('dialog[open] [data-testid=confirm-items] li')].map((li) => [...li.children].map((c) => c.textContent).join(' | '));
      w.__asked!.push([document.querySelector('dialog[open] [data-testid=confirm-text]')?.textContent ?? '', ...items].join('\n'));
      ok.click();
    }, 100);
  };
  await page.addInitScript(answer, name ?? null);
  await page.evaluate(answer, name ?? null).catch(() => {});
  return () => page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []);
}
